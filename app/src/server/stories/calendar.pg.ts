/**
 * 달력용 이야기 날짜(PLAN_ai-daily-story-view §2). 읽기만 하고 생성·쓰기는 하지 않는다.
 *
 * - 순서: subject 형식 → 날짜 범위(from 포함·to 제외, from<to, 최대62일) → active+gen → 그 사용자의 날짜만 DISTINCT 오름차순.
 * - 잘못된 입력은 SQL 전에 거부한다. 미래 범위는 허용한다. 예상 밖 DB 오류는 호출자에게 throw한다.
 */
import "server-only";
import { verifyActiveAccount, type SessionSubject } from "../account/lifecycle";
import type { Db } from "../db/pool";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import { isStorySubject } from "./store.pg";

const MAX_DAYS = 62;
const DAY_MS = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);

export async function listStoryDates(
  db: Db,
  subject: SessionSubject,
  from: string,
  to: string,
): Promise<Result<string[], "invalid_date" | "not_signed_in">> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  if (typeof from !== "string" || typeof to !== "string" || parseLocalDate(from) === null || parseLocalDate(to) === null) {
    return { ok: false, error: "invalid_date" };
  }
  const days = (utc(to) - utc(from)) / DAY_MS;
  if (days < 1 || days > MAX_DAYS) return { ok: false, error: "invalid_date" };
  if (!(await verifyActiveAccount(db, subject))) return { ok: false, error: "not_signed_in" };
  const r = await db.query<{ date: string }>(
    `SELECT DISTINCT to_char(local_date, 'YYYY-MM-DD') AS date FROM pod.story_versions
      WHERE user_id = $1::uuid AND local_date >= $2::date AND local_date < $3::date
      ORDER BY 1`,
    [subject.userId, from, to],
  );
  return { ok: true, value: r.rows.map((row) => row.date) };
}
