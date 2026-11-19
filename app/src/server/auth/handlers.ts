/**
 * 인증 HTTP 처리 함수(PLAN_mvp-oidc-integration §6.2·§6.3). Next 타입 없이 결과(status·Location·쿠키 효과)만 돌려준다.
 *
 * - auth 설정 오류는 모든 함수에서 가장 먼저 503(쿠키·Location 없음)이다. cfg가 있을 때 POST는 Origin 검사가 그다음이다.
 * - 내부 redirect는 cfg.session.baseUrl 위의 고정 경로다. Host·request.url·query의 사용자 ID는 쓰지 않는다.
 * - callback은 cfg가 있으면 응답마다 flow 쿠키를 지운다. fresh OAuth 검증 전 실패에서는 세션·복구 쿠키를 건드리지 않는다.
 * - 브라우저 flow 쿠키 삭제는 서버의 원자적 재생 방지가 아니다. 같은 code의 동시 요청은 공급자 code 일회성과 F3 멱등에 맡긴다.
 */
import "server-only";
import { completeSuccessfulLogin } from "../account/login";
import { requestWithdrawal, restoreAccount } from "../account/lifecycle";
import type { Db } from "../db/pool";
import type { AuthConfig, AuthR, ProviderConfig } from "./config";
import { flowCookieOptions, readFlow } from "./flow-cookie";
import { beginLogin, finishLogin } from "./oidc";
import { readRecovery, recoveryCookieOptions, sealRecovery } from "./recovery-cookie";
import { parseReturnTo } from "./return-to";
import { assertSameOrigin, readSession, sealSession, sessionCookieOptions } from "./session";
import type { SessionConfig } from "./session";

type SetOptions = { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date };
export type CookieEffect =
  | { op: "set"; name: string; value: string; options: SetOptions }
  | { op: "delete"; name: string; secure: boolean };
export type HandlerResult =
  | { status: 303; location: URL; cookies: CookieEffect[] }
  | { status: 403 | 404 | 503; cookies: CookieEffect[] };

type NamedOptions = SetOptions & { name: string };
type Kind = "flow" | "session" | "recovery";

const optionsOf: Record<Kind, (cfg: SessionConfig, expiresAt: Date) => NamedOptions> = {
  flow: flowCookieOptions,
  session: sessionCookieOptions,
  recovery: recoveryCookieOptions,
};

function setCookie(o: NamedOptions, value: string): CookieEffect {
  return {
    op: "set",
    name: o.name,
    value,
    options: { httpOnly: o.httpOnly, secure: o.secure, sameSite: o.sameSite, path: o.path, expires: o.expires },
  };
}

function deleteCookie(cfg: SessionConfig, kind: Kind): CookieEffect {
  return { op: "delete", name: optionsOf[kind](cfg, new Date(0)).name, secure: cfg.secureCookies };
}

const status = (code: 403 | 404 | 503, cookies: CookieEffect[] = []): HandlerResult => ({ status: code, cookies });
const redirect = (cfg: SessionConfig, path: string, cookies: CookieEffect[]): HandlerResult => ({
  status: 303,
  location: new URL(path, cfg.baseUrl),
  cookies,
});

/** 설정에서 켜진 공급자만 고른다(Record 조회만으로 임의 문자열을 공급자로 보지 않는다). */
function enabledProvider(cfg: AuthConfig, provider: string): ProviderConfig | null {
  const id = cfg.enabled.find((e) => e === provider);
  return id === undefined ? null : (cfg.providers[id] ?? null);
}

const formString = (form: FormData, name: string): string | null => {
  const v = form.get(name);
  return typeof v === "string" ? v : null;
};

/** POST /auth/{p}/start */
export async function handleStart(auth: AuthR, provider: string, origin: string | null, form: FormData): Promise<HandlerResult> {
  if (!auth.ok) return status(503);
  const cfg = auth.value;
  if (!assertSameOrigin(cfg.session, origin).ok) return status(403);
  const p = enabledProvider(cfg, provider);
  if (p === null) return status(404);
  const returnTo = parseReturnTo(form.get("returnTo")) ?? "/";
  try {
    const r = await beginLogin(p, cfg.session, returnTo);
    if (!r.ok) return status(503);
    const flow = setCookie(flowCookieOptions(cfg.session, r.value.flow.expiresAt), r.value.flow.value);
    return { status: 303, location: r.value.authorizeUrl, cookies: [flow] };
  } catch {
    return status(503);
  }
}

/** GET /auth/{p}/callback */
export async function handleCallback(
  auth: AuthR,
  getDb: () => Db,
  provider: string,
  query: URLSearchParams,
  cookies: { flow?: string },
): Promise<HandlerResult> {
  if (!auth.ok) return status(503);
  const cfg = auth.value;
  const s = cfg.session;
  const F = deleteCookie(s, "flow");
  const p = enabledProvider(cfg, provider);
  if (p === null) return status(404, [F]);
  const flow = await readFlow(s, cookies.flow);
  if (!flow.ok) return redirect(s, "/login?error=expired", [F]);
  if (flow.value.provider !== p.id || flow.value.issuer !== p.issuer.href) return redirect(s, "/login?error=failed", [F]);

  const verified = await finishLogin(p, flow.value, query);
  if (!verified.ok) {
    if (verified.error === "provider_unavailable") return status(503, [F]);
    return redirect(s, verified.error === "cancelled" ? "/login?error=cancelled" : "/login?error=failed", [F]);
  }

  // 여기부터 fresh OAuth로 검증된 identity만 쓴다.
  let login: Awaited<ReturnType<typeof completeSuccessfulLogin>>;
  try {
    login = await completeSuccessfulLogin(getDb(), { provider: p.id, subject: verified.value.subject });
  } catch {
    return status(503, [F]);
  }
  if (!login.ok) return redirect(s, "/login?error=failed", [F]);

  const S = deleteCookie(s, "session");
  const R = deleteCookie(s, "recovery");
  const outcome = login.value;
  if (outcome.kind === "active") {
    try {
      const sealed = await sealSession(s, { userId: outcome.userId, gen: outcome.gen });
      return redirect(s, flow.value.returnTo, [F, setCookie(sessionCookieOptions(s, sealed.expiresAt), sealed.value), R]);
    } catch {
      return status(503, [F, S, R]);
    }
  }
  if (outcome.kind === "pending_deletion") {
    try {
      const sealed = await sealRecovery(s, { userId: outcome.userId, gen: outcome.gen });
      return redirect(s, "/account/restore", [F, S, setCookie(recoveryCookieOptions(s, sealed.expiresAt), sealed.value)]);
    } catch {
      return status(503, [F, S, R]);
    }
  }
  return redirect(s, "/login?error=purge_due", [F, S, R]);
}

/** POST /auth/logout */
export function handleLogout(auth: AuthR, origin: string | null): HandlerResult {
  if (!auth.ok) return status(503);
  const s = auth.value.session;
  if (!assertSameOrigin(s, origin).ok) return status(403);
  return redirect(s, "/login?notice=signed_out", [deleteCookie(s, "session"), deleteCookie(s, "recovery")]);
}

/** POST /auth/withdraw */
export async function handleWithdraw(
  auth: AuthR,
  getDb: () => Db,
  origin: string | null,
  form: FormData,
  cookies: { session?: string },
): Promise<HandlerResult> {
  if (!auth.ok) return status(503);
  const s = auth.value.session;
  if (!assertSameOrigin(s, origin).ok) return status(403);
  if (formString(form, "confirm") !== "withdraw") return redirect(s, "/account/withdraw", []);
  const S = deleteCookie(s, "session");
  const session = await readSession(s, cookies.session);
  if (!session.ok) return redirect(s, "/login", [S]);
  let r: Awaited<ReturnType<typeof requestWithdrawal>>;
  try {
    r = await requestWithdrawal(getDb(), { userId: session.value.userId, gen: session.value.gen });
  } catch {
    return status(503); // 세션 유지: 다시 시도할 수 있다
  }
  return redirect(s, r.ok ? "/login?notice=withdrawn" : "/login?notice=signed_out", [S]);
}

/** POST /auth/restore */
export async function handleRestore(
  auth: AuthR,
  getDb: () => Db,
  origin: string | null,
  cookies: { recovery?: string },
): Promise<HandlerResult> {
  if (!auth.ok) return status(503);
  const s = auth.value.session;
  if (!assertSameOrigin(s, origin).ok) return status(403);
  const R = deleteCookie(s, "recovery");
  const proof = await readRecovery(s, cookies.recovery);
  if (!proof.ok) return redirect(s, "/login?error=expired", [R]);
  let r: Awaited<ReturnType<typeof restoreAccount>>;
  try {
    r = await restoreAccount(getDb(), { userId: proof.value.userId, gen: proof.value.gen });
  } catch {
    return status(503, [R]);
  }
  if (r.ok) {
    try {
      const sealed = await sealSession(s, { userId: proof.value.userId, gen: r.value.gen });
      return redirect(s, "/", [R, setCookie(sessionCookieOptions(s, sealed.expiresAt), sealed.value)]);
    } catch {
      return status(503, [R, deleteCookie(s, "session")]);
    }
  }
  if (r.error === "expired") return redirect(s, "/login?error=purge_due", [R]);
  if (r.error === "not_pending") return redirect(s, "/login", [R]);
  return redirect(s, "/login?error=expired", [R]);
}
