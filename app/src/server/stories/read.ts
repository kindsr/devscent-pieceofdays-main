/**
 * 날짜별 이야기 읽기(PLAN_ai-daily-story-storage §2). 쓰기·생성은 하지 않는다.
 *
 * - 순서: subject → 날짜 → active+gen → 최신 이야기 → 현재 입력. 두 문장 사이에 입력이 바뀌면
 *   revision이 달라져 outdated 쪽으로만 보인다(revision에 version이 들어가 되돌아가지 않는다).
 * - 현재 입력을 읽지 못하면(없음·31개·보낼 수 없는 글자) inputRevision은 null이고 기존 이야기는 outdated로 보인다.
 * - DTO에는 StoryRef만 복사한다. 내부 sourceRevision은 넣지 않는다. 예상 밖 DB 오류는 호출자에게 throw한다.
 */
import "server-only";
import { verifyActiveAccount, type SessionSubject } from "../account/lifecycle";
import type { Db } from "../db/pool";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import type { StoryDay } from "@/shared/stories";
import { captureStoryInput } from "./input.pg";
import { findLatestStory, isStorySubject } from "./store.pg";

export async function readStoryDay(
  db: Db,
  subject: SessionSubject,
  date: string,
): Promise<Result<StoryDay, "invalid_date" | "not_signed_in">> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  if (typeof date !== "string" || parseLocalDate(date) === null) return { ok: false, error: "invalid_date" };
  if (!(await verifyActiveAccount(db, subject))) return { ok: false, error: "not_signed_in" };
  const latest = await findLatestStory(db, subject.userId, date);
  const input = await captureStoryInput(db, subject.userId, date);
  const inputRevision = input.ok ? input.value.revision : null;
  const story = latest ? { id: latest.id, version: latest.version, body: latest.body, createdAt: latest.createdAt } : null;
  const state = !latest ? "none" : inputRevision !== null && latest.sourceRevision === inputRevision ? "current" : "outdated";
  return { ok: true, value: { date, inputRevision, story, state, generation: "unavailable" } };
}
