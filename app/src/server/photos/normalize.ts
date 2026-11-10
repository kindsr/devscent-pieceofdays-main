import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { NormalizedPhoto } from "./blob-store";
import type { Result } from "../result";
import { PHOTO_INPUT_MAX_BYTES, PHOTO_MAX_PIXELS, PHOTO_MAX_SIDE, PHOTO_OUTPUT_MAX_BYTES, type PhotoError } from "@/shared/photos";

let processing = false;

/** 네이티브 작업이 settle할 때까지 단일 slot을 유지한다. JS 시간 경주로 조기 해제하지 않는다. */
export async function normalizePhoto(bytes: Uint8Array): Promise<Result<NormalizedPhoto, PhotoError>> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, error: "invalid_photo" };
  if (bytes.byteLength > PHOTO_INPUT_MAX_BYTES) return { ok: false, error: "photo_too_large" };
  if (processing) return { ok: false, error: "busy" };
  processing = true;
  try {
    const image = sharp(bytes, { limitInputPixels: PHOTO_MAX_PIXELS, failOn: "warning" }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) return { ok: false, error: "invalid_photo" };
    if (metadata.width * metadata.height > PHOTO_MAX_PIXELS) return { ok: false, error: "photo_too_large" };
    const { data, info } = await image.autoOrient().resize({ width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (data.length > PHOTO_OUTPUT_MAX_BYTES) return { ok: false, error: "photo_too_large" };
    return { ok: true, value: { bytes: data, sha256: createHash("sha256").update(data).digest("hex"), width: info.width, height: info.height, contentType: "image/jpeg" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, error: /timeout/i.test(message) ? "unavailable" : /pixel limit/i.test(message) ? "photo_too_large" : "invalid_photo" };
  } finally {
    processing = false;
  }
}
