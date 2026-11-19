/**
 * native story worker CLI(PLAN_ai-story-live-generation §4.8·§11). 의존성 0, 인자 0.
 * 컨테이너 안에서 `node --env-file=<앱 env> src/server/stories/worker-cli.mjs`로 1회 실행하고, 고정 내부 주소의 route를 한 번 부른다.
 * - 직접 실행할 때만 process.env·global fetch로 동작한다. import만으로는 아무것도 하지 않는다.
 * - stdout에는 검증한 통계 JSON 한 줄만, 실패는 고정 stderr 한 줄과 exit 1이다. token은 출력하지 않는다.
 */
import { pathToFileURL } from "node:url";

const WORKER_URL = "http://127.0.0.1:3000/internal/story-worker";
const TIMEOUT_MS = 100_000;
const TOKEN = /^[0-9a-f]{64}$/;
const RESULTS = ["closed", "none", "skipped", "failed", "succeeded"];
const FAIL_LINE = "story-worker: unavailable\n";

const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** 정확한 {expired, enqueued, result}만 받아 고정 순서의 한 줄로 만든다. */
function statsLine(text) {
  let stats;
  try {
    stats = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return null;
  const keys = Object.keys(stats);
  if (keys.length !== 3 || !keys.includes("expired") || !keys.includes("enqueued") || !keys.includes("result")) return null;
  if (!count(stats.expired) || !count(stats.enqueued) || !RESULTS.includes(stats.result)) return null;
  return `${JSON.stringify({ expired: stats.expired, enqueued: stats.enqueued, result: stats.result })}\n`;
}

export async function runStoryWorkerCli({ env, request, stdout, stderr }) {
  const token = env.POD_STORY_WORKER_TOKEN;
  if (typeof token !== "string" || !TOKEN.test(token)) {
    stderr.write(FAIL_LINE);
    return 1;
  }
  try {
    const response = await request(WORKER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const line = response.status === 200 ? statsLine(text) : null;
    if (line === null) {
      stderr.write(FAIL_LINE);
      return 1;
    }
    stdout.write(line);
    return 0;
  } catch {
    stderr.write(FAIL_LINE);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStoryWorkerCli({ env: process.env, request: (url, init) => fetch(url, init), stdout: process.stdout, stderr: process.stderr });
}
