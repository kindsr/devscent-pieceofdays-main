/**
 * PostgreSQL 기록 저장(PLAN_mvp-domain-storage §3). app role Pool과 주입 시계만 쓴다.
 *
 * - env·HTTP·세션을 읽지 않는다. userId는 호출자가 신뢰된 문맥에서 넘긴다.
 * - 검증 순서: user → id → version → date → body. 앞 단계에서 걸리면 SQL을 실행하지 않는다.
 * - 값은 모두 $n 매개변수다. 기대 버전은 int4 밖 안전 정수도 22003 없이 비교하도록 bigint로 캐스트한다.
 * - UPDATE/DELETE가 0행이면 같은 소유자 조건으로만 다시 조회해 conflict와 not_found를 가른다.
 */
import "server-only";
import type { DatabaseError } from "pg";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate, seoulLocalDate } from "@/shared/local-date";
import type { DiaryDay, DiaryMoment, DiaryStore, DiaryWriteStore, MomentRef } from "./store";

const BODY_MAX = 300;
const SEOUL = "Asia/Seoul";

const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const codePoints = (s: string) => Array.from(s).length;
const isFkViolation = (err: unknown) => (err as Partial<DatabaseError> | null)?.code === "23503";

type MomentRow = { date: string; id: string; time: string; text: string; version: number };
type SummaryRow = { date: string; body: string; version: number };

const MOMENT_COLUMNS = `to_char(local_date, 'YYYY-MM-DD') AS date, id::text AS id,
       to_char(occurred_at AT TIME ZONE time_zone, 'HH24:MI') AS time, body AS text, version`;
const SUMMARY_COLUMNS = "to_char(local_date, 'YYYY-MM-DD') AS date, body, version";

function toMoment(r: MomentRow): DiaryMoment {
  return { id: r.id, time: r.time, text: r.text, image: null, version: r.version };
}

/** 날짜별로 묶는다. 조각은 쿼리 순서(occurred_at, id)를 유지한다. */
function groupDays(moments: MomentRow[], summaries: SummaryRow[]): DiaryDay[] {
  const days = new Map<string, DiaryDay>();
  const dayOf = (date: string) => {
    let day = days.get(date);
    if (!day) {
      day = { date, summary: "", summaryVersion: null, moments: [] };
      days.set(date, day);
    }
    return day;
  };
  for (const m of moments) dayOf(m.date).moments.push(toMoment(m));
  for (const s of summaries) {
    const day = dayOf(s.date);
    day.summary = s.body;
    day.summaryVersion = s.version;
  }
  return [...days.values()];
}

export function createPgDiaryStore(db: Db, opts: { now?: () => Date } = {}): DiaryStore & DiaryWriteStore {
  const now = opts.now ?? (() => new Date());

  async function momentExists(userId: string, id: string): Promise<boolean> {
    const r = await db.query("SELECT 1 FROM pod.diary_moments WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
    return r.rowCount === 1;
  }

  async function summaryExists(userId: string, date: string): Promise<boolean> {
    const r = await db.query("SELECT 1 FROM pod.day_summaries WHERE user_id = $1::uuid AND local_date = $2::date", [
      userId,
      date,
    ]);
    return r.rowCount === 1;
  }

  return {
    async getDay(userId, date) {
      if (!isUuid(userId) || parseLocalDate(date) === null) return null;
      const moments = await db.query<MomentRow>(
        `SELECT ${MOMENT_COLUMNS} FROM pod.diary_moments
          WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY occurred_at, id`,
        [userId, date],
      );
      const summaries = await db.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM pod.day_summaries WHERE user_id = $1::uuid AND local_date = $2::date`,
        [userId, date],
      );
      return groupDays(moments.rows, summaries.rows)[0] ?? null;
    },

    async listMonth(userId, year, month) {
      if (!isUuid(userId)) return [];
      if (!Number.isInteger(year) || year < 1 || year > 9999) return [];
      if (!Number.isInteger(month) || month < 1 || month > 12) return [];
      const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
      const range = "local_date >= $2::date AND local_date < ($2::date + interval '1 month')::date";
      const moments = await db.query<MomentRow>(
        `SELECT ${MOMENT_COLUMNS} FROM pod.diary_moments
          WHERE user_id = $1::uuid AND ${range} ORDER BY local_date, occurred_at, id`,
        [userId, first],
      );
      const summaries = await db.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM pod.day_summaries WHERE user_id = $1::uuid AND ${range} ORDER BY local_date`,
        [userId, first],
      );
      return groupDays(moments.rows, summaries.rows);
    },

    async createMoment(userId, body): Promise<Result<MomentRef, "invalid_body" | "not_found">> {
      if (!isUuid(userId)) return { ok: false, error: "not_found" };
      const text = body.trim();
      const length = codePoints(text);
      if (length < 1 || length > BODY_MAX) return { ok: false, error: "invalid_body" };
      const occurredAt = now();
      try {
        const r = await db.query<{ id: string; version: number }>(
          `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, time_zone, body)
           VALUES ($1::uuid, $2::date, $3::timestamptz, $4, $5)
           RETURNING id::text AS id, version`,
          [userId, seoulLocalDate(occurredAt), occurredAt.toISOString(), SEOUL, text],
        );
        const row = r.rows[0];
        if (!row) throw new Error("createMoment: insert returned no row");
        return { ok: true, value: { id: row.id, version: row.version } };
      } catch (err) {
        if (isFkViolation(err)) return { ok: false, error: "not_found" };
        throw err;
      }
    },

    async updateMoment(userId, id, expectedVersion, body) {
      if (!isUuid(userId) || !isUuid(id)) return { ok: false, error: "not_found" };
      if (!isVersion(expectedVersion)) return { ok: false, error: "invalid_version" };
      const text = body.trim();
      const length = codePoints(text);
      if (length < 1 || length > BODY_MAX) return { ok: false, error: "invalid_body" };
      const r = await db.query<{ id: string; version: number }>(
        `UPDATE pod.diary_moments SET body = $4, version = version + 1, updated_at = now()
          WHERE id = $1::uuid AND user_id = $2::uuid AND version = $3::bigint
          RETURNING id::text AS id, version`,
        [id, userId, expectedVersion, text],
      );
      const row = r.rows[0];
      if (row) return { ok: true, value: { id: row.id, version: row.version } };
      return { ok: false, error: (await momentExists(userId, id)) ? "conflict" : "not_found" };
    },

    async deleteMoment(userId, id, expectedVersion) {
      if (!isUuid(userId) || !isUuid(id)) return { ok: false, error: "not_found" };
      if (!isVersion(expectedVersion)) return { ok: false, error: "invalid_version" };
      const r = await db.query(
        "DELETE FROM pod.diary_moments WHERE id = $1::uuid AND user_id = $2::uuid AND version = $3::bigint",
        [id, userId, expectedVersion],
      );
      if (r.rowCount === 1) return { ok: true, value: null };
      return { ok: false, error: (await momentExists(userId, id)) ? "conflict" : "not_found" };
    },

    async saveSummary(userId, date, expectedVersion, body) {
      if (!isUuid(userId)) return { ok: false, error: "not_found" };
      if (expectedVersion !== null && !isVersion(expectedVersion)) return { ok: false, error: "invalid_version" };
      if (parseLocalDate(date) === null || date > seoulLocalDate(now())) return { ok: false, error: "invalid_date" };
      const text = body.trim();
      if (codePoints(text) > BODY_MAX) return { ok: false, error: "invalid_body" };

      if (expectedVersion === null) {
        if (text === "") {
          // 없는 행이면 no-op. 버전 없이 기존 행을 지우지 않는다. 없는 사용자는 not_found.
          const r = await db.query<{ user_exists: boolean; summary_exists: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pod.users WHERE id = $1::uuid) AS user_exists,
                    EXISTS (SELECT 1 FROM pod.day_summaries WHERE user_id = $1::uuid AND local_date = $2::date)
                      AS summary_exists`,
            [userId, date],
          );
          const state = r.rows[0];
          if (!state?.user_exists) return { ok: false, error: "not_found" };
          if (state.summary_exists) return { ok: false, error: "conflict" };
          return { ok: true, value: null };
        }
        try {
          const r = await db.query<{ version: number }>(
            `INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1::uuid, $2::date, $3)
             ON CONFLICT (user_id, local_date) DO NOTHING
             RETURNING version`,
            [userId, date, text],
          );
          const row = r.rows[0];
          if (row) return { ok: true, value: { version: row.version } };
          return { ok: false, error: "conflict" };
        } catch (err) {
          if (isFkViolation(err)) return { ok: false, error: "not_found" };
          throw err;
        }
      }

      if (text === "") {
        const r = await db.query(
          "DELETE FROM pod.day_summaries WHERE user_id = $1::uuid AND local_date = $2::date AND version = $3::bigint",
          [userId, date, expectedVersion],
        );
        if (r.rowCount === 1) return { ok: true, value: null };
      } else {
        const r = await db.query<{ version: number }>(
          `UPDATE pod.day_summaries SET body = $4, version = version + 1, updated_at = now()
            WHERE user_id = $1::uuid AND local_date = $2::date AND version = $3::bigint
            RETURNING version`,
          [userId, date, expectedVersion, text],
        );
        const row = r.rows[0];
        if (row) return { ok: true, value: { version: row.version } };
      }
      return { ok: false, error: (await summaryExists(userId, date)) ? "conflict" : "not_found" };
    },
  };
}
