/**
 * 실제 로그인 공급자 설정(PLAN_mvp-oidc-integration §4.1·§4.3). 서버 전용이다.
 *
 * - env는 인자로만 받는다. import 시 전역 env를 읽거나 접속하지 않고, 값을 바꾸거나 기록하지 않는다.
 * - 세션 설정은 기존 loadSessionConfig를 그대로 쓴다. issuer는 고정 상수이고 운영에서 env로 바꿀 수 없다.
 * - 판정 순서(0a → 8)는 계획 표를 따른다. fixture + 실제 auth 동시 사용만 throw한다.
 */
import "server-only";
import { authModeProblem } from "../runtime-mode";
import { loadSessionConfig } from "./session";
import type { SessionConfig } from "./session";
import type { Result } from "../result";

export const PROVIDER_IDS = ["google", "kakao"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const PROVIDER_ISSUERS: Readonly<Record<ProviderId, string>> = Object.freeze({
  google: "https://accounts.google.com",
  kakao: "https://kauth.kakao.com",
});

export type ProviderConfig = Readonly<{
  id: ProviderId;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
  insecureMock: boolean;
}>;
export type AuthConfig = Readonly<{
  session: SessionConfig;
  enabled: readonly ProviderId[];
  providers: Readonly<Partial<Record<ProviderId, ProviderConfig>>>;
}>;
export type AuthR = Result<AuthConfig, "auth_not_configured" | "invalid_config">;

const PROVIDERS_RE = /^(google|kakao)(,(google|kakao))*$/;
const MOCK_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENV_PREFIX: Readonly<Record<ProviderId, string>> = { google: "POD_AUTH_GOOGLE", kakao: "POD_AUTH_KAKAO" };

const isBlank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

/** 공급자 자격: 비어 있지 않고, 앞뒤 공백·제어문자가 없다. 값은 변형하지 않는다. */
const isCredential = (v: string | undefined): v is string =>
  typeof v === "string" && v !== "" && v === v.trim() && !CONTROL_RE.test(v);

/** 시험 전용 mock issuer: 정확히 http://127.0.0.1:<1-65535>, 원문 = URL.origin. */
function isMockIssuer(v: string): boolean {
  const port = MOCK_RE.exec(v)?.[1];
  if (port === undefined || Number(port) > 65535) return false;
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}

export function loadAuthConfig(env: Record<string, string | undefined>, nodeEnv: string | undefined): AuthR {
  const problem = authModeProblem(env, nodeEnv);
  if (problem === "fixture_with_auth") {
    throw new Error("POD_LOCAL_FIXTURE=1 cannot be combined with POD_AUTH_PROVIDERS");
  }
  const invalid = { ok: false, error: "invalid_config" } as const;
  if (problem === "mock_outside_dev") return invalid;

  const rawProviders = env.POD_AUTH_PROVIDERS;
  if (rawProviders === undefined || isBlank(rawProviders)) return { ok: false, error: "auth_not_configured" };

  const session = loadSessionConfig(env, nodeEnv);
  if (!session.ok) return session;

  if (!PROVIDERS_RE.test(rawProviders)) return invalid;
  const enabled = rawProviders.split(",") as ProviderId[];
  if (new Set(enabled).size !== enabled.length) return invalid;

  const credentials: { id: ProviderId; clientId: string; clientSecret: string }[] = [];
  for (const id of enabled) {
    const clientId = env[`${ENV_PREFIX[id]}_CLIENT_ID`];
    const clientSecret = env[`${ENV_PREFIX[id]}_CLIENT_SECRET`];
    if (!isCredential(clientId) || !isCredential(clientSecret)) return invalid;
    credentials.push({ id, clientId, clientSecret });
  }

  const mock = env.POD_AUTH_MOCK_OIDC_ISSUER;
  const useMock = mock !== undefined && !isBlank(mock);
  if (useMock && !isMockIssuer(mock)) return invalid;

  const providers: Partial<Record<ProviderId, ProviderConfig>> = {};
  for (const { id, clientId, clientSecret } of credentials) {
    providers[id] = Object.freeze({
      id,
      issuer: new URL(useMock ? `${mock}/${id}` : PROVIDER_ISSUERS[id]),
      clientId,
      clientSecret,
      redirectUri: new URL(`/auth/${id}/callback`, session.value.baseUrl),
      insecureMock: useMock,
    });
  }
  return {
    ok: true,
    value: Object.freeze({ session: session.value, enabled: Object.freeze([...enabled]), providers: Object.freeze(providers) }),
  };
}
