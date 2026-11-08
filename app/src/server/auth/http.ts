/**
 * 인증 route의 얇은 HTTP 어댑터(PLAN_mvp-oidc-integration §6.2·§6.3). 서버 전용이다.
 *
 * - B2 HandlerResult를 그대로 Response로 옮긴다: 303은 처리 함수가 만든 Location(설정 base 기준), 403·404·503은 고정 본문.
 * - 응답 쿠키는 CookieEffect 그대로 Set-Cookie로 쓴다. 이름 fallback·Domain은 없다.
 * - 요청 Host·request.url로 주소를 다시 만들지 않는다. 오류 원문·요청 값은 로그하지 않는다.
 */
import "server-only";
import { loadAuthConfig, type AuthR } from "./config";
import type { CookieEffect, HandlerResult } from "./handlers";

const FIXED_BODY = {
  403: "요청을 확인할 수 없어요.",
  404: "찾을 수 없어요.",
  503: "지금은 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요.",
} as const;

const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

function cookieLine(c: CookieEffect): string {
  const tail = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (c.op === "set") {
    if (c.options.secure) tail.push("Secure");
    return [`${c.name}=${c.value}`, `Expires=${c.options.expires.toUTCString()}`, ...tail].join("; ");
  }
  if (c.secure) tail.push("Secure");
  return [`${c.name}=`, `Expires=${EPOCH}`, "Max-Age=0", ...tail].join("; ");
}

/** 고정 응답(본문 text/plain·no-store·Location 없음). callback은 Referrer-Policy를 더한다. */
export function fixedResponse(status: 403 | 404 | 503, cookies: CookieEffect[] = [], opts: { callback?: boolean } = {}): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  if (opts.callback) headers.set("Referrer-Policy", "no-referrer");
  for (const c of cookies) headers.append("Set-Cookie", cookieLine(c));
  return new Response(FIXED_BODY[status], { status, headers });
}

/** HandlerResult → Response. */
export function toResponse(result: HandlerResult, opts: { callback?: boolean } = {}): Response {
  if (result.status !== 303) return fixedResponse(result.status, result.cookies, opts);
  const headers = new Headers({ Location: result.location.href, "Cache-Control": "no-store" });
  if (opts.callback) headers.set("Referrer-Policy", "no-referrer");
  for (const c of result.cookies) headers.append("Set-Cookie", cookieLine(c));
  return new Response(null, { status: 303, headers });
}

/** 인증 설정. 설정 충돌로 throw하면 invalid_config로 보고 처리 함수가 고정 503을 돌려주게 한다. */
export function readAuth(): AuthR {
  try {
    return loadAuthConfig(process.env, process.env.NODE_ENV);
  } catch {
    return { ok: false, error: "invalid_config" };
  }
}

/** form 본문. 형식이 깨졌으면 빈 form으로 보고 가드 판정(설정·Origin)은 처리 함수에 그대로 맡긴다. */
export async function formOf(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}
