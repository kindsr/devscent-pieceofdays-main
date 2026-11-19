// F4 B1 RED — OAuth flow 쿠키 codec(PLAN_mvp-oidc-integration §5, §9 U2). **형식만** 검사한다.
// 현재 enabled 공급자·설정 issuer와의 바인딩은 B2 callback 몫이라 여기서 섞지 않는다. mock issuer 형식 허용이 운영 허용을 뜻하지 않는다.
//
// - 대상 app/src/server/auth/flow-cookie.ts는 각 it 안에서 동적 import한다.
// - 암호 API는 실제 iron-session 9.0.1이다. vi.mock은 sealData·unsealData를 원래 구현 그대로 호출하는 **관찰 spy**로 감싼다
//   (ttl 600 관찰, missing이면 unseal 미호출 확인). 결과를 바꾸거나 통과시키지 않는다.
// - 계약 밖 payload는 같은 키 맵으로 실제 iron.sealData(ttl 600)를 호출해 만든다. 시계는 cfg.now 주입이다.
// - raw iron TTL(600초 + iron 60초 skew)은 별도 child 프로세스에서 가짜 Date.now로만 관찰한다.
import * as iron from "iron-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  DEV_BASE,
  EXPIRED,
  FLOW_COOKIE_MODULE,
  INVALID,
  MISSING,
  SEVEN_DAYS_MS,
  TEN_MIN_MS,
  USER,
  at,
  cfgOf,
  forge,
  key,
  loadModule,
  realNow,
  runRawTtlChild,
  tamper,
  type CookieOptions,
  type Result,
  type SessionConfig,
} from "./auth-b1-support";

vi.mock("iron-session", async (importOriginal) => {
  const real = await importOriginal<typeof import("iron-session")>();
  return { ...real, sealData: vi.fn(real.sealData), unsealData: vi.fn(real.unsealData) };
});
const sealSpy = vi.mocked(iron.sealData);
const unsealSpy = vi.mocked(iron.unsealData);
beforeEach(() => {
  sealSpy.mockClear();
  unsealSpy.mockClear();
});

type FlowInput = { provider: "google" | "kakao"; issuer: string; state: string; nonce: string; codeVerifier: string; returnTo: string };
type FlowApi = {
  sealFlow: (cfg: SessionConfig, f: FlowInput) => Promise<{ value: string; expiresAt: Date }>;
  readFlow: (cfg: SessionConfig, sealed: string | undefined) => Promise<Result<FlowInput & { expiresAt: Date }, "missing" | "invalid" | "expired">>;
  flowCookieOptions: (cfg: SessionConfig, expiresAt: Date) => CookieOptions;
};
const load = () => loadModule<FlowApi>(FLOW_COOKIE_MODULE, { sealFlow: "function", readFlow: "function", flowCookieOptions: "function" });

const b64 = (seed: string) => `${seed}${"AbCd09_-".repeat(6)}`.slice(0, 43);
const FLOW: FlowInput = {
  provider: "google",
  issuer: "https://accounts.google.com/",
  state: b64("state"),
  nonce: b64("nonce"),
  codeVerifier: b64("verif"),
  returnTo: "/days/2026-11-03",
};
const payloadOf = (f: FlowInput, iat: number, exp = iat + TEN_MIN_MS) => ({ purpose: "oauth_flow", v: 1, ...f, iat, exp });

describe("sealFlow / readFlow: round trip and timing", () => {
  it("seals exactly 10 keys with exp = iat + 600000 and iron ttl 600; readFlow returns the input and expiresAt", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const sealed = await m.sealFlow(cfg, FLOW);
    expect(sealed.expiresAt.getTime()).toBe(t0 + TEN_MIN_MS);
    expect(sealSpy).toHaveBeenCalledTimes(1);
    expect(sealSpy.mock.calls[0]![1]).toMatchObject({ password: cfg.secrets, ttl: 600 });
    const raw = await iron.unsealData<Record<string, unknown>>(sealed.value, { password: cfg.secrets as unknown as Record<string, string> });
    expect(raw).toEqual(payloadOf(FLOW, t0));
    expect(await m.readFlow(cfg, sealed.value)).toEqual({ ok: true, value: { ...FLOW, expiresAt: new Date(t0 + TEN_MIN_MS) } });
    // mock issuer 형식(http 127.0.0.1:port)도 형식상 허용된다(운영 허용 여부는 B2 callback이 판정)
    const mock: FlowInput = { ...FLOW, provider: "kakao", issuer: "http://127.0.0.1:4010/kakao", returnTo: "/" };
    const s2 = await m.sealFlow(cfg, mock);
    expect(await m.readFlow(cfg, s2.value)).toEqual({ ok: true, value: { ...mock, expiresAt: new Date(t0 + TEN_MIN_MS) } });
  });

  it("is ok until exp − 1 ms and expired at exp and later (injected clock); shorter lifetimes are accepted", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const { value } = await m.sealFlow(cfg, FLOW);
    expect(await m.readFlow(at(cfg, t0 + TEN_MIN_MS - 1), value)).toMatchObject({ ok: true });
    expect(await m.readFlow(at(cfg, t0 + TEN_MIN_MS), value)).toEqual(EXPIRED);
    expect(await m.readFlow(at(cfg, t0 + 2 * TEN_MIN_MS), value)).toEqual(EXPIRED);
    const short = await forge(cfg, payloadOf(FLOW, t0, t0 + 60_000));
    expect(await m.readFlow(cfg, short)).toEqual({ ok: true, value: { ...FLOW, expiresAt: new Date(t0 + 60_000) } });
  });

  it("undefined and \"\" are missing before unseal; garbage, tampering and unknown keys are invalid; key rotation reads older keys", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    expect(await m.readFlow(cfg, undefined)).toEqual(MISSING);
    expect(await m.readFlow(cfg, "")).toEqual(MISSING);
    expect(unsealSpy, "missing is decided before unsealData").not.toHaveBeenCalled();
    const { value } = await m.sealFlow(cfg, FLOW);
    for (const sealed of [" ", "abc", "Fe26.2*1*abc", tamper(value)]) {
      expect(await m.readFlow(cfg, sealed), JSON.stringify(sealed.slice(0, 20))).toEqual(INVALID);
    }
    expect(await m.readFlow(cfgOf({ secrets: { 1: key(9) }, now: t0 }), value), "other key").toEqual(INVALID);
    const rotated = cfgOf({ secrets: { 1: key(1), 2: key(2) }, now: t0 });
    expect(await m.readFlow(rotated, value), "older key in the map").toMatchObject({ ok: true });
    const fresh = await m.sealFlow(rotated, FLOW);
    expect(await m.readFlow(cfgOf({ secrets: { 2: key(2) }, now: t0 }), fresh.value), "sealed with the highest key").toMatchObject({ ok: true });
    expect(await m.readFlow(cfgOf({ secrets: { 1: key(1) }, now: t0 }), fresh.value), "key 2 removed").toEqual(INVALID);
  });

  it("iron's own ttl 600 (raw Date.now, beyond the 60 s skew) makes the seal invalid while the app clock is still before exp (child process)", async () => {
    await load();
    const t0 = realNow();
    const out = await runRawTtlChild({
      module: FLOW_COOKIE_MODULE,
      sealExport: "sealFlow",
      readExport: "readFlow",
      sealArg: FLOW,
      t0,
      appLaterMs: t0 + 60_000,
      rawWithinMs: t0 + 60_000,
      rawPassedMs: t0 + TEN_MIN_MS + 61_000 + 60_000,
    });
    expect(out.error, `child failed: ${out.stderr}`).toBeUndefined();
    expect(out.withinTtl).toMatchObject({ ok: true });
    expect(out.rawTtlPassed).toEqual(INVALID);
  });
});

describe("readFlow: authenticated payloads outside the format are invalid", () => {
  it("keys, purpose, v and provider", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const good = payloadOf(FLOW, t0);
    expect(await m.readFlow(cfg, await forge(cfg, good)), "positive control").toMatchObject({ ok: true });
    const without = (k: string) => {
      const c: Record<string, unknown> = { ...good };
      delete c[k];
      return c;
    };
    const bad: [string, unknown][] = [
      ["{}", {}],
      ["array", [good]],
      ["string", "flow"],
      ["null", null],
      ...Object.keys(good).map((k): [string, unknown] => [`missing ${k}`, without(k)]),
      ["extra key", { ...good, userId: USER }],
      ["purpose account_recovery", { ...good, purpose: "account_recovery" }],
      ["purpose session", { ...good, purpose: "session" }],
      ["v 2", { ...good, v: 2 }],
      ["v '1'", { ...good, v: "1" }],
      ["provider naver", { ...good, provider: "naver" }],
      ["provider Google", { ...good, provider: "Google" }],
      ["session 5-key payload", { v: 1, userId: USER, gen: 1, iat: t0, exp: t0 + SEVEN_DAYS_MS }],
      ["recovery 6-key payload", { purpose: "account_recovery", v: 1, userId: USER, gen: 1, iat: t0, exp: t0 + TEN_MIN_MS }],
    ];
    for (const [label, payload] of bad) expect(await m.readFlow(cfg, await forge(cfg, payload)), label).toEqual(INVALID);
  });

  it("issuer format: https, or http 127.0.0.1 with a port; original string must equal URL.href; no userinfo/query/hash; ≤ 256 chars", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    for (const issuer of ["https://a.b/", "http://127.0.0.1:1/x", "https://kauth.kakao.com/", "http://127.0.0.1:65535/google"]) {
      expect(await m.readFlow(cfg, await forge(cfg, payloadOf({ ...FLOW, issuer }, t0))), issuer).toMatchObject({ ok: true });
    }
    for (const issuer of [
      "https://a.b", // href는 끝 슬래시가 붙어 원문과 다르다
      "http://localhost:1/x",
      "http://127.0.0.1/x", // port 없음
      "http://127.0.0.2:1/x",
      "http://a.b/",
      "ftp://a.b/",
      "https://u:p@a.b/",
      "https://u@a.b/",
      "https://a.b/?x=1",
      "https://a.b/#x",
      "HTTPS://A.B/",
      " https://a.b/",
      "not a url",
      `https://a.b/${"x".repeat(250)}`,
    ]) {
      expect(await m.readFlow(cfg, await forge(cfg, payloadOf({ ...FLOW, issuer }, t0))), issuer.slice(0, 40)).toEqual(INVALID);
    }
    expect(await m.readFlow(cfg, await forge(cfg, { ...payloadOf(FLOW, t0), issuer: 1 })), "issuer number").toEqual(INVALID);
  });

  it("state/nonce/codeVerifier must be base64url of exactly 43 chars; returnTo must pass parseReturnTo unchanged", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    for (const field of ["state", "nonce", "codeVerifier"] as const) {
      for (const v of [b64("x").slice(0, 42), `${b64("x")}A`, `${b64("x").slice(0, 42)}+`, `${b64("x").slice(0, 42)}=`, `${b64("x").slice(0, 42)}/`, ""]) {
        expect(await m.readFlow(cfg, await forge(cfg, payloadOf({ ...FLOW, [field]: v }, t0))), `${field} ${v.length}`).toEqual(INVALID);
      }
      expect(await m.readFlow(cfg, await forge(cfg, { ...payloadOf(FLOW, t0), [field]: 43 })), `${field} number`).toEqual(INVALID);
    }
    for (const returnTo of ["//evil.example", "/login", "https://evil.example/", "/days/2026-02-30", "/days/", ""]) {
      expect(await m.readFlow(cfg, await forge(cfg, payloadOf({ ...FLOW, returnTo }, t0))), returnTo).toEqual(INVALID);
    }
  });

  it("time rules: future iat, exp ≤ iat, lifetime > 600000, negative / fractional / string / unsafe times are invalid", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const p = (iat: unknown, exp: unknown) => ({ ...payloadOf(FLOW, t0), iat, exp });
    const bad: [string, unknown][] = [
      ["future iat", p(t0 + 1, t0 + 1 + 60_000)],
      ["exp == iat", p(t0 - 1000, t0 - 1000)],
      ["exp < iat", p(t0 - 1000, t0 - 2000)],
      ["lifetime 600001", p(t0 - 1000, t0 - 1000 + TEN_MIN_MS + 1)],
      ["lifetime 7 days", p(t0 - 1000, t0 - 1000 + SEVEN_DAYS_MS)],
      ["iat negative", p(-1, TEN_MIN_MS - 2)],
      ["iat fraction", p(t0 - 0.5, t0 + 60_000)],
      ["exp fraction", p(t0, t0 + 1000.5)],
      ["iat string", p(String(t0), t0 + 60_000)],
      ["exp unsafe", p(t0, 2 ** 53)],
    ];
    for (const [label, payload] of bad) expect(await m.readFlow(cfg, await forge(cfg, payload)), label).toEqual(INVALID);
    expect(await m.readFlow(cfg, await forge(cfg, p(t0 - TEN_MIN_MS, t0))), "authentic exp == now").toEqual(EXPIRED);
  });
});

describe("sealFlow input checks and cookie options", () => {
  it("sealFlow throws when the input breaks the same format rules", async () => {
    const m = await load();
    const cfg = cfgOf();
    const bad: [string, unknown][] = [
      ["provider naver", { ...FLOW, provider: "naver" }],
      ["issuer localhost", { ...FLOW, issuer: "http://localhost:1/x" }],
      ["issuer without slash", { ...FLOW, issuer: "https://accounts.google.com" }],
      ["state 42", { ...FLOW, state: FLOW.state.slice(0, 42) }],
      ["nonce with +", { ...FLOW, nonce: `${FLOW.nonce.slice(0, 42)}+` }],
      ["verifier 44", { ...FLOW, codeVerifier: `${FLOW.codeVerifier}A` }],
      ["returnTo //evil", { ...FLOW, returnTo: "//evil.example" }],
    ];
    for (const [label, input] of bad) {
      await expect((async () => m.sealFlow(cfg, input as FlowInput))(), label).rejects.toBeDefined();
    }
  });

  it("flowCookieOptions: __Host-pod_oauth with Secure for https, pod_oauth for development http; HttpOnly, Lax, Path=/, expires, no Domain", async () => {
    const m = await load();
    const expires = new Date(realNow() + TEN_MIN_MS);
    const secure = m.flowCookieOptions(cfgOf({ base: BASE }), expires);
    expect(secure).toEqual({ name: "__Host-pod_oauth", httpOnly: true, secure: true, sameSite: "lax", path: "/", expires });
    const dev = m.flowCookieOptions(cfgOf({ base: DEV_BASE }), expires);
    expect(dev).toEqual({ name: "pod_oauth", httpOnly: true, secure: false, sameSite: "lax", path: "/", expires });
    expect("domain" in secure || "domain" in dev).toBe(false);
  });
});
