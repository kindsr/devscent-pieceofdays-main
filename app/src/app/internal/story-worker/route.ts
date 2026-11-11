// 내부 story worker route(PLAN_ai-story-live-generation §4.8). 컨테이너 안 native CLI만 127.0.0.1:3000으로 부른다.
// - front 허용 목록에 없어 외부에서는 404다. 같은 DB망의 다른 컨테이너도 닿을 수 있으므로 별도 token을 상수 시간 비교한다.
// - token·Host·전달 헤더·본문 중 하나라도 맞지 않으면 본문 없는 404, worker 예외는 고정 503이다. cookie·세션은 읽지 않는다.
// - x-forwarded-*: Next 서버(base-server)가 route handler 전에 host/port/proto/for를 기본값으로 채운다. 그래서 네 값이 모두
//   없거나(직접 호출) 모두 loopback 기본값과 정확히 같을 때만 받는다. 일부만 있거나 다르면, 또는 Forwarded가 있으면 404다.
//   이 헤더는 실제 TCP 상대의 증명이 아니다. 보안 경계는 token과 Host, 그리고 front의 허용 목록 밖 404다.
// - 키·token·사용자 식별자·원문 오류는 응답·로그에 넣지 않는다.
import { timingSafeEqual } from "node:crypto";
import { getAppDb } from "@/server/db/pool";
import { parsePhotoConfig } from "@/server/photos/config";
import { createS3BlobStore } from "@/server/photos/blob-store.s3";
import { parseClaudeConfig } from "@/server/stories/claude";
import { runOneStoryJob } from "@/server/stories/worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer ([0-9a-f]{64})$/;
// Next가 넣는 loopback 기본값. for는 연결 주소 하나(IPv4·IPv6·IPv4-mapped)만 허용한다.
const FORWARDED_DEFAULT: Record<string, readonly string[]> = {
  "x-forwarded-host": ["127.0.0.1:3000"],
  "x-forwarded-port": ["3000"],
  "x-forwarded-proto": ["http"],
  "x-forwarded-for": ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
};

function forwardingAllowed(headers: Headers): boolean {
  if (headers.has("forwarded")) return false;
  const names = Object.keys(FORWARDED_DEFAULT);
  const present = names.filter((name) => headers.has(name));
  if (present.length === 0) return true;
  if (present.length !== names.length) return false;
  return names.every((name) => FORWARDED_DEFAULT[name]!.includes(headers.get(name)!));
}

const notFound = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

function authorized(request: Request): boolean {
  const expected = process.env.POD_STORY_WORKER_TOKEN;
  if (typeof expected !== "string" || !TOKEN.test(expected)) return false;
  const headers = request.headers;
  if (headers.get("host") !== "127.0.0.1:3000") return false;
  if (!forwardingAllowed(headers)) return false;
  const length = headers.get("content-length");
  if ((length !== null && length !== "0") || headers.has("transfer-encoding")) return false;
  const match = BEARER.exec(headers.get("authorization") ?? "");
  if (!match) return false;
  return timingSafeEqual(Buffer.from(match[1]!, "hex"), Buffer.from(expected, "hex"));
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return notFound();
  let blobs: ReturnType<typeof createS3BlobStore> | null = null;
  try {
    const claude = parseClaudeConfig(process.env);
    const photos = parsePhotoConfig(process.env);
    blobs = photos.ok && photos.value ? createS3BlobStore(photos.value) : null;
    const stats = await runOneStoryJob({ db: getAppDb(), blobs, claude: claude.ok ? claude.value : null });
    return new Response(JSON.stringify({ expired: stats.expired, enqueued: stats.enqueued, result: stats.result }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    try { blobs?.destroy?.(); } catch { /* 종료 오류의 원문도 남기지 않는다. */ }
  }
}
