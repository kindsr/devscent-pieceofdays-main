// F4 B3 RED — 요청 viewer·기록 문맥(PLAN_mvp-oidc-integration §7, §9 B3/D4). DB 없음(단위).
//
// 대상: app/src/server/context.ts의 getViewer(아직 없음)와 async getDiaryContext(지금은 동기).
// - 각 it 안에서 vi.resetModules 뒤 동적 import한다. getViewer export 부재는 명시 단언으로 이 it만 RED가 된다.
// - 실제 사용: runtime-mode·loadAuthConfig·sealSession/readSession·sessionCookieOptions·verifyActiveAccount.
// - mock 경계(요청 입력만):
//   1) process.env: vi.stubEnv로 사례마다 넣고 afterEach unstubAllEnvs로 되돌린다.
//   2) next/headers: cookies()·headers()를 시험이 정한 요청 쿠키·헤더로 바꾼다. 읽은 쿠키 이름을 기록한다.
//   3) react cache: React 19 클라이언트 빌드의 cache는 memo 없이 fn을 그대로 부른다(실제 렌더 밖에서는 요청 cache가 아니다).
//      그래서 시험은 cache를 "현재 요청 번호(h.request)별 memo"로 바꾼 seam을 쓴다. 같은 요청 안에서는 한 번만 계산되고,
//      요청 번호가 바뀌면 새로 계산돼야 한다. 모듈 전역에 사용자 정보를 두면 요청 B가 A의 결과를 보게 되어 드러난다.
//   4) db/pool.getAppDb: 단위에서는 시험 fake Db를 돌려준다(실제 verifyActiveAccount가 그 query를 부른다). 실제 PG는 tests/db/f4-dal.test.ts.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAuthConfig } from "@/server/auth/config";
import { sealFlow } from "@/server/auth/flow-cookie";
import { sealRecovery } from "@/server/auth/recovery-cookie";
import { sealSession, type SessionConfig } from "@/server/auth/session";
import { APP_DIR } from "./auth-b1-support";

const h = vi.hoisted(() => ({
  request: 0,
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  cookieReads: [] as string[],
  db: null as null | (() => unknown),
  getDbCalls: 0,
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
    // 요청 번호별 memo(시험 seam). 실제 React 서버 렌더의 요청 범위 cache를 흉내 낸다.
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

vi.mock("@/server/db/pool", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    getAppDb: () => {
      h.getDbCalls++;
      if (!h.db) throw new Error("POD_DATABASE_URL is not set");
      return h.db();
    },
  };
});

const CONTEXT_MODULE = path.join(APP_DIR, "src", "server", "context.ts");

type RequestViewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };
type ContextApi = { getViewer: () => Promise<RequestViewer>; getDiaryContext: () => Promise<Record<string, unknown>> };

async function freshModule(): Promise<Record<string, unknown>> {
  vi.resetModules();
  try {
    return (await import(/* @vite-ignore */ CONTEXT_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/server/context.ts could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** getViewer·getDiaryContext export를 단언한다. getViewer가 없으면 이 it만 실패한다(정상 RED). */
async function loadContext(): Promise<ContextApi> {
  const mod = await freshModule();
  expect(typeof mod.getViewer, "src/server/context.ts must export function getViewer").toBe("function");
  expect(typeof mod.getDiaryContext, "src/server/context.ts must export function getDiaryContext").toBe("function");
  return mod as unknown as ContextApi;
}

// ---------------------------------------------------------------- 요청·env·DB 조작(시험 전용)

const KEY = "ci-only-b3-session-key-1-".padEnd(40, "x");
const BASE = "https://pieceofdays.example";
const DEV_BASE = "http://127.0.0.1:3300";
const UID_A = "0190f3a2-7c1e-7d4b-9a01-0000000000aa";
const UID_B = "0190f3a2-7c1e-7d4b-9a01-0000000000bb";

type EnvMap = Record<string, string>;
const AUTH_ENV = (base = BASE): EnvMap => ({
  POD_LOCAL_FIXTURE: "",
  POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY }),
  POD_AUTH_BASE_URL: base,
  POD_AUTH_PROVIDERS: "google",
  POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client",
  POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
  POD_AUTH_KAKAO_CLIENT_ID: "",
  POD_AUTH_KAKAO_CLIENT_SECRET: "",
  POD_AUTH_MOCK_OIDC_ISSUER: "",
  POD_DATABASE_URL: "",
});
const NO_AUTH_ENV: EnvMap = { ...AUTH_ENV(), POD_AUTH_PROVIDERS: "", POD_AUTH_SESSION_SECRETS: "", POD_AUTH_BASE_URL: "" };

function setEnv(env: EnvMap): void {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

/** 새 요청을 시작한다: 요청 번호 증가, 쿠키·헤더 교체, 읽기 기록 초기화. */
function newRequest(cookies: Record<string, string> = {}, headers: Record<string, string> = {}): void {
  h.request++;
  h.cookies = new Map(Object.entries(cookies));
  h.headers = new Map(Object.entries(headers));
  h.cookieReads = [];
}

type Query = { sql: string; params: unknown[] };
/** fake Db: 실제 verifyActiveAccount가 부르는 query를 기록하고 active 사용자 목록으로 답한다. */
function fakeDb(active: { userId: string; gen: number }[], opts: { fail?: boolean } = {}) {
  const queries: Query[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (opts.fail) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      const [uid, gen] = params;
      const hit = active.some((a) => a.userId === uid && String(a.gen) === String(gen));
      return { rowCount: hit ? 1 : 0, rows: hit ? [{ "?column?": 1 }] : [] };
    },
  };
  return { db, queries };
}

function sessionCfg(base = BASE): SessionConfig {
  const r = loadAuthConfig(AUTH_ENV(base), "test");
  if (!r.ok) throw new Error(`test config rejected: ${r.error}`);
  return r.value.session;
}
const seal = async (subject: { userId: string; gen: number }, base = BASE, cfg = sessionCfg(base)) =>
  (await sealSession(cfg, subject)).value;

afterEach(() => {
  vi.unstubAllEnvs();
  h.db = null;
  h.getDbCalls = 0;
  newRequest();
});

// ================================================================= getViewer 순서

describe("getViewer: mode conflict, fixture and auth config (§7 steps 1–3)", () => {
  it("fixture + PROVIDERS throws before returning fixture and before reading cookies or the DB (any PROVIDERS text)", async () => {
    const ctx = await loadContext();
    for (const providers of ["google", "Google", "naver", "google,kakao"]) {
      setEnv({ ...AUTH_ENV(), POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: providers });
      newRequest({ "__Host-pod_session": await seal({ userId: UID_A, gen: 1 }) });
      h.db = () => fakeDb([{ userId: UID_A, gen: 1 }]).db;
      await expect(ctx.getViewer(), providers).rejects.toThrow();
      await expect(ctx.getDiaryContext(), providers).rejects.toThrow();
      expect(h.cookieReads, `${providers}: no cookie read`).toEqual([]);
      expect(h.getDbCalls, `${providers}: no DB`).toBe(0);
    }
  });

  it("fixture mode → { kind: \"fixture\" } without cookies or DB, even with a valid session cookie present", async () => {
    const ctx = await loadContext();
    setEnv({ ...NO_AUTH_ENV, POD_LOCAL_FIXTURE: "1" });
    newRequest({ "__Host-pod_session": await seal({ userId: UID_A, gen: 1 }), pod_session: "x" });
    expect(await ctx.getViewer()).toEqual({ kind: "fixture" });
    expect(h.cookieReads).toEqual([]);
    expect(h.getDbCalls).toBe(0);
  });

  it("auth config errors → unavailable with the loadAuthConfig reason; no cookie read, no DB", async () => {
    const ctx = await loadContext();
    const cases: [string, EnvMap, string, "auth_not_configured" | "invalid_config"][] = [
      ["providers blank", NO_AUTH_ENV, "test", "auth_not_configured"],
      ["providers blank with spaces", { ...AUTH_ENV(), POD_AUTH_PROVIDERS: "   " }, "test", "auth_not_configured"],
      ["session secrets missing", { ...AUTH_ENV(), POD_AUTH_SESSION_SECRETS: "" }, "test", "auth_not_configured"],
      ["provider credentials missing", { ...AUTH_ENV(), POD_AUTH_GOOGLE_CLIENT_SECRET: "" }, "test", "invalid_config"],
      ["unknown provider", { ...AUTH_ENV(), POD_AUTH_PROVIDERS: "naver" }, "test", "invalid_config"],
      ["short session secret", { ...AUTH_ENV(), POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: "short" }) }, "test", "invalid_config"],
      ["http base in production", AUTH_ENV(DEV_BASE), "production", "invalid_config"],
      ["mock issuer outside development/test", { ...AUTH_ENV(), POD_AUTH_MOCK_OIDC_ISSUER: "http://127.0.0.1:9" }, "production", "invalid_config"],
      ["mock issuer malformed", { ...AUTH_ENV(), POD_AUTH_MOCK_OIDC_ISSUER: "http://localhost:9" }, "test", "invalid_config"],
    ];
    for (const [label, env, nodeEnv, reason] of cases) {
      setEnv(env);
      vi.stubEnv("NODE_ENV", nodeEnv);
      newRequest({ "__Host-pod_session": "anything", pod_session: "anything" });
      h.db = () => fakeDb([]).db;
      expect(await ctx.getViewer(), label).toEqual({ kind: "unavailable", reason });
      expect(h.cookieReads, `${label}: no cookie read`).toEqual([]);
      expect(h.getDbCalls, `${label}: no DB`).toBe(0);
    }
  });
});

describe("getViewer: session cookie and active-account check (§7 steps 4–7)", () => {
  it("reads only the exact sessionCookieOptions name (secure __Host-pod_session / dev pod_session) with no fallback", async () => {
    const ctx = await loadContext();
    for (const [base, right, wrong] of [
      [BASE, "__Host-pod_session", "pod_session"],
      [DEV_BASE, "pod_session", "__Host-pod_session"],
    ] as const) {
      setEnv(AUTH_ENV(base));
      const value = await seal({ userId: UID_A, gen: 1 }, base);
      h.db = () => fakeDb([{ userId: UID_A, gen: 1 }]).db;
      newRequest({ [wrong]: value, session: value, "pod-session": value });
      expect(await ctx.getViewer(), `${base}: cookie under ${wrong} only`).toEqual({ kind: "signed_out" });
      expect(h.cookieReads, `${base}: read names`).toEqual([right]);
      expect(h.getDbCalls, `${base}: no DB for a missing session`).toBe(0);
      newRequest({ [right]: value });
      expect(await ctx.getViewer(), `${base}: cookie under ${right}`).toEqual({ kind: "user", userId: UID_A, gen: 1 });
      expect(h.cookieReads).toEqual([right]);
    }
  });

  it("missing / invalid / other-purpose / other-key / expired sessions → signed_out with no DB access", async () => {
    const ctx = await loadContext();
    setEnv(AUTH_ENV());
    const cfg = sessionCfg();
    h.db = () => fakeDb([{ userId: UID_A, gen: 1 }]).db;
    const otherKey: SessionConfig = Object.freeze({ ...cfg, secrets: Object.freeze({ 1: "ci-only-b3-other-key-1-".padEnd(40, "z") }) });
    const cases: [string, string | undefined][] = [
      ["missing", undefined],
      ["empty", ""],
      ["garbage", "not-a-seal"],
      ["recovery proof", (await sealRecovery(cfg, { userId: UID_A, gen: 1 })).value],
      [
        "flow cookie",
        (
          await sealFlow(cfg, {
            provider: "google",
            issuer: "https://accounts.google.com/",
            state: "s".repeat(43),
            nonce: "n".repeat(43),
            codeVerifier: "v".repeat(43),
            returnTo: "/",
          })
        ).value,
      ],
      ["other key", await seal({ userId: UID_A, gen: 1 }, BASE, otherKey)],
      ["expired", await seal({ userId: UID_A, gen: 1 }, BASE, Object.freeze({ ...cfg, now: () => new Date(Date.now() - 8 * 86_400_000) }))],
    ];
    for (const [label, value] of cases) {
      newRequest(value === undefined ? {} : { "__Host-pod_session": value });
      expect(await ctx.getViewer(), label).toEqual({ kind: "signed_out" });
      expect(h.getDbCalls, `${label}: no DB`).toBe(0);
    }
  });

  it("valid session: active + same gen → user; inactive/other gen → signed_out; getAppDb or query failure → unavailable db_unavailable", async () => {
    const ctx = await loadContext();
    setEnv(AUTH_ENV());
    const value = await seal({ userId: UID_A, gen: 2 });
    const ok = fakeDb([{ userId: UID_A, gen: 2 }]);
    h.db = () => ok.db;
    newRequest({ "__Host-pod_session": value });
    expect(await ctx.getViewer()).toEqual({ kind: "user", userId: UID_A, gen: 2 });
    expect(ok.queries.map((q) => q.params), "verifyActiveAccount(userId, gen) from the session").toEqual([[UID_A, 2]]);

    const none = fakeDb([{ userId: UID_A, gen: 3 }]);
    h.db = () => none.db;
    newRequest({ "__Host-pod_session": value });
    expect(await ctx.getViewer(), "gen mismatch / not active").toEqual({ kind: "signed_out" });

    h.db = null; // getAppDb throws (POD_DATABASE_URL not set)
    newRequest({ "__Host-pod_session": value });
    expect(await ctx.getViewer(), "getAppDb throws").toEqual({ kind: "unavailable", reason: "db_unavailable" });

    const down = fakeDb([], { fail: true });
    h.db = () => down.db;
    newRequest({ "__Host-pod_session": value });
    expect(await ctx.getViewer(), "query throws").toEqual({ kind: "unavailable", reason: "db_unavailable" });
    expect(down.queries).toHaveLength(1);
  });

  it("request header / query userId is never used: the session subject decides (header x-user-id, cookie userId ignored)", async () => {
    const ctx = await loadContext();
    setEnv(AUTH_ENV());
    const db = fakeDb([
      { userId: UID_A, gen: 1 },
      { userId: UID_B, gen: 1 },
    ]);
    h.db = () => db.db;
    newRequest(
      { "__Host-pod_session": await seal({ userId: UID_A, gen: 1 }), userId: UID_B, user_id: UID_B },
      { "x-user-id": UID_B, "x-forwarded-user": UID_B, referer: `${BASE}/?userId=${UID_B}` },
    );
    expect(await ctx.getViewer()).toEqual({ kind: "user", userId: UID_A, gen: 1 });
    expect(db.queries.every((q) => !q.params.includes(UID_B)), "B is never looked up").toBe(true);
    newRequest({ userId: UID_B }, { "x-user-id": UID_B });
    expect(await ctx.getViewer(), "no session, only B identifiers").toEqual({ kind: "signed_out" });
  });
});

// ================================================================= 요청 경계

describe("request isolation (React cache seam = per-request memo)", () => {
  it("memoizes within one request; a new request with other cookies, config or DB state gets a fresh result (no module-global user)", async () => {
    const ctx = await loadContext();
    setEnv(AUTH_ENV());
    const a = await seal({ userId: UID_A, gen: 1 });
    const b = await seal({ userId: UID_B, gen: 1 });
    const db = fakeDb([
      { userId: UID_A, gen: 1 },
      { userId: UID_B, gen: 1 },
    ]);
    h.db = () => db.db;

    newRequest({ "__Host-pod_session": a });
    expect(await ctx.getViewer()).toEqual({ kind: "user", userId: UID_A, gen: 1 });
    expect(await ctx.getViewer(), "same request: memo").toEqual({ kind: "user", userId: UID_A, gen: 1 });
    expect(h.cookieReads, "same request reads the cookie once").toHaveLength(1);
    expect(db.queries, "same request checks the DB once").toHaveLength(1);

    newRequest({});
    expect(await ctx.getViewer(), "request without cookie").toEqual({ kind: "signed_out" });
    newRequest({ "__Host-pod_session": b });
    expect(await ctx.getViewer(), "request with B's cookie").toEqual({ kind: "user", userId: UID_B, gen: 1 });

    // 같은 쿠키라도 다음 요청에서 DB 상태가 바뀌면 반영된다(탈퇴 커밋 뒤 차단)
    h.db = () => fakeDb([{ userId: UID_B, gen: 1 }]).db;
    newRequest({ "__Host-pod_session": a });
    expect(await ctx.getViewer(), "A no longer active").toEqual({ kind: "signed_out" });

    // 설정이 바뀌면 다음 요청이 반영한다
    setEnv(NO_AUTH_ENV);
    newRequest({ "__Host-pod_session": b });
    expect(await ctx.getViewer()).toEqual({ kind: "unavailable", reason: "auth_not_configured" });
    setEnv({ ...NO_AUTH_ENV, POD_LOCAL_FIXTURE: "1" });
    newRequest({ "__Host-pod_session": b });
    expect(await ctx.getViewer()).toEqual({ kind: "fixture" });
  });
});

// ================================================================= getDiaryContext

describe("getDiaryContext (async, §7 DiaryContext)", () => {
  it("is async and maps a not-configured viewer to exactly { kind: \"unavailable\" } (existing public API)", async () => {
    const mod = await freshModule();
    expect(typeof mod.getDiaryContext).toBe("function");
    setEnv(NO_AUTH_ENV);
    newRequest();
    const r = (mod.getDiaryContext as () => unknown)();
    expect(r, "getDiaryContext returns a Promise").toBeInstanceOf(Promise);
    expect(await r).toEqual({ kind: "unavailable" });
  });

  it("maps user → { kind: \"signed_in\" } only (no userId, store or fixture data), signed_out → signed_out, db/config errors → unavailable, fixture → fixture store", async () => {
    const ctx = await loadContext();
    setEnv(AUTH_ENV());
    h.db = () => fakeDb([{ userId: UID_A, gen: 1 }]).db;
    newRequest({ "__Host-pod_session": await seal({ userId: UID_A, gen: 1 }) });
    const signedIn = await ctx.getDiaryContext();
    expect(signedIn).toEqual({ kind: "signed_in" });
    expect(JSON.stringify(signedIn)).not.toContain(UID_A);

    newRequest({});
    expect(await ctx.getDiaryContext()).toEqual({ kind: "signed_out" });

    h.db = null;
    newRequest({ "__Host-pod_session": await seal({ userId: UID_A, gen: 1 }) });
    expect(await ctx.getDiaryContext(), "db_unavailable").toEqual({ kind: "unavailable" });

    setEnv({ ...AUTH_ENV(), POD_AUTH_GOOGLE_CLIENT_ID: "" });
    newRequest({});
    expect(await ctx.getDiaryContext(), "invalid_config").toEqual({ kind: "unavailable" });

    setEnv({ ...NO_AUTH_ENV, POD_LOCAL_FIXTURE: "1" });
    newRequest({});
    const fx = await ctx.getDiaryContext();
    expect(fx).toMatchObject({ kind: "fixture", userId: "local-fixture-user", today: "2026-11-02" });
    expect(typeof (fx.store as { getDay?: unknown }).getDay).toBe("function");
    expect(h.getDbCalls, "fixture never touches the DB").toBe(0);
  });
});
