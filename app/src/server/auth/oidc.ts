/**
 * OIDC 어댑터(PLAN_mvp-oidc-integration §6.1). 서버 전용이다.
 *
 * - discovery·인가 요청·code 교환·ID Token 검증은 openid-client 6.8.9가 한다. 제품은 JWT를 파싱하거나 서명을 검증하지 않는다.
 * - 항상 enableNonRepudiationChecks(ID Token 서명 검증)를 켜고, insecureMock일 때만 allowInsecureRequests를 더한다.
 * - token·ID Token 원문·vendor 오류 객체는 저장·반환·로그하지 않는다. userinfo는 호출하지 않는다.
 */
import "server-only";
import {
  AuthorizationResponseError,
  ClientSecretPost,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";
import type { Configuration } from "openid-client";
import type { ProviderConfig } from "./config";
import { sealFlow } from "./flow-cookie";
import type { FlowInput } from "./flow-cookie";
import type { SessionConfig } from "./session";
import type { Result } from "../result";

/** issuer.href·clientId·clientSecret·insecureMock 조합별 Configuration(프로세스 메모리, 실패는 캐시하지 않음). */
const configurations = new Map<string, Promise<Configuration>>();

function configurationFor(p: ProviderConfig): Promise<Configuration> {
  const key = JSON.stringify([p.issuer.href, p.clientId, p.clientSecret, p.insecureMock]);
  const cached = configurations.get(key);
  if (cached) return cached;
  const execute = p.insecureMock ? [allowInsecureRequests, enableNonRepudiationChecks] : [enableNonRepudiationChecks];
  const pending = discovery(p.issuer, p.clientId, p.clientSecret, ClientSecretPost(p.clientSecret), { execute });
  configurations.set(key, pending);
  pending.catch(() => {
    if (configurations.get(key) === pending) configurations.delete(key);
  });
  return pending;
}

async function tryConfiguration(p: ProviderConfig): Promise<Configuration | null> {
  try {
    return await configurationFor(p);
  } catch {
    return null;
  }
}

/** 인가 요청 URL과 flow 쿠키를 만든다. discovery 실패만 provider_unavailable이다. */
export async function beginLogin(
  p: ProviderConfig,
  session: SessionConfig,
  returnTo: string,
): Promise<Result<{ authorizeUrl: URL; flow: { value: string; expiresAt: Date } }, "provider_unavailable">> {
  const config = await tryConfiguration(p);
  if (config === null) return { ok: false, error: "provider_unavailable" };
  const codeVerifier = randomPKCECodeVerifier();
  const state = randomState();
  const nonce = randomNonce();
  const authorizeUrl = buildAuthorizationUrl(config, {
    redirect_uri: p.redirectUri.href,
    scope: "openid",
    response_type: "code",
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const flow = await sealFlow(session, { provider: p.id, issuer: p.issuer.href, state, nonce, codeVerifier, returnTo });
  return { ok: true, value: { authorizeUrl, flow } };
}

/**
 * callback query를 검증하고 code를 교환한다. currentUrl은 설정 redirectUri에 들어온 query의 모든 entry를 순서대로 append한다
 * (중복 매개변수를 vendor가 거부하게 set·중복 제거를 쓰지 않는다).
 */
export async function finishLogin(
  p: ProviderConfig,
  flow: FlowInput,
  query: URLSearchParams,
): Promise<Result<{ subject: string }, "provider_unavailable" | "cancelled" | "rejected">> {
  const config = await tryConfiguration(p);
  if (config === null) return { ok: false, error: "provider_unavailable" };
  const currentUrl = new URL(p.redirectUri.href);
  for (const [k, v] of query) currentUrl.searchParams.append(k, v);
  try {
    const tokens = await authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const subject = tokens.claims()?.sub;
    if (typeof subject !== "string") return { ok: false, error: "rejected" };
    return { ok: true, value: { subject } };
  } catch (err) {
    // vendor가 iss·state를 검증한 뒤 돌려준 인가 오류만 취소로 본다.
    if (err instanceof AuthorizationResponseError && err.error === "access_denied") return { ok: false, error: "cancelled" };
    return { ok: false, error: "rejected" };
  }
}
