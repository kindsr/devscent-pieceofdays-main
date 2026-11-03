/**
 * 공급자 무관 봉인 세션 codec(PLAN_mvp-authentication §5). 서버 전용이다.
 *
 * - 암호화·무결성은 iron-session sealData/unsealData가 맡는다. 앱의 정확한 7일 기준은 payload exp와 cfg.now()다.
 * - raw iron unseal reason(expired·unknown-password)은 HMAC 검증 전에도 나오므로 판정에 쓰지 않는다.
 * - env는 인자로만 받는다. 전역 시계·환경 변수를 바꾸지 않는다. Node가 직접 읽을 수 있게 erasable TS만 쓴다.
 */
import "server-only";
import { sealData, unsealData } from "iron-session";
import { isUuid } from "../ids";
import type { Result } from "../result";

export type SessionConfig = Readonly<{
  secrets: Readonly<Record<number, string>>;
  baseUrl: URL;
  secureCookies: boolean;
  now: () => Date;
}>;

const SESSION_TTL_MS = 604_800_000;
const SESSION_TTL_SEC = 604_800;
const MIN_SECRET_LENGTH = 32;
const KEY_RE = /^[1-9][0-9]*$/;
const DEV_NODE_ENVS: readonly (string | undefined)[] = ["development", "test"];
const DEV_HTTP_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const PAYLOAD_KEYS = ["v", "userId", "gen", "iat", "exp"];

const isBlank = (v: string | undefined) => v === undefined || v.trim() === "";
const isGen = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isEpochMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** hostname이 운영에서 거부하는 loopback(localhost·IPv4 127.0.0.0/8·IPv6 [::1])인지. WHATWG 정규화 결과로 판정한다. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** §5.2 표를 위에서부터 판정한다. */
export function loadSessionConfig(
  env: Record<string, string | undefined>,
  nodeEnv: string | undefined,
): Result<SessionConfig, "auth_not_configured" | "invalid_config"> {
  const rawSecrets = env.POD_AUTH_SESSION_SECRETS;
  const rawBase = env.POD_AUTH_BASE_URL;
  if (rawSecrets === undefined || rawBase === undefined || isBlank(rawSecrets) || isBlank(rawBase)) {
    return { ok: false, error: "auth_not_configured" };
  }
  const invalid = { ok: false, error: "invalid_config" } as const;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSecrets);
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return invalid;
  const secrets: Record<number, string> = {};
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k) || !Number.isSafeInteger(Number(k))) return invalid;
    if (typeof v !== "string" || v.length < MIN_SECRET_LENGTH || v.trim() === "") return invalid;
    secrets[Number(k)] = v;
  }

  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return invalid;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid;
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return invalid;
  }
  const devHttp = DEV_NODE_ENVS.includes(nodeEnv) && url.protocol === "http:" && DEV_HTTP_HOSTS.includes(url.hostname);
  if (!devHttp && (url.protocol !== "https:" || isLoopbackHost(url.hostname))) return invalid;

  const baseUrl = new URL(url.origin);
  return {
    ok: true,
    value: Object.freeze({
      secrets: Object.freeze(secrets),
      baseUrl,
      secureCookies: baseUrl.protocol === "https:",
      now: () => new Date(),
    }),
  };
}

/** 정확히 7일짜리 세션을 봉인한다. userId·gen 형식이 틀리면 throw한다. */
export async function sealSession(
  cfg: SessionConfig,
  subject: { userId: string; gen: number },
): Promise<{ value: string; expiresAt: Date }> {
  const { userId, gen } = subject;
  if (!isUuid(userId)) throw new Error("sealSession: userId must be a UUID");
  if (!isGen(gen)) throw new Error("sealSession: gen must be a safe positive integer");
  const iat = cfg.now().getTime();
  const exp = iat + SESSION_TTL_MS;
  const value = await sealData({ v: 1, userId, gen, iat, exp }, { password: cfg.secrets, ttl: SESSION_TTL_SEC });
  return { value, expiresAt: new Date(exp) };
}

/** §5.3 순서: missing → unseal → payload 검사(invalid) → exp 판정(expired/ok). */
export async function readSession(
  cfg: SessionConfig,
  sealed: string | undefined,
): Promise<Result<{ userId: string; gen: number; expiresAt: Date }, "missing" | "invalid" | "expired">> {
  if (sealed === undefined || sealed === "") return { ok: false, error: "missing" };
  const invalid = { ok: false, error: "invalid" } as const;
  if (typeof sealed !== "string") return invalid;
  // 실패하면 iron이 {}를 돌려준다(raw reason은 쓰지 않는다). {}는 아래 키 검사에서 invalid가 된다.
  const payload: unknown = await unsealData(sealed, { password: cfg.secrets });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return invalid;
  const p = payload as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((k) => Object.hasOwn(p, k))) return invalid;
  const { v, userId, gen, iat, exp } = p;
  if (v !== 1 || !isUuid(userId) || !isGen(gen) || !isEpochMs(iat) || !isEpochMs(exp)) return invalid;
  const now = cfg.now().getTime();
  if (exp <= iat || exp - iat > SESSION_TTL_MS || iat > now) return invalid;
  if (exp <= now) return { ok: false, error: "expired" };
  return { ok: true, value: { userId, gen, expiresAt: new Date(exp) } };
}

/** 세션 쿠키 이름·속성. Secure가 없으면 __Host- 접두를 쓰지 않는다. Domain 속성은 두지 않는다. */
export function sessionCookieOptions(
  cfg: SessionConfig,
  expiresAt: Date,
): {
  name: "__Host-pod_session" | "pod_session";
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  expires: Date;
} {
  return {
    name: cfg.secureCookies ? "__Host-pod_session" : "pod_session",
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  };
}

/** 요청 Origin이 cfg.baseUrl.origin 직렬화 문자열과 정확히 같을 때만 ok다. */
export function assertSameOrigin(cfg: SessionConfig, origin: string | null): Result<null, "origin_missing" | "origin_mismatch"> {
  if (origin === null || origin === "") return { ok: false, error: "origin_missing" };
  return origin === cfg.baseUrl.origin ? { ok: true, value: null } : { ok: false, error: "origin_mismatch" };
}
