// PLAN_private-photo-moments §2.1 RED. HTTP 입력/인증 경계만 검사한다. 실제 PG/S3는 DB·E2E 시험 담당이다.
// 새 route가 없으면 함수 존재 단언만 실패한다. 새 서비스 mock은 route 존재 확인 뒤에만 등록한다.
import { existsSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type PhotoError = "invalid_request" | "invalid_body" | "invalid_photo" | "photo_too_large" | "not_signed_in" | "forbidden" | "conflict" | "busy" | "unavailable";
type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type Photo = { bytes: Buffer; sha256: string; width: number; height: number; contentType: "image/jpeg" };
type Ref = { id: string; version: number };
type Viewer = { kind: "user"; userId: string; gen: number } | { kind: "fixture" | "signed_out" } | { kind: "unavailable"; reason: "db_unavailable" };
type CreateResult = Result<{ moment: Ref; replayed: boolean }, PhotoError>;
type ReadResult = Result<{ bytes: Buffer; contentType: "image/jpeg" }, "not_found" | "unavailable">;
type Route = (request: NextRequest, context?: { params: Promise<{ id: string }> }) => Promise<Response>;

const h = vi.hoisted(() => ({
  events: [] as string[], headers: new Map<string, string>(), viewer: { kind: "signed_out" } as Viewer,
  viewerError: null as Error | null, configReply: { ok: true, value: null } as unknown,
  configError: null as Error | null, blobError: null as Error | null,
  normalizeReply: null as unknown as Result<Photo, PhotoError>, normalizeError: null as Error | null,
  createReply: null as unknown as CreateResult, createError: null as Error | null,
  readReply: null as unknown as ReadResult, readError: null as Error | null,
  db: {} as object, blobs: {} as object,
  normalized: [] as Uint8Array[], creates: [] as unknown[][], reads: [] as unknown[][],
  configs: [] as unknown[], factories: [] as unknown[], logs: [] as unknown[][],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers(h.headers), cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/server/context", () => ({
  getViewer: async () => {
    h.events.push("viewer");
    if (h.viewerError) throw h.viewerError;
    return h.viewer;
  },
}));
vi.mock("@/server/auth/config", async (original) => {
  const real = await original<typeof import("@/server/auth/config")>();
  return { ...real, loadAuthConfig: (...args: Parameters<typeof real.loadAuthConfig>) => { h.events.push("auth"); return real.loadAuthConfig(...args); } };
});
vi.mock("@/server/db/pool", async (original) => {
  const real = await original<typeof import("@/server/db/pool")>();
  return { ...real, getAppDb: () => { h.events.push("db"); return h.db; } };
});

const BASE = "https://pieceofdays.example";
const USER = "0190f3a2-7c1e-7d4b-9a01-0000000000aa";
const OTHER = "0190f3a2-7c1e-7d4b-9a01-0000000000bb";
const REQUEST_ID = "3f8da0fa-2c35-44b5-8c80-357d6a54dcd5";
const PHOTO_ID = "6a633682-388e-49f2-ad57-4cd146703f40";
const MOMENT: Ref = { id: "e0e01268-4880-4ed4-85ec-4d4e8d5f9501", version: 1 };
const SECRET = "ci-only-photo-private-error-marker";
const CONFIG = { endpoint: "https://photos.example/", region: "us-east-1", bucket: "pieceofdays-ci-private", accessKeyId: "ci-only-photo-access", secretAccessKey: "ci-only-photo-secret" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0xff, 0xd9]); // trusted service-port bytes, not a decoder fixture.
const PHOTO: Photo = { bytes: JPEG, sha256: "b".repeat(64), width: 32, height: 16, contentType: "image/jpeg" };
const MODULES = ["@/server/photos/config", "@/server/photos/blob-store.s3", "@/server/photos/normalize", "@/server/photos/create-moment", "@/server/photos/read-photo"];
let mocked = false;

async function handler(kind: "upload" | "read"): Promise<Route> {
  vi.resetModules();
  const file = path.join(APP_DIR, "src", "app", "photos", kind === "upload" ? "upload" : "[id]", "route.ts");
  const method = kind === "upload" ? "POST" : "GET";
  let mod: Record<string, unknown> = {};
  if (existsSync(file)) {
    mocked = true;
    vi.doMock(MODULES[0]!, () => ({ parsePhotoConfig: (env: unknown) => {
      h.events.push("storage"); h.configs.push(env);
      if (h.configError) throw h.configError;
      return h.configReply;
    } }));
    vi.doMock(MODULES[1]!, () => ({ createS3BlobStore: (config: unknown) => {
      h.events.push("blobs"); h.factories.push(config);
      if (h.blobError) throw h.blobError;
      return h.blobs;
    } }));
    vi.doMock(MODULES[2]!, () => ({ normalizePhoto: async (bytes: Uint8Array) => {
      h.events.push("normalize"); h.normalized.push(bytes);
      if (h.normalizeError) throw h.normalizeError;
      return h.normalizeReply;
    } }));
    vi.doMock(MODULES[3]!, () => ({ createPhotoMoment: async (...args: unknown[]) => {
      h.events.push("create"); h.creates.push(args);
      if (h.createError) throw h.createError;
      return h.createReply;
    } }));
    vi.doMock(MODULES[4]!, () => ({ readPhoto: async (...args: unknown[]) => {
      h.events.push("read"); h.reads.push(args);
      if (h.readError) throw h.readError;
      return h.readReply;
    } }));
    mod = await import(/* @vite-ignore */ file); // an existing route with broken imports remains a real failure.
  }
  expect(typeof mod[method], `photos/${kind === "upload" ? "upload" : "[id]"}/route.ts must export ${method}`).toBe("function");
  return mod[method] as Route;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  const env = {
    POD_LOCAL_FIXTURE: "", POD_AUTH_PROVIDERS: "google", POD_AUTH_BASE_URL: BASE,
    POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: "ci-only-photo-route-session-key".padEnd(40, "x") }),
    POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client", POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret", POD_AUTH_MOCK_OIDC_ISSUER: "",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  h.events = []; h.headers = new Map(); h.viewer = { kind: "user", userId: USER, gen: 7 };
  h.viewerError = h.configError = h.blobError = h.normalizeError = h.createError = h.readError = null;
  h.configReply = { ok: true, value: CONFIG }; h.normalizeReply = { ok: true, value: PHOTO };
  h.createReply = { ok: true, value: { moment: MOMENT, replayed: false } };
  h.readReply = { ok: true, value: { bytes: JPEG, contentType: "image/jpeg" } };
  h.db = { query: () => { throw new Error("route must use the photo service port, not execute its own SQL"); } };
  h.blobs = { put: () => { throw new Error("route must not bypass the photo service port"); }, get: () => { throw new Error("route must not bypass the photo service port"); }, delete: () => { throw new Error("route must not bypass the photo service port"); } };
  h.normalized = []; h.creates = []; h.reads = []; h.configs = []; h.factories = []; h.logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { h.logs.push(args); });
});

afterEach(() => {
  if (mocked) for (const modulePath of MODULES) vi.doUnmock(modulePath);
  mocked = false;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

type Part = { name: string; value: string | File };
const file = (bytes: Uint8Array = JPEG, mime = "image/jpeg") => new File([Buffer.from(bytes)], "ci-only-private-photo.jpg", { type: mime });
const validParts = (): Part[] => [{ name: "photo", value: file() }, { name: "memo", value: "오늘의 사진 메모" }, { name: "requestId", value: REQUEST_ID }];

async function multipart(parts = validParts()): Promise<{ bytes: Buffer; type: string }> {
  const boundary = "pod-ci-photo-boundary";
  const chunks: Buffer[] = [];
  for (const { name, value } of parts) {
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (typeof value === "string") chunks.push(Buffer.from(`${disposition}\r\n\r\n${value}\r\n`));
    else chunks.push(Buffer.from(`${disposition}; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`), Buffer.from(await value.arrayBuffer()), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { bytes: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

function streamOf(bytes: Uint8Array, chunk = bytes.length) {
  let offset = 0;
  const seen = { pulls: 0, cancelled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulls++;
      h.events.push("body");
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(offset + chunk, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { seen.cancelled++; },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

function request(body: ReadableStream<Uint8Array> | null, opts: { origin?: string | null; type?: string; length?: string; signal?: AbortSignal } = {}): NextRequest {
  const headers = new Headers({ "content-type": opts.type ?? "multipart/form-data; boundary=pod-ci-photo-boundary" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? BASE);
  if (opts.length !== undefined) headers.set("content-length", opts.length);
  headers.set("x-user-id", OTHER); headers.set("cookie", `userId=${OTHER}; objectKey=photos/ci-only-spoof.jpg`);
  h.headers = new Map(headers);
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, signal: opts.signal, duplex: "half" };
  return new NextRequest(`${BASE}/photos/upload?userId=${OTHER}`, init);
}

function privateHeaders(response: Response) {
  const cache = response.headers.get("cache-control") ?? "";
  expect(cache).toContain("private"); expect(cache).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

async function failure(response: Response, status: number, error: PhotoError) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ ok: false, error });
}

const logText = () => JSON.stringify(h.logs, (_key, value: unknown) => value instanceof Error ? { message: value.message } : value);

describe("POST /photos/upload request boundary", () => {
  it("checks auth configuration, exact Origin, current viewer and storage before pulling request bytes", async () => {
    const post = await handler("upload");
    const body = await multipart();
    const cases: { label: string; status: number; error: PhotoError; env?: Record<string, string>; viewer?: Viewer; origin?: string | null; configured?: unknown; expected: string[] }[] = [
      { label: "auth absent", env: { POD_AUTH_PROVIDERS: "" }, status: 503, error: "unavailable", expected: ["auth"] },
      { label: "auth invalid", env: { POD_AUTH_SESSION_SECRETS: "{}" }, status: 503, error: "unavailable", expected: ["auth"] },
      { label: "missing origin", origin: null, status: 403, error: "forbidden", expected: ["auth"] },
      ...["null", "https://evil.example", `${BASE}/`, "https://pieceofdays.example.evil", "http://pieceofdays.example"].map((origin) => ({ label: "wrong origin", origin, status: 403, error: "forbidden" as const, expected: ["auth"] })),
      { label: "signed out", viewer: { kind: "signed_out" }, status: 401, error: "not_signed_in", expected: ["auth", "viewer"] },
      { label: "fixture", viewer: { kind: "fixture" }, status: 401, error: "not_signed_in", expected: ["auth", "viewer"] },
      { label: "viewer unavailable", viewer: { kind: "unavailable", reason: "db_unavailable" }, status: 503, error: "unavailable", expected: ["auth", "viewer"] },
      { label: "storage absent", configured: { ok: true, value: null }, status: 503, error: "unavailable", expected: ["auth", "viewer", "storage"] },
      { label: "storage invalid", configured: { ok: false, error: "invalid_photo_config" }, status: 503, error: "unavailable", expected: ["auth", "viewer", "storage"] },
    ];
    for (const c of cases) {
      h.events = []; h.viewer = c.viewer ?? { kind: "user", userId: USER, gen: 7 }; h.configReply = c.configured ?? { ok: true, value: CONFIG };
      vi.stubEnv("POD_AUTH_PROVIDERS", c.env?.POD_AUTH_PROVIDERS ?? "google");
      vi.stubEnv("POD_AUTH_SESSION_SECRETS", c.env?.POD_AUTH_SESSION_SECRETS ?? JSON.stringify({ 1: "ci-only-photo-route-session-key".padEnd(40, "x") }));
      const input = streamOf(body.bytes);
      await failure(await post(request(input.stream, { origin: c.origin, type: body.type })), c.status, c.error);
      expect(h.events, c.label).toEqual(c.expected);
      expect(input.seen.pulls, `${c.label}: no body read`).toBe(0);
      expect(h.creates).toEqual([]);
    }
  });

  it("normalizes the one File and uses only the verified user/gen; new results are 201, replays 200, with no private fields", async () => {
    const post = await handler("upload");
    const encoded = await multipart();
    for (const replayed of [false, true]) {
      h.createReply = { ok: true, value: { moment: MOMENT, replayed } };
      const input = streamOf(encoded.bytes, 37);
      const response = await post(request(input.stream, { type: encoded.type }));
      expect(response.status).toBe(replayed ? 200 : 201);
      expect(await response.json()).toEqual({ ok: true, value: MOMENT });
      expect(Buffer.from(h.normalized.at(-1)!)).toEqual(JPEG);
      const args = h.creates.at(-1)!;
      expect(args[0]).toBe(h.db); expect(args[1]).toBe(h.blobs);
      expect(args[2]).toEqual({ userId: USER, gen: 7 });
      expect(args[3]).toEqual({ requestId: REQUEST_ID, memo: "오늘의 사진 메모", photo: PHOTO });
      const stage = (name: string) => h.events.indexOf(name);
      expect(stage("auth")).toBeLessThan(stage("viewer")); expect(stage("viewer")).toBeLessThan(stage("storage")); expect(stage("storage")).toBeLessThan(stage("body"));
    }
  });

  it("rejects missing, unknown, duplicate or incorrectly typed fields, non-v4/lowercase request IDs and a missing multipart boundary before service writes", async () => {
    const post = await handler("upload");
    const cases: Part[][] = [
      ...["photo", "memo", "requestId"].map((name) => validParts().filter((p) => p.name !== name)),
      ...["photo", "memo", "requestId"].map((name) => [...validParts(), validParts().find((p) => p.name === name)!]),
      ...["userId", "key", "unexpected"].map((name) => [...validParts(), { name, value: OTHER }]),
      validParts().map((p) => p.name === "photo" ? { ...p, value: "not a File" } : p),
      validParts().map((p) => p.name === "memo" ? { ...p, value: file() } : p),
      validParts().map((p) => p.name === "requestId" ? { ...p, value: file() } : p),
      ...[REQUEST_ID.toUpperCase(), USER, "not-a-uuid"].map((value) => validParts().map((p) => p.name === "requestId" ? { ...p, value } : p)),
    ];
    for (const parts of cases) {
      const encoded = await multipart(parts);
      await failure(await post(request(streamOf(encoded.bytes).stream, { type: encoded.type })), 400, "invalid_request");
    }
    const encoded = await multipart();
    await failure(await post(request(streamOf(encoded.bytes).stream, { type: "multipart/form-data" })), 400, "invalid_request");
    await failure(await post(request(streamOf(Buffer.from("malformed multipart")).stream, { type: encoded.type })), 400, "invalid_request");
    expect(h.creates).toEqual([]);
  });

  it("does not trust an image MIME label when normalization rejects the supplied bytes", async () => {
    const post = await handler("upload");
    const disguised = Buffer.from("ci-only-private-photo-marker<html>not a photo</html>");
    h.normalizeReply = { ok: false, error: "invalid_photo" };
    const encoded = await multipart([{ name: "photo", value: file(disguised, "image/jpeg") }, ...validParts().filter((p) => p.name !== "photo")]);
    await failure(await post(request(streamOf(encoded.bytes).stream, { type: encoded.type })), 400, "invalid_photo");
    expect(Buffer.from(h.normalized[0]!)).toEqual(disguised);
    expect(h.creates).toEqual([]);
  });

  it("maps normalization and storage service refusals to fixed HTTP/JSON errors without falling back to a text-only write", async () => {
    const post = await handler("upload");
    const encoded = await multipart();
    const statuses: Record<PhotoError, number> = { invalid_request: 400, invalid_body: 400, invalid_photo: 400, photo_too_large: 413, not_signed_in: 401, forbidden: 403, conflict: 409, busy: 503, unavailable: 503 };
    for (const error of ["invalid_photo", "photo_too_large", "busy", "unavailable"] as const) {
      h.normalizeReply = { ok: false, error };
      await failure(await post(request(streamOf(encoded.bytes).stream)), statuses[error], error);
      expect(h.creates).toEqual([]);
    }
    h.normalizeReply = { ok: true, value: PHOTO };
    for (const error of Object.keys(statuses) as PhotoError[]) {
      h.createReply = { ok: false, error };
      await failure(await post(request(streamOf(encoded.bytes).stream)), statuses[error], error);
    }
  });

  it("refuses declared and actual bodies over 9MiB, including missing or dishonest Content-Length, and cancels the bounded reader", async () => {
    const post = await handler("upload");
    const small = streamOf((await multipart()).bytes);
    await failure(await post(request(small.stream, { length: String(9 * 1024 * 1024 + 1) })), 413, "photo_too_large");
    expect(small.seen.pulls, "declared oversize is refused before reading").toBe(0);
    const huge = await multipart([{ name: "photo", value: file(Buffer.alloc(9 * 1024 * 1024 + 1)) }, ...validParts().filter((p) => p.name !== "photo")]);
    for (const length of [undefined, "1"]) {
      const input = streamOf(huge.bytes, 128 * 1024);
      await failure(await post(request(input.stream, { length, type: huge.type })), 413, "photo_too_large");
      expect(input.seen.cancelled, "oversize reader was cancelled").toBe(1);
    }
    expect(h.normalized).toEqual([]); expect(h.creates).toEqual([]);
  });

  it("limits an unfinished multipart read to 15 seconds and cancels the stream without a write", async () => {
    const post = await handler("upload");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Node's native AbortSignal timeout has its own clock. Drive the same public deadline
    // primitive with this test clock so manual timers and AbortSignal-based readers agree.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), milliseconds);
      return deadline.signal;
    });
    const seen = { pulls: 0, cancelled: 0 };
    const stream = new ReadableStream<Uint8Array>({ pull() { seen.pulls++; return new Promise(() => undefined); }, cancel() { seen.cancelled++; } }, { highWaterMark: 0 });
    const pending = post(request(stream));
    await vi.waitFor(() => expect(seen.pulls).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(15_001);
    await failure(await pending, 503, "unavailable");
    expect(seen.cancelled).toBe(1); expect(h.creates).toEqual([]);
  });

  it("cancels a body read when its request is aborted and never publishes a partial upload", async () => {
    const post = await handler("upload");
    const seen = { pulls: 0, cancelled: 0 };
    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { seen.pulls++; return new Promise(() => undefined); }, cancel() { seen.cancelled++; } }, { highWaterMark: 0 });
    const pending = post(request(stream, { signal: abort.signal }));
    await vi.waitFor(() => expect(seen.pulls).toBeGreaterThan(0));
    abort.abort();
    await failure(await pending, 503, "unavailable");
    expect(seen.cancelled).toBe(1); expect(h.normalized).toEqual([]); expect(h.creates).toEqual([]);
  });

  it("rechecks the viewer on each request and replaces thrown internal details with unavailable without logging them", async () => {
    const post = await handler("upload");
    const encoded = await multipart();
    expect((await post(request(streamOf(encoded.bytes).stream))).status).toBe(201);
    h.viewer = { kind: "signed_out" };
    const denied = streamOf(encoded.bytes);
    await failure(await post(request(denied.stream)), 401, "not_signed_in");
    expect(denied.seen.pulls).toBe(0); expect(h.creates).toHaveLength(1);
    h.viewer = { kind: "user", userId: USER, gen: 7 };
    for (const stage of ["viewerError", "configError", "blobError", "normalizeError", "createError"] as const) {
      h[stage] = new Error(`${SECRET} ${CONFIG.secretAccessKey}`);
      await failure(await post(request(streamOf(encoded.bytes).stream)), 503, "unavailable");
      h[stage] = null;
    }
    const logs = logText();
    expect(logs).not.toContain(SECRET); expect(logs).not.toContain(CONFIG.secretAccessKey);
  });
});

describe("GET /photos/[id] private response adapter", () => {
  const getRequest = () => new NextRequest(`${BASE}/photos/${PHOTO_ID}?userId=${OTHER}`, { headers: { "x-user-id": OTHER } });
  const context = (id = PHOTO_ID) => ({ params: Promise.resolve({ id }) });

  it("returns only trusted readPhoto bytes to the verified active user/gen with private no-store and nosniff, without requiring an Origin header", async () => {
    const get = await handler("read");
    const req = getRequest();
    const response = await get(req, context());
    expect(response.status).toBe(200); privateHeaders(response);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
    const args = h.reads[0]!;
    expect(args[0]).toBe(h.db); expect(args[1]).toBe(h.blobs); expect(args[2]).toEqual({ userId: USER, gen: 7 }); expect(args[3]).toBe(PHOTO_ID);
  });

  it("returns no photo bytes for signed-out/fixture/unavailable viewers or unconfigured storage, always with private response headers", async () => {
    const get = await handler("read");
    for (const [viewer, status] of [[{ kind: "signed_out" }, 401], [{ kind: "fixture" }, 401], [{ kind: "unavailable", reason: "db_unavailable" }, 503]] as [Viewer, number][]) {
      h.viewer = viewer;
      const response = await get(getRequest(), context());
      expect(response.status).toBe(status); privateHeaders(response);
      expect(Buffer.from(await response.arrayBuffer()).includes(JPEG)).toBe(false);
    }
    h.viewer = { kind: "user", userId: USER, gen: 7 }; h.configReply = { ok: true, value: null };
    const response = await get(getRequest(), context());
    expect(response.status).toBe(503); privateHeaders(response);
    expect(h.reads).toEqual([]);
  });

  it("maps foreign/missing/malformed IDs to the same private 404 and never serializes identifiers, object keys or hashes", async () => {
    const get = await handler("read");
    h.readReply = { ok: false, error: "not_found" };
    const bodies: string[] = [];
    for (const id of [PHOTO_ID, "f7db496c-5009-4e27-b9bd-bcedc4a88576", "not-a-uuid"]) {
      const response = await get(getRequest(), context(id));
      expect(response.status).toBe(404); privateHeaders(response);
      const text = await response.text(); bodies.push(text);
      for (const secret of [USER, OTHER, PHOTO_ID, "photos/", PHOTO.sha256]) expect(text).not.toContain(secret);
    }
    expect(new Set(bodies).size, "same denial body for foreign and missing resources").toBe(1);
  });

  it("maps read failures to private 503 with no bytes, raw storage detail, credentials or automatic retry", async () => {
    const get = await handler("read");
    h.readReply = { ok: false, error: "unavailable" };
    let response = await get(getRequest(), context());
    expect(response.status).toBe(503); privateHeaders(response);
    expect(Buffer.from(await response.arrayBuffer()).includes(JPEG)).toBe(false);
    h.readError = new Error(`${SECRET} ${CONFIG.secretAccessKey}`);
    response = await get(getRequest(), context());
    expect(response.status).toBe(503); privateHeaders(response);
    const body = await response.text();
    expect(body).not.toContain(SECRET); expect(body).not.toContain(CONFIG.secretAccessKey);
    expect(h.reads).toHaveLength(2);
    const logs = logText();
    expect(logs).not.toContain(SECRET); expect(logs).not.toContain(CONFIG.secretAccessKey);
  });
});
