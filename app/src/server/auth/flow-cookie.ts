/**
 * OAuth flow 쿠키 codec(PLAN_mvp-oidc-integration §5). 서버 전용이며 **형식만** 검사한다.
 * 현재 enabled 공급자·설정 issuer와의 바인딩은 B2 callback이 판정한다. 호출자는 issuer로 ProviderConfig.issuer.href를 넣는다.
 * raw iron unseal reason은 쓰지 않는다. 만료는 payload exp와 cfg.now()로만 판정한다.
 */
import "server-only";
import { sealData, unsealData } from "iron-session";
import { PROVIDER_IDS } from "./config";
import type { ProviderId } from "./config";
import { SHORT_COOKIE_TTL_MS, SHORT_COOKIE_TTL_SEC, hasExactKeys, shortCookieOptions, validShortTimes } from "./cookie-util";
import { parseReturnTo } from "./return-to";
import type { SessionConfig } from "./session";
import type { Result } from "../result";

export type FlowInput = { provider: ProviderId; issuer: string; state: string; nonce: string; codeVerifier: string; returnTo: string };

const FLOW_KEYS = ["purpose", "v", "provider", "issuer", "state", "nonce", "codeVerifier", "returnTo", "iat", "exp"] as const;
const ISSUER_MAX = 256;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

const isProvider = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
const isToken = (v: unknown): v is string => typeof v === "string" && B64URL_43.test(v);

/** https, 또는 명시 port가 있는 http 127.0.0.1. 원문 = URL.href, userinfo·query·hash 없음, 256자 이하. */
function isIssuer(v: unknown): v is string {
  if (typeof v !== "string" || v.length > ISSUER_MAX) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.href !== v || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port !== "";
}

function validFlowFields(f: Record<string, unknown>): boolean {
  return (
    isProvider(f.provider) &&
    isIssuer(f.issuer) &&
    isToken(f.state) &&
    isToken(f.nonce) &&
    isToken(f.codeVerifier) &&
    typeof f.returnTo === "string" &&
    parseReturnTo(f.returnTo) === f.returnTo
  );
}

export async function sealFlow(cfg: SessionConfig, f: FlowInput): Promise<{ value: string; expiresAt: Date }> {
  if (typeof f !== "object" || f === null || !validFlowFields(f as unknown as Record<string, unknown>)) {
    throw new Error("sealFlow: flow input is outside the cookie format");
  }
  const iat = cfg.now().getTime();
  const exp = iat + SHORT_COOKIE_TTL_MS;
  const payload = {
    purpose: "oauth_flow",
    v: 1,
    provider: f.provider,
    issuer: f.issuer,
    state: f.state,
    nonce: f.nonce,
    codeVerifier: f.codeVerifier,
    returnTo: f.returnTo,
    iat,
    exp,
  };
  const value = await sealData(payload, { password: cfg.secrets, ttl: SHORT_COOKIE_TTL_SEC });
  return { value, expiresAt: new Date(exp) };
}

export async function readFlow(
  cfg: SessionConfig,
  sealed: string | undefined,
): Promise<Result<FlowInput & { expiresAt: Date }, "missing" | "invalid" | "expired">> {
  if (sealed === undefined || sealed === "") return { ok: false, error: "missing" };
  const invalid = { ok: false, error: "invalid" } as const;
  if (typeof sealed !== "string") return invalid;
  const p: unknown = await unsealData(sealed, { password: cfg.secrets });
  if (!hasExactKeys(p, FLOW_KEYS)) return invalid;
  if (p.purpose !== "oauth_flow" || p.v !== 1 || !validFlowFields(p)) return invalid;
  const now = cfg.now().getTime();
  if (!validShortTimes(p.iat, p.exp, now)) return invalid;
  const exp = p.exp as number;
  if (exp <= now) return { ok: false, error: "expired" };
  return {
    ok: true,
    value: {
      provider: p.provider as ProviderId,
      issuer: p.issuer as string,
      state: p.state as string,
      nonce: p.nonce as string,
      codeVerifier: p.codeVerifier as string,
      returnTo: p.returnTo as string,
      expiresAt: new Date(exp),
    },
  };
}

export function flowCookieOptions(
  cfg: SessionConfig,
  expiresAt: Date,
): { name: "__Host-pod_oauth" | "pod_oauth"; httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } {
  return shortCookieOptions(cfg, "pod_oauth", expiresAt);
}
