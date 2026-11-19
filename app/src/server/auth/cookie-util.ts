/**
 * flow·복구 쿠키 codec이 함께 쓰는 10분 수명 규칙과 쿠키 속성(PLAN_mvp-oidc-integration §5).
 * 세션 쿠키(session.ts)는 여기에 의존하지 않는다.
 */
import "server-only";
import type { SessionConfig } from "./session";

export const SHORT_COOKIE_TTL_MS = 600_000;
export const SHORT_COOKIE_TTL_SEC = 600;

const isEpochMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** iat·exp가 안전한 비음수 정수이고 0 < exp − iat ≤ 10분, iat ≤ now이면 true. */
export function validShortTimes(iat: unknown, exp: unknown, now: number): boolean {
  if (!isEpochMs(iat) || !isEpochMs(exp)) return false;
  return exp > iat && exp - iat <= SHORT_COOKIE_TTL_MS && iat <= now;
}

/** secure면 __Host- 접두 이름. HttpOnly·Lax·Path=/·expires, Domain 없음. */
export function shortCookieOptions<N extends string>(
  cfg: SessionConfig,
  baseName: N,
  expiresAt: Date,
): { name: `__Host-${N}` | N; httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } {
  return {
    name: cfg.secureCookies ? (`__Host-${baseName}` as const) : baseName,
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  };
}

/** unseal 결과가 정확히 keys 집합의 키만 가진 plain 객체인지. */
export function hasExactKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
