/**
 * 이야기 버전 저장·조회(PLAN_ai-daily-story-storage §2). app role은 SELECT·INSERT만 가진다.
 *
 * - 저장은 users 행을 active + 현재 gen 조건으로 잠근 뒤 같은 revision을 재사용하거나 다음 version을 넣는다.
 *   사용자 행 잠금이 같은 사용자의 동시 저장을 직렬화한다. 외부 생성 중에는 이 잠금을 잡지 않는다(호출자 책임).
 * - 조회는 계정 상태를 다시 확인하지 않는다. 호출자(generate·read)가 먼저 확인한다.
 * - 직접 수정·재생성(PLAN_story-edit-regenerate §2)은 기존 행을 UPDATE·DELETE하지 않고 최신 version을 base로 다음 version을 넣는다.
 *   source_revision은 실제 입력 v1을 그대로 승계한다. 같은 revision에 여러 version이 있으면 최신 것이 그 revision의 이야기다.
 */
import "server-only";
import type { SessionSubject } from "../account/lifecycle";
import { withTransaction, type Db, type Tx } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import { STORY_MAX, type StoryEditError, type StoryRef } from "@/shared/stories";

/** 서버 전용. read가 현재 입력과 비교할 저장 당시 revision을 함께 가진다. */
export type StoredStory = StoryRef & { sourceRevision: string };

type StoryRow = {
  id: string; version: number; body: string; created_at: Date; source_revision: string;
  origin: "ai" | "user_edit"; base_version: number | null;
};

const COLUMNS = "id::text AS id, version, body, created_at, source_revision, origin, base_version";
const BY_REVISION = `SELECT ${COLUMNS} FROM pod.story_versions
  WHERE user_id = $1::uuid AND local_date = $2::date AND source_revision = $3 ORDER BY version DESC LIMIT 1`;
const LATEST = `SELECT ${COLUMNS} FROM pod.story_versions
  WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY version DESC LIMIT 1`;
const LOCK_ACTIVE = `SELECT 1 FROM pod.users
  WHERE id = $1::uuid AND status = 'active' AND auth_generation::bigint = $2::bigint FOR UPDATE`;
const INSERT_NEXT = `INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body, origin, base_version)
  VALUES ($1::uuid, $2::date, $3::integer + 1, $4, $5, $6, $3::integer)
  RETURNING ${COLUMNS}`;
/** 저장을 거부하는 제어 문자: C0(LF·CR·TAB 제외)·DEL·C1. trim 전 원문에서 본다. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** 다음 version을 쓸 때의 출처와 기준 version(PLAN_story-edit-regenerate §2). */
export type StoryAppendOpts = { baseVersion: number; origin: "ai" | "user_edit" };

export const isStorySubject = (s: unknown): s is SessionSubject =>
  typeof s === "object" && s !== null && isUuid((s as SessionSubject).userId)
  && Number.isSafeInteger((s as SessionSubject).gen) && (s as SessionSubject).gen > 0;

/** AI 글은 기존 4필드 그대로, 직접 고친 글에만 edited: true를 붙인다. origin·base·revision은 내보내지 않는다. */
function toRef(r: StoryRow): StoryRef {
  const ref: StoryRef = { id: r.id, version: r.version, body: r.body, createdAt: new Date(r.created_at).toISOString() };
  return r.origin === "user_edit" ? { ...ref, edited: true } : ref;
}
const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export async function findLatestStory(db: Pick<Db, "query">, userId: string, date: string): Promise<StoredStory | null> {
  if (!isUuid(userId) || parseLocalDate(date) === null) return null;
  const row = (await db.query<StoryRow>(LATEST, [userId, date])).rows[0];
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
  return withTransaction(db, (tx) => appendStoryVersionTx(tx, subject, date, revision, body));
}

/**
 * appendStoryVersion의 core를 호출자 트랜잭션 안에서 실행한다(PLAN_ai-story-live-generation §4.1).
 * worker finish가 job·usage 갱신과 같은 tx에서 쓴다. 같은 tx에서 users 행을 다시 잠가도 무해하다.
 * opts가 없으면 기존 replay/append 그대로다. opts가 있으면 잠금 뒤 최신 version이 baseVersion이고 그 revision이 같을 때만
 * base + 1을 넣고, 아니면 conflict다(재생성 완료·직접 수정, PLAN_story-edit-regenerate §2).
 */
export function appendStoryVersionTx(
  tx: Tx, subject: SessionSubject, date: string, revision: string, body: string,
): Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in">>;
export function appendStoryVersionTx(
  tx: Tx, subject: SessionSubject, date: string, revision: string, body: string, opts: StoryAppendOpts,
): Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in" | "conflict">>;
export async function appendStoryVersionTx(
  tx: Tx,
  subject: SessionSubject,
  date: string,
  revision: string,
  body: string,
  opts?: StoryAppendOpts,
): Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in" | "conflict">> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  const locked = await tx.query(LOCK_ACTIVE, [subject.userId, subject.gen]);
  if (locked.rowCount !== 1) return { ok: false, error: "not_signed_in" } as const;
  if (opts !== undefined) {
    if (!isVersion(opts.baseVersion)) return { ok: false, error: "conflict" } as const;
    const latest = (await tx.query<StoryRow>(LATEST, [subject.userId, date])).rows[0];
    if (!latest || latest.version !== opts.baseVersion || latest.source_revision !== revision) return { ok: false, error: "conflict" } as const;
    const next = await tx.query<StoryRow>(INSERT_NEXT, [subject.userId, date, latest.version, revision, body, opts.origin]);
    return { ok: true, value: { story: toRef(next.rows[0]!), replayed: false } } as const;
  }
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
}

/**
 * 사용자가 최신 이야기를 직접 고친다(PLAN_story-edit-regenerate §2). 외부 전송·동의·키가 필요 없고 조각·사진을 읽거나 고치지 않는다.
 *
 * - SQL 전 검증: subject → 날짜 → input 정확히 { expectedVersion, body } → body(원문 제어 문자 거부 뒤 trim, 1..2000 codepoint)
 *   → expectedVersion(양의 safe integer, 아니면 conflict).
 * - tx: users FOR UPDATE(active+gen) → 그날 queued/running job이면 busy → 최신 version 불일치·이야기 없음 conflict
 *   → trim 본문이 최신과 같으면 INSERT 0(unchanged) → origin user_edit, base 최신으로 다음 version.
 */
export async function editStoryVersion(
  db: Db,
  subject: SessionSubject,
  date: string,
  input: unknown,
): Promise<Result<{ story: StoryRef; unchanged: boolean }, StoryEditError>> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  if (typeof date !== "string" || parseLocalDate(date) === null) return { ok: false, error: "invalid_date" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "invalid_body" };
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "body" || keys[1] !== "expectedVersion") return { ok: false, error: "invalid_body" };
  const { body: raw, expectedVersion } = input as { body: unknown; expectedVersion: unknown };
  if (typeof raw !== "string" || CONTROL.test(raw)) return { ok: false, error: "invalid_body" };
  const body = raw.trim();
  const length = Array.from(body).length;
  if (length < 1 || length > STORY_MAX) return { ok: false, error: "invalid_body" };
  if (!isVersion(expectedVersion)) return { ok: false, error: "conflict" };
  return withTransaction(db, async (tx): Promise<Result<{ story: StoryRef; unchanged: boolean }, StoryEditError>> => {
    if ((await tx.query(LOCK_ACTIVE, [subject.userId, subject.gen])).rowCount !== 1) return { ok: false, error: "not_signed_in" };
    const busy = await tx.query(
      "SELECT 1 FROM pod.story_jobs WHERE user_id = $1::uuid AND local_date = $2::date AND state IN ('queued', 'running') LIMIT 1",
      [subject.userId, date],
    );
    if ((busy.rowCount ?? 0) > 0) return { ok: false, error: "busy" };
    const latest = (await tx.query<StoryRow>(LATEST, [subject.userId, date])).rows[0];
    if (!latest || latest.version !== expectedVersion) return { ok: false, error: "conflict" };
    if (latest.body === body) return { ok: true, value: { story: toRef(latest), unchanged: true } };
    const next = await tx.query<StoryRow>(INSERT_NEXT, [subject.userId, date, latest.version, latest.source_revision, body, "user_edit"]);
    return { ok: true, value: { story: toRef(next.rows[0]!), unchanged: false } };
  });
}
