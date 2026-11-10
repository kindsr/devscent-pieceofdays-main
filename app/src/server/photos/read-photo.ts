import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { PHOTO_MAX_PIXELS, PHOTO_MAX_SIDE, PHOTO_OUTPUT_MAX_BYTES } from "@/shared/photos";
import type { SessionSubject } from "../account/lifecycle";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import type { BlobStore } from "./blob-store";
import { findOwnedPhoto } from "./store.pg";

export async function readPhoto(
  db: Pick<Db, "query">, blobs: BlobStore, viewer: SessionSubject, photoId: string, signal?: AbortSignal,
): Promise<Result<{ bytes: Buffer; contentType: "image/jpeg" }, "not_found" | "unavailable">> {
  if (!isUuid(photoId) || !isUuid(viewer.userId) || !Number.isSafeInteger(viewer.gen) || viewer.gen < 1) return { ok: false, error: "not_found" };
  try {
    if (signal?.aborted) return { ok: false, error: "unavailable" };
    const initial = await findOwnedPhoto(db, viewer, photoId);
    if (!initial) return { ok: false, error: "not_found" };
    const bytes = await blobs.get(initial.object_key, signal);
    if (!bytes || bytes.length < 1 || bytes.length > PHOTO_OUTPUT_MAX_BYTES || bytes.length !== initial.byte_length
      || createHash("sha256").update(bytes).digest("hex") !== initial.sha256) return { ok: false, error: "unavailable" };
    // JPEG header metadata만 읽는다. GET은 정규화/재인코딩하지 않는다.
    const metadata = await sharp(bytes, { limitInputPixels: PHOTO_MAX_PIXELS }).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== initial.width || metadata.height !== initial.height
      || initial.width > PHOTO_MAX_SIDE || initial.height > PHOTO_MAX_SIDE) return { ok: false, error: "unavailable" };
    const final = await findOwnedPhoto(db, viewer, photoId);
    if (!final) return { ok: false, error: "not_found" };
    if (signal?.aborted || final.object_key !== initial.object_key || final.sha256 !== initial.sha256
      || final.byte_length !== initial.byte_length || final.width !== initial.width || final.height !== initial.height) return { ok: false, error: "unavailable" };
    return { ok: true, value: { bytes, contentType: "image/jpeg" } };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
