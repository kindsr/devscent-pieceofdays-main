/**
 * AI 하루 이야기 생성 작업(PLAN_ai-story-live-generation §4.6). PG 행이 durable job이고 lease가 실행권이다.
 *
 * - 잠금 순서는 모든 경로에서 users → settings/job → usage다(expire는 job → usage, users 잠금 0).
 * - job의 gen·동의 version/revision은 enqueue 때 snapshot이며 app이 바꿀 수 없다. claim·송신 직전·완료에서 같아야 하고
 *   달라지면 새 값으로 구제하지 않고 실패로 닫는다. 자동 재시도·재큐잉은 0이다.
 * - 사용량 원장은 송신 직전에 'sent'로 남기고, 완료 결과와 무관하게 실측 usage(settled)·불명(unknown)·미송신(not_sent)으로 정산한다.
 * - 외부 I/O(사진 읽기·HTTP)는 이 파일 밖에서 하며, 여기의 트랜잭션은 그동안 열려 있지 않다.
 */
import "server-only";
import type { DatabaseError } from "pg";
import type { SessionSubject } from "../account/lifecycle";
import { withTransaction, type Db, type Tx } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate, seoulLocalDate } from "@/shared/local-date";
import {
  STORY_CONSENT_VERSION,
  STORY_MANUAL_DAILY_MAX,
  type StoryGenerationView,
  type StoryJobFailure,
  type StoryRequestError,
} from "@/shared/stories";
import { captureStoryInputV2, type StoryInputV2 } from "./input-v2.pg";
import { appendStoryVersionTx, findStoryByRevision, isStorySubject } from "./store.pg";

export type ClaimedStoryJob = {
  id: string; userId: string; date: string; kind: "manual" | "scheduled";
  leaseToken: string; gen: number; consentVersion: number; consentRevision: number; input: StoryInputV2;
};
type Usage = { inputTokens: number; outputTokens: number };
export type StoryJobOutcome =
  | { ok: true; body: string; usage: Usage }
  | { ok: false; error: StoryJobFailure; sent: boolean; usage: Usage | null };

const FAILURES: readonly string[] = [
  "photo_unavailable", "input_changed", "unavailable", "timeout", "invalid_output", "lease_expired",
  "consent_missing", "not_signed_in", "invalid_input", "input_too_large",
] satisfies StoryJobFailure[];
const LEASE = "interval '3 minutes'";
/** 서울 기준 그 날 0시(timestamptz). 요청일 수 집계의 하한이다. */
const SEOUL_DAY_START = "(($1::date)::timestamp AT TIME ZONE 'Asia/Seoul')";

type UserRow = { status: string; gen: string };
type SettingsRow = { consent_version: number; consent_revision: string; manual_enabled: boolean; auto_enabled: boolean };

async function lockUser(tx: Tx, userId: string): Promise<UserRow | null> {
  const r = await tx.query<UserRow>("SELECT status, auth_generation::text AS gen FROM pod.users WHERE id = $1::uuid FOR UPDATE", [userId]);
  return r.rows[0] ?? null;
}
async function readSettings(db: Pick<Db, "query">, userId: string): Promise<SettingsRow | null> {
  const r = await db.query<SettingsRow>(
    "SELECT consent_version, consent_revision::text AS consent_revision, manual_enabled, auto_enabled FROM pod.story_ai_settings WHERE user_id = $1::uuid",
    [userId],
  );
  return r.rows[0] ?? null;
}
const userActive = (u: UserRow | null, gen: number): boolean => u !== null && u.status === "active" && u.gen === String(gen);
/** 현재 정책 버전·같은 동의 epoch·해당 종류 동의가 모두 유지되는지. */
const consentHolds = (s: SettingsRow | null, kind: "manual" | "scheduled", revision: number): boolean =>
  s !== null && s.consent_version === STORY_CONSENT_VERSION && s.consent_revision === String(revision)
  && (kind === "manual" ? s.manual_enabled : s.auto_enabled);

// ---------------------------------------------------------------- 수동 요청

export async function requestManualStory(
  db: Db,
  subject: SessionSubject,
  date: string,
  opts?: { now?: () => Date },
): Promise<Result<{ jobId: string }, StoryRequestError>> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  const now = opts?.now?.() ?? new Date();
  if (parseLocalDate(date) === null || !(now instanceof Date) || Number.isNaN(now.getTime())) return { ok: false, error: "invalid_date" };
  const today = seoulLocalDate(now);
  if (date > today) return { ok: false, error: "invalid_date" };
  try {
    return await withTransaction(db, async (tx): Promise<Result<{ jobId: string }, StoryRequestError>> => {
      const user = await lockUser(tx, subject.userId);
      if (!userActive(user, subject.gen)) return { ok: false, error: "not_signed_in" };
      const settings = await readSettings(tx, subject.userId);
      if (settings === null || settings.consent_version !== STORY_CONSENT_VERSION || !settings.manual_enabled) {
        return { ok: false, error: "consent_missing" };
      }
      // 서울 요청일의 수동 요청 수(실패 포함). created_at은 DB 시각이므로 하한만 둔다.
      const count = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pod.story_jobs
          WHERE user_id = $2::uuid AND kind = 'manual' AND created_at >= ${SEOUL_DAY_START}`,
        [today, subject.userId],
      );
      if (count.rows[0]!.n >= STORY_MANUAL_DAILY_MAX) return { ok: false, error: "limited" };
      const input = await captureStoryInputV2(tx, subject.userId, date);
      if (!input.ok) return { ok: false, error: input.error };
      if (await findStoryByRevision(tx, subject.userId, date, input.value.revisionV1)) return { ok: false, error: "already_current" };
      const r = await tx.query<{ id: string }>(
        `INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision)
         VALUES ($1::uuid, $2::date, 'manual', 'queued', $3, $4::bigint, $5, $6::bigint)
         RETURNING id::text AS id`,
        [subject.userId, date, input.value.revision, user!.gen, settings.consent_version, settings.consent_revision],
      );
      return { ok: true, value: { jobId: r.rows[0]!.id } };
    });
  } catch (err) {
    const e = err as Partial<DatabaseError>;
    if (e?.code === "23505" && e.constraint === "story_jobs_one_inflight") return { ok: false, error: "busy" };
    if (e?.code === "23505" && e.constraint === "story_jobs_manual_once") return { ok: false, error: "already_current" };
    return { ok: false, error: "unavailable" };
  }
}

// ---------------------------------------------------------------- 화면 판정(읽기 전용)

export async function readStoryGeneration(
  db: Pick<Db, "query">,
  userId: string,
  date: string,
  keyReady: boolean,
): Promise<StoryGenerationView> {
  if (!keyReady || !isUuid(userId) || parseLocalDate(date) === null) return { state: "unavailable" };
  const settings = await readSettings(db, userId);
  const policy = settings !== null && settings.consent_version === STORY_CONSENT_VERSION;
  const manualEnabled = policy && settings.manual_enabled;
  const autoEnabled = policy && settings.auto_enabled;
  const latest = (await db.query<{ kind: "manual" | "scheduled"; state: string; error: string | null }>(
    `SELECT kind, state, error FROM pod.story_jobs
      WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, date],
  )).rows[0];
  if (latest && (latest.state === "queued" || latest.state === "running")) {
    return { state: latest.state as "queued" | "running", kind: latest.kind };
  }
  const count = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pod.story_jobs
      WHERE user_id = $1::uuid AND kind = 'manual'
        AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`,
    [userId],
  )).rows[0]!.n;
  const canRequest = manualEnabled && count < STORY_MANUAL_DAILY_MAX;
  if (latest && latest.state === "failed") {
    const failure = (FAILURES.includes(latest.error ?? "") ? latest.error : "unavailable") as StoryJobFailure;
    return { state: "failed", failure, canRetry: canRequest };
  }
  if (!manualEnabled) return { state: "off", manualEnabled: false, autoEnabled };
  return canRequest ? { state: "ready", autoEnabled } : { state: "limited" };
}

// ---------------------------------------------------------------- lease 만료·자동 enqueue

/** 만료된 running job을 lease_expired로 닫고 그 job의 sent 사용량을 unknown으로 둔다. 재큐잉은 0이다. */
export async function expireStoryLeases(db: Db): Promise<number> {
  const r = await db.query<{ n: number }>(
    `WITH expired AS (
       UPDATE pod.story_jobs
          SET state = 'failed', error = 'lease_expired', lease_token = NULL, lease_until = NULL, updated_at = now()
        WHERE state = 'running' AND lease_until <= clock_timestamp()
        RETURNING id
     ), unknown AS (
       UPDATE pod.story_usage SET state = 'unknown', settled_at = now()
        WHERE state = 'sent' AND job_id IN (SELECT id FROM expired)
        RETURNING 1
     )
     SELECT count(*)::int AS n FROM expired`,
  );
  return r.rows[0]!.n;
}

/**
 * 회고 시각(설정이 없으면 20:00)이 지난 자동 동의 계정에 서울 하루 1회 job을 넣는다. now는 시험 주입용이다.
 * 대상 users 행을 id 순서로 먼저 잠근 뒤 넣는다(users → job). 잠금 없이 넣으면 수동 요청(users FOR UPDATE 뒤 insert)과
 * 고유 index 대기·FK KEY SHARE 대기가 엇갈려 교착할 수 있다.
 */
export async function enqueueDueStories(db: Db, opts?: { now?: Date }): Promise<number> {
  const now = opts?.now;
  if (now !== undefined && (!(now instanceof Date) || Number.isNaN(now.getTime()))) throw new Error("enqueueDueStories: invalid now");
  const r = await db.query(
    `WITH clock AS (SELECT (COALESCE($2::timestamptz, clock_timestamp()) AT TIME ZONE 'Asia/Seoul') AS ts),
     due AS (
       SELECT s.user_id, (c.ts)::date AS local_date, u.auth_generation, s.consent_version, s.consent_revision
         FROM pod.story_ai_settings s
         JOIN pod.users u ON u.id = s.user_id AND u.status = 'active'
         LEFT JOIN pod.preferences p ON p.user_id = s.user_id
         CROSS JOIN clock c
        WHERE s.auto_enabled AND s.consent_version = $1
          AND (c.ts)::time >= COALESCE(p.reflection_time, '20:00')::time
          AND s.auto_enabled_at < (((c.ts)::date + COALESCE(p.reflection_time, '20:00')::time) AT TIME ZONE 'Asia/Seoul')
        ORDER BY u.id
        FOR UPDATE OF u
     )
     INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision)
     SELECT user_id, local_date, 'scheduled', 'queued', auth_generation, consent_version, consent_revision
       FROM due ORDER BY user_id
     ON CONFLICT DO NOTHING`,
    [STORY_CONSENT_VERSION, now ? now.toISOString() : null],
  );
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------- claim

type JobRow = {
  id: string; user_id: string; local_date: string; kind: "manual" | "scheduled"; source_revision: string | null;
  auth_generation: string; consent_version: number; consent_revision: string;
};

export async function claimStoryJob(db: Db): Promise<
  | { kind: "none" }
  | { kind: "skipped" | "failed"; jobId: string }
  | { kind: "claimed"; job: ClaimedStoryJob }
> {
  const candidate = (await db.query<{ id: string; user_id: string }>(
    "SELECT id::text AS id, user_id::text AS user_id FROM pod.story_jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 1",
  )).rows[0];
  if (!candidate) return { kind: "none" };
  return withTransaction(db, async (tx) => {
    const user = await lockUser(tx, candidate.user_id);
    const settings = await readSettings(tx, candidate.user_id);
    const job = (await tx.query<JobRow>(
      `SELECT id::text AS id, user_id::text AS user_id, local_date::text AS local_date, kind, source_revision,
              auth_generation::text AS auth_generation, consent_version, consent_revision::text AS consent_revision
         FROM pod.story_jobs WHERE id = $1::uuid AND state = 'queued' FOR UPDATE SKIP LOCKED`,
      [candidate.id],
    )).rows[0];
    if (!job) return { kind: "none" } as const;
    const close = async (state: "failed" | "skipped", error: string) => {
      await tx.query("UPDATE pod.story_jobs SET state = $2, error = $3, updated_at = now() WHERE id = $1::uuid", [job.id, state, error]);
      return { kind: state, jobId: job.id } as const;
    };
    const gen = Number(job.auth_generation);
    const consentRevision = Number(job.consent_revision);
    if (!userActive(user, gen)) return close("failed", "not_signed_in");
    if (job.consent_version !== STORY_CONSENT_VERSION || !consentHolds(settings, job.kind, consentRevision)) return close("failed", "consent_missing");
    const input = await captureStoryInputV2(tx, job.user_id, job.local_date);
    if (!input.ok) {
      if (input.error === "no_input") return close("skipped", "no_input");
      return close("failed", input.error === "invalid_date" ? "invalid_input" : input.error);
    }
    if (await findStoryByRevision(tx, job.user_id, job.local_date, input.value.revisionV1)) return close("skipped", "already_current");
    if (job.source_revision !== null && job.source_revision !== input.value.revision) return close("failed", "input_changed");
    const r = await tx.query<{ lease_token: string }>(
      `UPDATE pod.story_jobs
          SET state = 'running', source_revision = COALESCE(source_revision, $2), lease_token = gen_random_uuid(),
              lease_until = clock_timestamp() + ${LEASE}, updated_at = now()
        WHERE id = $1::uuid
        RETURNING lease_token::text AS lease_token`,
      [job.id, input.value.revision],
    );
    return {
      kind: "claimed",
      job: {
        id: job.id, userId: job.user_id, date: job.local_date, kind: job.kind, leaseToken: r.rows[0]!.lease_token,
        gen, consentVersion: job.consent_version, consentRevision, input: input.value,
      },
    } as const;
  });
}

// ---------------------------------------------------------------- 송신 직전 fence

/** 사진 준비 뒤·HTTP 직전에 계정·동의·lease·입력을 다시 확인하고 사용량 'sent'를 남긴다. 거부하면 job을 닫고 송신하지 않는다. */
export async function markStorySent(
  db: Db,
  job: ClaimedStoryJob,
  model: string,
): Promise<{ ok: true } | { ok: false; error: "not_signed_in" | "consent_missing" | "input_changed" | "lease_expired" }> {
  return withTransaction(db, async (tx) => {
    const user = await lockUser(tx, job.userId);
    const settings = await readSettings(tx, job.userId);
    const lease = (await tx.query<{ live: boolean }>(
      `SELECT lease_until > clock_timestamp() AS live FROM pod.story_jobs
        WHERE id = $1::uuid AND lease_token = $2::uuid AND state = 'running' FOR UPDATE`,
      [job.id, job.leaseToken],
    )).rows[0];
    let error: "not_signed_in" | "consent_missing" | "input_changed" | "lease_expired" | null = null;
    if (!userActive(user, job.gen)) error = "not_signed_in";
    else if (!consentHolds(settings, job.kind, job.consentRevision)) error = "consent_missing";
    else if (!lease?.live) error = "lease_expired";
    else {
      const input = await captureStoryInputV2(tx, job.userId, job.date);
      if (!input.ok || input.value.revision !== job.input.revision) error = "input_changed";
    }
    if (error !== null) {
      await tx.query(
        `UPDATE pod.story_jobs SET state = 'failed', error = $3, lease_token = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1::uuid AND lease_token = $2::uuid AND state = 'running'`,
        [job.id, job.leaseToken, error],
      );
      return { ok: false, error } as const;
    }
    await tx.query(
      `INSERT INTO pod.story_usage (job_id, usage_month, model, state)
       VALUES ($1::uuid, date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date, $2, 'sent')`,
      [job.id, model],
    );
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------- 완료

/**
 * 한 트랜잭션으로 사용량을 정산하고(fence 결과와 무관하게 commit) fence가 모두 통과한 성공만 이야기로 저장한다.
 * lease가 만료됐거나 이미 다른 상태로 닫힌 job은 저장하지 않는다. purge로 사용자·job이 없으면 익명 사용량만 남긴다.
 */
export async function finishStoryJob(db: Db, job: ClaimedStoryJob, outcome: StoryJobOutcome): Promise<"succeeded" | "failed"> {
  return withTransaction(db, async (tx) => {
    const user = await lockUser(tx, job.userId);
    const settings = await readSettings(tx, job.userId);
    const row = (await tx.query<{ state: string; lease_token: string | null; live: boolean | null }>(
      `SELECT state, lease_token::text AS lease_token, lease_until > clock_timestamp() AS live
         FROM pod.story_jobs WHERE id = $1::uuid FOR UPDATE`,
      [job.id],
    )).rows[0];

    if (outcome.usage) {
      await tx.query(
        `UPDATE pod.story_usage SET state = 'settled', input_tokens = $2, output_tokens = $3, settled_at = now()
          WHERE job_id = $1::uuid AND state IN ('sent', 'unknown')`,
        [job.id, outcome.usage.inputTokens, outcome.usage.outputTokens],
      );
    } else if (!outcome.ok && outcome.sent) {
      await tx.query("UPDATE pod.story_usage SET state = 'unknown', settled_at = now() WHERE job_id = $1::uuid AND state = 'sent'", [job.id]);
    } else {
      await tx.query("UPDATE pod.story_usage SET state = 'not_sent', settled_at = now() WHERE job_id = $1::uuid AND state = 'sent'", [job.id]);
    }

    if (!row || row.state !== "running" || row.lease_token !== job.leaseToken) return "failed";
    let error: string | null = null;
    let storyId: string | null = null;
    if (!userActive(user, job.gen)) error = "not_signed_in";
    else if (!consentHolds(settings, job.kind, job.consentRevision)) error = "consent_missing";
    else if (!row.live) error = "lease_expired";
    else if (!outcome.ok) error = outcome.error;
    else {
      // revision late fence: 요청 중 원본이 바뀌거나 지워졌으면 저장하지 않는다.
      const input = await captureStoryInputV2(tx, job.userId, job.date);
      if (!input.ok || input.value.revision !== job.input.revision) error = "input_changed";
      else {
        const saved = await appendStoryVersionTx(tx, { userId: job.userId, gen: job.gen }, job.date, input.value.revisionV1, outcome.body);
        if (saved.ok) storyId = saved.value.story.id;
        else error = "not_signed_in";
      }
    }
    if (storyId !== null) {
      await tx.query(
        `UPDATE pod.story_jobs SET state = 'succeeded', story_id = $2::uuid, error = NULL, lease_token = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1::uuid`,
        [job.id, storyId],
      );
      return "succeeded";
    }
    await tx.query(
      "UPDATE pod.story_jobs SET state = 'failed', error = $2, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1::uuid",
      [job.id, FAILURES.includes(error ?? "") ? error : "unavailable"],
    );
    return "failed";
  });
}
