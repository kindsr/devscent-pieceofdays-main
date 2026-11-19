import "server-only";
import type { NextRequest } from "next/server";
import { getViewer } from "@/server/context";
import { getAppDb } from "@/server/db/pool";
import { createS3BlobStore } from "@/server/photos/blob-store.s3";
import type { BlobStore } from "@/server/photos/blob-store";
import { parsePhotoConfig } from "@/server/photos/config";
import { readPhoto } from "@/server/photos/read-photo";

export const runtime = "nodejs";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TEXT = { 401: "다시 로그인해 주세요.", 404: "사진을 찾을 수 없어요.", 503: "지금은 사진을 불러올 수 없어요." } as const;
const failure = (status: 401 | 404 | 503) => new Response(TEXT[status], { status, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" } });

/** 소유권·계정 세대의 최초/최종 확인과 객체 무결성은 readPhoto 안에서 끝낸다. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let blobs: BlobStore | undefined;
  try {
    const viewer = await getViewer();
    if (viewer.kind !== "user") return failure(viewer.kind === "unavailable" ? 503 : 401);
    const { id } = await params;
    if (id.length !== 36 || !ID.test(id)) return failure(404);
    const config = parsePhotoConfig(process.env);
    if (!config.ok || !config.value) return failure(503);
    blobs = createS3BlobStore(config.value);
    const result = await readPhoto(getAppDb(), blobs, { userId: viewer.userId, gen: viewer.gen }, id, req.signal);
    if (!result.ok) return failure(result.error === "not_found" ? 404 : 503);
    if (req.signal.aborted) return failure(503);
    return new Response(new Uint8Array(result.value.bytes), { status: 200, headers: { ...PRIVATE, "Content-Type": "image/jpeg" } });
  } catch {
    return failure(503);
  } finally {
    try { blobs?.destroy?.(); } catch { /* 정리 오류의 원문도 응답하지 않는다. */ }
  }
}
