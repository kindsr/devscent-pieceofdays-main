// PLAN_private-photo-moments §1·§2.1 RED. 합성 이미지와 가짜 설정만 사용한다.
// 실제 Sharp로 decode/re-encode 결과를 확인한다. 시간 제한 사례만 출력 Promise를 보류한다.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type PhotoError = "invalid_request" | "invalid_body" | "invalid_photo" | "photo_too_large" | "not_signed_in" | "forbidden" | "conflict" | "busy" | "unavailable";
type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type Photo = { bytes: Buffer; sha256: string; width: number; height: number; contentType: "image/jpeg" };
type Normalize = (bytes: Uint8Array) => Promise<Result<Photo, PhotoError>>;
type PhotoConfig = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
type ParseConfig = (env: Record<string, string | undefined>) => Result<PhotoConfig | null, "invalid_photo_config">;
const ROOT = path.join(APP_DIR, "src", "server", "photos");
const MIB = 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function load<T>(file: string, name: string): Promise<T> {
  const filename = path.join(ROOT, file);
  let mod: Record<string, unknown> = {};
  try {
    mod = await import(/* @vite-ignore */ filename);
  } catch (err) {
    if (existsSync(filename)) throw err;
  }
  expect(typeof mod[name], `server/photos/${file} must export function ${name}`).toBe("function");
  return mod[name] as T;
}

const normalize = () => load<Normalize>("normalize.ts", "normalizePhoto");
const parser = () => load<ParseConfig>("config.ts", "parsePhotoConfig");
const solid = (width = 32, height = 16) => sharp({ create: { width, height, channels: 3, background: "#5078a0" } });

function photoValue(result: Result<Photo, PhotoError>): Photo {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`expected normalized synthetic image, received ${result.error}`);
  return result.value;
}

async function expectJpeg(photo: Photo, width: number, height: number): Promise<void> {
  expect(Buffer.isBuffer(photo.bytes)).toBe(true);
  expect(photo.contentType).toBe("image/jpeg");
  expect(photo.bytes.length).toBeGreaterThan(0);
  expect(photo.bytes.length).toBeLessThanOrEqual(4 * MIB);
  expect(photo.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(photo.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(photo.sha256).toBe(hash(photo.bytes));
  expect([photo.width, photo.height]).toEqual([width, height]);
  const metadata = await sharp(photo.bytes).metadata();
  expect([metadata.format, metadata.width, metadata.height]).toEqual(["jpeg", width, height]);
  for (const key of ["exif", "icc", "iptc", "xmp", "orientation"] as const) expect(metadata[key], key).toBeUndefined();
  const decoded = await sharp(photo.bytes).raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info.channels).toBe(3);
  expect(decoded.data.length).toBe(width * height * 3);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("private photo normalization", () => {
  it("decodes JPEG/PNG/WebP bytes into bounded, metadata-free JPEG without enlarging small images", async () => {
    const run = await normalize();
    for (const image of [await solid().jpeg().toBuffer(), await solid().png().toBuffer(), await solid().webp().toBuffer()]) {
      await expectJpeg(photoValue(await run(new Uint8Array(image))), 32, 16);
    }
  });

  it("applies EXIF orientation before reducing the long side to 2560 and removes the original metadata", async () => {
    const run = await normalize();
    const image = await solid(3200, 1600).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const original = await sharp(image).metadata();
    expect(original.orientation, "positive control: orientation exists in the input").toBe(6);
    expect(original.exif, "positive control: metadata exists in the input").toBeDefined();
    await expectJpeg(photoValue(await run(image)), 1280, 2560);
  });

  it("accepts the exact 8MiB byte boundary but refuses one extra byte before treating it as an image", async () => {
    const run = await normalize();
    const image = await solid().jpeg().toBuffer();
    const exact = Buffer.alloc(8 * MIB);
    image.copy(exact); // valid JPEG followed by padding; decoded pixels are unchanged.
    await expectJpeg(photoValue(await run(exact)), 32, 16);
    expect(await run(Buffer.alloc(8 * MIB + 1))).toEqual({ ok: false, error: "photo_too_large" });
  });

  it("accepts 40,000,000 pixels and refuses a decodable image above that limit", async () => {
    const run = await normalize();
    const exact = await solid(8000, 5000).png().toBuffer();
    expect(exact.length).toBeLessThan(8 * MIB);
    await expectJpeg(photoValue(await run(exact)), 2560, 1600);
    const over = await solid(8001, 5000).png().toBuffer();
    expect((await sharp(over).metadata()).width).toBe(8001);
    expect(await run(over)).toEqual({ ok: false, error: "photo_too_large" });
  }, 30_000);

  it("refuses an encoded JPEG above the 4MiB output boundary rather than returning an oversized photo", async () => {
    const run = await normalize();
    const image = await solid().jpeg().toBuffer();
    const oversized = Buffer.alloc(4 * MIB + 1);
    image.copy(oversized);
    const prototype = Object.getPrototypeOf(sharp()) as { toBuffer: (options?: { resolveWithObject?: boolean }) => unknown };
    const output = vi.spyOn(prototype, "toBuffer").mockImplementation(async (options) => options?.resolveWithObject
      ? { data: oversized, info: { format: "jpeg", width: 32, height: 16, channels: 3, size: oversized.length } }
      : oversized);
    expect(await run(image)).toEqual({ ok: false, error: "photo_too_large" });
    output.mockRestore();
    await expectJpeg(photoValue(await run(image)), 32, 16);
  });

  it("rejects corrupt, SVG/HTML and unsupported bytes without coercing non-byte values or logging the input", async () => {
    const run = await normalize();
    const logs: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    const marker = "ci-only-private-photo-input-marker";
    const invalid: unknown[] = [
      Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.from(`${marker}<html>not an image</html>`),
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>${marker}</text></svg>`),
      await solid().gif().toBuffer(), undefined, null, marker, {}, [0xff, 0xd8], { toString: () => marker },
    ];
    for (const input of invalid) {
      expect(await (run as (value: unknown) => Promise<Result<Photo, PhotoError>>)(input)).toEqual({ ok: false, error: "invalid_photo" });
    }
    expect(JSON.stringify(logs), "raw photo details are never logged").not.toContain(marker);
  });

  it("refuses animated multi-page WebP even though a single-frame WebP is supported", async () => {
    const run = await normalize();
    const frames = Buffer.concat([Buffer.alloc(2 * 2 * 3, 32), Buffer.alloc(2 * 2 * 3, 224)]);
    const animated = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ lossless: true, delay: [100, 100], loop: 0 }).toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages, "positive control: two actual frames").toBe(2);
    expect(await run(animated)).toEqual({ ok: false, error: "invalid_photo" });
  });

  it("admits one normalization at a time, returns busy to an overlapping call, and releases the slot after success or rejection", async () => {
    const run = await normalize();
    const image = await solid().png().toBuffer();
    const first = run(image);
    expect(await run(image)).toEqual({ ok: false, error: "busy" });
    await expectJpeg(photoValue(await first), 32, 16);
    expect(await run(Buffer.from("ci-only-corrupt-photo"))).toEqual({ ok: false, error: "invalid_photo" });
    await expectJpeg(photoValue(await run(image)), 32, 16);
  });

  it("sets the native five-second processing bound, holds the slot until native timeout settles, then permits a later request", async () => {
    const run = await normalize();
    const image = await solid().png().toBuffer();
    const prototype = Object.getPrototypeOf(sharp()) as { toBuffer: (...args: unknown[]) => unknown; timeout: (options: { seconds: number }) => unknown };
    const bound = vi.spyOn(prototype, "timeout");
    let nativeTimeout!: (error: Error) => void;
    const stalled = vi.spyOn(prototype, "toBuffer").mockImplementation(() => new Promise((_resolve, reject) => { nativeTimeout = reject; }));
    const pending = run(image);
    await vi.waitFor(() => expect(stalled).toHaveBeenCalled(), { timeout: 1000 });
    expect(bound.mock.calls.some(([options]) => options?.seconds === 5), "native processing timeout is configured").toBe(true);
    expect(await run(image), "a pending native operation still owns the single slot").toEqual({ ok: false, error: "busy" });
    nativeTimeout(new Error("timeout: 0% complete")); // Sharp v0.35.5 native timeout error shape.
    expect(await pending).toEqual({ ok: false, error: "unavailable" });
    stalled.mockRestore();
    bound.mockRestore();
    await expectJpeg(photoValue(await run(image)), 32, 16);
  });
});

const ENV = {
  POD_PHOTOS_S3_ENDPOINT: "https://photos.example/",
  POD_PHOTOS_S3_REGION: "us-east-1",
  POD_PHOTOS_S3_BUCKET: "pieceofdays-ci-private",
  POD_PHOTOS_S3_ACCESS_KEY_ID: "ci-only-photo-access-key",
  POD_PHOTOS_S3_SECRET_ACCESS_KEY: "ci-only-photo-secret-key",
};
const INVALID = { ok: false, error: "invalid_photo_config" };

describe("private photo storage configuration", () => {
  it("returns null only for absent photo configuration and returns exactly five server-side fields when complete", async () => {
    const parse = await parser();
    expect(parse({ NODE_ENV: "production", UNRELATED: "ci-only-unrelated" })).toEqual({ ok: true, value: null });
    expect(parse({ ...ENV, NODE_ENV: "production" })).toEqual({
      ok: true,
      value: { endpoint: ENV.POD_PHOTOS_S3_ENDPOINT, region: ENV.POD_PHOTOS_S3_REGION, bucket: ENV.POD_PHOTOS_S3_BUCKET, accessKeyId: ENV.POD_PHOTOS_S3_ACCESS_KEY_ID, secretAccessKey: ENV.POD_PHOTOS_S3_SECRET_ACCESS_KEY },
    });
    for (const key of Object.keys(ENV)) expect(parse({ [key]: ENV[key as keyof typeof ENV] }), `partial ${key}`).toEqual(INVALID);
  });

  it("rejects incomplete, non-string, padded or control-character credentials without logging their values", async () => {
    const parse = await parser();
    const logs: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    for (const key of Object.keys(ENV)) {
      for (const value of [undefined, "", " ", " padded", "padded ", "ci-only\nsecret", "ci-only\0secret", 123, {}, ["coercion"]]) {
        expect(parse({ ...ENV, [key]: value } as unknown as Record<string, string | undefined>), `${key}: invalid type/format`).toEqual(INVALID);
      }
    }
    expect(JSON.stringify(logs)).not.toContain(ENV.POD_PHOTOS_S3_SECRET_ACCESS_KEY);
    expect(JSON.stringify(logs)).not.toContain(ENV.POD_PHOTOS_S3_ACCESS_KEY_ID);
  });

  it("refuses credentials, query, fragment or non-root path in the endpoint and refuses ordinary HTTP", async () => {
    const parse = await parser();
    for (const endpoint of [
      "https://user:ci-only-password@photos.example/", "https://photos.example/?key=ci-only-secret", "https://photos.example/#secret",
      "https://photos.example/bucket", "https://photos.example/%2e/bucket", "http://photos.example/", "ftp://photos.example/", "not a URL",
    ]) expect(parse({ ...ENV, POD_PHOTOS_S3_ENDPOINT: endpoint, NODE_ENV: "production" })).toEqual(INVALID);
  });

  it("permits loopback HTTP only in isolated test/development, never production or a lookalike remote host", async () => {
    const parse = await parser();
    for (const NODE_ENV of ["test", "development"]) {
      const isolated = { ...ENV, POD_PHOTOS_S3_ENDPOINT: "http://127.0.0.1:4010/", NODE_ENV, POD_FULL_CHECK_ISOLATED: "1" };
      expect(parse(isolated)).toMatchObject({ ok: true, value: { endpoint: isolated.POD_PHOTOS_S3_ENDPOINT } });
      expect(parse({ ...isolated, POD_FULL_CHECK_ISOLATED: undefined })).toEqual(INVALID);
      expect(parse({ ...isolated, POD_PHOTOS_S3_ENDPOINT: "http://127.0.0.1.evil.example/" })).toEqual(INVALID);
      expect(parse({ ...isolated, POD_PHOTOS_S3_ENDPOINT: "http://0.0.0.0:4010/" })).toEqual(INVALID);
    }
    for (const NODE_ENV of ["production", "staging", undefined]) {
      expect(parse({ ...ENV, POD_PHOTOS_S3_ENDPOINT: "http://127.0.0.1:4010/", NODE_ENV, POD_FULL_CHECK_ISOLATED: "1" })).toEqual(INVALID);
    }
  });
});
