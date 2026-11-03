// F4a RED — 공급자 무관 봉인 세션 codec(PLAN_mvp-authentication §5 전체, §8 ② 기능 시험 사례).
// 대상 app/src/server/auth/session.ts는 아직 없다. 각 it 안에서 절대경로를 동적 import하고 export 존재를 먼저 단언한다
// (정적 import TS2307·beforeAll 실패로 인한 0 수집/skip을 피한다).
//
// - 암호 API는 실제 iron-session 9.0.1이다. vi.mock은 sealData·unsealData를 **원래 구현을 그대로 호출하는 관찰 spy**로
//   감쌀 뿐이며, 결과를 바꾸거나 통과시키지 않는다(§5.3 "missing은 unseal 호출 전", "ttl: 604_800" 관찰용).
// - 위조 payload는 같은 cfg.secrets로 실제 iron sealData(ttl 604800)를 호출해 만든다(봉인은 정상, 내용만 계약 밖).
// - 시계는 cfg.now 주입만 쓴다. iron 자체 TTL(raw Date.now)은 별도 child 프로세스에서 가짜 Date.now로 관찰한다.
// - 모든 키·URL·사용자 ID는 시험 전용 가짜 값이다. 실제 비밀값을 쓰지 않는다.
// - 메시지 문구, 새 오류 코드, 복구 쿠키 API는 시험하지 않는다(§5.4: 복구 쿠키는 F4b/c).
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as iron from "iron-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("iron-session", async (importOriginal) => {
  const real = await importOriginal<typeof import("iron-session")>();
  return { ...real, sealData: vi.fn(real.sealData), unsealData: vi.fn(real.unsealData) };
});

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SESSION_MODULE = path.join(APP_DIR, "src", "server", "auth", "session.ts");
const NOOP_MODULE = path.join(APP_DIR, "tests", "server-only-noop.ts");

// ---------------------------------------------------------------- 최소 로컬 계약 타입(§5.1)

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type SessionConfig = Readonly<{
  secrets: Readonly<Record<number, string>>;
  baseUrl: URL;
  secureCookies: boolean;
  now: () => Date;
}>;
type SessionModule = {
  loadSessionConfig: (
    env: Record<string, string | undefined>,
    nodeEnv: string | undefined,
  ) => Result<SessionConfig, "auth_not_configured" | "invalid_config">;
  sealSession: (cfg: SessionConfig, subject: { userId: string; gen: number }) => Promise<{ value: string; expiresAt: Date }>;
  readSession: (
    cfg: SessionConfig,
    sealed: string | undefined,
  ) => Promise<Result<{ userId: string; gen: number; expiresAt: Date }, "missing" | "invalid" | "expired">>;
  sessionCookieOptions: (
    cfg: SessionConfig,
    expiresAt: Date,
  ) => { name: string; httpOnly: boolean; secure: boolean; sameSite: string; path: string; expires: Date };
  assertSameOrigin: (cfg: SessionConfig, origin: string | null) => Result<null, "origin_missing" | "origin_mismatch">;
};

const EXPORTS = ["loadSessionConfig", "sealSession", "readSession", "sessionCookieOptions", "assertSameOrigin"] as const;

async function load(): Promise<SessionModule> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ SESSION_MODULE)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F4a product module src/server/auth/session.ts could not be loaded (expected before GREEN): ${msg}`);
  }
  for (const name of EXPORTS) expect(typeof mod[name], `session.ts must export function ${name}`).toBe("function");
  return mod as unknown as SessionModule;
}

// ---------------------------------------------------------------- 가짜 값·도우미

const SEVEN_DAYS_MS = 604_800_000;
const key = (n: number) => `ci-only-session-key-${n}-`.padEnd(40, "x"); // 40자, 가짜
const USER = "0190f3a2-7c1e-7d4b-9a01-0123456789ab";
const BASE = "https://pieceofdays.example";

const envOf = (secrets: unknown, base: string | undefined = BASE): Record<string, string | undefined> => ({
  POD_AUTH_SESSION_SECRETS: typeof secrets === "string" ? secrets : JSON.stringify(secrets),
  POD_AUTH_BASE_URL: base,
});

function okConfig(m: SessionModule, env: Record<string, string | undefined>, nodeEnv: string | undefined, label = ""): SessionConfig {
  const r = m.loadSessionConfig(env, nodeEnv);
  expect(r, `config ok ${label}`).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`unexpected ${r.error} ${label}`);
  return r.value;
}

/** 운영 https cfg(키 맵 지정 가능). */
const prodConfig = (m: SessionModule, secrets: Record<string, string> = { "1": key(1) }) =>
  okConfig(m, envOf(secrets), "production");

const at = (cfg: SessionConfig, ms: number): SessionConfig => ({ ...cfg, now: () => new Date(ms) });
/** 실제 현재 시각(초 단위로 내림). iron 자체 TTL이 시험 도중 지나지 않게 실제 시각 근처를 쓴다. */
const realNow = () => Math.floor(Date.now() / 1000) * 1000;

/** 같은 키 맵으로 실제 iron을 써서 임의 payload를 정상 봉인한다(내용만 계약 밖). */
const forge = (cfg: SessionConfig, payload: unknown) =>
  iron.sealData(payload, { password: cfg.secrets as unknown as Record<string, string>, ttl: 604_800 });

const sealSpy = vi.mocked(iron.sealData);
const unsealSpy = vi.mocked(iron.unsealData);
beforeEach(() => {
  sealSpy.mockClear();
  unsealSpy.mockClear();
});

const INVALID = { ok: false, error: "invalid" };
const EXPIRED = { ok: false, error: "expired" };
const MISSING = { ok: false, error: "missing" };
const NOT_CONFIGURED = { ok: false, error: "auth_not_configured" };
const INVALID_CONFIG = { ok: false, error: "invalid_config" };

// ================================================================ §5.2 loadSessionConfig

describe("loadSessionConfig (§5.2, evaluated top to bottom)", () => {
  it("accepts a valid production https config: origin-normalized baseUrl, secureCookies, raw secrets map, real-clock now; env is not mutated", async () => {
    const m = await load();
    const raw = `  ${key(2)}  `; // 값은 trim·변형하지 않는다
    const env = Object.freeze(envOf({ "1": key(1), "2": raw }, "HTTPS://Pieceofdays.Example:443/"));
    const cfg = okConfig(m, env, "production");
    expect(cfg.baseUrl).toBeInstanceOf(URL);
    expect(cfg.baseUrl.href).toBe("https://pieceofdays.example/");
    expect(cfg.baseUrl.origin).toBe(BASE);
    expect(cfg.secureCookies).toBe(true);
    expect(cfg.secrets[1]).toBe(key(1));
    expect(cfg.secrets[2]).toBe(raw);
    expect(Object.keys(cfg.secrets).sort()).toEqual(["1", "2"]);
    const before = Date.now();
    const now = cfg.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(env).toEqual(envOf({ "1": key(1), "2": raw }, "HTTPS://Pieceofdays.Example:443/"));
  });

  it("row 1: missing or blank SECRETS/BASE_URL → auth_not_configured (before any other check)", async () => {
    const m = await load();
    const cases: [string, Record<string, string | undefined>][] = [
      ["both missing", {}],
      ["secrets missing", { POD_AUTH_BASE_URL: BASE }],
      ["base missing", { POD_AUTH_SESSION_SECRETS: JSON.stringify({ "1": key(1) }) }],
      ["secrets empty", envOf("")],
      ["secrets blank", envOf("   ")],
      ["base empty", envOf({ "1": key(1) }, "")],
      ["base blank", envOf({ "1": key(1) }, " \t ")],
      ["base undefined", { ...envOf({ "1": key(1) }), POD_AUTH_BASE_URL: undefined }],
      ["missing beats malformed", { POD_AUTH_SESSION_SECRETS: "not json" }],
      ["blank beats bad url", envOf(" ", "not a url")],
    ];
    for (const [label, env] of cases) {
      expect(m.loadSessionConfig(env, "production"), label).toEqual(NOT_CONFIGURED);
      expect(m.loadSessionConfig(env, "development"), `${label} (development)`).toEqual(NOT_CONFIGURED);
    }
  });

  it("row 2: SECRETS that are not a JSON object, or an empty object → invalid_config", async () => {
    const m = await load();
    for (const secrets of ["not json", "{", "[]", `["${key(1)}"]`, "null", "1", "true", `"${key(1)}"`, "{}"]) {
      expect(m.loadSessionConfig(envOf(secrets), "production"), secrets).toEqual(INVALID_CONFIG);
    }
  });

  it("row 3: keys must be positive decimal integers without leading zero within the safe range", async () => {
    const m = await load();
    for (const k of ["0", "01", "-1", "1.5", "1e3", "a", "", " 1", "+1", "0x1", "9007199254740992", "99999999999999999999"]) {
      expect(m.loadSessionConfig(envOf({ [k]: key(1) }), "production"), `key ${JSON.stringify(k)}`).toEqual(INVALID_CONFIG);
      expect(
        m.loadSessionConfig(envOf({ "1": key(1), [k]: key(2) }), "production"),
        `key ${JSON.stringify(k)} next to a valid key`,
      ).toEqual(INVALID_CONFIG);
    }
    const cfg = okConfig(m, envOf({ "1": key(1), "10": key(10), "9007199254740991": key(3) }), "production");
    expect(cfg.secrets[10]).toBe(key(10));
    expect(cfg.secrets[9007199254740991]).toBe(key(3));
  });

  it("row 4: values must be strings of ≥ 32 UTF-16 code units that are not whitespace-only (not trimmed)", async () => {
    const m = await load();
    const bad: [string, unknown][] = [
      ["31 chars", "a".repeat(31)],
      ["32 spaces", " ".repeat(32)],
      ["32 mixed whitespace", " \t\n".repeat(11).slice(0, 32)],
      ["31 code units (15 emoji + 1)", `${"😀".repeat(15)}a`],
      ["number", 1234],
      ["null", null],
      ["object", { k: key(1) }],
      ["array", [key(1)]],
    ];
    for (const [label, value] of bad) {
      expect(m.loadSessionConfig(envOf({ "1": value }), "production"), label).toEqual(INVALID_CONFIG);
    }
    const ok32 = "b".repeat(32);
    const emoji32 = "😀".repeat(16); // 32 UTF-16 code units
    const padded = `  ${"c".repeat(30)}  `; // 34 code units, 공백만은 아님
    const cfg = okConfig(m, envOf({ "1": ok32, "2": emoji32, "3": padded }), "production");
    expect([cfg.secrets[1], cfg.secrets[2], cfg.secrets[3]]).toEqual([ok32, emoji32, padded]);
  });

  it("rows 5–6: BASE_URL must parse, be http(s), and have no userinfo/path/query/hash (root slash and empty ?/# allowed)", async () => {
    const m = await load();
    for (const base of [
      "not a url",
      "pieceofdays.example",
      "ftp://pieceofdays.example",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pass@pieceofdays.example",
      "https://user@pieceofdays.example",
      "https://pieceofdays.example/app",
      "https://pieceofdays.example/app/",
      "https://pieceofdays.example/?a=1",
      "https://pieceofdays.example/#x",
    ]) {
      expect(m.loadSessionConfig(envOf({ "1": key(1) }, base), "production"), base).toEqual(INVALID_CONFIG);
    }
    for (const base of [BASE, `${BASE}/`, `${BASE}/?`, `${BASE}#`, `${BASE}/?#`]) {
      const cfg = okConfig(m, envOf({ "1": key(1) }, base), "production", base);
      expect(cfg.baseUrl.href, base).toBe(`${BASE}/`);
    }
  });

  it("row 7: development/test http loopback (localhost, 127.0.0.1, [::1], WHATWG-normalized 127.1 / 0x7f.0.0.1) → ok with secureCookies false", async () => {
    const m = await load();
    const cases: [string, string][] = [
      ["http://localhost", "http://localhost"],
      ["http://localhost:3000", "http://localhost:3000"],
      ["http://127.0.0.1:3100/", "http://127.0.0.1:3100"],
      ["http://[::1]:8080", "http://[::1]:8080"],
      ["http://127.1", "http://127.0.0.1"],
      ["http://0x7f.0.0.1:3000", "http://127.0.0.1:3000"],
      ["HTTP://LOCALHOST:80/", "http://localhost"],
    ];
    for (const nodeEnv of ["development", "test"]) {
      for (const [base, origin] of cases) {
        const cfg = okConfig(m, envOf({ "1": key(1) }, base), nodeEnv, `${nodeEnv} ${base}`);
        expect(cfg.secureCookies, `${nodeEnv} ${base}`).toBe(false);
        expect(cfg.baseUrl.origin, `${nodeEnv} ${base}`).toBe(origin);
      }
    }
  });

  it("row 8: production rules (also for empty/other/case-variant nodeEnv) reject http and https loopback; development rejects other http hosts and https loopback", async () => {
    const m = await load();
    const env = (base: string) => envOf({ "1": key(1) }, base);
    const prodRejected = [
      "http://pieceofdays.example",
      "http://localhost:3000",
      "http://127.0.0.1",
      "https://localhost",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://127.5.6.7",
      "https://127.255.255.254",
      "https://[::1]",
      "https://127.1",
      "https://0x7f.0.0.1",
    ];
    for (const nodeEnv of ["production", "", undefined, "staging", "Development", "TEST", " development"]) {
      for (const base of prodRejected) {
        expect(m.loadSessionConfig(env(base), nodeEnv), `${String(nodeEnv)} ${base}`).toEqual(INVALID_CONFIG);
      }
      const ok = okConfig(m, env("https://pieceofdays.example:8443"), nodeEnv, String(nodeEnv));
      expect(ok.secureCookies).toBe(true);
      expect(ok.baseUrl.origin).toBe("https://pieceofdays.example:8443");
    }
    for (const nodeEnv of ["development", "test"]) {
      for (const base of [
        "http://pieceofdays.example",
        "http://192.168.0.10:3000",
        "http://10.0.0.1",
        "http://localhost.example",
        "http://127.0.0.2",
        "https://localhost",
        "https://127.0.0.1:3000",
        "https://[::1]",
      ]) {
        expect(m.loadSessionConfig(env(base), nodeEnv), `${nodeEnv} ${base}`).toEqual(INVALID_CONFIG);
      }
      expect(okConfig(m, env(BASE), nodeEnv).secureCookies, `${nodeEnv} https public`).toBe(true);
    }
  });
});

// ================================================================ §5.3 sealSession / readSession

describe("sealSession / readSession (§5.3)", () => {
  it("round-trips {userId, gen} with an exact 7-day expiry from the injected clock, sealing a 5-key payload with iron ttl 604800", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = at(prodConfig(m), t0);
    const sealed = await m.sealSession(cfg, { userId: USER, gen: 3 });
    expect(typeof sealed.value).toBe("string");
    expect(sealed.value.length).toBeGreaterThan(0);
    expect(sealed.expiresAt).toBeInstanceOf(Date);
    expect(sealed.expiresAt.getTime()).toBe(t0 + SEVEN_DAYS_MS);
    // 실제 iron 봉인 호출 관찰(원래 구현 그대로): password는 cfg 키 맵, ttl은 정확히 604800초
    expect(sealSpy).toHaveBeenCalledTimes(1);
    expect(sealSpy.mock.calls[0]![1]).toMatchObject({ password: cfg.secrets, ttl: 604_800 });
    // 봉인 내용은 정확히 키 5개
    const payload = await iron.unsealData<Record<string, unknown>>(sealed.value, {
      password: cfg.secrets as unknown as Record<string, string>,
    });
    expect(payload).toEqual({ v: 1, userId: USER, gen: 3, iat: t0, exp: t0 + SEVEN_DAYS_MS });
    expect(await m.readSession(cfg, sealed.value)).toEqual({
      ok: true,
      value: { userId: USER, gen: 3, expiresAt: new Date(t0 + SEVEN_DAYS_MS) },
    });
  });

  it("is ok until exp − 1 ms and expired at exp and later (injected clock only)", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = prodConfig(m);
    const { value } = await m.sealSession(at(cfg, t0), { userId: USER, gen: 1 });
    const exp = t0 + SEVEN_DAYS_MS;
    expect(await m.readSession(at(cfg, exp - 1), value)).toMatchObject({ ok: true, value: { userId: USER, gen: 1 } });
    expect(await m.readSession(at(cfg, exp), value)).toEqual(EXPIRED);
    expect(await m.readSession(at(cfg, exp + 1), value)).toEqual(EXPIRED);
    expect(await m.readSession(at(cfg, exp + 30 * 86_400_000), value)).toEqual(EXPIRED);
  });

  it("gen accepts safe positive integers up to MAX_SAFE_INTEGER", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = at(prodConfig(m), t0);
    for (const gen of [1, 2, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const { value } = await m.sealSession(cfg, { userId: USER, gen });
      expect(await m.readSession(cfg, value), `gen ${gen}`).toMatchObject({ ok: true, value: { userId: USER, gen } });
    }
  });

  it("sealSession throws for a non-UUID userId or an invalid gen", async () => {
    const m = await load();
    const cfg = at(prodConfig(m), realNow());
    const attempt = (subject: { userId: unknown; gen: unknown }) =>
      (async () => m.sealSession(cfg, subject as { userId: string; gen: number }))();
    for (const userId of ["", "not-a-uuid", `${USER}x`, USER.replace(/-/g, ""), 1, null]) {
      await expect(attempt({ userId, gen: 1 }), `userId ${JSON.stringify(userId)}`).rejects.toBeDefined();
    }
    for (const gen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined]) {
      await expect(attempt({ userId: USER, gen }), `gen ${String(gen)}`).rejects.toBeDefined();
    }
  });

  it("undefined and \"\" are missing before unseal is called; other unreadable strings are invalid", async () => {
    const m = await load();
    const cfg = at(prodConfig(m), realNow());
    expect(await m.readSession(cfg, undefined)).toEqual(MISSING);
    expect(await m.readSession(cfg, "")).toEqual(MISSING);
    expect(unsealSpy, "missing is decided before unsealData").not.toHaveBeenCalled();
    const { value } = await m.sealSession(cfg, { userId: USER, gen: 1 });
    // iron이 무시하는 끝 버전 메타데이터 대신 인증 영역을 변조한다.
    const mid = Math.floor(value.length / 2);
    const tampered = value.slice(0, mid) + (value[mid] === "a" ? "b" : "a") + value.slice(mid + 1);
    for (const sealed of [" ", "   ", "abc", "Fe26.2*1*abc", tampered]) {
      expect(await m.readSession(cfg, sealed), JSON.stringify(sealed.slice(0, 24))).toEqual(INVALID);
    }
  });

  it("key rotation: seals with the highest-numbered key, reads seals made with an older key in the map, rejects unknown keys", async () => {
    const m = await load();
    const t0 = realNow();
    const oldCfg = at(prodConfig(m, { "1": key(1) }), t0);
    const rotated = at(prodConfig(m, { "1": key(1), "2": key(2) }), t0);
    const onlyNew = at(prodConfig(m, { "2": key(2) }), t0);
    const other = at(prodConfig(m, { "1": key(9) }), t0);
    const old = await m.sealSession(oldCfg, { userId: USER, gen: 1 });
    expect(await m.readSession(rotated, old.value)).toMatchObject({ ok: true, value: { userId: USER, gen: 1 } });
    expect(await m.readSession(other, old.value)).toEqual(INVALID);
    const fresh = await m.sealSession(rotated, { userId: USER, gen: 2 });
    expect(await m.readSession(onlyNew, fresh.value)).toMatchObject({ ok: true, value: { gen: 2 } });
    expect(await m.readSession(oldCfg, fresh.value)).toEqual(INVALID);
  });

  it("authenticated payloads outside the 5-key contract are invalid (keys, v, userId, gen, iat/exp types, recovery-purpose payload)", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = at(prodConfig(m), t0);
    const good = { v: 1, userId: USER, gen: 1, iat: t0, exp: t0 + SEVEN_DAYS_MS };
    // 양성 제어: 같은 방식으로 봉인한 정상 payload는 ok
    expect(await m.readSession(cfg, await forge(cfg, good))).toMatchObject({ ok: true, value: { userId: USER, gen: 1 } });
    const without = (k: keyof typeof good) => {
      const c: Record<string, unknown> = { ...good };
      delete c[k];
      return c;
    };
    const bad: [string, unknown][] = [
      ["{}", {}],
      ["array", [good]],
      ["string", "payload"],
      ["null", null],
      ["missing v", without("v")],
      ["missing userId", without("userId")],
      ["missing gen", without("gen")],
      ["missing iat", without("iat")],
      ["missing exp", without("exp")],
      ["extra key", { ...good, role: "admin" }],
      ["recovery-purpose payload (6 keys)", { purpose: "account_recovery", ...good }],
      ["v 2", { ...good, v: 2 }],
      ["v '1'", { ...good, v: "1" }],
      ["userId not UUID", { ...good, userId: "not-a-uuid" }],
      ["userId number", { ...good, userId: 1 }],
      ["gen 0", { ...good, gen: 0 }],
      ["gen -1", { ...good, gen: -1 }],
      ["gen 1.5", { ...good, gen: 1.5 }],
      ["gen '1'", { ...good, gen: "1" }],
      ["gen 2^53", { ...good, gen: 2 ** 53 }],
      ["gen null", { ...good, gen: null }],
      ["iat negative", { ...good, iat: -1, exp: SEVEN_DAYS_MS - 2 }],
      ["iat fraction", { ...good, iat: t0 - 0.5, exp: t0 + 3_600_000 }],
      ["iat string", { ...good, iat: String(t0) }],
      ["exp fraction", { ...good, exp: t0 + 1000.5 }],
      ["exp string", { ...good, exp: String(t0 + 1000) }],
      ["exp unsafe", { ...good, exp: 2 ** 53 }],
    ];
    for (const [label, payload] of bad) {
      expect(await m.readSession(cfg, await forge(cfg, payload)), label).toEqual(INVALID);
    }
  });

  it("time rules: future iat, exp ≤ iat and lifetimes over 7 days are invalid; shorter lifetimes are accepted; authentic past exp is expired", async () => {
    const m = await load();
    const t0 = realNow();
    const cfg = at(prodConfig(m), t0);
    const p = (iat: number, exp: number) => ({ v: 1, userId: USER, gen: 4, iat, exp });
    const invalid: [string, unknown][] = [
      ["iat 1 ms in the future", p(t0 + 1, t0 + 1 + 3_600_000)],
      ["exp == iat", p(t0 - 1000, t0 - 1000)],
      ["exp < iat", p(t0 - 1000, t0 - 2000)],
      ["lifetime 7 days + 1 ms", p(t0 - 1000, t0 - 1000 + SEVEN_DAYS_MS + 1)],
      ["lifetime 30 days", p(t0 - 1000, t0 - 1000 + 30 * 86_400_000)],
    ];
    for (const [label, payload] of invalid) {
      expect(await m.readSession(cfg, await forge(cfg, payload)), label).toEqual(INVALID);
    }
    expect(await m.readSession(cfg, await forge(cfg, p(t0, t0 + 3_600_000))), "1 hour lifetime").toEqual({
      ok: true,
      value: { userId: USER, gen: 4, expiresAt: new Date(t0 + 3_600_000) },
    });
    expect(await m.readSession(cfg, await forge(cfg, p(t0 - 1000, t0 - 1000 + SEVEN_DAYS_MS))), "exactly 7 days").toMatchObject({
      ok: true,
    });
    expect(await m.readSession(cfg, await forge(cfg, p(t0 - SEVEN_DAYS_MS, t0))), "exp == now").toEqual(EXPIRED);
    expect(await m.readSession(cfg, await forge(cfg, p(t0 - 2 * 3_600_000, t0 - 3_600_000))), "exp in the past").toEqual(
      EXPIRED,
    );
  });

  it("iron's own TTL (raw Date.now) passing makes a seal invalid even while the app clock is before exp (child process, fake Date.now)", async () => {
    await load(); // 모듈이 없으면 여기서 명시적으로 실패한다
    const t0 = realNow();
    const out = await runRawTtlChild({ t0 });
    expect(out.error, `child failed: ${out.stderr}`).toBeUndefined();
    // 양성 제어: iron 시계·앱 시계 모두 1시간 뒤 → ok
    expect(out.withinTtl).toMatchObject({ ok: true, value: { userId: USER, gen: 7 } });
    // iron 자체 TTL(7일 + 60초 skew)을 넘긴 가짜 Date.now, 앱 시계는 1시간 뒤 → invalid(인증된 만료 아님)
    expect(out.rawTtlPassed).toEqual(INVALID);
  });
});

// ================================================================ §5.3 쿠키·Origin

describe("sessionCookieOptions / assertSameOrigin (§5.3)", () => {
  it("cookie name and attributes follow secureCookies; no Domain attribute", async () => {
    const m = await load();
    const expires = new Date(realNow() + SEVEN_DAYS_MS);
    const secure = m.sessionCookieOptions(prodConfig(m), expires);
    expect(secure).toEqual({
      name: "__Host-pod_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires,
    });
    const devCfg = okConfig(m, envOf({ "1": key(1) }, "http://127.0.0.1:3100"), "development");
    const dev = m.sessionCookieOptions(devCfg, expires);
    expect(dev).toEqual({ name: "pod_session", httpOnly: true, secure: false, sameSite: "lax", path: "/", expires });
    expect("domain" in secure || "domain" in dev).toBe(false);
  });

  it("assertSameOrigin accepts only the exact serialized base origin", async () => {
    const m = await load();
    const cfg = okConfig(m, envOf({ "1": key(1) }, `${BASE}/`), "production");
    expect(m.assertSameOrigin(cfg, BASE)).toEqual({ ok: true, value: null });
    expect(m.assertSameOrigin(cfg, null)).toEqual({ ok: false, error: "origin_missing" });
    expect(m.assertSameOrigin(cfg, "")).toEqual({ ok: false, error: "origin_missing" });
    for (const origin of [
      "null",
      " ",
      ` ${BASE}`,
      `${BASE} `,
      `${BASE}/`,
      `${BASE}/path`,
      `${BASE}, https://evil.example`,
      "http://pieceofdays.example",
      "https://pieceofdays.example:8443",
      "https://pieceofdays.example:443",
      "https://PIECEOFDAYS.example",
      "https://evil.example",
      "https://sub.pieceofdays.example",
      "not a url",
    ]) {
      expect(m.assertSameOrigin(cfg, origin), JSON.stringify(origin)).toEqual({ ok: false, error: "origin_mismatch" });
    }
    const dev = okConfig(m, envOf({ "1": key(1) }, "http://localhost:3000"), "development");
    expect(m.assertSameOrigin(dev, "http://localhost:3000")).toEqual({ ok: true, value: null });
    for (const origin of ["http://localhost", "http://127.0.0.1:3000", "https://localhost:3000"]) {
      expect(m.assertSameOrigin(dev, origin), origin).toEqual({ ok: false, error: "origin_mismatch" });
    }
  });
});

// ================================================================ child: iron 자체 TTL 관찰

type ChildOut = { withinTtl?: unknown; rawTtlPassed?: unknown; error?: string; stderr?: string };

/**
 * 별도 Node 프로세스에서 Date.now만 가짜로 바꿔 iron 자체 TTL을 관찰한다(제품의 전역 시계는 건드리지 않는다).
 * 제품 모듈은 Node 자체 TS 실행으로 읽고, `server-only`·`@/` alias·확장자 없는 상대 경로만 resolve hook으로 맞춘다.
 */
function runRawTtlChild(input: { t0: number }): Promise<ChildOut> {
  const script = `
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const I = JSON.parse(process.env.POD_F4A_CHILD_INPUT);
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: pathToFileURL(I.noop).href, shortCircuit: true };
    let target = null;
    if (specifier.startsWith("@/")) target = path.join(I.appDir, "src", specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:"))
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (target) for (const c of [target, target + ".ts", target + ".tsx", path.join(target, "index.ts")])
      if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
    return next(specifier, context);
  },
});
let fake = I.t0;
Date.now = () => fake;
try {
  const m = await import(pathToFileURL(I.sessionModule).href);
  const r = m.loadSessionConfig(I.env, "production");
  if (!r.ok) throw new Error("config " + r.error);
  const sealed = await m.sealSession({ ...r.value, now: () => new Date(I.t0) }, { userId: I.userId, gen: 7 });
  const appLater = { ...r.value, now: () => new Date(I.t0 + 3600000) };
  fake = I.t0 + 3600000;
  const withinTtl = await m.readSession(appLater, sealed.value);
  fake = I.t0 + 604800000 + 120000;
  const rawTtlPassed = await m.readSession(appLater, sealed.value);
  process.stdout.write("POD_F4A_CHILD=" + JSON.stringify({ withinTtl, rawTtlPassed }) + "\\n");
} catch (err) {
  process.stdout.write("POD_F4A_CHILD=" + JSON.stringify({ error: String(err && err.stack || err) }) + "\\n");
}
`;
  const payload = JSON.stringify({
    t0: input.t0,
    appDir: APP_DIR,
    sessionModule: SESSION_MODULE,
    noop: NOOP_MODULE,
    userId: USER,
    env: envOf({ "1": key(1) }),
  });
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: APP_DIR,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POD_F4A_CHILD_INPUT: payload },
        timeout: 60_000,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith("POD_F4A_CHILD="));
        if (!line) {
          resolve({ error: `no child result (${err ? String(err.message) : "exit 0"})`, stderr });
          return;
        }
        const parsed = JSON.parse(line.slice("POD_F4A_CHILD=".length)) as ChildOut;
        resolve({ ...parsed, stderr });
      },
    );
  });
}
