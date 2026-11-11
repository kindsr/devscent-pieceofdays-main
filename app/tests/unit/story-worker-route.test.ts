// PLAN_ai-story-live-generation §4.8 RED. 내부 worker route의 인증 경계만 검사한다(worker·DB·사진 저장소는 mock).
// - route 파일이 없으면 export 단언만 실패한다. 서비스 mock은 route 존재 확인 뒤에만 등록한다(photo-routes 시험과 같은 방식).
// - 가짜 token·가짜 키만 쓴다(실제 API·DB·S3·네트워크 0). 실제 worker 동작은 tests/db/story-jobs.test.ts가 증명한다.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type Stats = { expired: number; enqueued: number; result: "closed" | "none" | "skipped" | "failed" | "succeeded" };
type Route = (request: Request) => Promise<Response>;

const h = vi.hoisted(() => ({
  events: [] as string[],
  deps: [] as unknown[],
  reply: { expired: 0, enqueued: 0, result: "none" } as unknown,
  workerError: null as Error | null,
  photoReply: { ok: true, value: null } as unknown,
  db: { ciOnlyDb: true } as object,
  blobs: { ciOnlyBlobs: true } as object,
  logs: [] as string[],
}));

const FILE = path.join(APP_DIR, "src", "app", "internal", "story-worker", "route.ts");
const URL_OK = "http://127.0.0.1:3000/internal/story-worker";
const TOKEN = "0123456789abcdef".repeat(4);
const OTHER_TOKEN = "fedcba9876543210".repeat(4);
const API_KEY = `sk-ant-api03-ci-only-route-${"z".repeat(40)}`;
const SECRET = "ci-only-worker-private-error-marker";
const PHOTO_CONFIG = { endpoint: "https://photos.example/", region: "us-east-1", bucket: "pieceofdays-ci-private", accessKeyId: "ci-only-access", secretAccessKey: "ci-only-secret" };

async function load(): Promise<Record<string, unknown>> {
  vi.resetModules();
  let mod: Record<string, unknown> = {};
  if (existsSync(FILE)) {
    vi.doMock("next/headers", () => ({
      headers: async () => { h.events.push("next-headers"); return new Headers(); },
      cookies: async () => { h.events.push("cookies"); return { get: () => undefined, getAll: () => [] }; },
    }));
    vi.doMock("@/server/db/pool", async (original) => {
      const real = await original<Record<string, unknown>>();
      return { ...real, getAppDb: () => { h.events.push("db"); return h.db; } };
    });
    vi.doMock("@/server/photos/config", () => ({ parsePhotoConfig: () => { h.events.push("photo-config"); return h.photoReply; } }));
    vi.doMock("@/server/photos/blob-store.s3", () => ({ createS3BlobStore: () => { h.events.push("blobs"); return h.blobs; } }));
    vi.doMock("@/server/stories/worker", () => ({
      STORY_JOB_DEADLINE_MS: 80_000,
      runOneStoryJob: async (deps: unknown) => {
        h.events.push("worker"); h.deps.push(deps);
        if (h.workerError) throw h.workerError;
        return h.reply;
      },
    }));
    mod = (await import(/* @vite-ignore */ FILE)) as Record<string, unknown>;
  }
  expect(typeof mod.POST, "src/app/internal/story-worker/route.ts must export POST (PLAN §4.8)").toBe("function");
  return mod;
}
async function route(): Promise<Route> {
  return (await load()).POST as Route;
}

function request(over: { headers?: Record<string, string>; body?: string; url?: string } = {}): Request {
  const headers = new Headers({ host: "127.0.0.1:3000", authorization: `Bearer ${TOKEN}`, ...(over.headers ?? {}) });
  return new Request(over.url ?? URL_OK, { method: "POST", headers, body: over.body });
}

async function expect404(response: Response, label: string) {
  expect(response.status, label).toBe(404);
  expect(await response.text(), `${label}: no body`).toBe("");
  expect(h.events.filter((e) => e === "worker" || e === "db"), `${label}: no worker or DB access`).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv("POD_STORY_WORKER_TOKEN", TOKEN);
  vi.stubEnv("ANTHROPIC_API_KEY", API_KEY);
  h.events = []; h.deps = []; h.logs = [];
  h.reply = { expired: 1, enqueued: 2, result: "succeeded" } satisfies Stats;
  h.workerError = null;
  h.photoReply = { ok: true, value: PHOTO_CONFIG };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { h.logs.push(args.map((a) => String(a instanceof Error ? `${a.message} ${a.stack ?? ""}` : a)).join(" ")); });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("next/headers");
  vi.doUnmock("@/server/db/pool");
  vi.doUnmock("@/server/photos/config");
  vi.doUnmock("@/server/photos/blob-store.s3");
  vi.doUnmock("@/server/stories/worker");
});

describe("internal story worker route module", () => {
  it("is a dynamic Node route exporting only POST", async () => {
    const mod = await load();
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.runtime).toBe("nodejs");
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(mod[method], `${method} is not exported (Next answers 405)`).toBeUndefined();
  });
});

describe("internal story worker route authentication", () => {
  it("runs one worker step with the app DB, the photo store and the Claude config, answering only the stats", async () => {
    const POST = await route();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json(;|$)/);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ expired: 1, enqueued: 2, result: "succeeded" });
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["expired", "enqueued", "result"]);
    expect(h.deps).toHaveLength(1);
    const deps = h.deps[0] as Record<string, unknown>;
    expect(deps.db).toBe(h.db);
    expect(deps.blobs).toBe(h.blobs);
    expect(deps.claude).toEqual({ apiKey: API_KEY, model: "claude-sonnet-5-5" });
    expect(h.events, "no cookie or session read").not.toContain("cookies");
    for (const secret of [TOKEN, API_KEY]) expect(text + h.logs.join("\n")).not.toContain(secret);
  });

  it("passes null blobs when photo storage is not configured and a null Claude config when the key is unset", async () => {
    h.photoReply = { ok: true, value: null };
    vi.stubEnv("ANTHROPIC_API_KEY", undefined as unknown as string);
    h.reply = { expired: 0, enqueued: 0, result: "closed" } satisfies Stats;
    const POST = await route();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expired: 0, enqueued: 0, result: "closed" });
    const deps = h.deps[0] as Record<string, unknown>;
    expect(deps.blobs).toBeNull();
    expect(deps.claude).toBeNull();
  });

  it("answers an empty 404 when the configured token is missing or not 64 lowercase hex", async () => {
    for (const value of [undefined, "", TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, "g".repeat(64)]) {
      vi.stubEnv("POD_STORY_WORKER_TOKEN", value as string);
      const POST = await route();
      h.events = [];
      await expect404(await POST(request()), `env token ${String(value).slice(0, 8)}…(${String(value).length})`);
    }
  });

  it("answers an empty 404 for a missing, malformed or different bearer token", async () => {
    const POST = await route();
    const cases: [string, Record<string, string>][] = [
      ["other token", { authorization: `Bearer ${OTHER_TOKEN}` }],
      ["uppercase", { authorization: `Bearer ${TOKEN.toUpperCase()}` }],
      ["short", { authorization: `Bearer ${TOKEN.slice(2)}` }],
      ["long", { authorization: `Bearer ${TOKEN}00` }],
      ["basic scheme", { authorization: `Basic ${TOKEN}` }],
      ["lowercase scheme", { authorization: `bearer ${TOKEN}` }],
      ["two spaces", { authorization: `Bearer  ${TOKEN}` }],
      ["trailing text", { authorization: `Bearer ${TOKEN} x` }],
    ];
    for (const [label, headers] of cases) { h.events = []; await expect404(await POST(request({ headers })), label); }
    h.events = [];
    const bare = new Headers({ host: "127.0.0.1:3000" });
    await expect404(await POST(new Request(URL_OK, { method: "POST", headers: bare })), "no authorization");
  });

  it("answers an empty 404 when any forwarding header is present or the Host is not 127.0.0.1:3000", async () => {
    const POST = await route();
    const cases: [string, Record<string, string>][] = [
      ["x-forwarded-for", { "x-forwarded-for": "127.0.0.1" }],
      ["x-forwarded-host", { "x-forwarded-host": "127.0.0.1:3000" }],
      ["x-forwarded-proto", { "x-forwarded-proto": "http" }],
      ["forwarded", { forwarded: "for=127.0.0.1" }],
      ["public host", { host: "dev.pieceofdays.com" }],
      ["localhost name", { host: "localhost:3000" }],
      ["other port", { host: "127.0.0.1:80" }],
      ["no port", { host: "127.0.0.1" }],
    ];
    for (const [label, headers] of cases) { h.events = []; await expect404(await POST(request({ headers })), label); }
  });

  it("answers an empty 404 for a request with a body", async () => {
    const POST = await route();
    h.events = [];
    await expect404(await POST(request({ headers: { "content-length": "2" }, body: "{}" })), "content-length 2");
    h.events = [];
    const ok = await POST(request({ headers: { "content-length": "0" } }));
    expect(ok.status, "an explicit zero length is allowed").toBe(200);
  });

  it("answers a fixed 503 without the error text when the worker throws", async () => {
    h.workerError = new Error(`${SECRET} ${TOKEN} ${API_KEY}`);
    const POST = await route();
    const response = await POST(request());
    expect(response.status).toBe(503);
    const text = await response.text();
    for (const secret of [SECRET, TOKEN, API_KEY]) {
      expect(text, "response").not.toContain(secret);
      expect(h.logs.join("\n"), "logs").not.toContain(secret);
    }
  });
});
