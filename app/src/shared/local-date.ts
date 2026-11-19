/** 사용자 기준 날짜 YYYY-MM-DD. 실제 달력에 있는 날짜만 받는다. */
export type LocalDate = string;

export function parseLocalDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= last ? value : null;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"] as const;
export { WEEK };

export function dateParts(date: LocalDate): { y: number; m: number; d: number; w: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d, w: WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]! };
}

export function dateLabel(date: LocalDate): string {
  const p = dateParts(date);
  return `${p.m}월 ${p.d}일 ${p.w}요일`;
}

/**
 * [가정] 사용자 시간대 Asia/Seoul. 명시한 IANA 시간대로 계산하므로 프로세스 TZ와 무관하고
 * 과거 이력(1988 서머타임 UTC+10, 1954~1961 UTC+8:30 등)도 tzdb를 따른다.
 */
const SEOUL_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function seoulPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((p) => p.type === type);
  if (!part) throw new Error(`Asia/Seoul date part ${type} is missing`);
  return part.value;
}

/** 순간(instant)의 서울 날짜 YYYY-MM-DD. */
export function seoulLocalDate(instant: Date): LocalDate {
  const parts = SEOUL_PARTS.formatToParts(instant);
  return `${seoulPart(parts, "year").padStart(4, "0")}-${seoulPart(parts, "month")}-${seoulPart(parts, "day")}`;
}

/** 순간(instant)의 서울 시각 24시간제 HH:MM. 초는 버린다. */
export function seoulTime(instant: Date): string {
  const parts = SEOUL_PARTS.formatToParts(instant);
  return `${seoulPart(parts, "hour")}:${seoulPart(parts, "minute")}`;
}
