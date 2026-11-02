// F3 slice ③ RED — 개인 꾸미기 manifest 순수 검증·렌더 정책(PLAN_mvp-domain-storage §4·§5 ③,
// DECORATION_MARKET_ARCHITECTURE §3.2~§3.4). 수치는 PLAN §4 [기본값, 메인 수락]이 정본이다.
// src/shared/manifest.ts는 아직 없으므로 각 it 안에서 절대경로를 동적 import하고 export 존재를 먼저 단언한다.
// issues는 공개 계약의 string[]만 확인한다(문구·순서·개수는 계약이 아니다).
// 여러 오류가 겹친 항목의 우선순위는 계약에 없으므로 각 거부 사례는 한 가지만 틀리게 만든다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const MANIFEST_MODULE = path.join(APP_DIR, "src", "shared", "manifest.ts");

// ---------------------------------------------------------------- 최소 로컬 계약 타입(PLAN §4)

type Manifest = { schema: 1; base: "d-warm-pieces@1"; placements: Record<string, unknown>[]; ink: Record<string, unknown>[] };
type Opts = { allowedAssets?: ReadonlySet<string> };
type Validation = { ok: true; value: Manifest } | { ok: false; error: "invalid_manifest"; issues: string[] };
type ManifestModule = {
  validateManifest: (input: unknown, opts?: Opts) => Validation;
  manifestForRender: (input: unknown, opts?: Opts) => Manifest | null;
  MANIFEST_LIMITS: {
    maxBytes: number;
    maxPlacementsPerSlot: Record<string, number>;
    maxStrokes: number;
    maxPointsPerStroke: number;
    maxPoints: number;
  };
};

async function load(): Promise<ManifestModule> {
  let mod: Partial<ManifestModule>;
  try {
    mod = (await import(/* @vite-ignore */ MANIFEST_MODULE)) as Partial<ManifestModule>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F3 product module src/shared/manifest.ts could not be loaded (expected before GREEN): ${msg}`);
  }
  expect(typeof mod.validateManifest, "manifest.ts must export function validateManifest").toBe("function");
  expect(typeof mod.manifestForRender, "manifest.ts must export function manifestForRender").toBe("function");
  expect(typeof mod.MANIFEST_LIMITS, "manifest.ts must export MANIFEST_LIMITS").toBe("object");
  return mod as ManifestModule;
}

// ---------------------------------------------------------------- fixture

const A = "builtin:star";
const B = "builtin:moon-2";
const allow = (...assets: string[]): Opts => ({ allowedAssets: new Set(assets) });
const ALLOW: Opts = allow(A, B);
type Obj = Record<string, unknown>;

const root = (placements: Obj[] = [], ink: Obj[] = []): Obj => ({ schema: 1, base: "d-warm-pieces@1", placements, ink });
const general = (slot: string, over: Obj = {}): Obj => ({
  slot,
  asset: A,
  anchor: "start",
  x: 0.5,
  y: 0.5,
  max_w: 0.25,
  rotate: 0,
  ...over,
});
const sticker = (over: Obj = {}): Obj => ({ slot: "piece.sticker", asset: A, corner: "top-end", every: 3, ...over });
const pts = (n: number, v = 0.1): [number, number][] => Array.from({ length: n }, () => [v, v]);
const stroke = (over: Obj = {}, n = 2): Obj => ({
  slot: "board.corner",
  anchor: "start",
  color: "ink",
  width: 2,
  points: pts(n),
  ...over,
});
const without = (o: Obj, key: string): Obj => {
  const c = { ...o };
  delete c[key];
  return c;
};
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

function expectValid(m: ManifestModule, input: unknown, opts?: Opts, label = ""): void {
  const before = structuredClone(input);
  const r = m.validateManifest(input, opts);
  expect(r, `valid ${label}`).toMatchObject({ ok: true });
  if (r.ok) expect(r.value, `value equals input ${label}`).toEqual(before);
  expect(input, `input not mutated ${label}`).toEqual(before);
}

function expectInvalid(m: ManifestModule, input: unknown, opts?: Opts, label = ""): void {
  let r: Validation | undefined;
  expect(() => (r = m.validateManifest(input, opts)), `no throw ${label}`).not.toThrow();
  expect(r, `invalid ${label}`).toMatchObject({ ok: false, error: "invalid_manifest" });
  const issues = (r as { issues?: unknown }).issues;
  expect(Array.isArray(issues), `issues is an array ${label}`).toBe(true);
  expect((issues as unknown[]).every((s) => typeof s === "string"), `issues are strings ${label}`).toBe(true);
}

/** 각 [label, input]이 거부되는지 확인한다. */
function expectAllInvalid(m: ManifestModule, cases: [string, unknown][], opts: Opts | undefined = ALLOW): void {
  for (const [label, input] of cases) expectInvalid(m, input, opts, label);
}

/**
 * 유효 구조·수치·개수 범위의 펜 manifest를 JSON UTF-8 크기가 정확히 target이 되도록 만든다.
 * 10획 × 500점 = 5000점(상한과 같음). 좌표 0.1 → 0.11 → 0.111 … 로 1바이트씩 늘린다(새 필드·padding 없음).
 */
function sizedPenManifest(target: number): Obj {
  const STROKES = 10;
  const PER = 500;
  const digits = new Array<number>(STROKES * PER * 2).fill(1);
  const val = (k: number) => Number(`0.${"1".repeat(k)}`);
  const build = () =>
    root(
      [],
      Array.from({ length: STROKES }, (_, s) =>
        stroke({ points: Array.from({ length: PER }, (_, p) => [val(digits[(s * PER + p) * 2]!), val(digits[(s * PER + p) * 2 + 1]!)]) }),
      ),
    );
  let len = bytes(build());
  if (len > target) throw new Error(`fixture base ${len} exceeds ${target}`);
  let i = 0;
  while (len < target) {
    if (digits[i]! < 15) {
      digits[i]! += 1;
      len += 1;
    }
    i = (i + 1) % digits.length;
  }
  return build();
}

// ---------------------------------------------------------------- validateManifest

describe("MANIFEST_LIMITS", () => {
  it("exposes the PLAN §4 fixed values for the five known slots", async () => {
    const m = await load();
    expect(m.MANIFEST_LIMITS).toEqual({
      maxBytes: 65536,
      maxPlacementsPerSlot: {
        "board.backdrop": 1,
        "board.corner": 2,
        "oneline.tape": 1,
        "piece.sticker": 1,
        "empty.illust": 1,
      },
      maxStrokes: 200,
      maxPointsPerStroke: 500,
      maxPoints: 5000,
    });
  });
});

describe("validateManifest: accepted shapes and boundaries", () => {
  it("accepts the empty manifest and pen-only manifests with the default (empty) allowlist", async () => {
    const m = await load();
    expectValid(m, root(), undefined, "empty");
    expectValid(m, root(), {}, "empty, opts {}");
    expectValid(m, root([], [stroke()]), undefined, "pen only, default opts");
    expectValid(m, root([], [stroke({ slot: "empty.illust", anchor: "end" })]), undefined, "pen in empty.illust");
  });

  it("accepts every slot, enum value and numeric boundary when assets are allowlisted", async () => {
    const m = await load();
    const full = root(
      [
        general("board.backdrop", { x: 0, y: 0, max_w: 1, rotate: -15, hide_below: 375 }),
        general("board.corner", { asset: B, anchor: "end", x: 1, y: 1, max_w: 0.000001, rotate: 15, hide_below: 768 }),
        general("board.corner", { rotate: 0, hide_below: 1100 }),
        general("oneline.tape", { anchor: "end" }),
        general("empty.illust"),
        sticker({ corner: "top-start", every: 1, hide_below: 375 }),
      ],
      [
        stroke({ color: "ink", width: 2, points: [[0, 0], [1, 1]] }),
        stroke({ color: "accent", width: 4, anchor: "end" }),
        stroke({ color: "muted", width: 8, slot: "empty.illust" }),
        stroke({ color: "focus" }),
      ],
    );
    expectValid(m, full, ALLOW, "full");
    for (const corner of ["top-start", "top-end", "bottom-start", "bottom-end"]) {
      expectValid(m, root([sticker({ corner })]), ALLOW, `corner ${corner}`);
    }
    for (const every of [1, 12]) expectValid(m, root([sticker({ every })]), ALLOW, `every ${every}`);
    // 32자 asset 이름(형식 상한)
    const long = `builtin:${"a".repeat(32)}`;
    expectValid(m, root([general("board.corner", { asset: long })]), allow(long), "asset name 32");
  });
});

describe("validateManifest: rejected shapes (one defect each)", () => {
  it("root: non-object inputs, missing/extra keys, unknown schema/base, non-array lists", async () => {
    const m = await load();
    const cases: [string, unknown][] = [
      ["null", null],
      ["undefined", undefined],
      ["array", []],
      ["string", JSON.stringify(root())],
      ["number", 1],
      ["missing schema", without(root(), "schema")],
      ["missing base", without(root(), "base")],
      ["missing placements", without(root(), "placements")],
      ["missing ink", without(root(), "ink")],
      ["extra root key style", { ...root(), style: "color:red" }],
      ["extra root key font", { ...root(), font: "serif" }],
      ["schema 2", { ...root(), schema: 2 }],
      ["schema '1'", { ...root(), schema: "1" }],
      ["base other", { ...root(), base: "d-warm-pieces@2" }],
      ["placements object", { ...root(), placements: {} }],
      ["placements null", { ...root(), placements: null }],
      ["ink string", { ...root(), ink: "[]" }],
      ["placement item null", root([null as unknown as Obj])],
      ["ink item array", root([], [[] as unknown as Obj])],
    ];
    expectAllInvalid(m, cases);
  });

  it("general placement: ranges, integer rotate, enums, types, non-finite numbers, missing/extra keys, unknown slot", async () => {
    const m = await load();
    const g = (over: Obj) => root([general("board.corner", over)]);
    const cases: [string, unknown][] = [
      ["x -0.01", g({ x: -0.01 })],
      ["x 1.01", g({ x: 1.01 })],
      ["y -1", g({ y: -1 })],
      ["y 2", g({ y: 2 })],
      ["max_w 0", g({ max_w: 0 })],
      ["max_w -0.1", g({ max_w: -0.1 })],
      ["max_w 1.0001", g({ max_w: 1.0001 })],
      ["rotate -16", g({ rotate: -16 })],
      ["rotate 16", g({ rotate: 16 })],
      ["rotate 1.5", g({ rotate: 1.5 })],
      ["x NaN", g({ x: Number.NaN })],
      ["y Infinity", g({ y: Number.POSITIVE_INFINITY })],
      ["max_w -Infinity", g({ max_w: Number.NEGATIVE_INFINITY })],
      ["rotate NaN", g({ rotate: Number.NaN })],
      ["x string", g({ x: "0.5" })],
      ["y boolean", g({ y: true })],
      ["rotate string", g({ rotate: "0" })],
      ["anchor middle", g({ anchor: "middle" })],
      ["anchor number", g({ anchor: 0 })],
      ["hide_below 0", g({ hide_below: 0 })],
      ["hide_below 1440", g({ hide_below: 1440 })],
      ["hide_below '375'", g({ hide_below: "375" })],
      ["hide_below null", g({ hide_below: null })],
      ["missing asset", root([without(general("board.corner"), "asset")])],
      ["missing anchor", root([without(general("board.corner"), "anchor")])],
      ["missing x", root([without(general("board.corner"), "x")])],
      ["missing y", root([without(general("board.corner"), "y")])],
      ["missing max_w", root([without(general("board.corner"), "max_w")])],
      ["missing rotate", root([without(general("board.corner"), "rotate")])],
      ["extra key corner", g({ corner: "top-end" })],
      ["extra key every", g({ every: 3 })],
      ["extra key css", g({ css: "left:0" })],
      ["extra key url", g({ url: "https://example.com/a.png" })],
      ["unknown slot", root([general("board.unknown")])],
      ["slot number", root([general(1 as unknown as string)])],
      ["missing slot", root([without(general("board.corner"), "slot")])],
    ];
    expectAllInvalid(m, cases);
  });

  it("piece.sticker: corner/every enums and integers, forbidden general fields, missing/extra keys", async () => {
    const m = await load();
    const s = (over: Obj) => root([sticker(over)]);
    const cases: [string, unknown][] = [
      ["every 0", s({ every: 0 })],
      ["every 13", s({ every: 13 })],
      ["every 2.5", s({ every: 2.5 })],
      ["every NaN", s({ every: Number.NaN })],
      ["every Infinity", s({ every: Number.POSITIVE_INFINITY })],
      ["every string", s({ every: "3" })],
      ["corner middle", s({ corner: "middle" })],
      ["corner top", s({ corner: "top" })],
      ["hide_below 500", s({ hide_below: 500 })],
      ["with x", s({ x: 0.5 })],
      ["with y", s({ y: 0.5 })],
      ["with max_w", s({ max_w: 0.2 })],
      ["with rotate", s({ rotate: 0 })],
      ["with anchor", s({ anchor: "start" })],
      ["extra key", s({ color: "accent" })],
      ["missing asset", root([without(sticker(), "asset")])],
      ["missing corner", root([without(sticker(), "corner")])],
      ["missing every", root([without(sticker(), "every")])],
    ];
    expectAllInvalid(m, cases);
  });

  it("ink stroke: slot/anchor/color/width enums, point tuples and ranges, non-finite numbers, missing/extra keys", async () => {
    const m = await load();
    const k = (over: Obj) => root([], [stroke(over)]);
    const cases: [string, unknown][] = [
      ["slot oneline.tape", k({ slot: "oneline.tape" })],
      ["slot board.backdrop", k({ slot: "board.backdrop" })],
      ["slot piece.sticker", k({ slot: "piece.sticker" })],
      ["anchor center", k({ anchor: "center" })],
      ["color red", k({ color: "red" })],
      ["color hex", k({ color: "#ff0000" })],
      ["width 3", k({ width: 3 })],
      ["width 2.5", k({ width: 2.5 })],
      ["width '2'", k({ width: "2" })],
      ["one point", k({ points: pts(1) })],
      ["zero points", k({ points: [] })],
      ["points not array", k({ points: "0.1,0.1" })],
      ["point 1-tuple", k({ points: [[0.1], [0.2, 0.2]] })],
      ["point 3-tuple", k({ points: [[0.1, 0.1, 0.1], [0.2, 0.2]] })],
      ["point object", k({ points: [{ x: 0.1, y: 0.1 }, [0.2, 0.2]] })],
      ["point x -0.01", k({ points: [[-0.01, 0.1], [0.2, 0.2]] })],
      ["point y 1.01", k({ points: [[0.1, 1.01], [0.2, 0.2]] })],
      ["point NaN", k({ points: [[Number.NaN, 0.1], [0.2, 0.2]] })],
      ["point Infinity", k({ points: [[0.1, Number.POSITIVE_INFINITY], [0.2, 0.2]] })],
      ["point string", k({ points: [["0.1", 0.1], [0.2, 0.2]] })],
      ["point boolean", k({ points: [[0.1, false], [0.2, 0.2]] })],
      ["extra key asset", k({ asset: A })],
      ["extra key brush", k({ brush: "soft" })],
      ["missing slot", root([], [without(stroke(), "slot")])],
      ["missing anchor", root([], [without(stroke(), "anchor")])],
      ["missing color", root([], [without(stroke(), "color")])],
      ["missing width", root([], [without(stroke(), "width")])],
      ["missing points", root([], [without(stroke(), "points")])],
    ];
    expectAllInvalid(m, cases);
  });

  it("asset: default allowlist is empty, explicit allowlist admits, malformed names are rejected even if listed", async () => {
    const m = await load();
    const withAsset = (asset: string) => root([general("board.corner", { asset })]);
    expectInvalid(m, withAsset(A), undefined, "default opts rejects any asset");
    expectInvalid(m, withAsset(A), {}, "opts without allowedAssets");
    expectInvalid(m, root([sticker()]), allow(), "empty allowlist rejects sticker");
    expectInvalid(m, withAsset("builtin:sun"), ALLOW, "well-formed but not listed");
    expectValid(m, withAsset(A), ALLOW, "listed");
    const malformed = [
      "ast_123",
      "builtin:",
      "builtin:Star",
      "builtin:star_1",
      "builtin:star.png",
      `builtin:${"a".repeat(33)}`,
      " builtin:star",
      "builtin:star\n",
      "https://example.com/star.png",
      "data:image/png;base64,AAAA",
      "upload:abc",
    ];
    for (const asset of malformed) {
      expectInvalid(m, withAsset(asset), allow(asset), `malformed asset ${JSON.stringify(asset)}`);
    }
    expectInvalid(m, root([general("board.corner", { asset: 1 })]), ALLOW, "asset number");
  });

  it("per-slot placement limits (board.corner 2, others 1) are counted separately from ink", async () => {
    const m = await load();
    expectValid(m, root([general("board.corner"), general("board.corner", { asset: B })]), ALLOW, "corner 2");
    expectInvalid(
      m,
      root([general("board.corner"), general("board.corner"), general("board.corner")]),
      ALLOW,
      "corner 3",
    );
    for (const slot of ["board.backdrop", "oneline.tape", "empty.illust"]) {
      expectValid(m, root([general(slot)]), ALLOW, `${slot} 1`);
      expectInvalid(m, root([general(slot), general(slot)]), ALLOW, `${slot} 2`);
    }
    expectInvalid(m, root([sticker(), sticker({ corner: "bottom-end" })]), ALLOW, "piece.sticker 2");
    // 같은 슬롯의 ink 획은 placement 상한에 들어가지 않는다
    expectValid(
      m,
      root(
        [general("board.corner"), general("board.corner"), general("empty.illust")],
        [stroke(), stroke(), stroke(), stroke({ slot: "empty.illust" }), stroke({ slot: "empty.illust" })],
      ),
      ALLOW,
      "2 corner placements + 3 corner strokes + 1 illust placement + 2 illust strokes",
    );
  });

  it("stroke/point limits: 200/201 strokes, 500/501 points per stroke, 5000/5001 points total", async () => {
    const m = await load();
    expectValid(m, root([], Array.from({ length: 200 }, () => stroke())), undefined, "200 strokes");
    expectInvalid(m, root([], Array.from({ length: 201 }, () => stroke())), undefined, "201 strokes");
    expectValid(m, root([], [stroke({}, 500)]), undefined, "500 points");
    expectInvalid(m, root([], [stroke({}, 501)]), undefined, "501 points");
    const total = (last: number) =>
      root([], [...Array.from({ length: 9 }, () => stroke({}, 500)), stroke({}, last), stroke({}, 2)]);
    expectValid(m, total(498), undefined, "5000 points total");
    expectInvalid(m, total(499), undefined, "5001 points total");
  });

  it("size: JSON.stringify UTF-8 bytes 65536 accepted, 65537 rejected (fixture verified with Buffer.byteLength)", async () => {
    const m = await load();
    const at = sizedPenManifest(65536);
    const over = sizedPenManifest(65537);
    // fixture 자체 확인: 크기 외 제약은 모두 유효(10획 × 500점 = 5000점, 좌표 0~1)
    expect(bytes(at)).toBe(65536);
    expect(bytes(over)).toBe(65537);
    expect((over.ink as Obj[]).reduce((n, s) => n + (s.points as unknown[]).length, 0)).toBe(5000);
    expectValid(m, at, undefined, "65536 bytes");
    expectInvalid(m, over, undefined, "65537 bytes");
  });

  it("stringify failures (circular reference, BigInt) return invalid_manifest without throwing", async () => {
    const m = await load();
    const circular = root([], [stroke()]);
    circular.self = circular;
    const big = root([general("board.corner", { x: BigInt(0) })]);
    expectInvalid(m, circular, ALLOW, "circular");
    expectInvalid(m, big, ALLOW, "BigInt");
    expect(() => m.manifestForRender(circular, ALLOW)).not.toThrow();
    expect(m.manifestForRender(circular, ALLOW)).toBeNull();
    expect(() => m.manifestForRender(big, ALLOW)).not.toThrow();
    expect(m.manifestForRender(big, ALLOW)).toBeNull();
  });

  it("does not mutate (deep-frozen) inputs in validate or render", async () => {
    const m = await load();
    const input = root(
      [general("board.corner"), general("board.unknown"), general("oneline.tape", { asset: "builtin:sun" }), sticker()],
      [stroke()],
    );
    const snapshot = structuredClone(input);
    const freeze = (v: unknown): void => {
      if (v && typeof v === "object") {
        Object.freeze(v);
        for (const x of Object.values(v)) freeze(x);
      }
    };
    freeze(input);
    expect(() => m.validateManifest(input, ALLOW)).not.toThrow();
    expect(() => m.manifestForRender(input, ALLOW)).not.toThrow();
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------- manifestForRender

describe("manifestForRender: fallback policy", () => {
  it("returns the manifest for a fully valid input and null for unknown schema/base or root structure errors", async () => {
    const m = await load();
    const valid = root([general("board.corner"), sticker()], [stroke()]);
    expect(m.manifestForRender(valid, ALLOW)).toEqual(valid);
    expect(m.manifestForRender(root())).toEqual(root());
    const nulls: [string, unknown][] = [
      ["schema 2", { ...valid, schema: 2 }],
      ["base other", { ...valid, base: "e-other@1" }],
      ["null", null],
      ["array", []],
      ["missing ink", without(valid, "ink")],
      ["placements object", { ...valid, placements: {} }],
      ["extra root key", { ...valid, css: "body{}" }],
    ];
    for (const [label, input] of nulls) expect(m.manifestForRender(input, ALLOW), label).toBeNull();
  });

  it("returns null when a known-slot item has a wrong number or format", async () => {
    const m = await load();
    const ok = [general("oneline.tape"), sticker()];
    const nulls: [string, unknown][] = [
      ["known slot x 1.5", root([...ok, general("board.corner", { x: 1.5 })])],
      ["rotate 1.5", root([...ok, general("board.corner", { rotate: 1.5 })])],
      ["max_w 0", root([...ok, general("board.corner", { max_w: 0 })])],
      ["hide_below 500", root([...ok, general("board.corner", { hide_below: 500 })])],
      ["sticker with x", root([general("oneline.tape"), sticker({ x: 0.5 })])],
      ["sticker every 13", root([general("oneline.tape"), sticker({ every: 13 })])],
      ["malformed asset (allowlisted)", root([...ok, general("board.corner", { asset: "https://example.com/a.png" })])],
      ["ink width 3", root(ok, [stroke({ width: 3 })])],
      ["ink color hex", root(ok, [stroke({ color: "#000" })])],
      ["ink point 3-tuple", root(ok, [stroke({ points: [[0.1, 0.1, 0.1], [0.2, 0.2]] })])],
      ["ink point out of range", root(ok, [stroke({ points: [[1.5, 0.1], [0.2, 0.2]] })])],
    ];
    const withUrl = allow(A, B, "https://example.com/a.png");
    for (const [label, input] of nulls) expect(m.manifestForRender(input, withUrl), label).toBeNull();
  });

  it("drops only unknown-slot items and well-formed assets outside the allowlist, keeping the order of the rest", async () => {
    const m = await load();
    const corner = general("board.corner");
    const future = general("board.future"); // 형식은 일반 placement와 같고 slot만 모른다
    const notListed = general("oneline.tape", { asset: "builtin:sun" }); // 형식은 맞고 목록 밖
    const tape = general("empty.illust", { asset: B });
    const stick = sticker();
    const s1 = stroke();
    const s2 = stroke({ slot: "empty.illust", color: "focus" });
    const input = root([future, corner, notListed, stick, tape], [s1, stroke({ slot: "board.future" }), s2]);
    expect(m.manifestForRender(input, ALLOW)).toEqual(root([corner, stick, tape], [s1, s2]));
    // 기본(빈) 허용 목록: asset을 쓰는 항목만 모두 버리고 펜은 남긴다
    expect(m.manifestForRender(root([corner, stick], [s1, s2]))).toEqual(root([], [s1, s2]));
    // 설정에서 빠진(이전에 유효했던) asset도 drop
    expect(m.manifestForRender(root([corner, general("board.corner", { asset: B })], [s1]), allow(B))).toEqual(
      root([general("board.corner", { asset: B })], [s1]),
    );
  });

  // ---- R1 메인 결정(기술 기본값): 렌더에도 byte·개수 상한, slot 분류, drop 뒤 개수 계산 ----

  it("R1: render applies byte and count limits — over-limit inputs are null, at-limit inputs pass unchanged", async () => {
    const m = await load();
    const same = (input: Obj, label: string) => {
      const before = structuredClone(input);
      expect(m.manifestForRender(input, ALLOW), label).toEqual(before);
      expect(input, `input not mutated ${label}`).toEqual(before);
    };
    const isNull = (input: Obj, label: string) => expect(m.manifestForRender(input, ALLOW), label).toBeNull();
    same(root([general("board.corner"), general("board.corner", { asset: B })]), "corner 2");
    isNull(root([general("board.corner"), general("board.corner"), general("board.corner")]), "corner 3");
    same(root([general("oneline.tape")]), "tape 1");
    isNull(root([general("oneline.tape"), general("oneline.tape", { asset: B })]), "tape 2");
    isNull(root([sticker(), sticker({ corner: "bottom-start" })]), "sticker 2");
    same(root([], Array.from({ length: 200 }, () => stroke())), "200 strokes");
    isNull(root([], Array.from({ length: 201 }, () => stroke())), "201 strokes");
    same(root([], [stroke({}, 500)]), "500 points");
    isNull(root([], [stroke({}, 501)]), "501 points");
    const total = (last: number) =>
      root([], [...Array.from({ length: 9 }, () => stroke({}, 500)), stroke({}, last), stroke({}, 2)]);
    same(total(498), "5000 points total");
    isNull(total(499), "5001 points total");
    const at = sizedPenManifest(65536);
    const over = sizedPenManifest(65537);
    expect(bytes(at)).toBe(65536);
    expect(bytes(over)).toBe(65537);
    same(at, "65536 bytes");
    isNull(over, "65537 bytes");
  });

  it("R1: slot classification — malformed entries and known slots in the wrong list are null; unknown-string slots are dropped without reading other fields", async () => {
    const m = await load();
    const corner = general("board.corner");
    const s1 = stroke();
    const nulls: [string, Obj][] = [
      ["ink slot board.backdrop", root([corner], [s1, stroke({ slot: "board.backdrop" })])],
      ["ink slot oneline.tape", root([corner], [s1, stroke({ slot: "oneline.tape" })])],
      ["ink slot piece.sticker", root([corner], [s1, stroke({ slot: "piece.sticker" })])],
      ["placement entry null", root([corner, null as unknown as Obj], [s1])],
      ["placement entry array", root([corner, [] as unknown as Obj], [s1])],
      ["placement missing slot", root([corner, without(general("oneline.tape"), "slot")], [s1])],
      ["placement slot number", root([corner, general(7 as unknown as string)], [s1])],
      ["ink entry null", root([corner], [s1, null as unknown as Obj])],
      ["ink entry array", root([corner], [s1, [] as unknown as Obj])],
      ["ink missing slot", root([corner], [s1, without(stroke(), "slot")])],
      ["ink slot null", root([corner], [s1, stroke({ slot: null })])],
    ];
    for (const [label, input] of nulls) expect(m.manifestForRender(input, ALLOW), label).toBeNull();

    // 알려진 5개 슬롯 어디에도 없는 문자열 slot: 나머지 필드가 잘못돼도 그 항목만 버린다
    const junkPlacement: Obj = { slot: "board.future", x: "bad", rotate: 99, asset: "https://x", extra: { a: [1] } };
    const junkInk: Obj = { slot: "ink.future", width: 99, color: "#fff", points: "nope" };
    const input = root([junkPlacement, corner, sticker()], [junkInk, s1]);
    const before = structuredClone(input);
    expect(m.manifestForRender(input, ALLOW)).toEqual(root([corner, sticker()], [s1]));
    expect(input).toEqual(before);

    // 입력 전체 stringify 규칙이 먼저다(별도 격리): unknown slot 안의 BigInt·순환 참조도 전체 null
    expect(m.manifestForRender(root([corner, { slot: "board.future", n: BigInt(1) }], [s1]), ALLOW)).toBeNull();
    const cyc: Obj = { slot: "board.future" };
    cyc.self = cyc;
    expect(() => m.manifestForRender(root([corner, cyc], [s1]), ALLOW)).not.toThrow();
    expect(m.manifestForRender(root([corner, cyc], [s1]), ALLOW)).toBeNull();
  });

  it("R1: limits are counted after drops (dropped items do not count), but input bytes are measured before drops", async () => {
    const m = await load();
    const c1 = general("board.corner");
    const c2 = general("board.corner", { asset: B, anchor: "end" });
    const unlisted = general("board.corner", { asset: "builtin:sun" }); // 형식 정상, 목록 밖
    const future = general("board.future");
    // 남은 board.corner 2개는 허용(목록 밖·unknown 항목은 개수에 들어가지 않는다)
    expect(m.manifestForRender(root([c1, unlisted, future, c2]), ALLOW)).toEqual(root([c1, c2]));
    expect(m.manifestForRender(root([sticker(), sticker({ asset: "builtin:sun" })]), ALLOW)).toEqual(root([sticker()]));

    // unknown ink가 원본 획 수 200·획당 500·전체 5000을 넘겨도, bytes ≤ 65536이고 남은 유효 부분이 상한 안이면 허용
    const valid = [stroke(), stroke({ slot: "empty.illust" })];
    const manyUnknown = Array.from({ length: 250 }, () => stroke({ slot: "ink.future" }));
    const raw1 = root([], [...valid, ...manyUnknown]);
    expect(bytes(raw1)).toBeLessThanOrEqual(65536);
    expect(m.manifestForRender(raw1, ALLOW)).toEqual(root([], valid));
    const eightFull = Array.from({ length: 8 }, () => stroke({}, 500));
    const bigUnknown = [stroke({ slot: "ink.future" }, 600), stroke({ slot: "ink.future" }, 600)];
    const raw2 = root([], [...eightFull, ...bigUnknown]); // 원본 점 5200, unknown 획당 600
    expect(bytes(raw2)).toBeLessThanOrEqual(65536);
    expect(m.manifestForRender(raw2, ALLOW)).toEqual(root([], eightFull));

    // 입력 bytes는 drop 전 원문 기준: unknown 내용 때문에 65537이면 null, 65536이면 남은 항목 반환
    const withUnknownOfSize = (target: number): Obj => {
      const probe = root([{ slot: "board.future", note: "" }], [stroke()]);
      const pad = target - bytes(probe);
      return root([{ slot: "board.future", note: "x".repeat(pad) }], [stroke()]);
    };
    const at = withUnknownOfSize(65536);
    const over = withUnknownOfSize(65537);
    expect(bytes(at)).toBe(65536);
    expect(bytes(over)).toBe(65537);
    expect(m.manifestForRender(at, ALLOW)).toEqual(root([], [stroke()]));
    expect(m.manifestForRender(over, ALLOW)).toBeNull();
  });

  // ---- S3 회귀(PR25 독립 검토 P2-1): 구멍 있는(sparse) 배열 ----

  it("regression: sparse placements/ink arrays are rejected as invalid_manifest without throwing, and render is null", async () => {
    const m = await load();
    const hole = (items: Obj[], length: number): Obj[] => {
      const a = [...items];
      a.length = length; // 실제 구멍: 인덱스 속성이 없다
      return a;
    };
    const holePlacements = hole([], 1);
    const validThenHolePlacements = hole([general("board.corner")], 2);
    const holeInk = hole([], 1);
    const validThenHoleInk = hole([stroke()], 2);
    // fixture 확인: undefined 값을 가진 dense 배열이 아니라 진짜 구멍이다(JSON.stringify는 null로 성공)
    expect(Object.hasOwn(holePlacements, 0)).toBe(false);
    expect(Object.hasOwn(validThenHolePlacements, 1)).toBe(false);
    expect(Object.hasOwn(holeInk, 0)).toBe(false);
    expect(Object.hasOwn(validThenHoleInk, 1)).toBe(false);
    expect(JSON.stringify(holePlacements)).toBe("[null]");
    // 양성 제어: 같은 위치에 undefined 값이 있는 dense 배열은 이미 invalid로 거부된다
    const dense = [undefined] as unknown as Obj[];
    expect(Object.hasOwn(dense, 0)).toBe(true);
    expectInvalid(m, root(dense), ALLOW, "dense [undefined] placements");

    const cases: [string, Obj][] = [
      ["sparse placements [<hole>]", root(holePlacements, [stroke()])],
      ["sparse placements [valid, <hole>]", root(validThenHolePlacements, [stroke()])],
      ["sparse ink [<hole>]", root([general("board.corner")], holeInk)],
      ["sparse ink [valid, <hole>]", root([general("board.corner")], validThenHoleInk)],
    ];
    for (const [label, input] of cases) {
      expectInvalid(m, input, ALLOW, label);
      expect(m.manifestForRender(input, ALLOW), `render ${label}`).toBeNull();
    }
  });
});
