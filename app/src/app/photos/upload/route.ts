import "server-only";
import type { NextRequest } from "next/server";
import { loadAuthConfig } from "@/server/auth/config";
import { assertSameOrigin } from "@/server/auth/session";
import { getViewer } from "@/server/context";
import { getAppDb } from "@/server/db/pool";
import { createS3BlobStore } from "@/server/photos/blob-store.s3";
import type { BlobStore } from "@/server/photos/blob-store";
import { parsePhotoConfig } from "@/server/photos/config";
import { createPhotoMoment } from "@/server/photos/create-moment";
import { normalizePhoto } from "@/server/photos/normalize";
import type { Result } from "@/server/result";
import { PHOTO_REQUEST_MAX_BYTES, type PhotoError } from "@/shared/photos";

export const runtime = "nodejs";
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATUS: Record<PhotoError, number> = {
  invalid_request: 400, invalid_body: 400, invalid_photo: 400, photo_too_large: 413,
  not_signed_in: 401, forbidden: 403, conflict: 409, busy: 503, unavailable: 503,
};
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: PhotoError) => Response.json({ ok: false, error }, { status: STATUS[error], headers: PRIVATE });

/** Content-Length는 선검사만 한다. 실제 읽은 바이트와 완료 시한을 별도로 제한한다. */
async function readBody(req: NextRequest): Promise<Result<Buffer, PhotoError>> {
  const length = req.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return { ok: false, error: "invalid_request" };
    if (Number(length) > PHOTO_REQUEST_MAX_BYTES) return { ok: false, error: "photo_too_large" };
  }
  if (!req.body) return { ok: false, error: "invalid_request" };
  const reader = req.body.getReader();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  let rejectDeadline: (reason: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { cancel(); rejectDeadline(new Error("photo_read_unavailable")); };
  const timer = setTimeout(abort, 15_000);
  req.signal.addEventListener("abort", abort, { once: true });
  try {
    if (req.signal.aborted) abort();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (req.signal.aborted || cancelled) return { ok: false, error: "unavailable" };
      if (done) return { ok: true, value: Buffer.concat(chunks, size) };
      size += value.byteLength;
      if (size > PHOTO_REQUEST_MAX_BYTES) {
        cancel();
        return { ok: false, error: "photo_too_large" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    cancel();
    return { ok: false, error: "unavailable" };
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** 설정 → 정확 Origin → 요청 viewer → 저장 설정, 그 뒤에만 multipart를 읽는다. */
export async function POST(req: NextRequest): Promise<Response> {
  let blobs: BlobStore | undefined;
  try {
    const auth = loadAuthConfig(process.env, process.env.NODE_ENV);
    if (!auth.ok) return failure("unavailable");
    if (!assertSameOrigin(auth.value.session, req.headers.get("origin")).ok) return failure("forbidden");
    const viewer = await getViewer();
    if (viewer.kind !== "user") return failure(viewer.kind === "unavailable" ? "unavailable" : "not_signed_in");
    const config = parsePhotoConfig(process.env);
    if (!config.ok || !config.value) return failure("unavailable");
    blobs = createS3BlobStore(config.value);
    const type = req.headers.get("content-type");
    if (!type || !/^multipart\/form-data\s*;\s*boundary=(?:"[^"\r\n]{1,70}"|[^\s;"\r\n]{1,70})\s*$/i.test(type)) return failure("invalid_request");
    const body = await readBody(req);
    if (!body.ok) return failure(body.error);
    let form: FormData;
    try {
      // 원본 Request.formData()는 사용하지 않는다. 한도를 확인한 버퍼만 파싱한다.
      form = await new Response(new Uint8Array(body.value), { headers: { "Content-Type": type } }).formData();
    } catch {
      return failure("invalid_request");
    }
    const entries = [...form.entries()];
    if (entries.length !== 3 || ["photo", "memo", "requestId"].some((key) => form.getAll(key).length !== 1)) return failure("invalid_request");
    const photo = form.get("photo");
    const memo = form.get("memo");
    const requestId = form.get("requestId");
    if (!(photo instanceof File) || typeof memo !== "string" || typeof requestId !== "string" || requestId.length !== 36 || !REQUEST_ID.test(requestId)) return failure("invalid_request");
    if (!memo.trim() || Array.from(memo.trim()).length > 300) return failure("invalid_body");
    if (req.signal.aborted) return failure("unavailable");
    const normalized = await normalizePhoto(new Uint8Array(await photo.arrayBuffer()));
    if (!normalized.ok) return failure(normalized.error);
    if (req.signal.aborted) return failure("unavailable");
    const result = await createPhotoMoment(getAppDb(), blobs, { userId: viewer.userId, gen: viewer.gen }, { requestId, memo, photo: normalized.value });
    if (!result.ok) return failure(result.error);
    return Response.json({ ok: true, value: result.value.moment }, { status: result.value.replayed ? 200 : 201, headers: PRIVATE });
  } catch {
    return failure("unavailable");
  } finally {
    try { blobs?.destroy?.(); } catch { /* 정리 오류의 원문도 응답하지 않는다. */ }
  }
}
