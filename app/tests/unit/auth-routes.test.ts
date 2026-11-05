// F4 B4 RED — 인증 HTTP route 어댑터·탈퇴 gate·계정 page(PLAN_mvp-oidc-integration §6.2·§6.3·§7·§8,
// PLAN_dev-usable-app §6 탈퇴 gate). DB 없음(단위). 성공 로그인·지급·탈퇴·복구 전 흐름은 tests/e2e-auth(실제 PG18)가 맡는다.
//
// 대상(아직 없음, main 고정 경로):
//   src/app/auth/[provider]/start/route.ts (POST) · src/app/auth/[provider]/callback/route.ts (GET)
//   src/app/auth/{logout,withdraw,restore}/route.ts (POST) · src/app/login/page.tsx · src/app/account/{withdraw,restore}/page.tsx
// - 각 it 안에서 vi.resetModules 뒤 절대경로로 동적 import한다. 모듈 부재는 그 it만 실패한다(정상 RED).
// - route는 B2 처리 함수(handle*)·loadAuthConfig·getAppDb를 그대로 부르는 얇은 어댑터다. 실제 B2·codec·mock OIDC issuer를 쓴다.
//   spy는 호출 여부만 센다(동작은 실제 함수 그대로).
// - mock 경계(요청 입력만): next/headers(cookies·headers는 현재 요청 값을 돌려주고, set·delete는 기록만 한다),
//   next/navigation의 client hook(렌더용 stub. redirect·notFound는 실제), db/pool.getAppDb(시험이 fake Db를 줄 때만 대체).
// - 응답 쿠키는 route가 돌려주는 Response의 Set-Cookie로만 확인한다(next/headers cookies().set으로 쓰면 이 시험에서 보이지 않는다).
// - 값은 모두 가짜다(ci-only-*). 실제 공급자·DB에 연결하지 않는다.
import path from "node:path";
import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadAuthConfig } from "@/server/auth/config";
import { readFlow } from "@/server/auth/flow-cookie";
import { sealRecovery } from "@/server/auth/recovery-cookie";
import { sealSession, type SessionConfig } from "@/server/auth/session";
import { closeAllMockIssuers, startMockIssuer, type MockIssuer } from "../support/mock-oidc-issuer";
import { APP_DIR } from "./auth-b1-support";

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  cookieCalls: 0,
  cookieWrites: [] as string[],
  db: null as null | (() => unknown),
  getDbCalls: 0,
  handlerCalls: { start: 0, callback: 0, logout: 0, withdraw: 0, restore: 0 },
  loadAuthConfigCalls: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    h.cookieCalls++;
    return {
      get: (name: string) => {
        const value = h.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
      has: (name: string) => h.cookies.has(name),
      getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
      set: (name: string) => void h.cookieWrites.push(`set:${String(name)}`),
      delete: (name: string) => void h.cookieWrites.push(`delete:${String(name)}`),
    };
  },
  headers: async () => new Headers([...h.headers]),
}));

vi.mock("next/navigation", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const router = { push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined };
  return { ...real, useRouter: () => router, usePathname: () => "/", useSearchParams: () => new URLSearchParams() };
});

vi.mock("@/server/auth/handlers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/handlers")>();
  return {
    ...real,
    handleStart: (...a: Parameters<typeof real.handleStart>) => (h.handlerCalls.start++, real.handleStart(...a)),
    handleCallback: (...a: Parameters<typeof real.handleCallback>) => (h.handlerCalls.callback++, real.handleCallback(...a)),
    handleLogout: (...a: Parameters<typeof real.handleLogout>) => (h.handlerCalls.logout++, real.handleLogout(...a)),
    handleWithdraw: (...a: Parameters<typeof real.handleWithdraw>) => (h.handlerCalls.withdraw++, real.handleWithdraw(...a)),
    handleRestore: (...a: Parameters<typeof real.handleRestore>) => (h.handlerCalls.restore++, real.handleRestore(...a)),
  };
});

vi.mock("@/server/auth/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/config")>();
  return {
    ...real,
    loadAuthConfig: (...a: Parameters<typeof real.loadAuthConfig>) => (h.loadAuthConfigCalls++, real.loadAuthConfig(...a)),
  };
});

vi.mock("@/server/db/pool", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/pool")>();
  return {
    ...real,
    getAppDb: () => {
      h.getDbCalls++;
      return (h.db ? h.db() : real.getAppDb()) as ReturnType<typeof real.getAppDb>;
    },
  };
});

// ---------------------------------------------------------------- 대상 경로(main 고정)

const APP = path.join(APP_DIR, "src", "app");
const ROUTES = {
  start: path.join(APP, "auth", "[provider]", "start", "route.ts"),
  callback: path.join(APP, "auth", "[provider]", "callback", "route.ts"),
  logout: path.join(APP, "auth", "logout", "route.ts"),
  withdraw: path.join(APP, "auth", "withdraw", "route.ts"),
  restore: path.join(APP, "auth", "restore", "route.ts"),
} as const;
const METHOD: Record<keyof typeof ROUTES, "GET" | "POST"> = { start: "POST", callback: "GET", logout: "POST", withdraw: "POST", restore: "POST" };
const PAGES = {
  login: path.join(APP, "login", "page.tsx"),
  withdraw: path.join(APP, "account", "withdraw", "page.tsx"),
  restore: path.join(APP, "account", "restore", "page.tsx"),
  settings: path.join(APP, "settings", "page.tsx"),
} as const;

type Ctx = { params: Promise<Record<string, string>> };
type RouteFn = (req: NextRequest, ctx: Ctx) => Promise<Response> | Response;

async function freshImport(file: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F4 B4 product module ${path.relative(APP_DIR, file)} could not be loaded (expected before GREEN): ${msg}`);
  }
}

/** route 모듈을 새로 불러와 HTTP 메서드 export를 단언한다. */
async function route(name: keyof typeof ROUTES): Promise<RouteFn> {
  vi.resetModules();
  const mod = await freshImport(ROUTES[name]);
  expect(typeof mod[METHOD[name]], `${path.relative(APP_DIR, ROUTES[name])} must export ${METHOD[name]}`).toBe("function");
  return mod[METHOD[name]] as RouteFn;
}

// ---------------------------------------------------------------- 가짜 설정·요청

const KEY = "ci-only-b4-session-key-1-".padEnd(40, "x");
const BASE = "https://pieceofdays.example";
const DEV_BASE = "http://127.0.0.1:3300";
const UID = "0190f3a2-7c1e-7d4b-9a01-0000000000b4";

type EnvMap = Record<string, string>;
function authEnv(opts: { base?: string; mock?: MockIssuer; providers?: string } = {}): EnvMap {
  return {
    POD_LOCAL_FIXTURE: "",
    POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY }),
    POD_AUTH_BASE_URL: opts.base ?? BASE,
    POD_AUTH_PROVIDERS: opts.providers ?? "google",
    POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client",
    POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
    POD_AUTH_KAKAO_CLIENT_ID: "ci-only-kakao-client",
    POD_AUTH_KAKAO_CLIENT_SECRET: "ci-only-kakao-secret",
    POD_AUTH_MOCK_OIDC_ISSUER: opts.mock ? opts.mock.origin : "",
    POD_DATABASE_URL: "",
    POD_WITHDRAWAL_ENABLED: "",
  };
}
const NO_AUTH: EnvMap = { ...authEnv(), POD_AUTH_PROVIDERS: "", POD_AUTH_SESSION_SECRETS: "", POD_AUTH_BASE_URL: "" };
const INVALID_AUTH: EnvMap = { ...authEnv(), POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: "short" }) };

function setEnv(env: EnvMap, extra: Record<string, string | undefined> = {}): void {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  for (const [k, v] of Object.entries({ ...env, ...extra })) {
    if (v === undefined) vi.stubEnv(k, undefined);
    else vi.stubEnv(k, v);
  }
}

function cfgFor(env: EnvMap): SessionConfig {
  const r = loadAuthConfig(env, "test");
  if (!r.ok) throw new Error(`test config rejected: ${r.error}`);
  return r.value.session;
}

function resetObservations(): void {
  h.cookieCalls = 0;
  h.cookieWrites = [];
  h.getDbCalls = 0;
  h.loadAuthConfigCalls = 0;
  for (const k of Object.keys(h.handlerCalls) as (keyof typeof h.handlerCalls)[]) h.handlerCalls[k] = 0;
}

type ReqOpts = { origin?: string | null; cookies?: Record<string, string>; form?: Record<string, string>; host?: string };

/** 요청을 만들고 next/headers mock도 같은 쿠키·헤더를 보게 한다. */
function request(method: "GET" | "POST", url: string, opts: ReqOpts = {}): NextRequest {
  resetObservations();
  const headers = new Headers();
  if (opts.origin !== undefined && opts.origin !== null) headers.set("origin", opts.origin);
  const cookies = opts.cookies ?? {};
  if (Object.keys(cookies).length > 0) {
    headers.set("cookie", Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  }
  let body: string | undefined;
  if (method === "POST") {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(opts.form ?? {}).toString();
  }
  h.cookies = new Map(Object.entries(cookies));
  h.headers = new Map([...headers]);
  return new NextRequest(new URL(url, opts.host ?? BASE), { method, headers, body });
}

const ctx = (params: Record<string, string> = {}): Ctx => ({ params: Promise.resolve(params) });

// ---------------------------------------------------------------- 응답 확인

const BODY_403 = "요청을 확인할 수 없어요.";
const BODY_404 = "찾을 수 없어요.";
const BODY_503 = "지금은 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요.";

type ParsedCookie = { name: string; value: string; attrs: Map<string, string> };
function setCookies(res: Response): ParsedCookie[] {
  return res.headers.getSetCookie().map((line) => {
    const [nv = "", ...parts] = line.split(";");
    const i = nv.indexOf("=");
    const attrs = new Map<string, string>();
    for (const p of parts) {
      const j = p.indexOf("=");
      const k = (j < 0 ? p : p.slice(0, j)).trim().toLowerCase();
      attrs.set(k, j < 0 ? "" : p.slice(j + 1).trim());
    }
    return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim(), attrs };
  });
}

async function expectFixed(res: Response, status: 403 | 404 | 503, label: string, opts: { callback?: boolean } = {}): Promise<void> {
  expect(res.status, `${label}: status`).toBe(status);
  expect(await res.text(), `${label}: fixed body`).toBe(status === 403 ? BODY_403 : status === 404 ? BODY_404 : BODY_503);
  expect(res.headers.get("content-type")?.toLowerCase().replace(/\s+/g, ""), `${label}: content-type`).toBe("text/plain;charset=utf-8");
  expect(res.headers.get("cache-control") ?? "", `${label}: no-store`).toMatch(/(^|,|\s)no-store(,|$|\s)/);
  expect(res.headers.get("location"), `${label}: no Location`).toBeNull();
  if (opts.callback) expect(res.headers.get("referrer-policy"), `${label}: no-referrer`).toBe("no-referrer");
}

function expectRedirect(res: Response, location: string, label: string, opts: { callback?: boolean } = {}): void {
  expect(res.status, `${label}: status`).toBe(303);
  expect(res.headers.get("location"), `${label}: Location`).toBe(location);
  expect(res.headers.get("cache-control") ?? "", `${label}: no-store`).toMatch(/(^|,|\s)no-store(,|$|\s)/);
  if (opts.callback) expect(res.headers.get("referrer-policy"), `${label}: no-referrer`).toBe("no-referrer");
}

function expectNoCookies(res: Response, label: string): void {
  expect(res.headers.getSetCookie(), `${label}: no Set-Cookie`).toEqual([]);
  expect(h.cookieWrites, `${label}: no next/headers cookie writes`).toEqual([]);
}

/** 삭제 Set-Cookie: 빈 값, Path=/, Max-Age=0, 과거 Expires, HttpOnly, SameSite=Lax, Secure는 설정대로, Domain 없음. */
function expectDeleted(c: ParsedCookie | undefined, name: string, secure: boolean, label: string): void {
  expect(c, `${label}: Set-Cookie for ${name}`).toBeDefined();
  if (!c) return;
  expect(c.value, `${label}: ${name} value cleared`).toBe("");
  expect(c.attrs.get("path"), `${label}: ${name} Path`).toBe("/");
  expect(c.attrs.get("max-age"), `${label}: ${name} Max-Age`).toBe("0");
  const exp = Date.parse(c.attrs.get("expires") ?? "");
  expect(Number.isNaN(exp) ? Infinity : exp, `${label}: ${name} Expires in the past`).toBeLessThanOrEqual(Date.now());
  expect(c.attrs.has("httponly"), `${label}: ${name} HttpOnly`).toBe(true);
  expect(c.attrs.get("samesite")?.toLowerCase(), `${label}: ${name} SameSite`).toBe("lax");
  expect(c.attrs.has("secure"), `${label}: ${name} Secure`).toBe(secure);
  expect(c.attrs.has("domain"), `${label}: ${name} no Domain`).toBe(false);
}

/** 설정 Set-Cookie: 값 있음, Path=/, HttpOnly, SameSite=Lax, Secure는 설정대로, Domain 없음, Expires ≈ 기대 수명. */
function expectSet(c: ParsedCookie | undefined, name: string, secure: boolean, lifetimeMs: number, label: string): void {
  expect(c, `${label}: Set-Cookie for ${name}`).toBeDefined();
  if (!c) return;
  expect(c.value.length, `${label}: ${name} has a value`).toBeGreaterThan(0);
  expect(c.attrs.get("path"), `${label}: ${name} Path`).toBe("/");
  expect(c.attrs.has("httponly"), `${label}: ${name} HttpOnly`).toBe(true);
  expect(c.attrs.get("samesite")?.toLowerCase(), `${label}: ${name} SameSite`).toBe("lax");
  expect(c.attrs.has("secure"), `${label}: ${name} Secure`).toBe(secure);
  expect(c.attrs.has("domain"), `${label}: ${name} no Domain`).toBe(false);
  const exp = Date.parse(c.attrs.get("expires") ?? "");
  expect(Math.abs(exp - (Date.now() + lifetimeMs)), `${label}: ${name} Expires ≈ now + ${lifetimeMs}ms`).toBeLessThan(5_000);
  const maxAge = c.attrs.get("max-age");
  if (maxAge !== undefined) expect(Math.abs(Number(maxAge) * 1000 - lifetimeMs), `${label}: ${name} Max-Age`).toBeLessThan(5_000);
}

const byName = (list: ParsedCookie[], name: string) => list.find((c) => c.name === name);
const names = (secure: boolean) =>
  secure
    ? { flow: "__Host-pod_oauth", session: "__Host-pod_session", recovery: "__Host-pod_recovery" }
    : { flow: "pod_oauth", session: "pod_session", recovery: "pod_recovery" };

function expectNoSideEffects(label: string): void {
  expect(h.getDbCalls, `${label}: no DB`).toBe(0);
}

// ---------------------------------------------------------------- mock issuer(사례마다)

const issuers: MockIssuer[] = [];
async function mockFor(base = BASE): Promise<MockIssuer> {
  const m = await startMockIssuer({
    clients: [
      { provider: "google", clientId: "ci-only-google-client", clientSecret: "ci-only-google-secret", redirectUri: `${base}/auth/google/callback` },
      { provider: "kakao", clientId: "ci-only-kakao-client", clientSecret: "ci-only-kakao-secret", redirectUri: `${base}/auth/kakao/callback` },
    ],
  });
  issuers.push(m);
  return m;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  h.db = null;
  h.cookies = new Map();
  h.headers = new Map();
  resetObservations();
  await Promise.all(issuers.splice(0).map((m) => m.close()));
});

afterAll(async () => {
  await closeAllMockIssuers();
});

/** route로 실제 start를 실행해 flow 쿠키와 authorize URL을 얻는다. */
async function startLogin(mock: MockIssuer, provider: "google" | "kakao", returnTo = "/"): Promise<{ authorizeUrl: string; flow: string }> {
  const POST = await route("start");
  const res = await POST(request("POST", `/auth/${provider}/start`, { origin: BASE, form: { returnTo } }), ctx({ provider }));
  expect(res.status, "start succeeds").toBe(303);
  const flow = byName(setCookies(res), names(true).flow);
  expect(flow, "start sets the flow cookie").toBeDefined();
  return { authorizeUrl: res.headers.get("location") ?? "", flow: flow?.value ?? "" };
}

// ================================================================= 모듈 표면

describe("route modules: fixed paths, HTTP methods and runtime", () => {
  it("each auth route exports only its method (POST start/logout/withdraw/restore, GET callback) and keeps the Node.js runtime", async () => {
    for (const name of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
      vi.resetModules();
      const mod = await freshImport(ROUTES[name]);
      const rel = path.relative(APP_DIR, ROUTES[name]);
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(typeof mod[m], `${rel} ${m}`).toBe(m === METHOD[name] ? "function" : "undefined");
      }
      expect([undefined, "nodejs"], `${rel} runtime`).toContain(mod.runtime);
    }
  });
});

// ================================================================= 설정 오류

describe("auth not configured or invalid → fixed 503 on every route (no Location, cookies or DB)", () => {
  it("start, callback, logout, restore and an enabled withdraw all answer 503 with the fixed text/plain no-store body", async () => {
    for (const [label, env] of [
      ["not configured", NO_AUTH],
      ["invalid", INVALID_AUTH],
    ] as const) {
      const cases: [keyof typeof ROUTES, string, ReqOpts, Record<string, string>][] = [
        ["start", "/auth/google/start", { origin: BASE, form: { returnTo: "/" } }, { provider: "google" }],
        ["callback", "/auth/google/callback?code=x&state=y", { cookies: { pod_oauth: "x", "__Host-pod_oauth": "x" } }, { provider: "google" }],
        ["logout", "/auth/logout", { origin: BASE, cookies: { "__Host-pod_session": "x" } }, {}],
        ["restore", "/auth/restore", { origin: BASE, cookies: { "__Host-pod_recovery": "x" } }, {}],
        ["withdraw", "/auth/withdraw", { origin: BASE, form: { confirm: "withdraw" } }, {}],
      ];
      for (const [name, url, opts, params] of cases) {
        setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
        const fn = await route(name);
        const res = await fn(request(METHOD[name], url, opts), ctx(params));
        const l = `${label} ${name}`;
        await expectFixed(res, 503, l, { callback: name === "callback" });
        expectNoCookies(res, l);
        expectNoSideEffects(l);
      }
    }
  });
});

// ================================================================= Origin

describe("POST routes check the configured Origin (missing / \"null\" / other → 403, nothing changes)", () => {
  it("start, logout, restore and enabled withdraw reject a bad Origin with the fixed 403 and no cookies or DB", async () => {
    for (const origin of [null, "null", "https://evil.example", "https://pieceofdays.example:8443", "http://pieceofdays.example", ""]) {
      for (const [name, url, form, params] of [
        ["start", "/auth/google/start", { returnTo: "/" }, { provider: "google" }],
        ["logout", "/auth/logout", {}, {}],
        ["restore", "/auth/restore", {}, {}],
        ["withdraw", "/auth/withdraw", { confirm: "withdraw" }, {}],
      ] as const) {
        setEnv(authEnv(), { POD_WITHDRAWAL_ENABLED: "1" });
        const fn = await route(name);
        const res = await fn(
          request("POST", url, { origin, form, cookies: { "__Host-pod_session": "x", "__Host-pod_recovery": "x" } }),
          ctx(params),
        );
        const l = `${name} origin=${JSON.stringify(origin)}`;
        await expectFixed(res, 403, l);
        expectNoCookies(res, l);
        expectNoSideEffects(l);
      }
    }
  });

  it("the Location comes from the configured base URL, never from the request Host", async () => {
    setEnv(authEnv());
    const POST = await route("logout");
    const res = await POST(request("POST", "/auth/logout", { origin: BASE, host: "https://evil.example" }), ctx());
    expectRedirect(res, `${BASE}/login?notice=signed_out`, "logout on a forged Host");
    const forged = await POST(request("POST", "/auth/logout", { origin: "https://evil.example", host: "https://evil.example" }), ctx());
    await expectFixed(forged, 403, "Origin equal to the forged Host");
  });
});

// ================================================================= start

describe("POST /auth/{provider}/start", () => {
  it("unknown or disabled providers → fixed 404 without a flow cookie", async () => {
    for (const provider of ["naver", "Google", "kakao", "google ", "%67oogle"]) {
      setEnv(authEnv({ providers: "google" }));
      const POST = await route("start");
      const res = await POST(request("POST", `/auth/${encodeURIComponent(provider)}/start`, { origin: BASE, form: { returnTo: "/" } }), ctx({ provider }));
      await expectFixed(res, 404, `provider ${JSON.stringify(provider)}`);
      expectNoCookies(res, provider);
    }
  });

  it("success → 303 to the provider authorize URL with exactly one flow cookie (secure __Host-, 10 minutes) and the safe returnTo sealed", async () => {
    const mock = await mockFor();
    for (const [returnTo, expected] of [
      ["/days/2026-11-03", "/days/2026-11-03"],
      ["/settings", "/settings"],
      ["//evil.example", "/"],
      ["https://evil.example/", "/"],
      ["/login", "/"],
      ["", "/"],
    ] as const) {
      setEnv(authEnv({ mock }));
      const POST = await route("start");
      const res = await POST(request("POST", "/auth/google/start", { origin: BASE, form: { returnTo } }), ctx({ provider: "google" }));
      expect(res.status, returnTo).toBe(303);
      const loc = new URL(res.headers.get("location") ?? "about:blank");
      expect(`${loc.origin}${loc.pathname}`, "authorize endpoint").toBe(mock.endpoint("google", "authorize"));
      expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/);
      const list = setCookies(res);
      expect(list.map((c) => c.name), "only the flow cookie").toEqual(["__Host-pod_oauth"]);
      expectSet(list[0], "__Host-pod_oauth", true, 600_000, `start ${returnTo}`);
      const flow = await readFlow(cfgFor(authEnv({ mock })), list[0]?.value);
      expect(flow.ok && flow.value.returnTo, `sealed returnTo for ${JSON.stringify(returnTo)}`).toBe(expected);
      expectNoSideEffects("start");
    }
  });

  it("on an http development base the flow cookie is pod_oauth without Secure", async () => {
    const mock = await mockFor(DEV_BASE);
    setEnv(authEnv({ mock, base: DEV_BASE }));
    const POST = await route("start");
    const res = await POST(request("POST", "/auth/google/start", { origin: DEV_BASE, form: { returnTo: "/" }, host: DEV_BASE }), ctx({ provider: "google" }));
    expect(res.status).toBe(303);
    const list = setCookies(res);
    expect(list.map((c) => c.name)).toEqual(["pod_oauth"]);
    expectSet(list[0], "pod_oauth", false, 600_000, "dev start");
  });

  it("discovery failure → fixed 503 and no flow cookie", async () => {
    const mock = await mockFor();
    mock.faults.discovery = "error";
    setEnv(authEnv({ mock }));
    const POST = await route("start");
    const res = await POST(request("POST", "/auth/google/start", { origin: BASE, form: { returnTo: "/" } }), ctx({ provider: "google" }));
    await expectFixed(res, 503, "discovery down");
    expectNoCookies(res, "discovery down");
  });
});

// ================================================================= callback

describe("GET /auth/{provider}/callback", () => {
  it("unknown provider → fixed 404 that only deletes the flow cookie (no-referrer)", async () => {
    setEnv(authEnv());
    const GET = await route("callback");
    const res = await GET(
      request("GET", "/auth/naver/callback?code=x&state=y", { cookies: { "__Host-pod_oauth": "x", "__Host-pod_session": "keep" } }),
      ctx({ provider: "naver" }),
    );
    await expectFixed(res, 404, "unknown provider", { callback: true });
    const list = setCookies(res);
    expect(list.map((c) => c.name)).toEqual(["__Host-pod_oauth"]);
    expectDeleted(list[0], "__Host-pod_oauth", true, "unknown provider");
    expectNoSideEffects("unknown provider");
  });

  it("missing flow cookie → 303 /login?error=expired, flow deleted, the existing session cookie untouched", async () => {
    setEnv(authEnv());
    const GET = await route("callback");
    const res = await GET(
      request("GET", "/auth/google/callback?code=x&state=y", { cookies: { "__Host-pod_session": "keep" } }),
      ctx({ provider: "google" }),
    );
    expectRedirect(res, `${BASE}/login?error=expired`, "no flow", { callback: true });
    const list = setCookies(res);
    expect(list.map((c) => c.name), "only the flow cookie changes").toEqual(["__Host-pod_oauth"]);
    expectDeleted(list[0], "__Host-pod_oauth", true, "no flow");
    expectNoSideEffects("no flow");
  });

  it("the query reaches the B2 handler with duplicate entries preserved (duplicate state/code/iss → failed before any DB access)", async () => {
    const mock = await mockFor();
    setEnv(authEnv({ mock }));
    for (const dup of ["state", "code", "iss"] as const) {
      const { authorizeUrl, flow } = await startLogin(mock, "google");
      const a = await mock.authorize(authorizeUrl);
      const q = new URLSearchParams(a.callback.search);
      q.append(dup, q.get(dup) ?? "dup");
      const GET = await route("callback");
      const res = await GET(
        request("GET", `/auth/google/callback?${q.toString()}`, { cookies: { "__Host-pod_oauth": flow, "__Host-pod_session": "keep" } }),
        ctx({ provider: "google" }),
      );
      expectRedirect(res, `${BASE}/login?error=failed`, `duplicate ${dup}`, { callback: true });
      expect(setCookies(res).map((c) => c.name), `duplicate ${dup}: only F−`).toEqual(["__Host-pod_oauth"]);
      expectNoSideEffects(`duplicate ${dup}`);
    }
  });

  it("control: the same verified callback (even on a forged Host) passes OIDC and reaches the DB step → 503 without a DB, S and R untouched", async () => {
    const mock = await mockFor();
    setEnv(authEnv({ mock }));
    const { authorizeUrl, flow } = await startLogin(mock, "google");
    const a = await mock.authorize(authorizeUrl);
    const GET = await route("callback");
    const res = await GET(
      request("GET", `/auth/google/callback${a.callback.search}`, {
        cookies: { "__Host-pod_oauth": flow, "__Host-pod_session": "keep", "__Host-pod_recovery": "keep" },
        host: "https://evil.example",
      }),
      ctx({ provider: "google" }),
    );
    await expectFixed(res, 503, "verified callback without DB", { callback: true });
    expect(setCookies(res).map((c) => c.name), "only F−").toEqual(["__Host-pod_oauth"]);
    expect(h.getDbCalls, "the DB step was reached").toBeGreaterThan(0);
  });

  it("cancelled at the provider → 303 /login?error=cancelled", async () => {
    const mock = await mockFor();
    setEnv(authEnv({ mock }));
    const { authorizeUrl, flow } = await startLogin(mock, "google");
    const a = await mock.authorize(authorizeUrl, { deny: true });
    const GET = await route("callback");
    const res = await GET(request("GET", `/auth/google/callback${a.callback.search}`, { cookies: { "__Host-pod_oauth": flow } }), ctx({ provider: "google" }));
    expectRedirect(res, `${BASE}/login?error=cancelled`, "cancelled", { callback: true });
    expectNoSideEffects("cancelled");
  });
});

// ================================================================= logout · restore

describe("POST /auth/logout and /auth/restore", () => {
  it("logout → 303 /login?notice=signed_out deleting S and R (secure base) — with or without a session", async () => {
    for (const cookies of [{}, { "__Host-pod_session": "x", "__Host-pod_recovery": "y" }] as Record<string, string>[]) {
      setEnv(authEnv());
      const POST = await route("logout");
      const res = await POST(request("POST", "/auth/logout", { origin: BASE, cookies }), ctx());
      expectRedirect(res, `${BASE}/login?notice=signed_out`, "logout");
      const list = setCookies(res);
      expect(list.map((c) => c.name).sort()).toEqual(["__Host-pod_recovery", "__Host-pod_session"]);
      expectDeleted(byName(list, "__Host-pod_session"), "__Host-pod_session", true, "logout");
      expectDeleted(byName(list, "__Host-pod_recovery"), "__Host-pod_recovery", true, "logout");
      expectNoSideEffects("logout");
    }
  });

  it("logout on the http development base deletes pod_session / pod_recovery without Secure", async () => {
    setEnv(authEnv({ base: DEV_BASE }));
    const POST = await route("logout");
    const res = await POST(request("POST", "/auth/logout", { origin: DEV_BASE, host: DEV_BASE }), ctx());
    expectRedirect(res, `${DEV_BASE}/login?notice=signed_out`, "dev logout");
    const list = setCookies(res);
    expectDeleted(byName(list, "pod_session"), "pod_session", false, "dev logout");
    expectDeleted(byName(list, "pod_recovery"), "pod_recovery", false, "dev logout");
  });

  it("restore is independent of the withdrawal flag: no proof → 303 /login?error=expired with R−; valid proof without a DB → 503 with R− only", async () => {
    for (const flag of [undefined, "", "0", "1"]) {
      setEnv(authEnv(), { POD_WITHDRAWAL_ENABLED: flag });
      const POST = await route("restore");
      const none = await POST(request("POST", "/auth/restore", { origin: BASE }), ctx());
      expectRedirect(none, `${BASE}/login?error=expired`, `restore without proof (flag ${String(flag)})`);
      const nl = setCookies(none);
      expect(nl.map((c) => c.name)).toEqual(["__Host-pod_recovery"]);
      expectDeleted(nl[0], "__Host-pod_recovery", true, "restore without proof");

      const proof = (await sealRecovery(cfgFor(authEnv()), { userId: UID, gen: 2 })).value;
      const res = await POST(request("POST", "/auth/restore", { origin: BASE, cookies: { "__Host-pod_recovery": proof } }), ctx());
      await expectFixed(res, 503, `restore DB down (flag ${String(flag)})`);
      const list = setCookies(res);
      expect(list.map((c) => c.name)).toEqual(["__Host-pod_recovery"]);
      expectDeleted(list[0], "__Host-pod_recovery", true, "restore DB down");
      expect(h.handlerCalls.restore, "restore delegates to handleRestore").toBe(1);
    }
  });
});

// ================================================================= 탈퇴 gate

const DISABLED_FLAGS: (string | undefined)[] = [undefined, "", "0", "true", "TRUE", "yes", " 1", "1 ", "01", "1\n", "on"];

describe("withdrawal gate: POD_WITHDRAWAL_ENABLED must be exactly \"1\"", () => {
  it("disabled POST /auth/withdraw → fixed 503 before auth config, cookies, handler or DB (even with a valid session and Origin)", async () => {
    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    for (const flag of DISABLED_FLAGS) {
      for (const base of [env, NO_AUTH]) {
        setEnv(base, { POD_WITHDRAWAL_ENABLED: flag });
        const POST = await route("withdraw");
        const res = await POST(
          request("POST", "/auth/withdraw", { origin: BASE, form: { confirm: "withdraw" }, cookies: { "__Host-pod_session": session } }),
          ctx(),
        );
        const l = `flag ${JSON.stringify(flag)}${base === NO_AUTH ? " (no auth)" : ""}`;
        await expectFixed(res, 503, l);
        expectNoCookies(res, l);
        expect(h.handlerCalls.withdraw, `${l}: handleWithdraw not called`).toBe(0);
        expect(h.loadAuthConfigCalls, `${l}: auth config not loaded`).toBe(0);
        expect(h.cookieCalls, `${l}: cookies() not read`).toBe(0);
        expect(h.getDbCalls, `${l}: no DB`).toBe(0);
      }
    }
  });

  it("enabled (\"1\") delegates to the B2 table: bad Origin 403, no confirm → /account/withdraw, no session → /login with S−, DB down → 503 keeping S", async () => {
    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
    const POST = await route("withdraw");

    const noOrigin = await POST(request("POST", "/auth/withdraw", { form: { confirm: "withdraw" }, cookies: { "__Host-pod_session": session } }), ctx());
    await expectFixed(noOrigin, 403, "enabled, no Origin");

    for (const confirm of [undefined, "", "Withdraw", "withdraw ", "yes"]) {
      const res = await POST(
        request("POST", "/auth/withdraw", { origin: BASE, form: confirm === undefined ? {} : { confirm }, cookies: { "__Host-pod_session": session } }),
        ctx(),
      );
      expectRedirect(res, `${BASE}/account/withdraw`, `confirm ${JSON.stringify(confirm)}`);
      expectNoCookies(res, `confirm ${JSON.stringify(confirm)}`);
      expectNoSideEffects(`confirm ${JSON.stringify(confirm)}`);
    }

    const noSession = await POST(request("POST", "/auth/withdraw", { origin: BASE, form: { confirm: "withdraw" } }), ctx());
    expectRedirect(noSession, `${BASE}/login`, "enabled, no session");
    const ns = setCookies(noSession);
    expect(ns.map((c) => c.name)).toEqual(["__Host-pod_session"]);
    expectDeleted(ns[0], "__Host-pod_session", true, "enabled, no session");

    const down = await POST(request("POST", "/auth/withdraw", { origin: BASE, form: { confirm: "withdraw" }, cookies: { "__Host-pod_session": session } }), ctx());
    await expectFixed(down, 503, "enabled, DB down");
    expectNoCookies(down, "enabled, DB down (S kept for a retry)");
    expect(h.handlerCalls.withdraw, "enabled withdraw delegates to handleWithdraw").toBe(1);
    expect(h.getDbCalls, "DB step reached").toBeGreaterThan(0);
  });
});

// ================================================================= page(서버 컴포넌트 렌더)

type Rendered = { html?: string; redirect?: string; notFound?: boolean };

function navOutcome(err: unknown): Rendered {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { redirect: digest.split(";").slice(2, -2).join(";") };
  if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { notFound: true };
  throw err;
}

/** page를 새로 불러와 호출하고(redirect·notFound는 결과로), 반환 트리를 react-dom/server로 HTML까지 렌더한다. */
async function renderPage(file: string, searchParams: Record<string, string> = {}): Promise<Rendered> {
  vi.resetModules();
  const mod = await freshImport(file);
  expect(typeof mod.default, `${path.relative(APP_DIR, file)} must default-export a page`).toBe("function");
  const props = { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) };
  let el: unknown;
  try {
    el = await (mod.default as (p: typeof props) => unknown)(props);
  } catch (err) {
    return navOutcome(err);
  }
  const { renderToReadableStream } = await import("react-dom/server");
  try {
    const stream = await renderToReadableStream(el as ReactNode);
    await stream.allReady;
    return { html: await new Response(stream).text() };
  } catch (err) {
    return navOutcome(err);
  }
}

/** 요청 쿠키를 넣는다(page는 next/headers로 읽는다). */
function pageRequest(cookies: Record<string, string> = {}): void {
  resetObservations();
  h.cookies = new Map(Object.entries(cookies));
  h.headers = new Map();
}

/** verifyActiveAccount가 부르는 query에 active로 답하는 fake Db. */
const activeDb = (userId: string, gen: number) => () => ({
  query: async (_sql: string, params: unknown[] = []) => {
    const hit = params[0] === userId && String(params[1]) === String(gen);
    return { rowCount: hit ? 1 : 0, rows: hit ? [{ "?column?": 1 }] : [] };
  },
});

/** HTML 안의 tag 시작 태그들을 속성 맵으로 읽는다(속성 순서와 무관하게 비교한다). */
function tags(html: string, tag: string): Map<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))].map((m) => {
    const attrs = new Map<string, string>();
    for (const a of (m[1] ?? "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs.set((a[1] ?? "").toLowerCase(), a[2] ?? "");
    return attrs;
  });
}
const postForms = (html: string, action: string) =>
  tags(html, "form").filter((f) => f.get("action") === action && (f.get("method") ?? "").toLowerCase() === "post");

const TRY_NOTE = "체험판 기록은 이 브라우저에만 있고 계정으로 옮겨지지 않아요. 설정에서 내려받아 두세요.";
const WITHDRAW_NOTICE = "계정 탈퇴는 아직 준비 중이에요.";
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

describe("GET /account/withdraw and /settings under the withdrawal gate", () => {
  it("disabled flag → /account/withdraw redirects to /settings?notice=withdrawal_unavailable for every viewer", async () => {
    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    for (const flag of DISABLED_FLAGS) {
      for (const [label, cookies] of [
        ["signed in", { "__Host-pod_session": session }],
        ["signed out", {}],
      ] as const) {
        setEnv(env, { POD_WITHDRAWAL_ENABLED: flag });
        h.db = activeDb(UID, 1);
        pageRequest(cookies);
        const r = await renderPage(PAGES.withdraw);
        expect(r.redirect, `flag ${JSON.stringify(flag)} ${label}`).toBe("/settings?notice=withdrawal_unavailable");
      }
    }
  });

  it("enabled flag: a signed-out viewer is sent to /login with returnTo=/settings; a signed-in viewer sees the confirm form posting to /auth/withdraw", async () => {
    const env = authEnv();
    setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
    pageRequest({});
    const out = await renderPage(PAGES.withdraw);
    const u = new URL(out.redirect ?? "/missing-redirect", BASE);
    expect(u.pathname, "signed out → /login").toBe("/login");
    expect(u.searchParams.get("returnTo"), "returnTo").toBe("/settings");

    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
    h.db = activeDb(UID, 1);
    pageRequest({ "__Host-pod_session": session });
    const r = await renderPage(PAGES.withdraw);
    const html = decode(r.html ?? "");
    expect(postForms(html, "/auth/withdraw"), "one POST form to /auth/withdraw").toHaveLength(1);
    const confirm = tags(html, "input").filter((i) => i.get("name") === "confirm");
    expect(confirm.map((i) => [i.get("type"), i.get("value")]), "confirm=withdraw checkbox").toEqual([["checkbox", "withdraw"]]);
    expect(html, "§8 warning").toContain("탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요");
  });

  it("signed-in /settings: no withdraw entry while disabled (and the fixed notice for notice=withdrawal_unavailable); the 계정 탈퇴 link only when enabled", async () => {
    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    for (const flag of DISABLED_FLAGS) {
      setEnv(env, { POD_WITHDRAWAL_ENABLED: flag });
      h.db = activeDb(UID, 1);
      pageRequest({ "__Host-pod_session": session });
      const r = await renderPage(PAGES.settings, { notice: "withdrawal_unavailable" });
      const html = decode(r.html ?? "");
      const l = `flag ${JSON.stringify(flag)}`;
      expect(r.html, `${l}: settings renders`).toBeDefined();
      expect(postForms(html, "/auth/logout"), `${l}: account area with a POST logout form`).toHaveLength(1);
      expect(html, `${l}: no /account/withdraw link`).not.toContain('href="/account/withdraw"');
      expect(html, `${l}: no 계정 탈퇴 entry`).not.toContain("계정 탈퇴<");
      expect(html, `${l}: fixed notice`).toContain(WITHDRAW_NOTICE);
    }

    setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
    h.db = activeDb(UID, 1);
    pageRequest({ "__Host-pod_session": session });
    const on = decode((await renderPage(PAGES.settings)).html ?? "");
    expect(on, "enabled: link to /account/withdraw").toMatch(/<a[^>]*href="\/account\/withdraw"[^>]*>[^<]*계정 탈퇴/);
    expect(on, "no notice without the query").not.toContain(WITHDRAW_NOTICE);

    for (const notice of ["other", "<script>", "withdrawal_unavailable "]) {
      setEnv(env, { POD_WITHDRAWAL_ENABLED: "" });
      h.db = activeDb(UID, 1);
      pageRequest({ "__Host-pod_session": session });
      const html = decode((await renderPage(PAGES.settings, { notice })).html ?? "");
      expect(html, `notice ${JSON.stringify(notice)} is not in the allow list`).not.toContain(WITHDRAW_NOTICE);
      expect(html, "query value never reflected").not.toContain("<script>");
    }
  });

  it("signed-in /settings links the browser diary (/try/) with the not-migrated notice", async () => {
    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    setEnv(env, { POD_WITHDRAWAL_ENABLED: "1" });
    h.db = activeDb(UID, 1);
    pageRequest({ "__Host-pod_session": session });
    const html = decode((await renderPage(PAGES.settings)).html ?? "");
    expect(html).toMatch(/<a[^>]*href="\/try\/"[^>]*>[^<]*브라우저 기록장/);
    expect(html).toContain(TRY_NOTE);
  });
});

describe("GET /login and /account/restore (server pages)", () => {
  it("/login: unavailable auth → 로그인을 준비하고 있어요 without provider forms; a signed-in viewer is redirected to /", async () => {
    setEnv(NO_AUTH);
    pageRequest({});
    const off = decode((await renderPage(PAGES.login)).html ?? "");
    expect(off).toContain("로그인을 준비하고 있어요");
    expect(off).not.toMatch(/action="\/auth\/[a-z]+\/start"/);

    const env = authEnv();
    const session = (await sealSession(cfgFor(env), { userId: UID, gen: 1 })).value;
    setEnv(env);
    h.db = activeDb(UID, 1);
    pageRequest({ "__Host-pod_session": session });
    expect((await renderPage(PAGES.login)).redirect).toBe("/");
  });

  it("/login: enabled providers render POST forms to /auth/{p}/start in POD_AUTH_PROVIDERS order with a safe hidden returnTo, the /try/ link and notice", async () => {
    const mock = await mockFor();
    for (const [providers, order] of [
      ["google,kakao", ["google", "kakao"]],
      ["kakao,google", ["kakao", "google"]],
      ["google", ["google"]],
    ] as const) {
      setEnv(authEnv({ mock, providers }));
      pageRequest({});
      for (const [returnTo, expected] of [
        ["/days/2026-11-03", "/days/2026-11-03"],
        ["//evil.example", "/"],
        ["https://evil.example/x", "/"],
      ] as const) {
        const html = decode((await renderPage(PAGES.login, { returnTo })).html ?? "");
        const forms = tags(html, "form").filter((f) => /^\/auth\/[a-z]+\/start$/.test(f.get("action") ?? ""));
        expect(forms.map((f) => f.get("action")), `${providers}: provider order`).toEqual(order.map((p) => `/auth/${p}/start`));
        for (const f of forms) expect((f.get("method") ?? "").toLowerCase(), "POST form").toBe("post");
        const hidden = tags(html, "input").filter((i) => i.get("name") === "returnTo").map((i) => i.get("value"));
        expect(hidden.length, "one hidden returnTo per provider form").toBe(order.length);
        for (const v of hidden) expect(v, `returnTo ${returnTo}`).toBe(expected);
        expect(html, "never reflects an unsafe returnTo").not.toContain("evil.example");
      }
      const html = decode((await renderPage(PAGES.login)).html ?? "");
      expect(html).toMatch(/<a[^>]*href="\/try\/"[^>]*>[^<]*브라우저 기록장/);
      expect(html).toContain(TRY_NOTE);
      expect(html, "no artboard tool area in the product").not.toContain("정적 아트보드");
    }
  });

  it("/login shows only allow-listed error/notice texts (§6.3 · §8) and never reflects the query", async () => {
    setEnv(authEnv());
    const texts: Record<string, string> = {
      "error=cancelled": "로그인을 취소했어요. 다시 시도할 수 있어요.",
      "error=failed": "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
      "error=expired": "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요.",
      "error=purge_due": "복구 기간이 지나 이 계정을 되돌릴 수 없어요.",
      "notice=signed_out": "로그아웃했어요",
      "notice=withdrawn": "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요.",
    };
    const all = Object.values(texts);
    for (const [q, text] of Object.entries(texts)) {
      pageRequest({});
      const html = decode((await renderPage(PAGES.login, Object.fromEntries(new URLSearchParams(q)))).html ?? "");
      expect(html, q).toContain(text);
      for (const other of all) if (other !== text && !text.includes(other)) expect(html, `${q} must not show ${other}`).not.toContain(other);
    }
    for (const sp of [{ error: "bogus" }, { notice: "<b>x</b>" }, { error: "cancelled " }] as Record<string, string>[]) {
      pageRequest({});
      const html = decode((await renderPage(PAGES.login, sp)).html ?? "");
      for (const t of all) expect(html, `${JSON.stringify(sp)} shows no notice`).not.toContain(t);
      expect(html).not.toContain("<b>x</b>");
    }
  });

  it("/account/restore: a valid proof offers 복구하기 (POST /auth/restore) and 복구하지 않기 (POST /auth/logout); no or bad proof → expired text with a /login link; auth error → 준비 중", async () => {
    const env = authEnv();
    const proof = (await sealRecovery(cfgFor(env), { userId: UID, gen: 2 })).value;
    setEnv(env);
    pageRequest({ "__Host-pod_recovery": proof });
    const ok = decode((await renderPage(PAGES.restore)).html ?? "");
    expect(ok).toContain("탈퇴를 요청한 계정이에요. 복구할까요?");
    expect(postForms(ok, "/auth/restore"), "POST restore form").toHaveLength(1);
    expect(postForms(ok, "/auth/logout"), "POST logout form (복구하지 않기)").toHaveLength(1);
    expect(ok).toMatch(/<form[^>]*action="\/auth\/restore"[^>]*>[\s\S]*?복구하기[\s\S]*?<\/form>/);
    expect(ok).toMatch(/<form[^>]*action="\/auth\/logout"[^>]*>[\s\S]*?복구하지 않기[\s\S]*?<\/form>/);

    for (const cookies of [{}, { "__Host-pod_recovery": "garbage" }, { "__Host-pod_session": proof }] as Record<string, string>[]) {
      setEnv(env);
      pageRequest(cookies);
      const html = decode((await renderPage(PAGES.restore)).html ?? "");
      expect(html, JSON.stringify(Object.keys(cookies))).toContain("확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요.");
      expect(html).toMatch(/<a[^>]*href="\/login"/);
      expect(html).not.toMatch(/action="\/auth\/restore"/);
    }

    setEnv(NO_AUTH);
    pageRequest({ "__Host-pod_recovery": proof });
    const off = decode((await renderPage(PAGES.restore)).html ?? "");
    expect(off).toContain("준비");
    expect(off).not.toMatch(/action="\/auth\/restore"/);
  });
});
