/**
 * 이야기 입력 스냅샷(PLAN_ai-daily-story-storage §2). 그날 조각을 SQL 한 문장으로 읽는다.
 *
 * - revision은 날짜와 조각 (id, version)만으로 만든다. 메모 수정은 version을 올리고 삭제는 실제 DELETE다.
 * - 사진·정리 한 줄·글꼴·회고 시간은 입력이 아니다. 사진 전송을 도입하면 revision v2와 별도 시험을 둔다.
 * - 상한을 넘거나 보낼 수 없는 글자가 있으면 잘라 내거나 건너뛰지 않고 그날 전체를 거부한다.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import { STORY_INPUT_MAX_BYTES, STORY_INPUT_MAX_MOMENTS, STORY_TEXT_MAX } from "@/shared/stories";

export type StoryMoment = { id: string; version: number; time: string; text: string };
export type StoryInput = { date: string; revision: string; moments: StoryMoment[] };

// C0·DEL·C1 제어 문자. LF·CR·TAB만 허용한다(Claude 어댑터와 같은 규칙).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const validText = (text: string) => text.trim() !== "" && Array.from(text).length <= STORY_TEXT_MAX && !CONTROL.test(text);

export function storyRevision(date: string, refs: readonly { id: string; version: number }[]): string {
  const lines = [...refs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => `${r.id}:${r.version}\n`);
  return createHash("sha256").update(`v1\n${date}\n${lines.join("")}`, "utf8").digest("hex");
}

/** 외부로 보낼 수 있는 모양 {date, moments:[{time,text}]}만 새 객체로 복사한다. 식별자는 넣지 않는다. */
export function storyPayload(input: StoryInput): { date: string; moments: { time: string; text: string }[] } {
  return { date: input.date, moments: input.moments.map((m) => ({ time: m.time, text: m.text })) };
}

export async function captureStoryInput(
  db: Pick<Db, "query">,
  userId: string,
  date: string,
): Promise<Result<StoryInput, "invalid_date" | "no_input" | "input_too_large" | "invalid_input">> {
  if (!isUuid(userId) || parseLocalDate(date) === null) return { ok: false, error: "invalid_date" };
  const r = await db.query<StoryMoment>(
    `SELECT id::text AS id, version, to_char(occurred_at AT TIME ZONE time_zone, 'HH24:MI') AS time, body AS text
       FROM pod.diary_moments
      WHERE user_id = $1::uuid AND local_date = $2::date
      ORDER BY occurred_at, id
      LIMIT ${STORY_INPUT_MAX_MOMENTS + 1}`,
    [userId, date],
  );
  if (r.rows.length === 0) return { ok: false, error: "no_input" };
  if (r.rows.length > STORY_INPUT_MAX_MOMENTS) return { ok: false, error: "input_too_large" };
  const moments = r.rows.map((m) => ({ id: m.id, version: m.version, time: m.time, text: m.text }));
  if (!moments.every((m) => validText(m.text))) return { ok: false, error: "invalid_input" };
  const input = { date, revision: storyRevision(date, moments), moments };
  if (new TextEncoder().encode(JSON.stringify(storyPayload(input))).byteLength > STORY_INPUT_MAX_BYTES) {
    return { ok: false, error: "input_too_large" };
  }
  return { ok: true, value: input };
}
