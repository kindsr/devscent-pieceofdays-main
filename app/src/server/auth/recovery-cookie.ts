/**
 * 계정 복구 확인 쿠키 codec(PLAN_mvp-oidc-integration §5, PLAN_account-lifecycle §3). 서버 전용이다.
 * 발급은 B2 callback의 pending_deletion 분기에서만 한다. 일반 세션 API와 서로 읽히지 않는다(purpose·키 수).
 */
import "server-only";
import { sealData, unsealData } from "iron-session";
import { isUuid } from "../ids";
import type { SessionSubject } from "../account/lifecycle";
import { SHORT_COOKIE_TTL_MS, SHORT_COOKIE_TTL_SEC, hasExactKeys, shortCookieOptions, validShortTimes } from "./cookie-util";
import type { SessionConfig } from "./session";
import type { Result } from "../result";

const RECOVERY_KEYS = ["purpose", "v", "userId", "gen", "iat", "exp"] as const;

const isGen = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export async function sealRecovery(cfg: SessionConfig, s: SessionSubject): Promise<{ value: string; expiresAt: Date }> {
  if (!isUuid(s.userId)) throw new Error("sealRecovery: userId must be a UUID");
  if (!isGen(s.gen)) throw new Error("sealRecovery: gen must be a safe positive integer");
  const iat = cfg.now().getTime();
  const exp = iat + SHORT_COOKIE_TTL_MS;
  const value = await sealData(
    { purpose: "account_recovery", v: 1, userId: s.userId, gen: s.gen, iat, exp },
    { password: cfg.secrets, ttl: SHORT_COOKIE_TTL_SEC },
  );
  return { value, expiresAt: new Date(exp) };
}

export async function readRecovery(
  cfg: SessionConfig,
  sealed: string | undefined,
): Promise<Result<{ userId: string; gen: number; expiresAt: Date }, "missing" | "invalid" | "expired">> {
  if (sealed === undefined || sealed === "") return { ok: false, error: "missing" };
  const invalid = { ok: false, error: "invalid" } as const;
  if (typeof sealed !== "string") return invalid;
  const p: unknown = await unsealData(sealed, { password: cfg.secrets });
  if (!hasExactKeys(p, RECOVERY_KEYS)) return invalid;
  const { purpose, v, userId, gen, iat, exp } = p;
  if (purpose !== "account_recovery" || v !== 1 || !isUuid(userId) || !isGen(gen)) return invalid;
  const now = cfg.now().getTime();
  if (!validShortTimes(iat, exp, now)) return invalid;
  if ((exp as number) <= now) return { ok: false, error: "expired" };
  return { ok: true, value: { userId, gen, expiresAt: new Date(exp as number) } };
}

export function recoveryCookieOptions(
  cfg: SessionConfig,
  expiresAt: Date,
): { name: "__Host-pod_recovery" | "pod_recovery"; httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } {
  return shortCookieOptions(cfg, "pod_recovery", expiresAt);
}
