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

/** [가정] 사용자 시간대 Asia/Seoul. 1988년 이후 일광절약시간이 없어 UTC+9 고정이며 프로세스 TZ와 무관하다. */
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

function seoulWallClock(instant: Date): Date {
  return new Date(instant.getTime() + SEOUL_OFFSET_MS);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 순간(instant)의 서울 날짜 YYYY-MM-DD. */
export function seoulLocalDate(instant: Date): LocalDate {
  const t = seoulWallClock(instant);
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 순간(instant)의 서울 시각 24시간제 HH:MM. 초는 버린다. */
export function seoulTime(instant: Date): string {
  const t = seoulWallClock(instant);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
