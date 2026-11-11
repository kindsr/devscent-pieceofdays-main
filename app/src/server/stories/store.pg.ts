/**
 * 이야기 버전 저장·조회(PLAN_ai-daily-story-storage §2). app role은 SELECT·INSERT만 가진다.
 *
 * - 저장은 users 행을 active + 현재 gen 조건으로 잠근 뒤 같은 revision을 재사용하거나 다음 version을 넣는다.
 *   사용자 행 잠금이 같은 사용자의 동시 저장을 직렬화한다. 외부 생성 중에는 이 잠금을 잡지 않는다(호출자 책임).
 * - 조회는 계정 상태를 다시 확인하지 않는다. 호출자(generate·read)가 먼저 확인한다.
 */
import "server-only";
import type { SessionSubject } from "../account/lifecycle";
import { withTransaction, type Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import type { StoryRef } from "@/shared/stories";

/** 서버 전용. read가 현재 입력과 비교할 저장 당시 revision을 함께 가진다. */
export type StoredStory = StoryRef & { sourceRevision: string };

type StoryRow = { id: string; version: number; body: string; created_at: Date; source_revision: string };

const COLUMNS = "id::text AS id, version, body, created_at, source_revision";
const BY_REVISION = `SELECT ${COLUMNS} FROM pod.story_versions
  WHERE user_id = $1::uuid AND local_date = $2::date AND source_revision = $3`;

export const isStorySubject = (s: unknown): s is SessionSubject =>
  typeof s === "object" && s !== null && isUuid((s as SessionSubject).userId)
  && Number.isSafeInteger((s as SessionSubject).gen) && (s as SessionSubject).gen > 0;

const toRef = (r: StoryRow): StoryRef => ({ id: r.id, version: r.version, body: r.body, createdAt: new Date(r.created_at).toISOString() });

export async function findLatestStory(db: Pick<Db, "query">, userId: string, date: string): Promise<StoredStory | null> {
  if (!isUuid(userId) || parseLocalDate(date) === null) return null;
  const r = await db.query<StoryRow>(
    `SELECT ${COLUMNS} FROM pod.story_versions
      WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY version DESC LIMIT 1`,
    [userId, date],
  );
  const row = r.rows[0];
  return row ? { ...toRef(row), sourceRevision: row.source_revision } : null;
}

export async function findStoryByRevision(
  db: Pick<Db, "query">,
  userId: string,
  date: string,
  revision: string,
): Promise<StoryRef | null> {
  if (!isUuid(userId) || parseLocalDate(date) === null) return null;
  const row = (await db.query<StoryRow>(BY_REVISION, [userId, date, revision])).rows[0];
  return row ? toRef(row) : null;
}

export async function appendStoryVersion(
  db: Db,
  subject: SessionSubject,
  date: string,
  revision: string,
  body: string,
): Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in">> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  return withTransaction(db, async (tx) => {
    const locked = await tx.query(
      `SELECT 1 FROM pod.users
        WHERE id = $1::uuid AND status = 'active' AND auth_generation::bigint = $2::bigint FOR UPDATE`,
      [subject.userId, subject.gen],
    );
    if (locked.rowCount !== 1) return { ok: false, error: "not_signed_in" } as const;
    const existing = (await tx.query<StoryRow>(BY_REVISION, [subject.userId, date, revision])).rows[0];
    if (existing) return { ok: true, value: { story: toRef(existing), replayed: true } } as const;
    const r = await tx.query<StoryRow>(
      `INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body)
       SELECT $1::uuid, $2::date, COALESCE(max(version), 0) + 1, $3, $4
         FROM pod.story_versions WHERE user_id = $1::uuid AND local_date = $2::date
       RETURNING ${COLUMNS}`,
      [subject.userId, date, revision, body],
    );
    return { ok: true, value: { story: toRef(r.rows[0]!), replayed: false } } as const;
  });
}
