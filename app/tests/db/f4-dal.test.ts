// F4 B3 RED — 요청별 DAL(getViewer)의 실제 PG 확인(PLAN_mvp-oidc-integration §7, §9 D4).
//
// 대상: app/src/server/context.ts의 getViewer(아직 없음). 각 it 안에서 vi.resetModules 뒤 동적 import한다.
// - 실제 일회용 PG18(기존 harness freshMigratedDb), app role URL(POD_DATABASE_URL), 제품 getAppDb·verifyActiveAccount·
//   sealSession/readSession을 그대로 쓴다. DB·lifecycle·codec은 mock하지 않는다.
// - mock은 요청 입력뿐이다: next/headers(cookies·headers), react cache(요청 번호별 memo seam, request-context.test.ts와 같은 이유:
//   React 19 클라이언트 빌드의 cache는 렌더 밖에서 memo하지 않는다). env는 vi.stubEnv로 넣고 되돌린다.
// - 제품 getAppDb는 모듈 전역 Pool을 만든다. 사례마다 모듈을 새로 불러오고 finally에서 그 Pool을 닫는다.
// - owner 연결은 사용자 준비·상태 확인에만 쓴다. 탈퇴는 실제 lifecycle.requestWithdrawal(app role Pool)로 커밋한다.
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sealSession } from "@/server/auth/session";
import { loadAuthConfig } from "@/server/auth/config";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR } from "./f2-support";
import { endAllPools, endPool, freshMigratedDb, openAppPool } from "./f3-support";
import { lifeState, loadLifecycle, seedUser, setPending } from "./f4-lifecycle-support";

const h = vi.hoisted(() => ({
  request: 0,
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  cookieReads: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      h.cookieReads.push(name);
      const value = h.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => h.cookies.has(name),
    getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers([...h.headers]),
}));

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const memo = new Map<string, R>();
      return (...args: A): R => {
        const key = `${h.request}|${JSON.stringify(args)}`;
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key)!;
      };
    },
  };
});

const CONTEXT_MODULE = path.join(APP_DIR, "src", "server", "context.ts");
const POOL_MODULE = path.join(APP_DIR, "src", "server", "db", "pool.ts");
const CASE_TIMEOUT = 60_000;

type RequestViewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };
type ContextApi = { getViewer: () => Promise<RequestViewer> };

const KEY = "ci-only-b3-dal-key-1-".padEnd(40, "x");
const BASE = "https://pieceofdays.example";
const COOKIE = "__Host-pod_session";

let env: HarnessEnv;
let shared: Promise<DisposableDatabase> | undefined;
let seq = 0;

beforeAll(() => {
  env = readDisposableEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await endAllPools();
  if (env) await cleanupAll(env);
});

function sharedDb(): Promise<DisposableDatabase> {
  shared ??= freshMigratedDb(env, "f4dal");
  return shared;
}

const ident = (p: "google" | "kakao" = "google") => ({ provider: p, subject: `b3-${p}-${++seq}-${Date.now()}` });

function authEnv(databaseUrl: string): Record<string, string> {
  return {
    NODE_ENV: "test",
    POD_LOCAL_FIXTURE: "",
    POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY }),
    POD_AUTH_BASE_URL: BASE,
    POD_AUTH_PROVIDERS: "google",
    POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client",
    POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
    POD_AUTH_MOCK_OIDC_ISSUER: "",
    POD_DATABASE_URL: databaseUrl,
  };
}

function sessionCfg() {
  const r = loadAuthConfig(authEnv("unused"), "test");
  if (!r.ok) throw new Error(`test config rejected: ${r.error}`);
  return r.value.session;
}
const seal = async (userId: string, gen: number) => (await sealSession(sessionCfg(), { userId, gen })).value;

function newRequest(cookies: Record<string, string> = {}, headers: Record<string, string> = {}): void {
  h.request++;
  h.cookies = new Map(Object.entries(cookies));
  h.headers = new Map(Object.entries(headers));
  h.cookieReads = [];
}

/** env를 넣고 제품 모듈을 새로 불러 fn을 실행한다. 끝나면 제품 getAppDb Pool을 닫는다. */
async function withContext<T>(envMap: Record<string, string>, fn: (ctx: ContextApi) => Promise<T>): Promise<T> {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(envMap)) vi.stubEnv(k, v);
  vi.resetModules();
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ CONTEXT_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/server/context.ts could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  expect(typeof mod.getViewer, "src/server/context.ts must export function getViewer").toBe("function");
  try {
    return await fn(mod as unknown as ContextApi);
  } finally {
    if (envMap.POD_DATABASE_URL) {
      const pool = (await import(/* @vite-ignore */ POOL_MODULE)) as { getAppDb: () => pg.Pool };
      await pool.getAppDb().end().catch(() => undefined);
    }
  }
}

async function closedPortUrl(): Promise<string> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `postgres://pod_closed:ci-only-closed@127.0.0.1:${port}/pod_closed`;
}

const viewerFor = async (ctx: ContextApi, cookie: string | undefined, headers: Record<string, string> = {}, extra: Record<string, string> = {}) => {
  newRequest(cookie === undefined ? extra : { [COOKIE]: cookie, ...extra }, headers);
  return ctx.getViewer();
};

// =================================================================

describe("getViewer on a real disposable PG18 (app role, real verifyActiveAccount)", () => {
  it("active user with the current gen → user; old gen, pending, missing user and gen beyond int4 → signed_out", async () => {
    const db = await sharedDb();
    const active1 = await seedUser(env, db, [ident()], { granted: true });
    const active3 = await seedUser(env, db, [ident("kakao")], { granted: true, gen: 3 });
    const pending = await seedUser(env, db, [ident()], { granted: true });
    await setPending(env, db, pending, "clock_timestamp()", 2);
    await withContext(authEnv(db.urls.app), async (ctx) => {
      expect(await viewerFor(ctx, await seal(active1, 1))).toEqual({ kind: "user", userId: active1, gen: 1 });
      expect(await viewerFor(ctx, await seal(active3, 3))).toEqual({ kind: "user", userId: active3, gen: 3 });
      expect(await viewerFor(ctx, await seal(active3, 2)), "old gen").toEqual({ kind: "signed_out" });
      expect(await viewerFor(ctx, await seal(active3, 4)), "future gen").toEqual({ kind: "signed_out" });
      expect(await viewerFor(ctx, await seal(pending, 2)), "pending_deletion with current gen").toEqual({ kind: "signed_out" });
      expect(await viewerFor(ctx, await seal(randomUUID(), 1)), "no such user").toEqual({ kind: "signed_out" });
      for (const gen of [2 ** 31, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER]) {
        expect(await viewerFor(ctx, await seal(active1, gen)), `gen ${gen} beyond int4: no SQL error`).toEqual({ kind: "signed_out" });
      }
      expect(h.cookieReads, "only the exact session cookie name").toEqual([COOKIE]);
    });
  }, CASE_TIMEOUT);

  it("DB failures (no POD_DATABASE_URL, closed loopback port, role without table privileges) → unavailable db_unavailable, never user or signed_out", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    for (const [label, url] of [
      ["POD_DATABASE_URL blank", ""],
      ["closed loopback port", await closedPortUrl()],
      ["purge role (permission denied)", db.urls.purge],
    ] as const) {
      await withContext(authEnv(url), async (ctx) => {
        expect(await viewerFor(ctx, cookie), label).toEqual({ kind: "unavailable", reason: "db_unavailable" });
      });
    }
    // 대조: 같은 쿠키·같은 사용자는 정상 app role에서 user
    await withContext(authEnv(db.urls.app), async (ctx) => {
      expect(await viewerFor(ctx, cookie)).toEqual({ kind: "user", userId: uid, gen: 1 });
    });
  }, CASE_TIMEOUT);

  it("after a withdrawal COMMIT the next request with the old session is signed_out (pending, gen+1)", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    const life = await loadLifecycle();
    const pool = openAppPool(db, 1);
    try {
      await withContext(authEnv(db.urls.app), async (ctx) => {
        expect(await viewerFor(ctx, cookie), "before withdrawal").toEqual({ kind: "user", userId: uid, gen: 1 });
        expect(await life.withdraw(pool, { userId: uid, gen: 1 })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await lifeState(env, db, uid)).toMatchObject({ status: "pending_deletion", gen: 2 });
        expect(await viewerFor(ctx, cookie), "new request after COMMIT").toEqual({ kind: "signed_out" });
        expect(await viewerFor(ctx, await seal(uid, 2)), "even a session with the new gen while pending").toEqual({ kind: "signed_out" });
      });
    } finally {
      await endPool(pool);
    }
  }, CASE_TIMEOUT);

  it("A's session decides the viewer: B's userId in headers or cookies is ignored, and does not help once A is withdrawn", async () => {
    const db = await sharedDb();
    const a = await seedUser(env, db, [ident()], { granted: true });
    const b = await seedUser(env, db, [ident()], { granted: true });
    const cookieA = await seal(a, 1);
    const spoof = { "x-user-id": b, "x-forwarded-user": b, referer: `${BASE}/days?userId=${b}` };
    const life = await loadLifecycle();
    const pool = openAppPool(db, 1);
    try {
      await withContext(authEnv(db.urls.app), async (ctx) => {
        expect(await viewerFor(ctx, cookieA, spoof, { userId: b, user_id: b })).toEqual({ kind: "user", userId: a, gen: 1 });
        expect(await viewerFor(ctx, undefined, spoof, { userId: b }), "B identifiers without a session").toEqual({ kind: "signed_out" });
        expect(await life.withdraw(pool, { userId: a, gen: 1 })).toMatchObject({ ok: true });
        expect(await viewerFor(ctx, cookieA, spoof, { userId: b }), "A withdrawn, B still active").toEqual({ kind: "signed_out" });
        expect(await lifeState(env, db, b), "B untouched").toMatchObject({ status: "active", gen: 1 });
      });
    } finally {
      await endPool(pool);
    }
  }, CASE_TIMEOUT);

  it("fixture + PROVIDERS throws before returning fixture, even with a reachable DB and a valid session", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    await withContext({ ...authEnv(db.urls.app), POD_LOCAL_FIXTURE: "1" }, async (ctx) => {
      await expect(viewerFor(ctx, cookie)).rejects.toThrow();
      expect(h.cookieReads).toEqual([]);
    });
  }, CASE_TIMEOUT);
});
