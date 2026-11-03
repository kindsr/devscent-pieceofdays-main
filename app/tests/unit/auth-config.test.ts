// F4 B1 RED — loadAuthConfig(PLAN_mvp-oidc-integration §4.1·§4.3, §9 U1b). 순서(우선순위)와 auth 설정 결합에 집중한다.
// 기존 F4a loadSessionConfig의 세부 검증은 auth-session.test.ts가 맡으므로 여기서 복제하지 않는다.
// 신규 app/src/server/auth/config.ts는 각 it 안에서 동적 import한다. 실제 discovery·공급자 HTTP는 없다. 모든 값은 가짜다.
import { describe, expect, it } from "vitest";
import { AUTH_CONFIG_MODULE, BASE, DEV_BASE, SESSION_MODULE, key, loadModule, type Result, type SessionConfig } from "./auth-b1-support";

type ProviderId = "google" | "kakao";
type ProviderConfig = Readonly<{
  id: ProviderId;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
  insecureMock: boolean;
}>;
type AuthConfig = Readonly<{
  session: SessionConfig;
  enabled: readonly ProviderId[];
  providers: Readonly<Partial<Record<ProviderId, ProviderConfig>>>;
}>;
type ConfigApi = {
  PROVIDER_IDS: readonly string[];
  PROVIDER_ISSUERS: Readonly<Record<string, string>>;
  loadAuthConfig: (env: Record<string, string | undefined>, nodeEnv: string | undefined) => Result<AuthConfig, "auth_not_configured" | "invalid_config">;
};
const load = () =>
  loadModule<ConfigApi>(AUTH_CONFIG_MODULE, { PROVIDER_IDS: "object", PROVIDER_ISSUERS: "object", loadAuthConfig: "function" });

type Env = Record<string, string | undefined>;
const SESSION = { POD_AUTH_SESSION_SECRETS: JSON.stringify({ "1": key(1) }), POD_AUTH_BASE_URL: BASE };
const CREDS = {
  POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-id",
  POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
  POD_AUTH_KAKAO_CLIENT_ID: "ci-only-kakao-id",
  POD_AUTH_KAKAO_CLIENT_SECRET: "ci-only-kakao-secret",
};
const MOCK = "http://127.0.0.1:4010";
const NOT_CONFIGURED = { ok: false, error: "auth_not_configured" };
const INVALID_CONFIG = { ok: false, error: "invalid_config" };

function okValue(r: Result<AuthConfig, string>, label = ""): AuthConfig {
  expect(r, `ok ${label}`).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  return r.value;
}

describe("auth constants", () => {
  it("PROVIDER_IDS is [google, kakao] and the issuers are the fixed discovery issuers", async () => {
    const m = await load();
    expect([...m.PROVIDER_IDS]).toEqual(["google", "kakao"]);
    expect({ ...m.PROVIDER_ISSUERS }).toEqual({ google: "https://accounts.google.com", kakao: "https://kauth.kakao.com" });
  });
});

describe("loadAuthConfig: ordering (§4.3 rows 0a → 8)", () => {
  it("0a: fixture + non-blank PROVIDERS throws before anything else (invalid session, malformed PROVIDERS, MOCK in production)", async () => {
    const m = await load();
    const cases: [string, Env, string | undefined][] = [
      ["valid otherwise", { ...SESSION, ...CREDS, POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google" }, "development"],
      ["session invalid", { POD_AUTH_SESSION_SECRETS: "{}", POD_AUTH_BASE_URL: "nope", POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google" }, "test"],
      ["malformed PROVIDERS", { ...SESSION, POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "Google" }, "development"],
      ["MOCK + production", { POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google", POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, "production"],
    ];
    for (const [label, env, nodeEnv] of cases) expect(() => m.loadAuthConfig(env, nodeEnv), label).toThrow();
  });

  it("0b: non-blank MOCK outside development/test → invalid_config even when PROVIDERS and session are missing (before row 1)", async () => {
    const m = await load();
    for (const nodeEnv of ["production", undefined, "", "staging"]) {
      expect(m.loadAuthConfig({ POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, nodeEnv), String(nodeEnv)).toEqual(INVALID_CONFIG);
      expect(m.loadAuthConfig({ ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: "google", POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, nodeEnv)).toEqual(
        INVALID_CONFIG,
      );
    }
  });

  it("1–3: blank PROVIDERS → auth_not_configured; then session not configured → auth_not_configured, session invalid → invalid_config (before PROVIDERS format)", async () => {
    const m = await load();
    for (const providers of [undefined, "", "  "]) {
      expect(m.loadAuthConfig({ ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: providers }, "production"), JSON.stringify(providers)).toEqual(
        NOT_CONFIGURED,
      );
      expect(m.loadAuthConfig({ POD_AUTH_PROVIDERS: providers }, "production")).toEqual(NOT_CONFIGURED);
    }
    // fixture만 켜져 있으면(PROVIDERS 없음) 충돌이 아니고 auth_not_configured
    expect(m.loadAuthConfig({ ...SESSION, POD_LOCAL_FIXTURE: "1" }, "development")).toEqual(NOT_CONFIGURED);
    // 2행: session 미설정이 PROVIDERS 형식 오류보다 먼저
    expect(m.loadAuthConfig({ ...CREDS, POD_AUTH_PROVIDERS: "google" }, "production")).toEqual(NOT_CONFIGURED);
    expect(m.loadAuthConfig({ ...CREDS, POD_AUTH_PROVIDERS: "GOOGLE" }, "production")).toEqual(NOT_CONFIGURED);
    // 3행: session invalid(운영의 http·loopback base 포함)가 PROVIDERS 형식·자격보다 먼저
    for (const base of ["http://pieceofdays.example", "https://127.0.0.1", "not a url"]) {
      expect(m.loadAuthConfig({ ...SESSION, POD_AUTH_BASE_URL: base, POD_AUTH_PROVIDERS: "google" }, "production"), base).toEqual(INVALID_CONFIG);
    }
    expect(m.loadAuthConfig({ ...SESSION, POD_AUTH_BASE_URL: "http://x.example", POD_AUTH_PROVIDERS: "naver" }, "production")).toEqual(
      INVALID_CONFIG,
    );
  });

  it("4: PROVIDERS must match ^(google|kakao)(,(google|kakao))*$ without duplicates", async () => {
    const m = await load();
    for (const providers of ["google,", ",google", "google,google", "google, kakao", " google", "GOOGLE", "naver", "google;kakao", "google,,kakao", "kakao,google,kakao"]) {
      expect(m.loadAuthConfig({ ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: providers }, "production"), providers).toEqual(INVALID_CONFIG);
    }
  });

  it("5: every listed provider needs a non-blank ID and SECRET without surrounding whitespace or control characters (no partial enablement)", async () => {
    const m = await load();
    const both = { ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: "google,kakao" };
    const bad: [string, string | undefined][] = [
      ["missing", undefined],
      ["empty", ""],
      ["blank", "   "],
      ["leading space", " ci-only-x"],
      ["trailing space", "ci-only-x "],
      ["NUL", "ci-only\u0000x"],
      ["newline", "ci-only\nx"],
      ["tab", "ci-only\tx"],
      ["US", "ci-only\u001fx"],
      ["DEL", "ci-only\u007fx"],
    ];
    for (const name of ["POD_AUTH_GOOGLE_CLIENT_ID", "POD_AUTH_GOOGLE_CLIENT_SECRET", "POD_AUTH_KAKAO_CLIENT_ID", "POD_AUTH_KAKAO_CLIENT_SECRET"]) {
      for (const [label, value] of bad) {
        expect(m.loadAuthConfig({ ...both, [name]: value }, "production"), `${name} ${label}`).toEqual(INVALID_CONFIG);
      }
    }
    // 길이 하한은 없고, 안쪽 공백은 제어문자가 아니다
    const ok = okValue(m.loadAuthConfig({ ...both, POD_AUTH_GOOGLE_CLIENT_ID: "x", POD_AUTH_KAKAO_CLIENT_SECRET: "a b" }, "production"));
    expect(ok.providers.google?.clientId).toBe("x");
    expect(ok.providers.kakao?.clientSecret).toBe("a b");
  });

  it("6: credentials of providers outside the list are ignored even when malformed", async () => {
    const m = await load();
    const cfg = okValue(
      m.loadAuthConfig(
        { ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: "google", POD_AUTH_KAKAO_CLIENT_ID: " bad\u0000", POD_AUTH_KAKAO_CLIENT_SECRET: undefined },
        "production",
      ),
    );
    expect(cfg.enabled).toEqual(["google"]);
    expect(Object.keys(cfg.providers)).toEqual(["google"]);
  });

  it("7: in development/test a non-blank MOCK must be exactly http://127.0.0.1:<1-65535> equal to its URL.origin", async () => {
    const m = await load();
    const dev = { POD_AUTH_SESSION_SECRETS: SESSION.POD_AUTH_SESSION_SECRETS, POD_AUTH_BASE_URL: DEV_BASE, ...CREDS, POD_AUTH_PROVIDERS: "google" };
    for (const mock of [
      "http://localhost:4010",
      "http://127.0.0.1:4010/",
      "http://127.0.0.1:4010/google",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:80", // 기본 포트는 origin에서 빠지므로 원문과 다르다
      "http://127.0.0.1:080",
      "https://127.0.0.1:4010",
      "http://u@127.0.0.1:4010",
      "http://127.0.0.1:4010?x=1",
      "http://127.0.0.1:4010#x",
      "http://127.0.0.2:4010",
      " http://127.0.0.1:4010",
      "not a url",
    ]) {
      for (const nodeEnv of ["development", "test"]) {
        expect(m.loadAuthConfig({ ...dev, POD_AUTH_MOCK_OIDC_ISSUER: mock }, nodeEnv), `${mock} / ${nodeEnv}`).toEqual(INVALID_CONFIG);
      }
    }
    for (const port of ["1", "4010", "65535"]) {
      okValue(m.loadAuthConfig({ ...dev, POD_AUTH_MOCK_OIDC_ISSUER: `http://127.0.0.1:${port}` }, "test"), port);
    }
  });
});

describe("loadAuthConfig: values (§4.3 row 8)", () => {
  it("production: fixed issuers, exact callback URIs on the session base, raw credentials, enabled order, session pass-through; env is not mutated", async () => {
    const m = await load();
    const session = await loadModule<{ loadSessionConfig: (e: Env, n: string | undefined) => Result<SessionConfig, string> }>(SESSION_MODULE, {
      loadSessionConfig: "function",
    });
    const env = Object.freeze({ ...SESSION, ...CREDS, POD_AUTH_PROVIDERS: "kakao,google" });
    const snapshot = { ...env };
    const cfg = okValue(m.loadAuthConfig(env, "production"));
    expect(env).toEqual(snapshot);
    expect([...cfg.enabled]).toEqual(["kakao", "google"]);
    expect(Object.keys(cfg.providers).sort()).toEqual(["google", "kakao"]);
    const g = cfg.providers.google!;
    const k = cfg.providers.kakao!;
    expect({ ...g, issuer: g.issuer.href, redirectUri: g.redirectUri.href }).toEqual({
      id: "google",
      issuer: "https://accounts.google.com/",
      clientId: CREDS.POD_AUTH_GOOGLE_CLIENT_ID,
      clientSecret: CREDS.POD_AUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: "https://pieceofdays.example/auth/google/callback",
      insecureMock: false,
    });
    expect({ ...k, issuer: k.issuer.href, redirectUri: k.redirectUri.href }).toEqual({
      id: "kakao",
      issuer: "https://kauth.kakao.com/",
      clientId: CREDS.POD_AUTH_KAKAO_CLIENT_ID,
      clientSecret: CREDS.POD_AUTH_KAKAO_CLIENT_SECRET,
      redirectUri: "https://pieceofdays.example/auth/kakao/callback",
      insecureMock: false,
    });
    expect(g.issuer).toBeInstanceOf(URL);
    expect(g.redirectUri).toBeInstanceOf(URL);
    const s = session.loadSessionConfig(env, "production");
    if (!s.ok) throw new Error(s.error);
    expect({ base: cfg.session.baseUrl.href, secure: cfg.session.secureCookies, secrets: { ...cfg.session.secrets } }).toEqual({
      base: s.value.baseUrl.href,
      secure: s.value.secureCookies,
      secrets: { ...s.value.secrets },
    });
    expect(typeof cfg.session.now).toBe("function");
  });

  it("development/test + valid MOCK: issuer = MOCK + /<id>, insecureMock true, redirect on the dev base", async () => {
    const m = await load();
    const env = { POD_AUTH_SESSION_SECRETS: SESSION.POD_AUTH_SESSION_SECRETS, POD_AUTH_BASE_URL: DEV_BASE, ...CREDS, POD_AUTH_PROVIDERS: "google,kakao", POD_AUTH_MOCK_OIDC_ISSUER: MOCK };
    for (const nodeEnv of ["development", "test"]) {
      const cfg = okValue(m.loadAuthConfig(env, nodeEnv), nodeEnv);
      expect(cfg.session.secureCookies).toBe(false);
      for (const id of ["google", "kakao"] as const) {
        const p = cfg.providers[id]!;
        expect({ issuer: p.issuer.href, redirectUri: p.redirectUri.href, insecureMock: p.insecureMock }, `${nodeEnv} ${id}`).toEqual({
          issuer: `${MOCK}/${id}`,
          redirectUri: `${DEV_BASE}/auth/${id}/callback`,
          insecureMock: true,
        });
      }
    }
  });
});
