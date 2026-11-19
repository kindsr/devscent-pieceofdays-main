/**
 * 사진을 포함한 이야기 입력 스냅샷(PLAN_ai-story-live-generation §4.2). S1 `input.pg.ts`의 v1 계약은 그대로 둔다.
 *
 * - SQL 한 문장으로 그날 조각과, 같은 사용자의 ready 업로드로 확정된 사진 참조를 읽는다(owner·ready fence).
 * - revision(v2)은 job·late fence용으로 사진 sha까지 넣고, revisionV1은 저장·replay용 S1 값이다.
 * - 상한·글자 규칙은 v1과 같다. 넘으면 잘라 내거나 건너뛰지 않고 그날 전체를 거부한다.
 * - objectKey·photoId는 서버 안에서만 쓴다(외부 payload·DTO·로그 0).
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { parseLocalDate } from "@/shared/local-date";
import { STORY_INPUT_MAX_BYTES, STORY_INPUT_MAX_MOMENTS, STORY_TEXT_MAX } from "@/shared/stories";
import { storyRevision } from "./input.pg";

export type StoryPhotoRef = { photoId: string; sha256: string; byteLength: number; objectKey: string };
export type StoryMomentV2 = { id: string; version: number; time: string; text: string; photo: StoryPhotoRef | null };
export type StoryInputV2 = { date: string; revision: string; revisionV1: string; moments: StoryMomentV2[] };

// C0·DEL·C1 제어 문자. LF·CR·TAB만 허용한다(v1·Claude 어댑터와 같은 규칙).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const validText = (text: string) => text.trim() !== "" && Array.from(text).length <= STORY_TEXT_MAX && !CONTROL.test(text);

export function storyRevisionV2(date: string, refs: readonly { id: string; version: number; photoSha256: string | null }[]): string {
  const lines = [...refs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => `${r.id}:${r.version}:${r.photoSha256 ?? "-"}\n`);
  return createHash("sha256").update(`v2\n${date}\n${lines.join("")}`, "utf8").digest("hex");
}

type Row = {
  id: string; version: number; time: string; text: string;
  photo_id: string | null; sha256: string | null; byte_length: number | null; object_key: string | null;
};

export async function captureStoryInputV2(
  db: Pick<Db, "query">,
  userId: string,
  date: string,
): Promise<Result<StoryInputV2, "invalid_date" | "no_input" | "input_too_large" | "invalid_input">> {
  if (!isUuid(userId) || parseLocalDate(date) === null) return { ok: false, error: "invalid_date" };
  const r = await db.query<Row>(
    `SELECT m.id::text AS id, m.version, to_char(m.occurred_at AT TIME ZONE m.time_zone, 'HH24:MI') AS time, m.body AS text,
            p.id::text AS photo_id, p.sha256, p.byte_length, u.object_key
       FROM pod.diary_moments m
       LEFT JOIN pod.moment_photos p ON p.moment_id = m.id AND p.user_id = m.user_id
       LEFT JOIN pod.photo_uploads u ON u.id = p.id AND u.user_id = p.user_id AND u.status = 'ready'
      WHERE m.user_id = $1::uuid AND m.local_date = $2::date
      ORDER BY m.occurred_at, m.id
      LIMIT ${STORY_INPUT_MAX_MOMENTS + 1}`,
    [userId, date],
  );
  if (r.rows.length === 0) return { ok: false, error: "no_input" };
  if (r.rows.length > STORY_INPUT_MAX_MOMENTS) return { ok: false, error: "input_too_large" };
  const moments: StoryMomentV2[] = [];
  for (const row of r.rows) {
    if (!validText(row.text)) return { ok: false, error: "invalid_input" };
    let photo: StoryPhotoRef | null = null;
    if (row.photo_id !== null) {
      // 연결된 사진이 ready 업로드로 확인되지 않으면 그 사진만 빼지 않고 그날 전체를 거부한다.
      if (row.object_key === null || row.sha256 === null || row.byte_length === null) return { ok: false, error: "invalid_input" };
      photo = { photoId: row.photo_id, sha256: row.sha256, byteLength: row.byte_length, objectKey: row.object_key };
    }
    moments.push({ id: row.id, version: row.version, time: row.time, text: row.text, photo });
  }
  const payload = { date, moments: moments.map((m) => ({ time: m.time, text: m.text })) };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > STORY_INPUT_MAX_BYTES) {
    return { ok: false, error: "input_too_large" };
  }
  return {
    ok: true,
    value: {
      date,
      revision: storyRevisionV2(date, moments.map((m) => ({ id: m.id, version: m.version, photoSha256: m.photo?.sha256 ?? null }))),
      revisionV1: storyRevision(date, moments),
      moments,
    },
  };
}
