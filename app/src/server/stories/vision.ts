/**
 * 이야기용 사진 사본 준비(PLAN_ai-story-live-generation §4.3).
 *
 * - 이미 정규화된 저장 원본을 owner 행 기준 key로 한 장씩 직렬로 읽고, 길이·sha256이 DB 기록과 같은지 확인한다.
 * - 긴 변 512px 안으로(확대 없이) JPEG로 다시 만들고 metadata는 복사하지 않는다.
 * - 장당 256 KiB·합계 4 MiB·30장 상한. 한 장이라도 실패하면 일부만 보내지 않고 전체가 photo_unavailable이다.
 * - 결과에는 base64 JPEG만 담는다. key·사진 id·저장소 오류 원문은 결과·로그에 0이다.
 */
import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { BlobStore } from "../photos/blob-store";
import type { Result } from "../result";
import { STORY_PHOTO_MAX, STORY_PHOTO_MAX_BYTES, STORY_PHOTO_SIDE, STORY_PHOTOS_TOTAL_MAX_BYTES } from "@/shared/stories";
import type { StoryPhotoRef } from "./input-v2.pg";

export type StoryVisionPhoto = { mediaType: "image/jpeg"; data: string };

const unavailable = { ok: false, error: "photo_unavailable" } as const;

async function reencode(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "warning" })
    .timeout({ seconds: 5 })
    .resize({ width: STORY_PHOTO_SIDE, height: STORY_PHOTO_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function prepareStoryPhotos(
  blobs: Pick<BlobStore, "get">,
  photos: readonly StoryPhotoRef[],
  signal: AbortSignal,
): Promise<Result<StoryVisionPhoto[], "photo_unavailable">> {
  if (photos.length > STORY_PHOTO_MAX) return unavailable;
  const out: StoryVisionPhoto[] = [];
  let total = 0;
  try {
    for (const photo of photos) {
      if (signal.aborted) return unavailable;
      const stored = await blobs.get(photo.objectKey, signal);
      if (signal.aborted || stored === null || stored.byteLength !== photo.byteLength) return unavailable;
      if (createHash("sha256").update(stored).digest("hex") !== photo.sha256) return unavailable;
      const copy = await reencode(stored);
      if (signal.aborted) return unavailable;
      total += copy.byteLength;
      if (copy.byteLength > STORY_PHOTO_MAX_BYTES || total > STORY_PHOTOS_TOTAL_MAX_BYTES) return unavailable;
      out.push({ mediaType: "image/jpeg", data: copy.toString("base64") });
    }
  } catch {
    return unavailable;
  }
  return { ok: true, value: out };
}
