/**
 * 개인 꾸미기 manifest 검증·렌더 필터(PLAN_mvp-domain-storage §4). 브라우저·서버가 함께 쓰는 순수 함수만 둔다.
 *
 * - 입력은 바꾸지 않는다. 표준 API(JSON.stringify·TextEncoder)만 쓴다.
 * - 임의 색·CSS·HTML·URL·글꼴·업로드 필드는 없다. asset은 builtin 형식 + 주입된 허용 목록(기본 빈 목록)이다.
 * - validateManifest는 엄격 검사, manifestForRender는 R1 렌더 규칙(전체 null 또는 항목 drop)을 따른다.
 */

type Anchor = "start" | "end";
type Breakpoint = 375 | 768 | 1100;
type GeneralPlacement = {
  slot: "board.backdrop" | "board.corner" | "oneline.tape" | "empty.illust";
  asset: string;
  anchor: Anchor;
  x: number;
  y: number;
  max_w: number;
  rotate: number;
  hide_below?: Breakpoint;
};
type StickerPlacement = {
  slot: "piece.sticker";
  asset: string;
  corner: "top-start" | "top-end" | "bottom-start" | "bottom-end";
  every: number;
  hide_below?: Breakpoint;
};
type InkStroke = {
  slot: "board.corner" | "empty.illust";
  anchor: Anchor;
  color: "ink" | "accent" | "muted" | "focus";
  width: 2 | 4 | 8;
  points: [number, number][];
};
export type Manifest = {
  schema: 1;
  base: "d-warm-pieces@1";
  placements: (GeneralPlacement | StickerPlacement)[];
  ink: InkStroke[];
};
export type ManifestOpts = { allowedAssets?: ReadonlySet<string> };

export const MANIFEST_LIMITS: {
  maxBytes: 65536;
  maxPlacementsPerSlot: Record<string, number>;
  maxStrokes: 200;
  maxPointsPerStroke: 500;
  maxPoints: 5000;
} = {
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
};

const SCHEMA = 1;
const BASE = "d-warm-pieces@1";
const ROOT_KEYS = ["schema", "base", "placements", "ink"];
const GENERAL_KEYS = ["slot", "asset", "anchor", "x", "y", "max_w", "rotate"];
const STICKER_KEYS = ["slot", "asset", "corner", "every"];
const INK_KEYS = ["slot", "anchor", "color", "width", "points"];
const OPTIONAL_PLACEMENT_KEYS = ["hide_below"];
const ANCHORS: readonly unknown[] = ["start", "end"];
const BREAKPOINTS: readonly unknown[] = [375, 768, 1100];
const CORNERS: readonly unknown[] = ["top-start", "top-end", "bottom-start", "bottom-end"];
const COLORS: readonly unknown[] = ["ink", "accent", "muted", "focus"];
const WIDTHS: readonly unknown[] = [2, 4, 8];
const INK_SLOTS: readonly string[] = ["board.corner", "empty.illust"];
const ASSET_RE = /^builtin:[a-z0-9-]{1,32}$/;
const EMPTY_ASSETS: ReadonlySet<string> = new Set();

type Obj = Record<string, unknown>;

/** 항목 분류: 정상 / 모르는 slot(drop) / 형식 정상이지만 asset이 목록 밖(drop) / 형식 오류. */
type Verdict = { kind: "ok" } | { kind: "unknown_slot" } | { kind: "unlisted_asset" } | { kind: "invalid"; issue: string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inUnit = (v: unknown) => isNum(v) && v >= 0 && v <= 1;
const isKnownSlot = (slot: string) => Object.hasOwn(MANIFEST_LIMITS.maxPlacementsPerSlot, slot);

/** 필수 키가 모두 있고, 그 밖에는 선택 키만 있는지. */
function exactKeys(o: Obj, required: readonly string[], optional: readonly string[] = []): string | null {
  for (const k of required) if (!Object.hasOwn(o, k)) return `missing key ${k}`;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return `unexpected key ${k}`;
  return null;
}

function classifyPlacement(p: unknown, allowed: ReadonlySet<string>): Verdict {
  if (!isObj(p)) return { kind: "invalid", issue: "placement must be an object" };
  const slot = p.slot;
  if (typeof slot !== "string") return { kind: "invalid", issue: "placement slot must be a string" };
  if (!isKnownSlot(slot)) return { kind: "unknown_slot" };
  // 알려진 slot은 형식·수치를 먼저 모두 검사한 뒤에만 asset 목록을 본다.
  if (slot === "piece.sticker") {
    const keys = exactKeys(p, STICKER_KEYS, OPTIONAL_PLACEMENT_KEYS);
    if (keys) return { kind: "invalid", issue: `piece.sticker: ${keys}` };
    if (!CORNERS.includes(p.corner)) return { kind: "invalid", issue: "piece.sticker: invalid corner" };
    if (!Number.isInteger(p.every) || (p.every as number) < 1 || (p.every as number) > 12) {
      return { kind: "invalid", issue: "piece.sticker: every must be an integer 1..12" };
    }
  } else {
    const keys = exactKeys(p, GENERAL_KEYS, OPTIONAL_PLACEMENT_KEYS);
    if (keys) return { kind: "invalid", issue: `${slot}: ${keys}` };
    if (!ANCHORS.includes(p.anchor)) return { kind: "invalid", issue: `${slot}: invalid anchor` };
    if (!inUnit(p.x) || !inUnit(p.y)) return { kind: "invalid", issue: `${slot}: x and y must be 0..1` };
    if (!isNum(p.max_w) || p.max_w <= 0 || p.max_w > 1) return { kind: "invalid", issue: `${slot}: max_w must be >0..1` };
    if (!Number.isInteger(p.rotate) || (p.rotate as number) < -15 || (p.rotate as number) > 15) {
      return { kind: "invalid", issue: `${slot}: rotate must be an integer -15..15` };
    }
  }
  if (Object.hasOwn(p, "hide_below") && !BREAKPOINTS.includes(p.hide_below)) {
    return { kind: "invalid", issue: `${slot}: invalid hide_below` };
  }
  if (typeof p.asset !== "string" || !ASSET_RE.test(p.asset)) return { kind: "invalid", issue: `${slot}: malformed asset` };
  return allowed.has(p.asset) ? { kind: "ok" } : { kind: "unlisted_asset" };
}

function classifyStroke(s: unknown): Verdict {
  if (!isObj(s)) return { kind: "invalid", issue: "ink stroke must be an object" };
  const slot = s.slot;
  if (typeof slot !== "string") return { kind: "invalid", issue: "ink slot must be a string" };
  if (!isKnownSlot(slot)) return { kind: "unknown_slot" };
  if (!INK_SLOTS.includes(slot)) return { kind: "invalid", issue: `ink is not allowed in ${slot}` };
  const keys = exactKeys(s, INK_KEYS);
  if (keys) return { kind: "invalid", issue: `ink: ${keys}` };
  if (!ANCHORS.includes(s.anchor)) return { kind: "invalid", issue: "ink: invalid anchor" };
  if (!COLORS.includes(s.color)) return { kind: "invalid", issue: "ink: invalid color" };
  if (!WIDTHS.includes(s.width)) return { kind: "invalid", issue: "ink: invalid width" };
  if (!Array.isArray(s.points) || s.points.length < 2) return { kind: "invalid", issue: "ink: points must have 2 or more" };
  for (const pt of s.points) {
    if (!Array.isArray(pt) || pt.length !== 2 || !inUnit(pt[0]) || !inUnit(pt[1])) {
      return { kind: "invalid", issue: "ink: each point must be [x, y] within 0..1" };
    }
  }
  return { kind: "ok" };
}

/** 슬롯별 placement 개수·획 수·획당 점·전체 점 상한. 넘으면 issue 목록을 돌려준다. */
function limitIssues(placements: readonly Obj[], ink: readonly Obj[]): string[] {
  const issues: string[] = [];
  const perSlot = new Map<string, number>();
  for (const p of placements) perSlot.set(p.slot as string, (perSlot.get(p.slot as string) ?? 0) + 1);
  for (const [slot, n] of perSlot) {
    if (n > (MANIFEST_LIMITS.maxPlacementsPerSlot[slot] ?? 0)) issues.push(`too many placements in ${slot}`);
  }
  if (ink.length > MANIFEST_LIMITS.maxStrokes) issues.push("too many ink strokes");
  let total = 0;
  for (const s of ink) {
    const n = (s.points as unknown[]).length;
    total += n;
    if (n > MANIFEST_LIMITS.maxPointsPerStroke) issues.push("too many points in a stroke");
  }
  if (total > MANIFEST_LIMITS.maxPoints) issues.push("too many ink points");
  return issues;
}

/** JSON.stringify UTF-8 크기 검사와 루트 구조 검사. 실패하면 issue 문자열, 통과하면 루트 객체. */
function checkRoot(input: unknown): { issue: string } | { root: Obj & { placements: unknown[]; ink: unknown[] } } {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    return { issue: "manifest cannot be serialized to JSON" };
  }
  if (typeof json !== "string") return { issue: "manifest cannot be serialized to JSON" };
  if (new TextEncoder().encode(json).length > MANIFEST_LIMITS.maxBytes) return { issue: "manifest is larger than 65536 bytes" };
  if (!isObj(input)) return { issue: "manifest must be an object" };
  const keys = exactKeys(input, ROOT_KEYS);
  if (keys) return { issue: keys };
  if (input.schema !== SCHEMA) return { issue: "unknown schema" };
  if (input.base !== BASE) return { issue: "unknown base" };
  if (!Array.isArray(input.placements) || !Array.isArray(input.ink)) return { issue: "placements and ink must be arrays" };
  return { root: input as Obj & { placements: unknown[]; ink: unknown[] } };
}

/** 저장용 엄격 검사: 모르는 slot·목록 밖 asset도 거부한다. */
export function validateManifest(
  input: unknown,
  opts?: ManifestOpts,
): { ok: true; value: Manifest } | { ok: false; error: "invalid_manifest"; issues: string[] } {
  const checked = checkRoot(input);
  if ("issue" in checked) return { ok: false, error: "invalid_manifest", issues: [checked.issue] };
  const allowed = opts?.allowedAssets ?? EMPTY_ASSETS;
  const issues: string[] = [];
  // Array.from은 구멍(sparse)도 undefined로 방문한다(.map은 건너뛰어 구멍 있는 결과를 만든다).
  const verdicts = [
    ...Array.from(checked.root.placements, (p) => classifyPlacement(p, allowed)),
    ...Array.from(checked.root.ink, (s) => classifyStroke(s)),
  ];
  for (const v of verdicts) {
    if (v.kind === "invalid") issues.push(v.issue);
    else if (v.kind === "unknown_slot") issues.push("unknown slot");
    else if (v.kind === "unlisted_asset") issues.push("asset is not in the allowed list");
  }
  if (issues.length === 0) issues.push(...limitIssues(checked.root.placements as Obj[], checked.root.ink as Obj[]));
  if (issues.length > 0) return { ok: false, error: "invalid_manifest", issues };
  return { ok: true, value: input as Manifest };
}

/**
 * 렌더용 필터. null이면 기본 D로 그린다.
 * 원문 크기·루트·알려진 slot 항목의 형식 오류·(drop 뒤) 개수 상한 초과는 전체 null,
 * 모르는 slot 항목과 형식은 맞지만 목록 밖 asset 항목은 그 항목만 버린다. 남은 항목의 순서는 유지한다.
 */
export function manifestForRender(input: unknown, opts?: ManifestOpts): Manifest | null {
  const checked = checkRoot(input);
  if ("issue" in checked) return null;
  const allowed = opts?.allowedAssets ?? EMPTY_ASSETS;
  const placements: Obj[] = [];
  for (const p of checked.root.placements) {
    const v = classifyPlacement(p, allowed);
    if (v.kind === "invalid") return null;
    if (v.kind === "ok") placements.push(p as Obj);
  }
  const ink: Obj[] = [];
  for (const s of checked.root.ink) {
    const v = classifyStroke(s);
    if (v.kind === "invalid") return null;
    if (v.kind === "ok") ink.push(s as Obj);
  }
  if (limitIssues(placements, ink).length > 0) return null;
  return { schema: SCHEMA, base: BASE, placements, ink } as Manifest;
}
