// liveness(PLAN_dev-app-deployment §4): DB·env를 읽지 않는 고정 200. 공개 프록시 허용 목록에 없다.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
