// PLAN_ai-story-live-generation §4.8·§6.1·§11 RED. native worker CLI.
// 계약(main Q1 승인 2026-11-11): worker-cli.mjs가 `export async function runStoryWorkerCli({ env, request, stdout, stderr }): Promise<0 | 1>`.
// - request(url, init)는 고정 URL·POST·Bearer·redirect:"error"·100초 signal을 받는다. 시험은 그 값을 단언한 뒤 자기 loopback 임의 port로 실제 HTTP를 보낸다.
// - 직접 실행(entry)일 때만 process.env·global fetch로 호출한다. child process는 잘못된 token guard(HTTP 0)만 확인한다.
// - stdout·stderr는 write(text)를 가진 객체(process.stdout과 같은 모양)로 받는다고 가정한다.
import { spawn, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type Sink = { write: (text: string) => unknown };
type RequestFn = (url: string, init: RequestInit) => Promise<Response>;
type Run = (deps: { env: Record<string, string | undefined>; request: RequestFn; stdout: Sink; stderr: Sink }) => Promise<0 | 1>;

const CLI = path.join(APP_DIR, "src", "server", "stories", "worker-cli.mjs");
const FIXED_URL = "http://127.0.0.1:3000/internal/story-worker";
const TOKEN = "0123456789abcdef".repeat(4);
const FAIL_LINE = "story-worker: unavailable\n";

async function load(): Promise<Run> {
  expect(existsSync(CLI), "src/server/stories/worker-cli.mjs must exist (PLAN §4.8)").toBe(true);
  const mod = (await import(/* @vite-ignore */ CLI)) as Record<string, unknown>;
  expect(typeof mod.runStoryWorkerCli, "worker-cli.mjs must export function runStoryWorkerCli").toBe("function");
  return mod.runStoryWorkerCli as Run;
}

function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, out, err };
}

type Seen = { method?: string; url?: string; headers?: IncomingHttpHeaders; body: string };
async function loopback(status: number, body: string, contentType = "application/json") {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 고정 URL·init을 단언하고, 같은 init으로 시험 loopback port에 실제 HTTP를 보낸다. */
function forwardingRequest(port: number, inits: RequestInit[]): RequestFn {
  return async (url, init) => {
    expect(url, "the CLI uses only the fixed internal URL").toBe(FIXED_URL);
    inits.push(init);
    return fetch(`http://127.0.0.1:${port}/internal/story-worker`, init);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("story worker CLI module", () => {
  it("does nothing on import (no fetch, no exit code)", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const before = process.exitCode;
    await load();
    expect(network).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(before);
  });
});

describe("runStoryWorkerCli", () => {
  it("POSTs once to the fixed URL with only the bearer token, no body, redirect error and a 100 s signal, then prints one validated line", async () => {
    const run = await load();
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { timeouts.push(ms); return realTimeout(ms); });
    const server = await loopback(200, JSON.stringify({ expired: 1, enqueued: 0, result: "succeeded" }));
    try {
      const inits: RequestInit[] = [];
      const io = sinks();
      const code = await run({ env: { POD_STORY_WORKER_TOKEN: TOKEN }, request: forwardingRequest(server.port, inits), ...io });
      expect(code).toBe(0);
      expect(io.out.join("")).toBe('{"expired":1,"enqueued":0,"result":"succeeded"}\n');
      expect(io.err.join("")).toBe("");
      expect(inits).toHaveLength(1);
      const init = inits[0]!;
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.body ?? null).toBeNull();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeouts, "the request signal is a 100 second timeout").toContain(100_000);
      const headers = new Headers(init.headers);
      expect([...headers.keys()]).toEqual(["authorization"]);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]?.method).toBe("POST");
      expect(server.seen[0]?.url).toBe("/internal/story-worker");
      expect(server.seen[0]?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(server.seen[0]?.body).toBe("");
      expect(io.out.join("") + io.err.join(""), "the token is never printed").not.toContain(TOKEN);
    } finally {
      await server.close();
    }
  });

  it("refuses a missing or malformed token with the fixed stderr line, exit 1 and no request", async () => {
    const run = await load();
    for (const value of [undefined, "", TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}a`, ` ${TOKEN}`, "g".repeat(64)]) {
      const request = vi.fn<RequestFn>();
      const io = sinks();
      expect(await run({ env: { POD_STORY_WORKER_TOKEN: value }, request, ...io }), String(value)).toBe(1);
      expect(request).not.toHaveBeenCalled();
      expect(io.out.join("")).toBe("");
      expect(io.err.join("")).toBe(FAIL_LINE);
    }
  });

  it("exits 1 with only the fixed stderr line for non-200, non-JSON, malformed stats or a network failure", async () => {
    const run = await load();
    const responses: [string, number, string, string?][] = [
      ["404", 404, ""],
      ["503", 503, "ci-only-upstream-detail"],
      ["non-JSON", 200, "not json", "text/plain"],
      ["extra key", 200, JSON.stringify({ expired: 0, enqueued: 0, result: "none", token: TOKEN })],
      ["unknown result", 200, JSON.stringify({ expired: 0, enqueued: 0, result: "maybe" })],
      ["negative count", 200, JSON.stringify({ expired: -1, enqueued: 0, result: "none" })],
      ["fractional count", 200, JSON.stringify({ expired: 0.5, enqueued: 0, result: "none" })],
      ["array", 200, "[]"],
    ];
    for (const [label, status, body, type] of responses) {
      const server = await loopback(status, body, type);
      try {
        const io = sinks();
        expect(await run({ env: { POD_STORY_WORKER_TOKEN: TOKEN }, request: forwardingRequest(server.port, []), ...io }), label).toBe(1);
        expect(io.out.join(""), label).toBe("");
        expect(io.err.join(""), label).toBe(FAIL_LINE);
      } finally {
        await server.close();
      }
    }
    const io = sinks();
    const failing: RequestFn = async () => { throw new TypeError(`ci-only-network-failure ${TOKEN}`); };
    expect(await run({ env: { POD_STORY_WORKER_TOKEN: TOKEN }, request: failing, ...io })).toBe(1);
    expect(io.err.join("")).toBe(FAIL_LINE);
    expect(io.out.join("") + io.err.join("")).not.toContain(TOKEN);
  });

  it("gives up at 100 seconds through the request signal and exits 1", async () => {
    const run = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms);
      return c.signal;
    });
    const hanging: RequestFn = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const io = sinks();
    let settled = false;
    const pending = run({ env: { POD_STORY_WORKER_TOKEN: TOKEN }, request: hanging, ...io }).then((code) => { settled = true; return code; });
    await vi.advanceTimersByTimeAsync(99_999);
    expect(settled, "still waiting before 100 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(1);
    expect(io.err.join("")).toBe(FAIL_LINE);
  });
});

describe("story worker CLI entry (child process)", () => {
  it("as a direct entry refuses an invalid token with the fixed stderr line and exit 1", async () => {
    expect(existsSync(CLI), "src/server/stories/worker-cli.mjs must exist (PLAN §4.8)").toBe(true);
    for (const token of [undefined, "not-a-token"]) {
      // Next augments NodeJS.ProcessEnv with a required NODE_ENV; the child keeps exactly this minimal env (type-only cast, no NODE_ENV added).
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;
      if (token !== undefined) env.POD_STORY_WORKER_TOKEN = token;
      // stdin ignore, stdout/stderr pipe: the typed tuple selects the spawn overload whose stdout/stderr are non-null Readables.
      const options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] };
      const child = spawn(process.execPath, [CLI], options);
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
      child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code, String(token)).toBe(1);
      expect(out).toBe("");
      expect(err).toBe(FAIL_LINE);
    }
  }, 30_000);
});
