/** 회고 시각은 현행 기록 시간대(Asia/Seoul)의 벽시계 시·분이다. */
export const DEFAULT_REFLECTION_TIME = "20:00";

export function parseReflectionTime(value: unknown): string | null {
  return typeof value === "string" && value.length === 5 && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? value : null;
}
