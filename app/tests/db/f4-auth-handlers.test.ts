// F4 B2 RED — 처리 함수 5개(PLAN_mvp-oidc-integration §6.2·§6.3, §9 D1~D3). 실제 PG18 일회용 DB + 실제 vendor + mock issuer.
//
// 대상: app/src/server/auth/handlers.ts(아직 없음)의 handleStart·handleCallback·handleLogout·handleWithdraw·handleRestore.
// - 각 it 안에서 동적 import한다(없으면 그 it만 정상 RED). 공개 타입은 계획 §6.2를 최소 로컬 타입으로 옮겼다.
// - DB는 기존 하네스(helpers·f2·f3·f4-lifecycle support)의 일회용 PG18 guard·migration·app role Pool을 그대로 쓴다.
//   owner 경로는 시험 데이터 준비와 상태 확인에만 쓰고, handle*에는 app role Pool(또는 실패하는 getDb)만 넘긴다.
// - account/login·lifecycle·iron·openid-client는 mock하지 않는다. 쿠키 값은 실제 codec(readSession·readFlow·readRecovery)으로 읽는다.
// - 사례마다 새 mock issuer 포트를 쓰고 withMockIssuer로 닫는다. 전역 Date.now·process.env는 바꾸지 않는다.
// - seal 실패는 secrets {1: 정상, 2: 31자} 맵으로만 주입한다(iron이 가장 큰 번호로 봉인하다 throw). iron mock 없음.
// - §6.4: 복사한 쿠키+URL 재생을 앱 서버의 state 재사용 거부로 막는다고 보지 않는다(서버 state 저장소 없음, 계획 수락 경계).
//   여기서는 공급자 code 일회성 + F3 멱등(원장 1)과, flow 쿠키 삭제 뒤 재요청의 expired만 확인한다.
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAuthConfig, type AuthConfig, type AuthR, type ProviderId } from "@/server/auth/config";
import { flowCookieOptions, readFlow, sealFlow } from "@/server/auth/flow-cookie";
import { readRecovery, recoveryCookieOptions, sealRecovery } from "@/server/auth/recovery-cookie";
import { readSession, sealSession, sessionCookieOptions, type SessionConfig } from "@/server/auth/session";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, withOwner } from "./f2-support";
import { UUID_RE, endAllPools, endPool, expectLedgerInvariants, freshMigratedDb, openAppPool } from "./f3-support";
import { lifeState, seedUser, setPending, totals, type LifeState, type Totals } from "./f4-lifecycle-support";
import {
  captureConsole,
  closeAllMockIssuers,
  withMockIssuer,
  type MockClient,
  type MockFaults,
  type MockIssuer,
  type MockProviderId,
} from "../support/mock-oidc-issuer";

// ---------------------------------------------------------------- 공개 계약(§6.2 최소 로컬 타입)

const HANDLERS_MODULE = path.join(APP_DIR, "src", "server", "auth", "handlers.ts");
type CookieOptions = { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date };
type CookieEffect = { op: "set"; name: string; value: string; options: CookieOptions } | { op: "delete"; name: string; secure: boolean };
type HandlerResult = { status: 303; location: URL; cookies: CookieEffect[] } | { status: 403 | 404 | 503; cookies: CookieEffect[] };
type GetDb = () => pg.Pool;
type Handlers = {
  handleStart: (auth: AuthR, provider: string, origin: string | null, form: FormData) => Promise<HandlerResult>;
  handleCallback: (auth: AuthR, getDb: GetDb, provider: string, query: URLSearchParams, cookies: { flow?: string }) => Promise<HandlerResult>;
  handleLogout: (auth: AuthR, origin: string | null) => HandlerResult;
  handleWithdraw: (auth: AuthR, getDb: GetDb, origin: string | null, form: FormData, cookies: { session?: string }) => Promise<HandlerResult>;
  handleRestore: (auth: AuthR, getDb: GetDb, origin: string | null, cookies: { recovery?: string }) => Promise<HandlerResult>;
};
const HANDLER_NAMES = ["handleStart", "handleCallback", "handleLogout", "handleWithdraw", "handleRestore"] as const;

async function loadHandlers(): Promise<Handlers> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ HANDLERS_MODULE)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F4 B2 product module src/server/auth/handlers.ts could not be loaded (expected before GREEN): ${msg}`);
  }
  for (const name of HANDLER_NAMES) {
    expect(typeof mod[name], `src/server/auth/handlers.ts must export function ${name}`).toBe("function");
  }
  return mod as unknown as Handlers;
}

// ---------------------------------------------------------------- 파일 공용 DB·정리

const CASE_TIMEOUT = 120_000;
const BASE = "https://pieceofdays.example";
const DEV_BASE = "http://127.0.0.1:3300";
const KEY1 = "ci-only-b2-handler-key-1-".padEnd(40, "x");
const SHORT_KEY2 = "ci-only-b2-short-key-2-".padEnd(31, "y"); // 31자: iron 봉인만 실패
let env: HarnessEnv;
let shared: Promise<DisposableDatabase> | undefined;
let seq = 0;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  await closeAllMockIssuers();
  await endAllPools();
  if (env) await cleanupAll(env);
});

function sharedDb(): Promise<DisposableDatabase> {
  shared ??= freshMigratedDb(env, "f4auth");
  return shared;
}

const subject = (label: string) => `b2-${label}-${++seq}-${Date.now()}`;

/** app role Pool을 빌려 쓰고 반드시 닫는다. */
async function withAppPool<T>(fn: (pool: pg.Pool, db: DisposableDatabase) => Promise<T>, max = 2): Promise<T> {
  const db = await sharedDb();
  const pool = openAppPool(db, max);
  try {
    return await fn(pool, db);
  } finally {
    await endPool(pool);
  }
}

/** 닫힌 loopback 포트를 가리키는 Pool(연결 실패 주입). */
async function closedPortPool(): Promise<pg.Pool> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  const pool = new pg.Pool({ host: "127.0.0.1", port, user: "pod_closed", database: "pod_closed", max: 1, connectionTimeoutMillis: 3_000 });
  pool.on("error", () => undefined);
  return pool;
}

/** 실제 DB 쿼리가 권한 오류로 실패하는 Pool(purge role은 pod 테이블 권한이 없다). */
function purgeRolePool(db: DisposableDatabase): pg.Pool {
  const pool = new pg.Pool({ connectionString: db.urls.purge, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  return pool;
}

async function userIdFor(db: DisposableDatabase, provider: string, sub: string): Promise<string | null> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ id: string }>(
      "SELECT user_id::text AS id FROM pod.auth_identities WHERE provider = $1 AND subject = $2",
      [provider, sub],
    );
    return r.rows[0]?.id ?? null;
  });
}

const stateOf = async (db: DisposableDatabase, uid: string): Promise<LifeState> => {
  const s = await lifeState(env, db, uid);
  expect(s, `user ${uid} exists`).not.toBeNull();
  return s!;
};

// ---------------------------------------------------------------- 설정(실제 loadAuthConfig) · mock

type Ctx = { mock: MockIssuer; auth: AuthConfig; authR: AuthR; clients: MockClient[]; base: string; origin: string };

function clientsFor(base: string): MockClient[] {
  return (["google", "kakao"] as const).map((p) => ({
    provider: p,
    clientId: `ci-only-${p}-client-${++seq}`,
    clientSecret: `ci-only-${p}-secret-${++seq}-${Date.now()}`,
    redirectUri: new URL(`/auth/${p}/callback`, base).href,
  }));
}

function authFor(mock: MockIssuer, clients: MockClient[], base: string, providers: string): AuthConfig {
  const g = clients.find((c) => c.provider === "google")!;
  const k = clients.find((c) => c.provider === "kakao")!;
  const r = loadAuthConfig(
    {
      POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY1 }),
      POD_AUTH_BASE_URL: base,
      POD_AUTH_PROVIDERS: providers,
      POD_AUTH_GOOGLE_CLIENT_ID: g.clientId,
      POD_AUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
      POD_AUTH_KAKAO_CLIENT_ID: k.clientId,
      POD_AUTH_KAKAO_CLIENT_SECRET: k.clientSecret,
      POD_AUTH_MOCK_OIDC_ISSUER: mock.origin,
    },
    "test",
  );
  if (!r.ok) throw new Error(`test auth config was rejected: ${r.error}`);
  return r.value;
}

/** 사례마다 새 mock 포트 + 실제 설정. fn이 끝나면 mock을 닫는다. */
async function withCtx<T>(
  fn: (c: Ctx) => Promise<T>,
  o: { base?: string; providers?: string; faults?: MockFaults } = {},
): Promise<T> {
  const base = o.base ?? BASE;
  const clients = clientsFor(base);
  return withMockIssuer({ clients, faults: o.faults }, async (mock) => {
    const auth = authFor(mock, clients, base, o.providers ?? "google,kakao");
    return fn({ mock, auth, authR: { ok: true, value: auth }, clients, base, origin: new URL(base).origin });
  });
}

/** 같은 설정에 secrets {1: 정상, 2: 31자}: 키 1 봉인값은 읽히고 새 봉인(키 2)은 throw한다. */
function sealFailing(auth: AuthConfig): AuthR {
  const session: SessionConfig = Object.freeze({ ...auth.session, secrets: Object.freeze({ 1: KEY1, 2: SHORT_KEY2 }) });
  return { ok: true, value: Object.freeze({ ...auth, session }) };
}

// ---------------------------------------------------------------- 결과 검사

const names = (cfg: SessionConfig) => ({
  F: flowCookieOptions(cfg, new Date(0)).name,
  S: sessionCookieOptions(cfg, new Date(0)).name,
  R: recoveryCookieOptions(cfg, new Date(0)).name,
});

type SetValues = Partial<Record<"F" | "S" | "R", { value: string; expires: Date }>>;

/**
 * cookies가 spec(예: "F- S+ R-", 빈 문자열 = 변화 없음)과 정확히 같은지 본다(순서 무관, 추가 항목 0).
 * delete는 {op,name,secure}만, set은 {op,name,value,options} 정확히(Domain 등 다른 키 없음).
 */
function expectCookies(r: HandlerResult, cfg: SessionConfig, spec: string, label = ""): SetValues {
  const n = names(cfg);
  const tokens = spec.split(/\s+/).filter(Boolean);
  const want = tokens.map((t) => ({ kind: t[0] as "F" | "S" | "R", op: t[1] === "+" ? "set" : "delete" }));
  const got = r.cookies.map((c) => `${c.op}:${c.name}`).sort();
  expect(got, `cookie effects ${label}`).toEqual(want.map((w) => `${w.op}:${n[w.kind]}`).sort());
  const values: SetValues = {};
  for (const w of want) {
    const c = r.cookies.find((x) => x.name === n[w.kind])!;
    if (w.op === "delete") {
      expect(c, `${label} delete ${w.kind}`).toEqual({ op: "delete", name: n[w.kind], secure: cfg.secureCookies });
    } else {
      expect(Object.keys(c).sort(), `${label} set ${w.kind} keys`).toEqual(["name", "op", "options", "value"]);
      const s = c as Extract<CookieEffect, { op: "set" }>;
      expect(s.value, `${label} set ${w.kind} value`).toMatch(/^Fe26\.2\*/);
      expect(s.options, `${label} set ${w.kind} options (no Domain)`).toEqual({
        httpOnly: true,
        secure: cfg.secureCookies,
        sameSite: "lax",
        path: "/",
        expires: expect.any(Date),
      });
      values[w.kind] = { value: s.value, expires: s.options.expires };
    }
  }
  return values;
}

function expectRedirect(r: HandlerResult, base: string, pathAndQuery: string, label = ""): void {
  expect(r.status, `status ${label}`).toBe(303);
  const loc = (r as { location?: unknown }).location;
  expect(loc, `location is a URL ${label}`).toBeInstanceOf(URL);
  expect((loc as URL).href, `location ${label}`).toBe(new URL(pathAndQuery, base).href);
}

function expectNoLocation(r: HandlerResult, status: 403 | 404 | 503, label = ""): void {
  expect(r.status, `status ${label}`).toBe(status);
  expect(Object.hasOwn(r, "location"), `no location key ${label}`).toBe(false);
}

async function readSessionValue(cfg: SessionConfig, v: SetValues) {
  const r = await readSession(cfg, v.S?.value);
  expect(r, "issued session reads back").toMatchObject({ ok: true });
  if (!r.ok) throw new Error("session unreadable");
  expect(r.value.expiresAt.getTime()).toBe(v.S!.expires.getTime());
  return r.value;
}

async function readRecoveryValue(cfg: SessionConfig, v: SetValues) {
  const r = await readRecovery(cfg, v.R?.value);
  expect(r, "issued recovery proof reads back").toMatchObject({ ok: true });
  if (!r.ok) throw new Error("recovery unreadable");
  expect(r.value.expiresAt.getTime()).toBe(v.R!.expires.getTime());
  return r.value;
}

const form = (fields: Record<string, string | Blob> = {}): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** 사례별 새 spy: 호출되면 throw한다(사전 검증 경로의 DB 0 확인용). */
const noDb = () =>
  vi.fn<GetDb>(() => {
    throw new Error("getDb must not be called on this path");
  });

type Started = { authorizeUrl: URL; flow: string };

/** 실제 handleStart로 flow 쿠키와 authorize URL을 얻는다. */
async function start(h: Handlers, c: Ctx, provider: MockProviderId, returnTo?: string, authR: AuthR = c.authR): Promise<Started> {
  const r = await h.handleStart(authR, provider, c.origin, form(returnTo === undefined ? {} : { returnTo }));
  expect(r.status, `start ${provider}`).toBe(303);
  const v = expectCookies(r, c.auth.session, "F+", `start ${provider}`);
  return { authorizeUrl: (r as { location: URL }).location, flow: v.F!.value };
}

/** start → 공급자 authorize(실제 HTTP) → callback query. */
async function login(h: Handlers, c: Ctx, provider: MockProviderId, sub: string, returnTo?: string) {
  const s = await start(h, c, provider, returnTo);
  const a = await c.mock.authorize(s.authorizeUrl, { subject: sub });
  return { ...s, query: a.query };
}

// ================================================================= 하네스 대조(제품 모듈 없이)

describe("harness controls (no product module)", () => {
  it("failure injections behave as intended: closed port refuses, purge role query is denied, 721h purge_due data keeps the 720h rule, {1, 2:31자} reads key-1 seals but cannot seal", async () => {
    const db = await sharedDb();
    const closed = await closedPortPool();
    const denied = purgeRolePool(db);
    try {
      await expect(closed.query("SELECT 1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      await expect(denied.query("SELECT 1 FROM pod.auth_identities LIMIT 1")).rejects.toMatchObject({ code: "42501" });
      const uid = await seedUser(env, db, [{ provider: "google", subject: subject("ctl") }], { granted: true });
      await setPending(env, db, uid, "clock_timestamp() - interval '721 hours'", 2);
      const st = await stateOf(db, uid);
      expect(st).toMatchObject({ status: "pending_deletion", gen: 2, lifetimeS: 720 * 3600, ledger: 1, balance: 10 });
      expect(st.purgeMs!).toBeLessThan(Date.now());
      await withMockIssuer({ clients: clientsFor(BASE) }, async (mock) => {
        const auth = authFor(mock, clientsFor(BASE), BASE, "google");
        const failing = sealFailing(auth);
        if (!failing.ok) throw new Error("unreachable");
        const flowIn = { provider: "google" as const, issuer: auth.providers.google!.issuer.href, state: "s".repeat(43), nonce: "n".repeat(43), codeVerifier: "v".repeat(43), returnTo: "/" };
        const sealed = (await sealFlow(auth.session, flowIn)).value;
        expect(await readFlow(failing.value.session, sealed)).toMatchObject({ ok: true });
        const rec = (await sealRecovery(auth.session, { userId: uid, gen: 2 })).value;
        expect(await readRecovery(failing.value.session, rec)).toMatchObject({ ok: true, value: { userId: uid, gen: 2 } });
        await expect(sealSession(failing.value.session, { userId: uid, gen: 2 })).rejects.toThrow();
        await expect(sealRecovery(failing.value.session, { userId: uid, gen: 2 })).rejects.toThrow();
      });
    } finally {
      await closed.end().catch(() => undefined);
      await denied.end().catch(() => undefined);
    }
  }, CASE_TIMEOUT);
});

// ================================================================= 공통 첫 단계

describe("all five handlers: auth error first (§6.2)", () => {
  it("auth_not_configured / invalid_config → 503, no cookies, no Location, getDb never called, before any Origin/provider/form check", async () => {
    const h = await loadHandlers();
    for (const error of ["auth_not_configured", "invalid_config"] as const) {
      const authR: AuthR = { ok: false, error };
      const getDb = vi.fn<GetDb>(() => {
        throw new Error("getDb must not be called");
      });
      for (const origin of [BASE, null, "https://evil.example"]) {
        const results: [string, HandlerResult][] = [
          ["start", await h.handleStart(authR, "google", origin, form({ returnTo: "/" }))],
          ["callback", await h.handleCallback(authR, getDb, "google", new URLSearchParams({ code: "c", state: "s" }), { flow: "garbage" })],
          ["logout", h.handleLogout(authR, origin)],
          ["withdraw", await h.handleWithdraw(authR, getDb, origin, form({ confirm: "withdraw" }), { session: "garbage" })],
          ["restore", await h.handleRestore(authR, getDb, origin, { recovery: "garbage" })],
        ];
        for (const [name, r] of results) {
          expectNoLocation(r, 503, `${error} ${name} origin=${origin}`);
          expect(r.cookies, `${error} ${name}`).toEqual([]);
        }
      }
      expect(getDb).not.toHaveBeenCalled();
    }
    // handleLogout은 동기 함수다(§6.2).
    expect(h.handleLogout({ ok: false, error: "auth_not_configured" }, BASE)).not.toBeInstanceOf(Promise);
  }, CASE_TIMEOUT);
});

// ================================================================= Origin (POST 4종)

describe("Origin check on POST handlers (§6.2 second step)", () => {
  it("missing, empty, literal \"null\", mismatched or path-suffixed Origin → 403 with no cookies, no DB access and no provider traffic", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("origin") }], { granted: true, gen: 2 });
        const session = (await sealSession(c.auth.session, { userId: uid, gen: 2 })).value;
        const pendingUid = await seedUser(env, db, [{ provider: "google", subject: subject("origin-p") }], { granted: true, gen: 2 });
        await setPending(env, db, pendingUid, "clock_timestamp()");
        const recovery = (await sealRecovery(c.auth.session, { userId: pendingUid, gen: 2 })).value;
        const before = [await stateOf(db, uid), await stateOf(db, pendingUid), await totals(env, db)];
        const getDb = vi.fn<GetDb>(() => pool);
        for (const origin of [null, "", "null", "https://evil.example", `${BASE}/`, "http://pieceofdays.example", BASE.toUpperCase()]) {
          const label = `origin=${JSON.stringify(origin)}`;
          const rs: [string, HandlerResult][] = [
            ["start", await h.handleStart(c.authR, "google", origin, form({ returnTo: "/" }))],
            ["logout", h.handleLogout(c.authR, origin)],
            ["withdraw", await h.handleWithdraw(c.authR, getDb, origin, form({ confirm: "withdraw" }), { session })],
            ["restore", await h.handleRestore(c.authR, getDb, origin, { recovery })],
          ];
          for (const [name, r] of rs) {
            expectNoLocation(r, 403, `${name} ${label}`);
            expect(r.cookies, `${name} ${label}: S/R kept`).toEqual([]);
          }
        }
        expect(getDb).not.toHaveBeenCalled();
        expect(c.mock.discoveryRequests, "no provider traffic").toEqual([]);
        expect([await stateOf(db, uid), await stateOf(db, pendingUid), await totals(env, db)]).toEqual(before);
      });
    });
  }, CASE_TIMEOUT);
});

// ================================================================= start

describe("handleStart (§6.3 start table)", () => {
  it("provider not enabled (or unknown) → 404 with no cookies; discovery failure → 503 with no cookies", async () => {
    const h = await loadHandlers();
    await withCtx(
      async (c) => {
        for (const p of ["kakao", "naver", "Google", "", "google/../kakao"]) {
          const r = await h.handleStart(c.authR, p, c.origin, form({ returnTo: "/" }));
          expectNoLocation(r, 404, `provider ${JSON.stringify(p)}`);
          expect(r.cookies).toEqual([]);
        }
        expect(c.mock.discoveryRequests).toEqual([]);
      },
      { providers: "google" },
    );
    await withCtx(
      async (c) => {
        const r = await h.handleStart(c.authR, "google", c.origin, form({ returnTo: "/" }));
        expectNoLocation(r, 503, "discovery failure");
        expect(r.cookies).toEqual([]);
        expect(c.mock.discoveryRequests.length).toBeGreaterThan(0);
      },
      { faults: { discovery: "error" } },
    );
  }, CASE_TIMEOUT);

  it("success → 303 to the provider authorize URL with F+ only; returnTo is parseReturnTo(form) ?? \"/\"; secure and dev cookie names", async () => {
    const h = await loadHandlers();
    const cases: [string | Blob | undefined, string][] = [
      ["/days/2026-11-03", "/days/2026-11-03"],
      ["/settings", "/settings"],
      ["/", "/"],
      [undefined, "/"],
      ["//evil.example", "/"],
      ["https://evil.example/", "/"],
      ["/login", "/"],
      ["/auth/google/callback", "/"],
      ["/days/2026-02-30", "/"],
      ["/days?x=1", "/"],
      [new Blob(["/days"]), "/"],
    ];
    for (const base of [BASE, DEV_BASE]) {
      await withCtx(
        async (c) => {
          for (const provider of ["google", "kakao"] as const) {
            for (const [raw, want] of cases) {
              const r = await h.handleStart(c.authR, provider, c.origin, form(raw === undefined ? {} : { returnTo: raw }));
              expect(r.status).toBe(303);
              const loc = (r as { location: URL }).location;
              expect(loc).toBeInstanceOf(URL);
              expect(loc.origin + loc.pathname, `${provider} authorize endpoint`).toBe(c.mock.endpoint(provider, "authorize"));
              const v = expectCookies(r, c.auth.session, "F+", `${base} ${provider} ${String(raw)}`);
              const flow = await readFlow(c.auth.session, v.F!.value);
              expect(flow).toMatchObject({
                ok: true,
                value: { provider, issuer: c.auth.providers[provider as ProviderId]!.issuer.href, returnTo: want, state: loc.searchParams.get("state") },
              });
              if (flow.ok) expect(v.F!.expires.getTime()).toBe(flow.value.expiresAt.getTime());
            }
          }
          expect(names(c.auth.session).F).toBe(base === BASE ? "__Host-pod_oauth" : "pod_oauth");
        },
        { base },
      );
    }
  }, CASE_TIMEOUT);
});

// ================================================================= logout

describe("handleLogout (§6.3 logout table)", () => {
  it("success (with or without a session) → 303 /login?notice=signed_out with S− R−; secure and dev names", async () => {
    const h = await loadHandlers();
    for (const base of [BASE, DEV_BASE]) {
      await withCtx(
        async (c) => {
          const r = h.handleLogout(c.authR, c.origin);
          expectRedirect(r, base, "/login?notice=signed_out", base);
          expectCookies(r, c.auth.session, "S- R-", `logout ${base}`);
          expect(names(c.auth.session).S).toBe(base === BASE ? "__Host-pod_session" : "pod_session");
        },
        { base },
      );
    }
  }, CASE_TIMEOUT);
});

// ================================================================= callback

describe("handleCallback before fresh OAuth verification (§6.3 callback ②~⑤): F− only, S·R untouched, DB 0", () => {
  it("② provider not enabled → 404 with F− only", async () => {
    const h = await loadHandlers();
    const unreachableDb = noDb();
    await withCtx(
      async (c) => {
        const s = await start(h, c, "google");
        const a = await c.mock.authorize(s.authorizeUrl);
        for (const p of ["kakao", "naver", ""]) {
          const r = await h.handleCallback(c.authR, unreachableDb, p, a.query, { flow: s.flow });
          expectNoLocation(r, 404, `callback ${JSON.stringify(p)}`);
          expectCookies(r, c.auth.session, "F-", `callback ${p}`);
        }
        expect(unreachableDb).not.toHaveBeenCalled();
        expect(c.mock.tokenRequests).toEqual([]);
      },
      { providers: "google" },
    );
  }, CASE_TIMEOUT);

  it("③ missing / empty / garbage / tampered / other-purpose / other-key / expired flow → 303 /login?error=expired with F− only", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const s = await start(h, c, "google");
        const a = await c.mock.authorize(s.authorizeUrl);
        const cfg = c.auth.session;
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("flowbad") }], { granted: true });
        const sessionValue = (await sealSession(cfg, { userId: uid, gen: 1 })).value;
        const recoveryValue = (await sealRecovery(cfg, { userId: uid, gen: 1 })).value;
        const otherKeyCfg: SessionConfig = Object.freeze({ ...cfg, secrets: Object.freeze({ 1: "ci-only-b2-other-key-1-".padEnd(40, "z") }) });
        const real = await readFlow(cfg, s.flow);
        if (!real.ok) throw new Error("flow unreadable");
        const { expiresAt: _e, ...flowInput } = real.value;
        void _e;
        const otherKey = (await sealFlow(otherKeyCfg, flowInput)).value;
        const expired = (await sealFlow(Object.freeze({ ...cfg, now: () => new Date(Date.now() - 700_000) }), flowInput)).value;
        const mid = Math.floor(s.flow.length / 2);
        const tampered = s.flow.slice(0, mid) + (s.flow[mid] === "a" ? "b" : "a") + s.flow.slice(mid + 1);
        const before = await totals(env, db);
        const getDb = vi.fn<GetDb>(() => pool);
        for (const [label, flow] of [
          ["missing", undefined],
          ["empty", ""],
          ["garbage", "not-a-seal"],
          ["tampered", tampered],
          ["session value", sessionValue],
          ["recovery value", recoveryValue],
          ["other key", otherKey],
          ["expired", expired],
        ] as const) {
          const r = await h.handleCallback(c.authR, getDb, "google", a.query, flow === undefined ? {} : { flow });
          expectRedirect(r, c.base, "/login?error=expired", label);
          expectCookies(r, cfg, "F-", label);
        }
        expect(getDb).not.toHaveBeenCalled();
        expect(c.mock.tokenRequests, "no code exchange").toEqual([]);
        expect(await totals(env, db)).toEqual(before);
      });
    });
  }, CASE_TIMEOUT);

  it("④ flow bound to another provider path or another configured issuer → 303 /login?error=failed with F− only and no exchange", async () => {
    const h = await loadHandlers();
    const unreachableDb = noDb();
    await withCtx(async (c) => {
      // kakao로 시작한 flow를 google callback 경로로
      const k = await start(h, c, "kakao");
      const ka = await c.mock.authorize(k.authorizeUrl);
      const r1 = await h.handleCallback(c.authR, unreachableDb, "google", ka.query, { flow: k.flow });
      expectRedirect(r1, c.base, "/login?error=failed", "kakao flow on google path");
      expectCookies(r1, c.auth.session, "F-", "kakao flow on google path");
      // 실제 Google issuer href로 봉인된 flow를 mock 설정 callback에
      const g = await start(h, c, "google");
      const real = await readFlow(c.auth.session, g.flow);
      if (!real.ok) throw new Error("flow unreadable");
      const { expiresAt: _e, ...fi } = real.value;
      void _e;
      const foreign = (await sealFlow(c.auth.session, { ...fi, issuer: "https://accounts.google.com/" })).value;
      const ga = await c.mock.authorize(g.authorizeUrl);
      const r2 = await h.handleCallback(c.authR, unreachableDb, "google", ga.query, { flow: foreign });
      expectRedirect(r2, c.base, "/login?error=failed", "foreign issuer");
      expectCookies(r2, c.auth.session, "F-", "foreign issuer");
      expect(c.mock.tokenRequests).toEqual([]);
      // mock issuer A로 봉인 → 설정 B(다른 mock issuer)의 callback
      await withCtx(async (cB) => {
        const r3 = await h.handleCallback(cB.authR, unreachableDb, "google", ga.query, { flow: g.flow });
        expectRedirect(r3, cB.base, "/login?error=failed", "issuer A flow on config B");
        expectCookies(r3, cB.auth.session, "F-", "issuer A flow on config B");
        expect(cB.mock.tokenRequests).toEqual([]);
      });
      expect(c.mock.tokenRequests).toEqual([]);
    });
    expect(unreachableDb).not.toHaveBeenCalled();
  }, CASE_TIMEOUT);

  it("⑤ discovery failure → 503 F−; access_denied → 303 cancelled F−; vendor rejection (forged signature, tampered state) → 303 failed F−; DB 0", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      const before = await totals(env, db);
      const getDb = vi.fn<GetDb>(() => pool);
      // discovery 실패: 성공한 적 없는 mock issuer + 형식상 정상 flow
      await withCtx(
        async (c) => {
          const flow = (
            await sealFlow(c.auth.session, {
              provider: "google",
              issuer: c.auth.providers.google!.issuer.href,
              state: "s".repeat(43),
              nonce: "n".repeat(43),
              codeVerifier: "v".repeat(43),
              returnTo: "/",
            })
          ).value;
          const q = new URLSearchParams({ code: "unused", state: "s".repeat(43), iss: c.auth.providers.google!.issuer.href });
          const r = await h.handleCallback(c.authR, getDb, "google", q, { flow });
          expectNoLocation(r, 503, "discovery failure");
          expectCookies(r, c.auth.session, "F-", "discovery failure");
        },
        { faults: { discovery: "error" } },
      );
      // 취소
      await withCtx(async (c) => {
        for (const provider of ["google", "kakao"] as const) {
          const s = await start(h, c, provider);
          const a = await c.mock.authorize(s.authorizeUrl, { deny: true });
          const r = await h.handleCallback(c.authR, getDb, provider, a.query, { flow: s.flow });
          expectRedirect(r, c.base, "/login?error=cancelled", `${provider} cancel`);
          expectCookies(r, c.auth.session, "F-", `${provider} cancel`);
        }
        expect(c.mock.tokenRequests).toEqual([]);
      });
      // 위조 서명
      await withCtx(
        async (c) => {
          const s = await start(h, c, "google");
          const a = await c.mock.authorize(s.authorizeUrl, { subject: subject("forged") });
          const r = await h.handleCallback(c.authR, getDb, "google", a.query, { flow: s.flow });
          expectRedirect(r, c.base, "/login?error=failed", "forged signature");
          expectCookies(r, c.auth.session, "F-", "forged signature");
          expect(c.mock.tokenRequests.map((t) => t.outcome)).toEqual(["ok"]);
        },
        { faults: { idToken: "wrong_key" } },
      );
      // state 변조
      await withCtx(async (c) => {
        const s = await start(h, c, "google");
        const a = await c.mock.authorize(s.authorizeUrl);
        const q = new URLSearchParams(a.query);
        const st = q.get("state")!;
        q.set("state", (st[0] === "A" ? "B" : "A") + st.slice(1));
        const r = await h.handleCallback(c.authR, getDb, "google", q, { flow: s.flow });
        expectRedirect(r, c.base, "/login?error=failed", "tampered state");
        expectCookies(r, c.auth.session, "F-", "tampered state");
        expect(c.mock.tokenRequests).toEqual([]);
      });
      expect(getDb).not.toHaveBeenCalled();
      expect(await totals(env, db)).toEqual(before);
    });
  }, CASE_TIMEOUT);
});

describe("handleCallback after verification (§6.3 callback ⑥~⑧)", () => {
  it("⑥ DB failure (getDb throws, closed loopback Pool, real query failure) → 503 with F− only and no account writes", async () => {
    const h = await loadHandlers();
    const db = await sharedDb();
    const closed = await closedPortPool();
    const denied = purgeRolePool(db);
    try {
      const before = await totals(env, db);
      const variants: [string, GetDb][] = [
        [
          "getDb throws",
          () => {
            throw new Error("POD_DATABASE_URL is not set");
          },
        ],
        ["closed loopback pool", () => closed],
        ["query permission failure", () => denied],
      ];
      for (const [label, getDb] of variants) {
        await withCtx(async (c) => {
          const sub = subject("dbfail");
          const l = await login(h, c, "google", sub);
          const r = await h.handleCallback(c.authR, getDb, "google", l.query, { flow: l.flow });
          expectNoLocation(r, 503, label);
          expectCookies(r, c.auth.session, "F-", label);
          expect(c.mock.tokenRequests.map((t) => t.outcome), `${label}: OAuth was verified first`).toEqual(["ok"]);
          expect(await userIdFor(db, "google", sub)).toBeNull();
        });
      }
      expect(await totals(env, db)).toEqual(before);
    } finally {
      await closed.end().catch(() => undefined);
      await denied.end().catch(() => undefined);
    }
  }, CASE_TIMEOUT);

  it("⑦ invalid_identity (empty or over-long vendor sub with a valid signature) → 303 failed with F− only and DB unchanged", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      const before = await totals(env, db);
      for (const sub of ["", "s".repeat(256)]) {
        await withCtx(async (c) => {
          const l = await login(h, c, "google", sub);
          const r = await h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow });
          expectRedirect(r, c.base, "/login?error=failed", `sub length ${sub.length}`);
          expectCookies(r, c.auth.session, "F-", `sub length ${sub.length}`);
          expect(c.mock.tokenRequests.map((t) => t.outcome)).toEqual(["ok"]);
        });
      }
      expect(await totals(env, db)).toEqual(before);
    });
  }, CASE_TIMEOUT);

  it("⑧ active: new account → 303 returnTo with F− S+ R−, first grant 10 / ledger 1 / gen 1; re-login → same user, ledger unchanged (google secure, kakao dev names)", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      for (const [provider, base] of [
        ["google", BASE],
        ["kakao", DEV_BASE],
      ] as const) {
        await withCtx(
          async (c) => {
            const sub = subject(`active-${provider}`);
            const getDb = vi.fn<GetDb>(() => pool);
            const before = await totals(env, db);
            const l = await login(h, c, provider, sub, "/days/2026-11-03");
            const r = await h.handleCallback(c.authR, getDb, provider, l.query, { flow: l.flow });
            expectRedirect(r, base, "/days/2026-11-03", `${provider} new`);
            const v = expectCookies(r, c.auth.session, "F- S+ R-", `${provider} new`);
            const sess = await readSessionValue(c.auth.session, v);
            expect(sess.userId).toMatch(UUID_RE);
            expect(sess.gen).toBe(1);
            expect(await userIdFor(db, provider, sub)).toBe(sess.userId);
            const st = await stateOf(db, sess.userId);
            expect(st).toMatchObject({ status: "active", gen: 1, balance: 10, ledger: 1, identities: 1, requestedMs: null, purgeMs: null });
            expect(st.firstLoginAt).not.toBeNull();
            expect(await totals(env, db)).toEqual({
              users: before.users + 1,
              identities: before.identities + 1,
              accounts: before.accounts + 1,
              ledger: before.ledger + 1,
            } satisfies Totals);
            // 재로그인(새 flow·새 code, 같은 subject)
            const l2 = await login(h, c, provider, sub);
            const r2 = await h.handleCallback(c.authR, getDb, provider, l2.query, { flow: l2.flow });
            expectRedirect(r2, base, "/", `${provider} relogin`);
            const v2 = expectCookies(r2, c.auth.session, "F- S+ R-", `${provider} relogin`);
            const sess2 = await readSessionValue(c.auth.session, v2);
            expect(sess2).toMatchObject({ userId: sess.userId, gen: 1 });
            expect(await stateOf(db, sess.userId)).toEqual(st);
            expect(names(c.auth.session).S).toBe(base === BASE ? "__Host-pod_session" : "pod_session");
          },
          { base },
        );
      }
      await expectLedgerInvariants(env, db);
    });
  }, CASE_TIMEOUT);

  it("⑧ active + sealSession throw → 503 F− S− R−; COMMIT stays (ledger 1) and a later login returns the same user without a second grant", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const sub = subject("active-sealfail");
        const l = await login(h, c, "google", sub); // flow는 키 1로 봉인
        const r = await h.handleCallback(sealFailing(c.auth), () => pool, "google", l.query, { flow: l.flow });
        expectNoLocation(r, 503, "active seal failure");
        expectCookies(r, c.auth.session, "F- S- R-", "active seal failure");
        const uid = await userIdFor(db, "google", sub);
        expect(uid, "account committed before sealing").not.toBeNull();
        const st = await stateOf(db, uid!);
        expect(st).toMatchObject({ status: "active", gen: 1, balance: 10, ledger: 1 });
        const l2 = await login(h, c, "google", sub);
        const r2 = await h.handleCallback(c.authR, () => pool, "google", l2.query, { flow: l2.flow });
        expectRedirect(r2, c.base, "/", "relogin after seal failure");
        const v2 = expectCookies(r2, c.auth.session, "F- S+ R-", "relogin after seal failure");
        expect(await readSessionValue(c.auth.session, v2)).toMatchObject({ userId: uid, gen: 1 });
        expect(await stateOf(db, uid!), "granted=false: no second ledger row").toEqual(st);
      });
    });
  }, CASE_TIMEOUT);

  it("⑧ pending_deletion → 303 /account/restore with F− S− R+ (proof = locked userId·gen); seal failure → 503 F− S− R−; no writes either way", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const sub = subject("pending");
        const uid = await seedUser(env, db, [{ provider: "google", subject: sub }], { granted: true });
        await setPending(env, db, uid, "clock_timestamp()", 2);
        const baseline = await stateOf(db, uid);
        const before = await totals(env, db);
        const l = await login(h, c, "google", sub);
        const r = await h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow });
        expectRedirect(r, c.base, "/account/restore", "pending");
        const v = expectCookies(r, c.auth.session, "F- S- R+", "pending");
        expect(await readRecoveryValue(c.auth.session, v)).toMatchObject({ userId: uid, gen: 2 });
        expect(await readSession(c.auth.session, v.R!.value), "recovery proof is not a session").toEqual({ ok: false, error: "invalid" });
        expect(await stateOf(db, uid)).toEqual(baseline);
        // seal 실패
        const l2 = await login(h, c, "google", sub);
        const r2 = await h.handleCallback(sealFailing(c.auth), () => pool, "google", l2.query, { flow: l2.flow });
        expectNoLocation(r2, 503, "pending seal failure");
        expectCookies(r2, c.auth.session, "F- S- R-", "pending seal failure");
        expect(await stateOf(db, uid)).toEqual(baseline);
        expect(await totals(env, db)).toEqual(before);
      });
    });
  }, CASE_TIMEOUT);

  it("⑧ purge_due → 303 /login?error=purge_due with F− S− R−; no retry, no grant, no new account", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const sub = subject("purgedue");
        const uid = await seedUser(env, db, [{ provider: "kakao", subject: sub }], { granted: true });
        // deletion_requested_at을 과거로: purge_after = requested + 720h(L1 제약 유지)도 과거가 된다.
        await setPending(env, db, uid, "clock_timestamp() - interval '721 hours'", 2);
        const baseline = await stateOf(db, uid);
        const before = await totals(env, db);
        const l = await login(h, c, "kakao", sub);
        const r = await h.handleCallback(c.authR, () => pool, "kakao", l.query, { flow: l.flow });
        expectRedirect(r, c.base, "/login?error=purge_due", "purge_due");
        expectCookies(r, c.auth.session, "F- S- R-", "purge_due");
        expect(await stateOf(db, uid)).toEqual(baseline);
        expect(await totals(env, db)).toEqual(before);
        expect(c.mock.tokenRequests.map((t) => t.outcome), "one exchange, no retry").toEqual(["ok"]);
      });
    });
  }, CASE_TIMEOUT);
});

describe("callback replay and concurrency (§6.4)", () => {
  it("same code twice concurrently: one-time provider code → exactly one S+ and ledger 1; reuse-allowed provider → both succeed for the same user, ledger 1", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const sub = subject("race-once");
        const before = await totals(env, db);
        const l = await login(h, c, "google", sub);
        const rs = await Promise.all([0, 1].map(() => h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow })));
        const withSession = rs.filter((r) => r.cookies.some((x) => x.op === "set"));
        expect(withSession, "exactly one session issued").toHaveLength(1);
        const loser = rs.find((r) => !r.cookies.some((x) => x.op === "set"))!;
        expectRedirect(loser, c.base, "/login?error=failed", "losing callback");
        expectCookies(loser, c.auth.session, "F-", "losing callback");
        expect(c.mock.tokenRequests.map((t) => t.outcome).sort()).toEqual(["code_reused", "ok"]);
        const uid = await userIdFor(db, "google", sub);
        expect(await stateOf(db, uid!)).toMatchObject({ ledger: 1, balance: 10 });
        expect((await totals(env, db)).ledger).toBe(before.ledger + 1);
      });
      await withCtx(
        async (c) => {
          const sub = subject("race-reuse");
          const before = await totals(env, db);
          const l = await login(h, c, "google", sub);
          const rs = await Promise.all([0, 1].map(() => h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow })));
          const users = new Set<string>();
          for (const r of rs) {
            expectRedirect(r, c.base, "/", "reuse-allowed callback");
            const v = expectCookies(r, c.auth.session, "F- S+ R-", "reuse-allowed callback");
            users.add((await readSessionValue(c.auth.session, v)).userId);
          }
          expect(users.size, "same canonical user").toBe(1);
          const [uid] = [...users];
          expect(await stateOf(db, uid!)).toMatchObject({ ledger: 1, balance: 10, identities: 1 });
          const after = await totals(env, db);
          expect(after).toEqual({ users: before.users + 1, identities: before.identities + 1, accounts: before.accounts + 1, ledger: before.ledger + 1 });
        },
        { faults: { allowCodeReuse: true } },
      );
      await expectLedgerInvariants(env, db);
    });
  }, CASE_TIMEOUT);

  it("after a successful callback the browser has no flow cookie: repeating the same URL → expired with F− and no DB access or exchange", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const l = await login(h, c, "google", subject("replay"));
        const ok = await h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow });
        expect(ok.status).toBe(303);
        const before = await totals(env, db);
        const exchanges = c.mock.tokenRequests.length;
        const getDb = vi.fn<GetDb>(() => pool);
        const r = await h.handleCallback(c.authR, getDb, "google", l.query, {});
        expectRedirect(r, c.base, "/login?error=expired", "replay without flow");
        expectCookies(r, c.auth.session, "F-", "replay without flow");
        expect(getDb).not.toHaveBeenCalled();
        expect(c.mock.tokenRequests).toHaveLength(exchanges);
        expect(await totals(env, db)).toEqual(before);
      });
    });
  }, CASE_TIMEOUT);

  it("callback logs carry no code, state, token, subject, client secret or raw vendor error text", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool) => {
      const leaked: string[] = [];
      for (const faults of [{}, { idToken: "wrong_key" }, { token: "server_error" }] as MockFaults[]) {
        await withCtx(
          async (c) => {
            const cap = captureConsole();
            const markers: string[] = [];
            try {
              const sub = subject("logs");
              markers.push(sub);
              const l = await login(h, c, "google", sub);
              markers.push(l.flow, l.query.get("code") ?? "", l.query.get("state") ?? "");
              await h.handleCallback(c.authR, () => pool, "google", l.query, { flow: l.flow });
              const l2 = await login(h, c, "google", sub);
              markers.push(l2.flow, l2.query.get("code") ?? "", l2.query.get("state") ?? "");
              await h.handleCallback(
                c.authR,
                () => {
                  throw new Error("POD_DATABASE_URL is not set");
                },
                "google",
                l2.query,
                { flow: l2.flow },
              );
            } finally {
              cap.restore();
            }
            const text = cap.text();
            for (const m of [...markers, ...c.mock.secrets()]) {
              if (m.length >= 8 && text.includes(m)) leaked.push(`${JSON.stringify(faults)}:${m.slice(0, 6)}…`);
            }
          },
          { faults },
        );
      }
      expect(leaked).toEqual([]);
    });
  }, CASE_TIMEOUT);
});

// ================================================================= withdraw

describe("handleWithdraw (§6.3 withdraw table)", () => {
  it("confirm not exactly \"withdraw\" → 303 /account/withdraw, no cookies, no DB (checked before the session)", async () => {
    const h = await loadHandlers();
    const unreachableDb = noDb();
    await withAppPool(async (_pool, db) => {
      await withCtx(async (c) => {
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("confirm") }], { granted: true });
        const session = (await sealSession(c.auth.session, { userId: uid, gen: 1 })).value;
        const baseline = await stateOf(db, uid);
        for (const [label, f, s] of [
          ["missing", form(), session],
          ["Withdraw", form({ confirm: "Withdraw" }), session],
          ["trailing space", form({ confirm: "withdraw " }), session],
          ["yes", form({ confirm: "yes" }), session],
          ["file", form({ confirm: new Blob(["withdraw"]) }), session],
          ["missing + invalid session", form(), "garbage"],
        ] as const) {
          const r = await h.handleWithdraw(c.authR, unreachableDb, c.origin, f, { session: s });
          expectRedirect(r, c.base, "/account/withdraw", label);
          expect(r.cookies, label).toEqual([]);
        }
        expect(unreachableDb).not.toHaveBeenCalled();
        expect(await stateOf(db, uid)).toEqual(baseline);
      });
    });
  }, CASE_TIMEOUT);

  it("session not ok (missing, garbage, recovery value, expired) → 303 /login with S− and no DB", async () => {
    const h = await loadHandlers();
    const unreachableDb = noDb();
    await withAppPool(async (_pool, db) => {
      await withCtx(async (c) => {
        const cfg = c.auth.session;
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("nosess") }], { granted: true });
        const recovery = (await sealRecovery(cfg, { userId: uid, gen: 1 })).value;
        const expired = (await sealSession(Object.freeze({ ...cfg, now: () => new Date(Date.now() - 8 * 86_400_000) }), { userId: uid, gen: 1 })).value;
        const baseline = await stateOf(db, uid);
        for (const [label, session] of [
          ["missing", undefined],
          ["garbage", "garbage"],
          ["recovery value", recovery],
          ["expired", expired],
        ] as const) {
          const r = await h.handleWithdraw(c.authR, unreachableDb, c.origin, form({ confirm: "withdraw" }), session === undefined ? {} : { session });
          expectRedirect(r, c.base, "/login", label);
          expectCookies(r, cfg, "S-", label);
        }
        expect(unreachableDb).not.toHaveBeenCalled();
        expect(await stateOf(db, uid)).toEqual(baseline);
      });
    });
  }, CASE_TIMEOUT);

  it("DB failure (getDb throws, closed loopback Pool) → 503 with the session kept and DB unchanged", async () => {
    const h = await loadHandlers();
    const db = await sharedDb();
    const closed = await closedPortPool();
    try {
      await withCtx(async (c) => {
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("wdbfail") }], { granted: true });
        const session = (await sealSession(c.auth.session, { userId: uid, gen: 1 })).value;
        const baseline = await stateOf(db, uid);
        const variants: [string, GetDb][] = [
          [
            "getDb throws",
            () => {
              throw new Error("POD_DATABASE_URL is not set");
            },
          ],
          ["closed loopback pool", () => closed],
        ];
        for (const [label, getDb] of variants) {
          const r = await h.handleWithdraw(c.authR, getDb, c.origin, form({ confirm: "withdraw" }), { session });
          expectNoLocation(r, 503, label);
          expect(r.cookies, `${label}: S kept for retry`).toEqual([]);
        }
        expect(await stateOf(db, uid)).toEqual(baseline);
      });
    } finally {
      await closed.end().catch(() => undefined);
    }
  }, CASE_TIMEOUT);

  it("success → 303 /login?notice=withdrawn S− (pending, gen+1, 720h); duplicate → same response, DB unchanged; stale / not_found → signed_out S−", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const cfg = c.auth.session;
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("withdraw") }], { granted: true });
        const before = await stateOf(db, uid);
        const session = (await sealSession(cfg, { userId: uid, gen: 1 })).value;
        const r = await h.handleWithdraw(c.authR, () => pool, c.origin, form({ confirm: "withdraw" }), { session });
        expectRedirect(r, c.base, "/login?notice=withdrawn", "first withdraw");
        expectCookies(r, cfg, "S-", "first withdraw");
        const after = await stateOf(db, uid);
        expect(after).toMatchObject({ status: "pending_deletion", gen: 2, lifetimeS: 720 * 3600, balance: before.balance, ledger: before.ledger });
        expect(after.firstLoginAt).toBe(before.firstLoginAt);
        // 중복(같은 옛 세션 재전송)
        const r2 = await h.handleWithdraw(c.authR, () => pool, c.origin, form({ confirm: "withdraw" }), { session });
        expectRedirect(r2, c.base, "/login?notice=withdrawn", "duplicate withdraw");
        expectCookies(r2, cfg, "S-", "duplicate withdraw");
        expect(await stateOf(db, uid)).toEqual(after);
        // stale: active gen 3 사용자의 gen 2 세션
        const staleUid = await seedUser(env, db, [{ provider: "kakao", subject: subject("stale") }], { granted: true, gen: 3 });
        const staleBefore = await stateOf(db, staleUid);
        const stale = (await sealSession(cfg, { userId: staleUid, gen: 2 })).value;
        const r3 = await h.handleWithdraw(c.authR, () => pool, c.origin, form({ confirm: "withdraw" }), { session: stale });
        expectRedirect(r3, c.base, "/login?notice=signed_out", "stale session");
        expectCookies(r3, cfg, "S-", "stale session");
        expect(await stateOf(db, staleUid)).toEqual(staleBefore);
        // not_found
        const missing = (await sealSession(cfg, { userId: randomUUID(), gen: 1 })).value;
        const t0 = await totals(env, db);
        const r4 = await h.handleWithdraw(c.authR, () => pool, c.origin, form({ confirm: "withdraw" }), { session: missing });
        expectRedirect(r4, c.base, "/login?notice=signed_out", "not_found");
        expectCookies(r4, cfg, "S-", "not_found");
        expect(await totals(env, db)).toEqual(t0);
      });
    });
  }, CASE_TIMEOUT);
});

// ================================================================= restore

describe("handleRestore (§6.3 restore table)", () => {
  it("proof not ok (missing, garbage, a session value, expired proof) → 303 /login?error=expired with R− and no DB", async () => {
    const h = await loadHandlers();
    const unreachableDb = noDb();
    await withAppPool(async (_pool, db) => {
      await withCtx(async (c) => {
        const cfg = c.auth.session;
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("badproof") }], { granted: true });
        await setPending(env, db, uid, "clock_timestamp()", 2);
        const baseline = await stateOf(db, uid);
        const session = (await sealSession(cfg, { userId: uid, gen: 2 })).value;
        const expired = (await sealRecovery(Object.freeze({ ...cfg, now: () => new Date(Date.now() - 700_000) }), { userId: uid, gen: 2 })).value;
        for (const [label, recovery] of [
          ["missing", undefined],
          ["garbage", "garbage"],
          ["session value", session],
          ["expired proof", expired],
        ] as const) {
          const r = await h.handleRestore(c.authR, unreachableDb, c.origin, recovery === undefined ? {} : { recovery });
          expectRedirect(r, c.base, "/login?error=expired", label);
          expectCookies(r, cfg, "R-", label);
        }
        expect(unreachableDb).not.toHaveBeenCalled();
        expect(await stateOf(db, uid)).toEqual(baseline);
      });
    });
  }, CASE_TIMEOUT);

  it("DB failure (getDb throws, closed loopback Pool) → 503 with R− and no session; DB unchanged", async () => {
    const h = await loadHandlers();
    const db = await sharedDb();
    const closed = await closedPortPool();
    try {
      await withCtx(async (c) => {
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("rdbfail") }], { granted: true });
        await setPending(env, db, uid, "clock_timestamp()", 2);
        const baseline = await stateOf(db, uid);
        const recovery = (await sealRecovery(c.auth.session, { userId: uid, gen: 2 })).value;
        const variants: [string, GetDb][] = [
          [
            "getDb throws",
            () => {
              throw new Error("POD_DATABASE_URL is not set");
            },
          ],
          ["closed loopback pool", () => closed],
        ];
        for (const [label, getDb] of variants) {
          const r = await h.handleRestore(c.authR, getDb, c.origin, { recovery });
          expectNoLocation(r, 503, label);
          expectCookies(r, c.auth.session, "R-", label);
        }
        expect(await stateOf(db, uid)).toEqual(baseline);
      });
    } finally {
      await closed.end().catch(() => undefined);
    }
  }, CASE_TIMEOUT);

  it("success → 303 / with R− S+ (active, gen+1, balance/ledger unchanged); success then seal failure → 503 R− S− with the COMMIT kept", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const cfg = c.auth.session;
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("restore") }], { granted: true });
        await setPending(env, db, uid, "clock_timestamp()", 2);
        const before = await stateOf(db, uid);
        const recovery = (await sealRecovery(cfg, { userId: uid, gen: 2 })).value;
        const r = await h.handleRestore(c.authR, () => pool, c.origin, { recovery });
        expectRedirect(r, c.base, "/", "restore");
        const v = expectCookies(r, cfg, "R- S+", "restore");
        expect(await readSessionValue(cfg, v)).toMatchObject({ userId: uid, gen: 3 });
        expect(await stateOf(db, uid)).toEqual({ ...before, status: "active", gen: 3, requestedMs: null, purgeMs: null, lifetimeS: null });
        // seal 실패(키 1로 봉인한 proof는 읽히고 새 세션 봉인만 실패)
        const uid2 = await seedUser(env, db, [{ provider: "kakao", subject: subject("restore-sealfail") }], { granted: true });
        await setPending(env, db, uid2, "clock_timestamp()", 2);
        const before2 = await stateOf(db, uid2);
        const recovery2 = (await sealRecovery(cfg, { userId: uid2, gen: 2 })).value;
        const r2 = await h.handleRestore(sealFailing(c.auth), () => pool, c.origin, { recovery: recovery2 });
        expectNoLocation(r2, 503, "restore seal failure");
        expectCookies(r2, cfg, "R- S-", "restore seal failure");
        expect(await stateOf(db, uid2)).toEqual({ ...before2, status: "active", gen: 3, requestedMs: null, purgeMs: null, lifetimeS: null });
      });
      await expectLedgerInvariants(env, db);
    });
  }, CASE_TIMEOUT);

  it("old proof after restore → re-withdraw is stale (expired); past purge deadline → purge_due; not_pending → /login without a session; unknown user → expired", async () => {
    const h = await loadHandlers();
    await withAppPool(async (pool, db) => {
      await withCtx(async (c) => {
        const cfg = c.auth.session;
        // stale_proof: 복구(gen 3) → 재탈퇴(gen 4) 뒤 옛 proof(gen 2)
        const uid = await seedUser(env, db, [{ provider: "google", subject: subject("stale-proof") }], { granted: true });
        await setPending(env, db, uid, "clock_timestamp()", 2);
        const oldProof = (await sealRecovery(cfg, { userId: uid, gen: 2 })).value;
        const restored = await h.handleRestore(c.authR, () => pool, c.origin, { recovery: oldProof });
        const sv = expectCookies(restored, cfg, "R- S+", "first restore");
        const s3 = await readSessionValue(cfg, sv);
        const w = await h.handleWithdraw(c.authR, () => pool, c.origin, form({ confirm: "withdraw" }), { session: sv.S!.value });
        expectRedirect(w, c.base, "/login?notice=withdrawn", "re-withdraw");
        expect(s3.gen).toBe(3);
        const pendingAgain = await stateOf(db, uid);
        expect(pendingAgain).toMatchObject({ status: "pending_deletion", gen: 4 });
        const r1 = await h.handleRestore(c.authR, () => pool, c.origin, { recovery: oldProof });
        expectRedirect(r1, c.base, "/login?error=expired", "stale proof");
        expectCookies(r1, cfg, "R-", "stale proof");
        expect(await stateOf(db, uid)).toEqual(pendingAgain);
        // expired: requested_at을 과거로(purge_after = requested + 720h 제약 유지)
        const uidE = await seedUser(env, db, [{ provider: "google", subject: subject("expired-proof") }], { granted: true });
        await setPending(env, db, uidE, "clock_timestamp() - interval '721 hours'", 2);
        const beforeE = await stateOf(db, uidE);
        const proofE = (await sealRecovery(cfg, { userId: uidE, gen: 2 })).value;
        const r2 = await h.handleRestore(c.authR, () => pool, c.origin, { recovery: proofE });
        expectRedirect(r2, c.base, "/login?error=purge_due", "expired deadline");
        expectCookies(r2, cfg, "R-", "expired deadline");
        expect(await stateOf(db, uidE)).toEqual(beforeE);
        // not_pending: 이미 active(다른 탭에서 복구)
        const uidA = await seedUser(env, db, [{ provider: "kakao", subject: subject("not-pending") }], { granted: true, gen: 3 });
        const beforeA = await stateOf(db, uidA);
        const proofA = (await sealRecovery(cfg, { userId: uidA, gen: 3 })).value;
        const r3 = await h.handleRestore(c.authR, () => pool, c.origin, { recovery: proofA });
        expectRedirect(r3, c.base, "/login", "not_pending");
        expectCookies(r3, cfg, "R-", "not_pending (no session issued)");
        expect(await stateOf(db, uidA)).toEqual(beforeA);
        // not_found
        const t0 = await totals(env, db);
        const proofN = (await sealRecovery(cfg, { userId: randomUUID(), gen: 2 })).value;
        const r4 = await h.handleRestore(c.authR, () => pool, c.origin, { recovery: proofN });
        expectRedirect(r4, c.base, "/login?error=expired", "not_found");
        expectCookies(r4, cfg, "R-", "not_found");
        expect(await totals(env, db)).toEqual(t0);
      });
    });
  }, CASE_TIMEOUT);
});
