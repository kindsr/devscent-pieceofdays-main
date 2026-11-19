// F4 B1 RED — 계정 복구 확인 쿠키 codec(PLAN_mvp-oidc-integration §5, §9 U3; PLAN_account-lifecycle §3).
// 복구 증명은 B2 callback의 pending_deletion 분기에서만 발급한다. 여기서는 codec 형식·시각·이름만 시험한다.
//
// - 대상 app/src/server/auth/recovery-cookie.ts는 각 it 안에서 동적 import한다. F4a session.ts는 변경 없이 대조군으로 쓴다.
// - 실제 iron-session 9.0.1을 쓴다. vi.mock은 원래 구현을 그대로 호출하는 관찰 spy뿐이다(ttl 600, missing이면 unseal 미호출).
// - raw iron TTL은 별도 child 프로세스의 가짜 Date.now로만 관찰한다.
import * as iron from "iron-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  DEV_BASE,
  EXPIRED,
  INVALID,
  MISSING,
  RECOVERY_COOKIE_MODULE,
  SESSION_MODULE,
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

type Subject = { userId: string; gen: number };
type RecoveryApi = {
  sealRecovery: (cfg: SessionConfig, s: Subject) => Promise<{ value: string; expiresAt: Date }>;
  readRecovery: (cfg: SessionConfig, sealed: string | undefined) => Promise<Result<{ userId: string; gen: number; expiresAt: Date }, "missing" | "invalid" | "expired">>;
  recoveryCookieOptions: (cfg: SessionConfig, expiresAt: Date) => CookieOptions;
};
type SessionApi = {
  sealSession: (cfg: SessionConfig, s: Subject) => Promise<{ value: string; expiresAt: Date }>;
  readSession: (cfg: SessionConfig, sealed: string | undefined) => Promise<Result<unknown, string>>;
};
const load = () =>
  loadModule<RecoveryApi>(RECOVERY_COOKIE_MODULE, { sealRecovery: "function", readRecovery: "function", recoveryCookieOptions: "function" });
const loadSession = () => loadModule<SessionApi>(SESSION_MODULE, { sealSession: "function", readSession: "function" });

const payloadOf = (s: Subject, iat: number, exp = iat + TEN_MIN_MS) => ({ purpose: "account_recovery", v: 1, ...s, iat, exp });

describe("sealRecovery / readRecovery", () => {
  it("seals exactly 6 keys with exp = iat + 600000 and iron ttl 600; readRecovery returns {userId, gen, expiresAt}", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const sealed = await m.sealRecovery(cfg, { userId: USER, gen: 3 });
    expect(sealed.expiresAt.getTime()).toBe(t0 + TEN_MIN_MS);
    expect(sealSpy).toHaveBeenCalledTimes(1);
    expect(sealSpy.mock.calls[0]![1]).toMatchObject({ password: cfg.secrets, ttl: 600 });
    const raw = await iron.unsealData<Record<string, unknown>>(sealed.value, { password: cfg.secrets as unknown as Record<string, string> });
    expect(raw).toEqual(payloadOf({ userId: USER, gen: 3 }, t0));
    expect(await m.readRecovery(cfg, sealed.value)).toEqual({
      ok: true,
      value: { userId: USER, gen: 3, expiresAt: new Date(t0 + TEN_MIN_MS) },
    });
    for (const gen of [1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const s = await m.sealRecovery(cfg, { userId: USER, gen });
      expect(await m.readRecovery(cfg, s.value), `gen ${gen}`).toMatchObject({ ok: true, value: { userId: USER, gen } });
    }
  });

  it("ok until exp − 1 ms, expired at exp (injected clock); shorter lifetimes accepted", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const { value } = await m.sealRecovery(cfg, { userId: USER, gen: 2 });
    expect(await m.readRecovery(at(cfg, t0 + TEN_MIN_MS - 1), value)).toMatchObject({ ok: true });
    expect(await m.readRecovery(at(cfg, t0 + TEN_MIN_MS), value)).toEqual(EXPIRED);
    expect(await m.readRecovery(at(cfg, t0 + SEVEN_DAYS_MS), value)).toEqual(EXPIRED);
    const short = await forge(cfg, payloadOf({ userId: USER, gen: 2 }, t0, t0 + 30_000));
    expect(await m.readRecovery(cfg, short)).toEqual({ ok: true, value: { userId: USER, gen: 2, expiresAt: new Date(t0 + 30_000) } });
  });

  it("sealRecovery throws for a non-UUID userId or a gen that is not a safe positive integer", async () => {
    const m = await load();
    const cfg = cfgOf();
    const attempt = (s: { userId: unknown; gen: unknown }) => (async () => m.sealRecovery(cfg, s as Subject))();
    for (const userId of ["", "not-a-uuid", `${USER}x`, USER.replace(/-/g, ""), 1, null]) {
      await expect(attempt({ userId, gen: 1 }), `userId ${JSON.stringify(userId)}`).rejects.toBeDefined();
    }
    for (const gen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined]) {
      await expect(attempt({ userId: USER, gen }), `gen ${String(gen)}`).rejects.toBeDefined();
    }
  });

  it("missing before unseal; garbage/tampered/other key invalid; key rotation (older key readable, removed key invalid)", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    expect(await m.readRecovery(cfg, undefined)).toEqual(MISSING);
    expect(await m.readRecovery(cfg, "")).toEqual(MISSING);
    expect(unsealSpy, "missing is decided before unsealData").not.toHaveBeenCalled();
    const { value } = await m.sealRecovery(cfg, { userId: USER, gen: 1 });
    for (const sealed of [" ", "abc", "Fe26.2*1*abc", tamper(value)]) {
      expect(await m.readRecovery(cfg, sealed), JSON.stringify(sealed.slice(0, 20))).toEqual(INVALID);
    }
    expect(await m.readRecovery(cfgOf({ secrets: { 1: key(9) }, now: t0 }), value)).toEqual(INVALID);
    const rotated = cfgOf({ secrets: { 1: key(1), 2: key(2) }, now: t0 });
    expect(await m.readRecovery(rotated, value)).toMatchObject({ ok: true });
    const fresh = await m.sealRecovery(rotated, { userId: USER, gen: 1 });
    expect(await m.readRecovery(cfgOf({ secrets: { 2: key(2) }, now: t0 }), fresh.value)).toMatchObject({ ok: true });
    expect(await m.readRecovery(cfgOf({ secrets: { 1: key(1) }, now: t0 }), fresh.value)).toEqual(INVALID);
  });

  it("payloads outside the 6-key contract are invalid (keys, purpose, v, userId, gen, times, session and flow payloads)", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const good = payloadOf({ userId: USER, gen: 1 }, t0);
    expect(await m.readRecovery(cfg, await forge(cfg, good)), "positive control").toMatchObject({ ok: true });
    const without = (k: string) => {
      const c: Record<string, unknown> = { ...good };
      delete c[k];
      return c;
    };
    const bad: [string, unknown][] = [
      ["{}", {}],
      ["array", [good]],
      ["null", null],
      ...Object.keys(good).map((k): [string, unknown] => [`missing ${k}`, without(k)]),
      ["extra key", { ...good, returnTo: "/" }],
      ["purpose oauth_flow", { ...good, purpose: "oauth_flow" }],
      ["v 2", { ...good, v: 2 }],
      ["userId not UUID", { ...good, userId: "not-a-uuid" }],
      ["gen 0", { ...good, gen: 0 }],
      ["gen 1.5", { ...good, gen: 1.5 }],
      ["gen '1'", { ...good, gen: "1" }],
      ["gen 2^53", { ...good, gen: 2 ** 53 }],
      ["future iat", { ...good, iat: t0 + 1, exp: t0 + 1 + 60_000 }],
      ["exp == iat", { ...good, iat: t0 - 1000, exp: t0 - 1000 }],
      ["lifetime 600001", { ...good, iat: t0 - 1000, exp: t0 - 1000 + TEN_MIN_MS + 1 }],
      ["iat negative", { ...good, iat: -1, exp: TEN_MIN_MS - 2 }],
      ["exp fraction", { ...good, exp: t0 + 1000.5 }],
      ["session 5-key payload", { v: 1, userId: USER, gen: 1, iat: t0, exp: t0 + SEVEN_DAYS_MS }],
      [
        "flow 10-key payload",
        { purpose: "oauth_flow", v: 1, provider: "google", issuer: "https://accounts.google.com/", state: "s".repeat(43), nonce: "n".repeat(43), codeVerifier: "c".repeat(43), returnTo: "/", iat: t0, exp: t0 + TEN_MIN_MS },
      ],
    ];
    for (const [label, payload] of bad) expect(await m.readRecovery(cfg, await forge(cfg, payload)), label).toEqual(INVALID);
    expect(await m.readRecovery(cfg, await forge(cfg, { ...good, iat: t0 - TEN_MIN_MS, exp: t0 })), "authentic exp == now").toEqual(EXPIRED);
  });

  it("session and recovery values are not interchangeable: readSession(recovery) and readRecovery(session) are invalid", async () => {
    const m = await load();
    const session = await loadSession();
    const t0 = realNow();
    const cfg = cfgOf({ now: t0 });
    const rec = await m.sealRecovery(cfg, { userId: USER, gen: 2 });
    const ses = await session.sealSession(cfg, { userId: USER, gen: 2 });
    expect(await session.readSession(cfg, rec.value)).toEqual(INVALID);
    expect(await m.readRecovery(cfg, ses.value)).toEqual(INVALID);
    // 대조: 각자 자기 reader로는 읽힌다
    expect(await session.readSession(cfg, ses.value)).toMatchObject({ ok: true });
    expect(await m.readRecovery(cfg, rec.value)).toMatchObject({ ok: true });
  });

  it("iron's own ttl 600 (raw Date.now beyond the 60 s skew) → invalid while the app clock is before exp (child process)", async () => {
    await load();
    const t0 = realNow();
    const out = await runRawTtlChild({
      module: RECOVERY_COOKIE_MODULE,
      sealExport: "sealRecovery",
      readExport: "readRecovery",
      sealArg: { userId: USER, gen: 4 },
      t0,
      appLaterMs: t0 + 60_000,
      rawWithinMs: t0 + 60_000,
      rawPassedMs: t0 + TEN_MIN_MS + 61_000 + 60_000,
    });
    expect(out.error, `child failed: ${out.stderr}`).toBeUndefined();
    expect(out.withinTtl).toMatchObject({ ok: true, value: { userId: USER, gen: 4 } });
    expect(out.rawTtlPassed).toEqual(INVALID);
  });

  it("recoveryCookieOptions: __Host-pod_recovery (Secure) / pod_recovery (development http); HttpOnly, Lax, Path=/, expires, no Domain", async () => {
    const m = await load();
    const expires = new Date(realNow() + TEN_MIN_MS);
    const secure = m.recoveryCookieOptions(cfgOf({ base: BASE }), expires);
    expect(secure).toEqual({ name: "__Host-pod_recovery", httpOnly: true, secure: true, sameSite: "lax", path: "/", expires });
    const dev = m.recoveryCookieOptions(cfgOf({ base: DEV_BASE }), expires);
    expect(dev).toEqual({ name: "pod_recovery", httpOnly: true, secure: false, sameSite: "lax", path: "/", expires });
    expect("domain" in secure || "domain" in dev).toBe(false);
  });
});
