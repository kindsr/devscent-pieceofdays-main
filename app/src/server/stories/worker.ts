/**
 * 내부 worker 한 단계(PLAN_ai-story-live-generation §4.7). 호출 한 번에 job 하나만 처리한다.
 *
 * - 순서: lease 만료 정리 → (키가 있을 때만) 자동 enqueue → claim 1건 → 사진 준비 → 송신 직전 fence → Claude 1회 → 완료.
 * - 80초 worker signal이 사진 준비·송신 직전 확인·공급자 호출 전 구간에 걸린다. 시한이 지나면 성공도 저장하지 않는다.
 * - 외부 I/O 동안 DB 트랜잭션을 잡지 않는다. 자동 재시도는 0이다.
 */
import "server-only";
import type { BlobStore } from "../photos/blob-store";
import { generateClaudePhotoStory, type ClaudeConfig, type ClaudeFetch } from "./claude";
import { claimStoryJob, enqueueDueStories, expireStoryLeases, finishStoryJob, markStorySent, type ClaimedStoryJob } from "./jobs.pg";
import type { Db } from "../db/pool";
import { prepareStoryPhotos, type StoryVisionPhoto } from "./vision";

export const STORY_JOB_DEADLINE_MS = 80_000;

export type StoryWorkerStats = { expired: number; enqueued: number; result: "closed" | "none" | "skipped" | "failed" | "succeeded" };

function photoInput(job: ClaimedStoryJob, photos: readonly StoryVisionPhoto[]) {
  let next = 0;
  return {
    date: job.date,
    moments: job.input.moments.map((m) => ({ time: m.time, text: m.text, photo: m.photo ? photos[next++]! : null })),
  };
}

export async function runOneStoryJob(deps: {
  db: Db;
  blobs: Pick<BlobStore, "get"> | null;
  claude: ClaudeConfig | null;
  fetch?: ClaudeFetch;
}): Promise<StoryWorkerStats> {
  const { db, blobs, claude } = deps;
  const expired = await expireStoryLeases(db);
  if (claude === null) return { expired, enqueued: 0, result: "closed" };
  const enqueued = await enqueueDueStories(db);
  const claim = await claimStoryJob(db);
  if (claim.kind !== "claimed") return { expired, enqueued, result: claim.kind };
  const job = claim.job;
  const signal = AbortSignal.timeout(STORY_JOB_DEADLINE_MS);
  const notSent = (error: "photo_unavailable" | "timeout") => finishStoryJob(db, job, { ok: false, error, sent: false, usage: null });

  const refs = job.input.moments.flatMap((m) => (m.photo ? [m.photo] : []));
  let photos: StoryVisionPhoto[] = [];
  if (refs.length > 0) {
    if (blobs === null) return { expired, enqueued, result: await notSent("photo_unavailable") };
    const prepared = await prepareStoryPhotos(blobs, refs, signal);
    if (!prepared.ok) return { expired, enqueued, result: await notSent(signal.aborted ? "timeout" : "photo_unavailable") };
    photos = prepared.value;
  }
  if (signal.aborted) return { expired, enqueued, result: await notSent("timeout") };
  const mark = await markStorySent(db, job, claude.model);
  if (!mark.ok) return { expired, enqueued, result: "failed" };
  if (signal.aborted) {
    // 'sent' 행을 남긴 뒤 송신하지 않았으므로 not_sent로 정산한다.
    return { expired, enqueued, result: await finishStoryJob(db, job, { ok: false, error: "timeout", sent: false, usage: null }) };
  }

  const result = await generateClaudePhotoStory(claude, photoInput(job, photos), { fetch: deps.fetch, signal });
  const outcome = result.ok && !signal.aborted
    ? { ok: true as const, body: result.value.body, usage: result.usage }
    : result.ok
      ? { ok: false as const, error: "timeout" as const, sent: true, usage: result.usage }
      : { ok: false as const, error: result.error, sent: result.sent, usage: result.usage };
  return { expired, enqueued, result: await finishStoryJob(db, job, outcome) };
}
