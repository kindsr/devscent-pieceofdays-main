// readiness(PLAN_dev-app-deployment §4): 앱 Pool과 분리한 요청마다의 단발 pg.Client로 SELECT 1만 한다.
// - 요청 시작부터 전체 2초 deadline(setTimeout)과 connect·query를 경합시킨다. 직렬 timeout 합계를 deadline으로 세지 않는다.
// - 모든 경로에서 타이머를 해제하고 client 종료를 시작하되, 종료를 기다려 응답을 늦추지 않는다.
//   성공이 아니면(실패·deadline) 이 요청의 socket을 즉시 끊는다(응답하지 않는 상대에게 연결을 남기지 않는다).
// - 늦게 끝나는 거부·종료 실패는 삼켜 원문 로그·unhandled rejection을 남기지 않는다. 쓰기·스키마 접근은 없다.
// - 200은 migration 완료의 증거가 아니다. 공개 프록시 허용 목록에 없다.
import net from "node:net";
import pg from "pg";

export const dynamic = "force-dynamic";

const DEADLINE_MS = 2000;
const HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

function answer(ready: boolean): Response {
  return new Response(ready ? "ok" : "not ready", { status: ready ? 200 : 503, headers: HEADERS });
}

function startClose(client: pg.Client): void {
  try {
    void Promise.resolve(client.end()).catch(() => undefined);
  } catch {
    // 종료 시작 실패도 응답에는 영향을 주지 않는다.
  }
}

function abort(socket: net.Socket | undefined): void {
  if (!socket || socket.destroyed) return;
  try {
    socket.resetAndDestroy();
  } catch {
    socket.destroy();
  }
}

export async function GET(): Promise<Response> {
  const connectionString = process.env.POD_DATABASE_URL;
  if (!connectionString) return answer(false);

  // pg 공개 옵션 `stream`으로 이 요청 전용 socket을 만들어, 실패 시 끊을 대상을 직접 갖는다.
  let socket: net.Socket | undefined;
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    stream: () => (socket = new net.Socket()),
  });
  client.on("error", () => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), DEADLINE_MS);
  });
  const check = (async () => {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  })().catch(() => false);

  let ready = false;
  try {
    ready = await Promise.race([check, deadline]);
    return answer(ready);
  } finally {
    clearTimeout(timer);
    startClose(client);
    if (!ready) abort(socket);
  }
}
