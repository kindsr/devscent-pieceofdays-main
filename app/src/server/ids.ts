import "server-only";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 하이픈이 있는 8-4-4-4-12 UUID 문자열인지. 형식이 틀린 입력은 SQL에 보내기 전에 거부한다. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
