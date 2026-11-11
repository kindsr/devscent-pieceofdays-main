// PLAN_ai-story-live-generation §4.3 RED. 이야기용 사진 사본 준비(prepareStoryPhotos). 실제 sharp·in-memory BlobStore만 쓴다.
// - 제품 모듈은 existsSync 뒤 변수 경로로 동적 import한다(부재는 assert 실패).
// - 합성 이미지만 만든다(실제 사진·S3·DB·네트워크 0).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type PhotoRef = { photoId: string; sha256: string; byteLength: number; objectKey: string };
type VisionPhoto = { mediaType: "image/jpeg"; data: string };
type Blobs = {
  put: (key: string, photo: unknown, signal?: AbortSignal) => Promise<void>;
  get: (key: string, signal?: AbortSignal) => Promise<Buffer | null>;
  delete: (key: string, signal?: AbortSignal) => Promise<void>;
};
type Prepare = (blobs: Blobs, photos: readonly PhotoRef[], signal: AbortSignal) => Promise<Result<VisionPhoto[], "photo_unavailable">>;

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const VISION = path.join(APP_DIR, "src", "server", "stories", "vision.ts");
const SHARED = path.join(APP_DIR, "src", "shared", "stories.ts");
const KIB = 1024;

async function load(): Promise<Prepare> {
  expect(existsSync(VISION), "src/server/stories/vision.ts must exist (PLAN §4.3)").toBe(true);
  const mod = (await import(/* @vite-ignore */ VISION)) as Record<string, unknown>;
  expect(typeof mod.prepareStoryPhotos, "vision.ts must export function prepareStoryPhotos").toBe("function");
  return mod.prepareStoryPhotos as Prepare;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const keyOf = (n: number) => `photos/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.jpg`;

/** 정규화된 저장 원본과 같은 형태의 합성 JPEG(그라데이션, 결정적). */
async function original(width: number, height: number, seed = 1, exif = false): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    raw[i] = (x * 7 + seed * 13) & 0xff;
    raw[i + 1] = (y * 5 + seed * 29) & 0xff;
    raw[i + 2] = ((x + y) * 3 + seed) & 0xff;
  }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  const withMeta = exif ? image.withExif({ IFD0: { Copyright: "ci-only-exif-copyright", Artist: "ci-only-artist" } }) : image;
  return withMeta.jpeg({ quality: 85 }).toBuffer();
}

/** 호출 순서·동시 실행 수를 기록하는 in-memory BlobStore. */
function memoryBlobs(store: Map<string, Buffer | null | "throw">) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const blobs: Blobs = {
    async put() { throw new Error("put is not used by prepareStoryPhotos"); },
    async delete() { throw new Error("delete is not used by prepareStoryPhotos"); },
    async get(key) {
      calls.push(key);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const value = store.get(key);
        if (value === "throw") throw new Error("ci-only-blob-failure");
        return value === undefined ? null : value;
      } finally {
        active--;
      }
    },
  };
  return { blobs, calls, maxActive: () => maxActive };
}

async function refsFor(images: Buffer[]): Promise<{ store: Map<string, Buffer | null | "throw">; refs: PhotoRef[] }> {
  const store = new Map<string, Buffer | null | "throw">();
  const refs = images.map((bytes, i) => {
    const objectKey = keyOf(i + 1);
    store.set(objectKey, bytes);
    return { photoId: `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`, sha256: sha(bytes), byteLength: bytes.byteLength, objectKey };
  });
  return { store, refs };
}

describe("story photo limits (shared constants)", () => {
  it("exports the fixed limits used by the preparation step", async () => {
    expect(existsSync(SHARED)).toBe(true);
    const mod = (await import(/* @vite-ignore */ SHARED)) as Record<string, unknown>;
    expect({ max: mod.STORY_PHOTO_MAX, side: mod.STORY_PHOTO_SIDE, each: mod.STORY_PHOTO_MAX_BYTES, total: mod.STORY_PHOTOS_TOTAL_MAX_BYTES })
      .toEqual({ max: 30, side: 512, each: 256 * KIB, total: 4 * 1024 * KIB });
  });
});

describe("prepareStoryPhotos", () => {
  it("re-encodes each stored original to a JPEG inside 512×512 without enlargement, in order, without metadata", async () => {
    const prepare = await load();
    const large = await original(2560, 1920, 1, true);
    const tall = await original(900, 1600, 2);
    const small = await original(300, 200, 3);
    const { store, refs } = await refsFor([large, tall, small]);
    const memory = memoryBlobs(store);
    const result = await prepare(memory.blobs, refs, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(memory.calls, "reads each object once, in the given order").toEqual(refs.map((r) => r.objectKey));
    expect(memory.maxActive(), "one photo at a time").toBe(1);
    const sizes: [number, number][] = [[512, 384], [288, 512], [300, 200]];
    let total = 0;
    for (const [i, photo] of result.value.entries()) {
      expect(Object.keys(photo).sort()).toEqual(["data", "mediaType"]);
      expect(photo.mediaType).toBe("image/jpeg");
      expect(photo.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      const bytes = Buffer.from(photo.data, "base64");
      expect(bytes.toString("base64"), "canonical base64").toBe(photo.data);
      expect(bytes.byteLength).toBeLessThanOrEqual(256 * KIB);
      total += bytes.byteLength;
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("jpeg");
      expect([meta.width, meta.height], `photo ${i + 1} size`).toEqual(sizes[i]);
      expect(meta.exif, "no EXIF").toBeUndefined();
      expect(meta.icc, "no ICC profile").toBeUndefined();
      expect(meta.xmp, "no XMP").toBeUndefined();
      expect(bytes.includes(Buffer.from("ci-only-exif-copyright")), "metadata text is not copied").toBe(false);
    }
    expect(total).toBeLessThanOrEqual(4 * 1024 * KIB);
  }, 60_000);

  it("returns an empty list without reading anything when there are no photos", async () => {
    const prepare = await load();
    const memory = memoryBlobs(new Map());
    expect(await prepare(memory.blobs, [], new AbortController().signal)).toEqual({ ok: true, value: [] });
    expect(memory.calls).toEqual([]);
  });

  it("accepts exactly 30 photos and refuses 31 as photo_unavailable without partial results", async () => {
    const prepare = await load();
    const images = await Promise.all(Array.from({ length: 31 }, (_, i) => original(64, 48, i + 1)));
    const thirty = await refsFor(images.slice(0, 30));
    const ok = await prepare(memoryBlobs(thirty.store).blobs, thirty.refs, new AbortController().signal);
    expect(ok.ok && ok.value.length).toBe(30);
    const all = await refsFor(images);
    expect(await prepare(memoryBlobs(all.store).blobs, all.refs, new AbortController().signal)).toEqual({ ok: false, error: "photo_unavailable" });
  }, 60_000);

  it("fails the whole set as photo_unavailable when any one photo is missing, altered, mis-sized, unreadable or not an image", async () => {
    const prepare = await load();
    const good = await original(640, 480, 5);
    const other = await original(640, 480, 6);
    type Case = [string, (store: Map<string, Buffer | null | "throw">, refs: PhotoRef[]) => PhotoRef[]];
    const cases: Case[] = [
      ["object missing (null)", (store, refs) => { store.set(refs[1]!.objectKey, null); return refs; }],
      ["store throws", (store, refs) => { store.set(refs[1]!.objectKey, "throw"); return refs; }],
      ["sha256 differs from the DB row", (store, refs) => { store.set(refs[1]!.objectKey, other); return refs; }],
      ["byte length differs from the DB row", (_store, refs) => refs.map((r, i) => (i === 1 ? { ...r, byteLength: r.byteLength + 1 } : r))],
      ["recorded sha differs", (_store, refs) => refs.map((r, i) => (i === 1 ? { ...r, sha256: sha(other) } : r))],
      ["bytes are not an image", (store, refs) => {
        const junk = Buffer.from("ci-only-not-a-jpeg-but-stored-as-one");
        store.set(refs[1]!.objectKey, junk);
        return refs.map((r, i) => (i === 1 ? { ...r, sha256: sha(junk), byteLength: junk.byteLength } : r));
      }],
    ];
    for (const [label, mutate] of cases) {
      const { store, refs } = await refsFor([good, other, good]);
      const changed = mutate(store, refs);
      const result = await prepare(memoryBlobs(store).blobs, changed, new AbortController().signal);
      expect(result, label).toEqual({ ok: false, error: "photo_unavailable" });
    }
  }, 60_000);

  it("treats an aborted signal as photo_unavailable and passes the signal to the store", async () => {
    const prepare = await load();
    const { store, refs } = await refsFor([await original(320, 240, 9)]);
    const aborted = new AbortController();
    aborted.abort();
    const memory = memoryBlobs(store);
    expect(await prepare(memory.blobs, refs, aborted.signal)).toEqual({ ok: false, error: "photo_unavailable" });
    const seen: (AbortSignal | undefined)[] = [];
    const live = new AbortController();
    const spying: Blobs = { ...memory.blobs, get: async (key, signal) => { seen.push(signal); return store.get(key) as Buffer; } };
    const ok = await prepare(spying, refs, live.signal);
    expect(ok.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0], "the store read receives an abort signal").toBeInstanceOf(AbortSignal);
  });

  it("never exposes object keys, photo ids or the store error text in the result", async () => {
    const prepare = await load();
    const { store, refs } = await refsFor([await original(320, 240, 11)]);
    store.set(refs[0]!.objectKey, "throw");
    const result = await prepare(memoryBlobs(store).blobs, refs, new AbortController().signal);
    const text = JSON.stringify(result);
    for (const secret of [refs[0]!.objectKey, refs[0]!.photoId, "ci-only-blob-failure"]) expect(text).not.toContain(secret);
  });
});
