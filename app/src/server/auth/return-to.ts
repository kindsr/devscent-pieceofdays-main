/**
 * 로그인 뒤 이동 경로 허용 목록(PLAN_mvp-oidc-integration §5). 정확 일치와 정규식만 쓴다.
 * 허용값은 그대로 돌려주고 그 밖은 null이다(호출자가 "/"로 바꾼다).
 */
import "server-only";
import { parseLocalDate } from "@/shared/local-date";

const MAX_LENGTH = 64;
const FIXED_PATHS: readonly string[] = ["/", "/days", "/settings"];
const DAY_PATH_RE = /^\/days\/(\d{4}-\d{2}-\d{2})$/;

export function parseReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_LENGTH) return null;
  if (FIXED_PATHS.includes(raw)) return raw;
  const date = DAY_PATH_RE.exec(raw)?.[1];
  return date !== undefined && parseLocalDate(date) === date ? raw : null;
}
