import "server-only";
import { createHash } from "node:crypto";
import type { PhotoError } from "@/shared/photos";
import type { SessionSubject } from "../account/lifecycle";
import type { Db } from "../db/pool";
import type { MomentRef } from "../diary/store";
import { isUuid } from "../ids";
import type { Result } from "../result";
import type { BlobStore, NormalizedPhoto } from "./blob-store";
import { abandonPhotoUpload, completePhotoUpload, reservePhotoUpload, type UploadReservation } from "./store.pg";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** photo는 normalizePhoto가 만든 내부 port 값이다. 원본 입력 검증/재인코딩을 반복하지 않는다. */
export async function createPhotoMoment(
  db: Db, blobs: BlobStore, viewer: SessionSubject,
  input: { requestId: string; memo: string; photo: NormalizedPhoto },
): Promise<Result<{ moment: MomentRef; replayed: boolean }, PhotoError>> {
  if (!isUuid(viewer.userId) || !Number.isSafeInteger(viewer.gen) || viewer.gen < 1) return { ok: false, error: "not_signed_in" };
  if (typeof input.requestId !== "string" || input.requestId.length !== 36 || !REQUEST_ID.test(input.requestId)) return { ok: false, error: "invalid_request" };
  if (typeof input.memo !== "string") return { ok: false, error: "invalid_body" };
  const memo = input.memo.trim();
  const length = Array.from(memo).length;
  if (length < 1 || length > 300) return { ok: false, error: "invalid_body" };
  const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, sha256: input.photo.sha256, memo })).digest("hex");
  let upload: UploadReservation | undefined;
  try {
    const reservation = await reservePhotoUpload(db, viewer, input.requestId, fingerprint);
    if (!reservation.ok) return reservation;
    if (reservation.value.kind === "replayed") return { ok: true, value: { moment: reservation.value.moment, replayed: true } };
    upload = reservation.value.upload;
    await blobs.put(upload.key, input.photo, AbortSignal.timeout(15_000));
    const completed = await completePhotoUpload(db, viewer, upload, memo, input.photo);
    if (completed.ok) return { ok: true, value: { moment: completed.value, replayed: false } };
    await abandonPhotoUpload(db, upload).catch(() => undefined);
    return completed;
  } catch {
    if (upload) await abandonPhotoUpload(db, upload).catch(() => undefined);
    return { ok: false, error: "unavailable" };
  }
}
