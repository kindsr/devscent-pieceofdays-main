// F5 S3a RED — 기록 Server Actions를 실제 PG18에서 확인한다(PLAN_dev-diary-actions §1·§2·§3).
//
// 대상: app/src/app/actions/diary.ts(아직 없음). 각 it 안에서 vi.resetModules 뒤 동적 import한다.
// - 실제 일회용 PG18(기존 harness freshMigratedDb), app role URL(POD_DATABASE_URL), 제품 getAppDb·getViewer·
//   sealSession/readSession·verifyActiveAccount·createPgDiaryStore·setFontKey를 그대로 쓴다. DB·lifecycle·codec·F3는 mock하지 않는다.
// - mock은 요청 입력뿐이다: next/headers(headers·cookies), react cache(요청 번호별 memo seam, f4-dal.test.ts와 같은 이유).
//   액션 호출 하나 = 새 POST 요청 하나(h.request 증가). env는 vi.stubEnv로 넣고 되돌린다.
// - 제품 getAppDb는 모듈 전역 Pool을 만든다. 사례마다 모듈을 새로 불러오고 finally에서 그 Pool을 닫는다.
// - owner 연결은 사용자 준비·결과 확인에만 쓴다. 탈퇴는 실제 lifecycle.requestWithdrawal(app role Pool)로 커밋한다.
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sealSession } from "@/server/auth/session";
import { loadAuthConfig } from "@/server/auth/config";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, withOwner } from "./f2-support";
import { endAllPools, endPool, freshMigratedDb, openAppPool } from "./f3-support";
import { MISSING_UUID, momentRows, summaryRows } from "./f3-diary-support";
import { lifeState, loadLifecycle, seedUser } from "./f4-lifecycle-support";

const h = vi.hoisted(() => ({
  request: 0,
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers([...h.headers]),
  cookies: async () => ({
    get: (name: string) => {
      const value = h.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => h.cookies.has(name),
    getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
  }),
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

const ACTIONS_MODULE = path.join(APP_DIR, "src", "app", "actions", "diary.ts");
const POOL_MODULE = path.join(APP_DIR, "src", "server", "db", "pool.ts");
const CASE_TIMEOUT = 60_000;

type ActionError =
  | "forbidden"
  | "not_signed_in"
  | "unavailable"
  | "invalid_body"
  | "invalid_version"
  | "invalid_date"
  | "invalid_font"
  | "not_found"
  | "conflict";
type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };
type Actions = {
  createMomentAction: (body: unknown) => Promise<ActionResult<{ id: string; version: number }>>;
  updateMomentAction: (id: unknown, expectedVersion: unknown, body: unknown) => Promise<ActionResult<{ id: string; version: number }>>;
  deleteMomentAction: (id: unknown, expectedVersion: unknown) => Promise<ActionResult<null>>;
  saveSummaryAction: (date: unknown, expectedVersion: unknown, body: unknown) => Promise<ActionResult<{ version: number } | null>>;
  setFontAction: (key: unknown) => Promise<ActionResult<"gothic" | "serif" | "hand">>;
};
const ACTION_NAMES = ["createMomentAction", "updateMomentAction", "deleteMomentAction", "saveSummaryAction", "setFontAction"] as const;

const KEY = "ci-only-s3a-dal-key-1-".padEnd(40, "x");
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
  shared ??= freshMigratedDb(env, "f5act");
  return shared;
}

const ident = () => ({ provider: "google", subject: `s3a-${++seq}-${Date.now()}` });

function authEnv(databaseUrl: string): Record<string, string> {
  return {
    NODE_ENV: "test",
    POD_LOCAL_FIXTURE: "",
    POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY }),
    POD_AUTH_BASE_URL: BASE,
    POD_AUTH_PROVIDERS: "google",
    POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client",
    POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
    POD_AUTH_KAKAO_CLIENT_ID: "",
    POD_AUTH_KAKAO_CLIENT_SECRET: "",
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

/** 새 POST 요청: 요청 번호 증가, 같은 Origin과 세션 쿠키(있으면)를 넣는다. */
function newRequest(cookie: string | undefined, opts: { origin?: string | null; headers?: Record<string, string>; cookies?: Record<string, string> } = {}): void {
  h.request++;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.origin = origin;
  h.headers = new Map(Object.entries(headers));
  h.cookies = new Map(Object.entries({ ...(cookie === undefined ? {} : { [COOKIE]: cookie }), ...(opts.cookies ?? {}) }));
}

/** 한 사용자로 보내는 요청 묶음. 액션마다 새 요청을 만든다. */
function as(a: Actions, cookie: string | undefined, opts: Parameters<typeof newRequest>[1] = {}) {
  const run = <K extends (typeof ACTION_NAMES)[number]>(name: K, ...args: unknown[]) => {
    newRequest(cookie, opts);
    return (a[name] as unknown as (...xs: unknown[]) => ReturnType<Actions[K]>)(...args);
  };
  return {
    create: (body: unknown) => run("createMomentAction", body),
    update: (id: unknown, v: unknown, body: unknown) => run("updateMomentAction", id, v, body),
    remove: (id: unknown, v: unknown) => run("deleteMomentAction", id, v),
    summary: (date: unknown, v: unknown, body: unknown) => run("saveSummaryAction", date, v, body),
    font: (key: unknown) => run("setFontAction", key),
  };
}

/** env를 넣고 제품 모듈을 새로 불러 fn을 실행한다. 끝나면 제품 getAppDb Pool을 닫는다. */
async function withActions<T>(envMap: Record<string, string>, fn: (a: Actions) => Promise<T>): Promise<T> {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(envMap)) vi.stubEnv(k, v);
  vi.resetModules();
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ ACTIONS_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/app/actions/diary.ts could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const name of ACTION_NAMES) expect(typeof mod[name], `src/app/actions/diary.ts must export function ${name}`).toBe("function");
  try {
    return await fn(mod as unknown as Actions);
  } finally {
    if (envMap.POD_DATABASE_URL) {
      const pool = (await import(/* @vite-ignore */ POOL_MODULE)) as { getAppDb: () => pg.Pool };
      await pool.getAppDb().end().catch(() => undefined);
    }
  }
}

function seoulDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const daysFromToday = (n: number) => seoulDate(new Date(Date.now() + n * 86_400_000));

async function fontOf(db: DisposableDatabase, userId: string): Promise<string | null> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ font_key: string }>("SELECT font_key FROM pod.preferences WHERE user_id = $1::uuid", [userId]);
    return r.rows[0]?.font_key ?? null;
  });
}

async function closedPortUrl(): Promise<string> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `postgres://pod_closed:ci-only-closed@127.0.0.1:${port}/pod_closed`;
}

function okOf<T>(r: ActionResult<T>, label: string): T {
  expect(r, label).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`${label}: unexpected ${r.error}`);
  return r.value;
}

// =================================================================

describe("diary actions on a real disposable PG18 (app role, real getViewer and F3)", () => {
  it("moment create → update → stale update/delete conflict (text kept) → delete → not_found", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    await withActions(authEnv(db.urls.app), async (a) => {
      const me = as(a, cookie);
      const created = okOf(await me.create("  국숫집 줄이 짧았다  "), "create");
      expect(created.version).toBe(1);
      let rows = await momentRows(env, db, uid);
      expect(rows.map((r) => [r.id, r.body, r.version, r.local_date])).toEqual([[created.id, "국숫집 줄이 짧았다", 1, seoulDate(new Date())]]);

      expect(await me.update(created.id, 1, "국숫집 줄이 생각보다 짧았다")).toEqual({ ok: true, value: { id: created.id, version: 2 } });
      expect(await me.update(created.id, 1, "낡은 화면의 글"), "stale update").toEqual({ ok: false, error: "conflict" });
      expect(await me.remove(created.id, 1), "stale delete").toEqual({ ok: false, error: "conflict" });
      expect(await me.update(created.id, 2, "가".repeat(301)), "too long").toEqual({ ok: false, error: "invalid_body" });
      rows = await momentRows(env, db, uid);
      expect(rows.map((r) => [r.body, r.version]), "text kept after failures").toEqual([["국숫집 줄이 생각보다 짧았다", 2]]);

      expect(await me.remove(created.id, 2)).toEqual({ ok: true, value: null });
      expect(await momentRows(env, db, uid)).toEqual([]);
      expect(await me.update(created.id, 3, "지운 뒤"), "after delete").toEqual({ ok: false, error: "not_found" });
      expect(await me.remove(created.id, 3), "delete again").toEqual({ ok: false, error: "not_found" });
    });
  }, CASE_TIMEOUT);

  it("summary: today create (null) → duplicate create conflict → versioned update → past date allowed → future invalid_date → empty body deletes", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    const today = seoulDate(new Date());
    const past = daysFromToday(-40);
    await withActions(authEnv(db.urls.app), async (a) => {
      const me = as(a, cookie);
      expect(await me.summary(today, null, "맑고 조용한 하루")).toEqual({ ok: true, value: { version: 1 } });
      expect(await me.summary(today, null, "두 번째 생성"), "create over existing").toEqual({ ok: false, error: "conflict" });
      expect(await me.summary(today, null, ""), "null-version delete of existing").toEqual({ ok: false, error: "conflict" });
      expect(await me.summary(today, 1, "고친 하루")).toEqual({ ok: true, value: { version: 2 } });
      expect(await me.summary(today, 1, "낡은 버전"), "stale").toEqual({ ok: false, error: "conflict" });
      expect(await me.summary(past, null, "지난 날의 한 줄"), "past date").toEqual({ ok: true, value: { version: 1 } });
      expect(await me.summary(daysFromToday(2), null, "미래"), "after Seoul today").toEqual({ ok: false, error: "invalid_date" });
      expect(await me.summary("2026-02-30", null, "없는 날"), "impossible date").toEqual({ ok: false, error: "invalid_date" });
      expect((await summaryRows(env, db, uid)).map((r) => [r.local_date, r.body, r.version]).sort()).toEqual(
        [
          [past, "지난 날의 한 줄", 1],
          [today, "고친 하루", 2],
        ].sort(),
      );
      expect(await me.summary(today, 2, "   ")).toEqual({ ok: true, value: null });
      expect((await summaryRows(env, db, uid)).map((r) => r.local_date)).toEqual([past]);
      expect(await me.summary(today, 3, "지운 뒤"), "after delete").toEqual({ ok: false, error: "not_found" });
    });
  }, CASE_TIMEOUT);

  it("font: allowed keys are stored for the session user; invalid keys leave the stored font unchanged", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    await withActions(authEnv(db.urls.app), async (a) => {
      const me = as(a, cookie);
      expect(await me.font("serif")).toEqual({ ok: true, value: "serif" });
      expect(await fontOf(db, uid)).toBe("serif");
      for (const bad of ["Serif", "mono", "", null, 1]) {
        expect(await me.font(bad), String(bad)).toEqual({ ok: false, error: "invalid_font" });
      }
      expect(await fontOf(db, uid), "unchanged").toBe("serif");
      expect(await me.font("hand")).toEqual({ ok: true, value: "hand" });
      expect(await fontOf(db, uid)).toBe("hand");
    });
  }, CASE_TIMEOUT);

  it("A/B ownership: B cannot change or delete A's moment (not_found, any version incl. beyond int4); A's beyond-int4 stale version → conflict", async () => {
    const db = await sharedDb();
    const uidA = await seedUser(env, db, [ident()], { granted: true });
    const uidB = await seedUser(env, db, [ident()], { granted: true });
    const cookieA = await seal(uidA, 1);
    const cookieB = await seal(uidB, 1);
    const today = seoulDate(new Date());
    await withActions(authEnv(db.urls.app), async (a) => {
      const A = as(a, cookieA);
      const B = as(a, cookieB);
      const mA = okOf(await A.create("A의 조각"), "A create");
      okOf(await A.summary(today, null, "A의 한 줄"), "A summary");
      for (const v of [1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
        expect(await B.update(mA.id, v, "B가 바꿈"), `B update v=${v}`).toEqual({ ok: false, error: "not_found" });
        expect(await B.remove(mA.id, v), `B delete v=${v}`).toEqual({ ok: false, error: "not_found" });
        expect(await A.update(MISSING_UUID, v, "없는 조각"), `missing v=${v}`).toEqual({ ok: false, error: "not_found" });
      }
      for (const v of [2 ** 31, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER]) {
        expect(await A.update(mA.id, v, "A가 큰 버전으로"), `A update v=${v}`).toEqual({ ok: false, error: "conflict" });
        expect(await A.remove(mA.id, v), `A delete v=${v}`).toEqual({ ok: false, error: "conflict" });
        expect(await A.summary(today, v, "큰 버전"), `A summary v=${v}`).toEqual({ ok: false, error: "conflict" });
      }
      // B의 한 줄은 같은 날짜여도 B 자신의 행이다(A 행에 영향 없음).
      expect(await B.summary(today, null, "B의 한 줄")).toEqual({ ok: true, value: { version: 1 } });
      expect(await B.summary(today, 1, "B가 고침")).toEqual({ ok: true, value: { version: 2 } });
      expect((await momentRows(env, db, uidA)).map((r) => [r.id, r.body, r.version])).toEqual([[mA.id, "A의 조각", 1]]);
      expect((await summaryRows(env, db, uidA)).map((r) => [r.body, r.version])).toEqual([["A의 한 줄", 1]]);
      expect(await momentRows(env, db, uidB)).toEqual([]);
      expect((await summaryRows(env, db, uidB)).map((r) => [r.body, r.version])).toEqual([["B가 고침", 2]]);
    });
  }, CASE_TIMEOUT);

  it("the session decides the owner: B identifiers in headers, cookies or extra arguments are ignored; no session → not_signed_in", async () => {
    const db = await sharedDb();
    const uidA = await seedUser(env, db, [ident()], { granted: true });
    const uidB = await seedUser(env, db, [ident()], { granted: true });
    const cookieA = await seal(uidA, 1);
    const spoof = {
      headers: { "x-user-id": uidB, "x-forwarded-user": uidB, referer: `${BASE}/days?userId=${uidB}` },
      cookies: { userId: uidB, user_id: uidB },
    };
    await withActions(authEnv(db.urls.app), async (a) => {
      newRequest(cookieA, spoof);
      const created = okOf(await (a.createMomentAction as unknown as (...xs: unknown[]) => Promise<ActionResult<{ id: string }>>)("A 세션의 조각", uidB), "spoofed create");
      newRequest(cookieA, spoof);
      expect(await (a.setFontAction as unknown as (...xs: unknown[]) => Promise<unknown>)("serif", uidB)).toEqual({ ok: true, value: "serif" });
      expect((await momentRows(env, db, uidA)).map((r) => r.id)).toEqual([created.id]);
      expect(await momentRows(env, db, uidB), "nothing written for B").toEqual([]);
      expect(await fontOf(db, uidA)).toBe("serif");
      expect(await fontOf(db, uidB), "B font untouched").toBeNull();

      const anon = as(a, undefined, spoof);
      expect(await anon.create("세션 없이"), "no session").toEqual({ ok: false, error: "not_signed_in" });
      expect(await anon.font("hand"), "no session font").toEqual({ ok: false, error: "not_signed_in" });
      expect(await momentRows(env, db, uidB)).toEqual([]);
    });
  }, CASE_TIMEOUT);

  it("Origin mismatch or missing → forbidden and nothing is written, even with a valid session", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    const today = seoulDate(new Date());
    await withActions(authEnv(db.urls.app), async (a) => {
      const mine = okOf(await as(a, cookie).create("원래 조각"), "create");
      for (const origin of [null, "", "null", "https://evil.example", "http://pieceofdays.example"]) {
        const other = as(a, cookie, { origin });
        expect(await other.create("다른 출처"), `create ${origin}`).toEqual({ ok: false, error: "forbidden" });
        expect(await other.update(mine.id, 1, "다른 출처"), `update ${origin}`).toEqual({ ok: false, error: "forbidden" });
        expect(await other.remove(mine.id, 1), `delete ${origin}`).toEqual({ ok: false, error: "forbidden" });
        expect(await other.summary(today, null, "다른 출처"), `summary ${origin}`).toEqual({ ok: false, error: "forbidden" });
        expect(await other.font("hand"), `font ${origin}`).toEqual({ ok: false, error: "forbidden" });
      }
      expect((await momentRows(env, db, uid)).map((r) => [r.body, r.version])).toEqual([["원래 조각", 1]]);
      expect(await summaryRows(env, db, uid)).toEqual([]);
      expect(await fontOf(db, uid)).toBeNull();
    });
  }, CASE_TIMEOUT);

  it("after a withdrawal COMMIT a new POST with the old session is not_signed_in and writes nothing", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    const today = seoulDate(new Date());
    const life = await loadLifecycle();
    const pool = openAppPool(db, 1);
    try {
      await withActions(authEnv(db.urls.app), async (a) => {
        const me = as(a, cookie);
        const m = okOf(await me.create("탈퇴 전 조각"), "before withdrawal");
        expect(await life.withdraw(pool, { userId: uid, gen: 1 })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await lifeState(env, db, uid)).toMatchObject({ status: "pending_deletion", gen: 2 });
        expect(await me.create("탈퇴 뒤"), "create").toEqual({ ok: false, error: "not_signed_in" });
        expect(await me.update(m.id, 1, "탈퇴 뒤"), "update").toEqual({ ok: false, error: "not_signed_in" });
        expect(await me.remove(m.id, 1), "delete").toEqual({ ok: false, error: "not_signed_in" });
        expect(await me.summary(today, null, "탈퇴 뒤"), "summary").toEqual({ ok: false, error: "not_signed_in" });
        expect(await me.font("hand"), "font").toEqual({ ok: false, error: "not_signed_in" });
        const newGen = as(a, await seal(uid, 2));
        expect(await newGen.create("새 gen 세션"), "pending account with the new gen").toEqual({ ok: false, error: "not_signed_in" });
        expect((await momentRows(env, db, uid)).map((r) => [r.body, r.version])).toEqual([["탈퇴 전 조각", 1]]);
        expect(await summaryRows(env, db, uid)).toEqual([]);
        expect(await fontOf(db, uid)).toBeNull();
      });
    } finally {
      await endPool(pool);
    }
  }, CASE_TIMEOUT);

  it("DB failures (closed loopback port, role without privileges, no URL) → unavailable and the stored rows stay as they were", async () => {
    const db = await sharedDb();
    const uid = await seedUser(env, db, [ident()], { granted: true });
    const cookie = await seal(uid, 1);
    const today = seoulDate(new Date());
    const mine = await withActions(authEnv(db.urls.app), async (a) => okOf(await as(a, cookie).create("보존할 조각"), "seed moment"));
    for (const [label, url] of [
      ["closed loopback port", await closedPortUrl()],
      ["purge role (permission denied)", db.urls.purge],
      ["POD_DATABASE_URL blank", ""],
    ] as const) {
      await withActions(authEnv(url), async (a) => {
        const me = as(a, cookie);
        expect(await me.create("실패 중 생성"), `${label}: create`).toEqual({ ok: false, error: "unavailable" });
        expect(await me.update(mine.id, 1, "실패 중 수정"), `${label}: update`).toEqual({ ok: false, error: "unavailable" });
        expect(await me.remove(mine.id, 1), `${label}: delete`).toEqual({ ok: false, error: "unavailable" });
        expect(await me.summary(today, null, "실패 중 한 줄"), `${label}: summary`).toEqual({ ok: false, error: "unavailable" });
        expect(await me.font("hand"), `${label}: font`).toEqual({ ok: false, error: "unavailable" });
      });
    }
    expect((await momentRows(env, db, uid)).map((r) => [r.id, r.body, r.version])).toEqual([[mine.id, "보존할 조각", 1]]);
    expect(await summaryRows(env, db, uid)).toEqual([]);
    expect(await fontOf(db, uid)).toBeNull();
  }, CASE_TIMEOUT);
});
