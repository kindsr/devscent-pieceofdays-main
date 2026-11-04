// DEV PREVIEW RED — 개발 도메인 /try/ 체험판의 브라우저 저장 모듈 계약(docs/plans/PLAN_dev-local-preview.md).
//
// 대상: frontend/public/try/store.mjs(아직 없음). 순수 ES module이며 각 it 안에서 동적 import하고 export를 확인한다.
// - 브라우저 저장은 빠른 체험을 위한 임시 기본값이다. 사용자의 확정 계정·저장 정책이 아니다.
// - storage는 getItem/setItem/removeItem만 가진 Map 기반 가짜 저장소, now는 시험이 주입하는 시각이다.
//   전역 Date.now·process.env·실제 localStorage는 바꾸지 않는다.
// - 구현 방식이 아니라 사용자 자료 보존(새로고침·다른 인스턴스·실패·손상)을 중심으로 확인한다.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "./auth-b1-support";

const STORE_MODULE = path.join(APP_DIR, "..", "frontend", "public", "try", "store.mjs");

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입)

type Font = "gothic" | "serif" | "hand";
type Moment = { id: string; time: string; text: string };
type Day = { date: string; summary: string; moments: Moment[] };
type Snapshot = { v: 1; font: Font; days: Day[] };
type Err = "invalid_input" | "not_found" | "storage_error" | "corrupt_data";
type Result<T> = { ok: true; value: T } | { ok: false; error: Err };
type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
type PreviewStore = {
  read(): Result<Snapshot>;
  addMoment(text: unknown): Result<Snapshot>;
  updateMoment(date: unknown, id: unknown, text: unknown): Result<Snapshot>;
  removeMoment(date: unknown, id: unknown): Result<Snapshot>;
  setSummary(date: unknown, text: unknown): Result<Snapshot>;
  setFont(font: unknown): Result<Snapshot>;
  clear(): Result<Snapshot>;
  exportJSON(): Result<string>;
};
type StoreApi = {
  STORAGE_KEY: string;
  seoulDate: (now: Date) => string;
  createPreviewStore: (storage: StorageLike, now?: () => Date) => PreviewStore;
};

async function loadStore(): Promise<StoreApi> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ pathToFileURL(STORE_MODULE).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DEV PREVIEW product module frontend/public/try/store.mjs could not be loaded (expected before GREEN): ${msg}`);
  }
  expect(typeof mod.STORAGE_KEY, "store.mjs must export string STORAGE_KEY").toBe("string");
  expect(typeof mod.seoulDate, "store.mjs must export function seoulDate").toBe("function");
  expect(typeof mod.createPreviewStore, "store.mjs must export function createPreviewStore").toBe("function");
  return mod as unknown as StoreApi;
}

const KEY = "pieceofdays.dev-preview.v1";
const OTHER_KEYS = { "other.site.setting": "keep-me", "pieceofdays.dev-preview.v0": "older-key-untouched" };

// ---------------------------------------------------------------- 가짜 저장소·시각

class FakeStorage implements StorageLike {
  map = new Map<string, string>(Object.entries(OTHER_KEYS));
  sets = 0;
  removes = 0;
  failGet = false;
  failSet = false;
  failRemove = false;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error("SecurityError: storage is not available");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet) throw new Error("QuotaExceededError: storage is full");
    this.sets++;
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    if (this.failRemove) throw new Error("SecurityError: storage is not available");
    this.removes++;
    this.map.delete(k);
  }
  raw(): string | null {
    return this.map.has(KEY) ? this.map.get(KEY)! : null;
  }
}

/** 고정 시각을 돌려주는 now. set으로 바꾼다. */
function clock(iso: string) {
  let t = new Date(iso);
  const now = () => new Date(t.getTime());
  return { now, set: (next: string) => (t = new Date(next)) };
}

// 2026-11-04 08:30 KST
const T0 = "2026-11-03T23:30:00.000Z";

const ok = <T>(r: Result<T>, label = ""): T => {
  expect(r, `expected ok ${label}`).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`unexpected ${r.error} ${label}`);
  return r.value;
};
const dayOf = (s: Snapshot, date: string) => s.days.find((d) => d.date === date);
const momentsOf = (s: Snapshot, date: string) => dayOf(s, date)?.moments ?? [];
const EMPTY: Snapshot = { v: 1, font: "gothic", days: [] };

/** 같은 저장소의 새 인스턴스(새로고침에 해당)로 다시 읽는다. */
function reread(api: StoreApi, storage: FakeStorage): Snapshot {
  return ok(api.createPreviewStore(storage, () => new Date(T0)).read(), "reread");
}

/** 쓰기가 실패해야 하는 호출의 정확한 오류(setItem 횟수·원문 불변은 호출한 사례가 함께 확인한다). */
function expectNoWrite(r: Result<unknown>, error: Err, label: string) {
  expect(r, label).toEqual({ ok: false, error });
}

function expectOtherKeysKept(storage: FakeStorage) {
  for (const [k, v] of Object.entries(OTHER_KEYS)) expect(storage.map.get(k), `other key ${k} kept`).toBe(v);
}

// ================================================================= 상수·날짜

describe("store.mjs exports and Seoul date", () => {
  it("STORAGE_KEY is the dedicated versioned key", async () => {
    const api = await loadStore();
    expect(api.STORAGE_KEY).toBe(KEY);
  });

  it("seoulDate gives the exact Asia/Seoul calendar date across UTC, month, year and leap boundaries", async () => {
    const api = await loadStore();
    const cases: [string, string][] = [
      ["2026-11-03T14:59:59.999Z", "2026-11-03"],
      ["2026-11-03T15:00:00.000Z", "2026-11-04"],
      ["2026-11-04T00:00:00.000Z", "2026-11-04"],
      ["2026-10-31T15:00:00.000Z", "2026-11-01"],
      ["2026-12-31T14:59:59.999Z", "2026-12-31"],
      ["2026-12-31T15:00:00.000Z", "2027-01-01"],
      ["2027-02-28T15:00:00.000Z", "2027-03-01"],
      ["2028-02-28T15:00:00.000Z", "2028-02-29"],
      ["2028-02-29T15:00:00.000Z", "2028-03-01"],
    ];
    for (const [iso, want] of cases) expect(api.seoulDate(new Date(iso)), iso).toBe(want);
  });
});

// ================================================================= 초기값·형식

describe("initial state and stored format", () => {
  it("a missing key reads as the empty v1 snapshot (gothic, no days, no sample data) and other keys stay untouched", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    expect(s.read()).toEqual({ ok: true, value: EMPTY });
    expect(JSON.parse(ok(s.exportJSON()))).toEqual(EMPTY);
    expectOtherKeysKept(storage);
    // now를 주지 않아도 만들 수 있다(기본 현재 시각)
    expect(api.createPreviewStore(new FakeStorage()).read()).toEqual({ ok: true, value: EMPTY });
  });

  it("a valid hand-written v1 snapshot reads back exactly (summary-only day included)", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const doc: Snapshot = {
      v: 1,
      font: "serif",
      days: [
        { date: "2026-11-01", summary: "", moments: [{ id: "m-a", time: "09:05", text: "아침 산책" }] },
        { date: "2026-11-02", summary: "한 줄만 남긴 날", moments: [] },
      ],
    };
    storage.map.set(KEY, JSON.stringify(doc));
    expect(api.createPreviewStore(storage, () => new Date(T0)).read()).toEqual({ ok: true, value: doc });
  });
});

// ================================================================= 조각 CRUD

describe("addMoment / updateMoment / removeMoment", () => {
  it("adds at the Seoul date and HH:mm of now with a new unique id; the record survives a reload", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const c = clock(T0);
    const s = api.createPreviewStore(storage, c.now);
    const a = ok(s.addMoment("  국숫집 줄이 짧았다  "));
    const first = momentsOf(a, "2026-11-04");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ time: "08:30", text: "국숫집 줄이 짧았다" });
    expect(typeof first[0]!.id === "string" && first[0]!.id.length > 0).toBe(true);
    c.set("2026-11-04T03:07:00.000Z"); // 12:07 KST
    const b = ok(s.addMoment("점심"));
    const two = momentsOf(b, "2026-11-04");
    expect(two).toHaveLength(2);
    expect(new Set(two.map((m) => m.id)).size).toBe(2);
    expect(two.find((m) => m.text === "점심")?.time).toBe("12:07");
    expect(two.find((m) => m.id === first[0]!.id), "first moment unchanged").toEqual(first[0]);
    expect(reread(api, storage), "reload").toEqual(b);
    expectOtherKeysKept(storage);
  });

  it("UTC/Seoul day, month and year boundaries put moments on the right dates and keep the other days", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const c = clock("2026-12-31T14:59:00.000Z"); // 12-31 23:59 KST
    const s = api.createPreviewStore(storage, c.now);
    ok(s.addMoment("올해 마지막"));
    c.set("2026-12-31T15:00:00.000Z"); // 01-01 00:00 KST
    ok(s.addMoment("새해 첫 조각"));
    c.set("2027-01-31T15:01:00.000Z"); // 02-01 00:01 KST
    const last = ok(s.addMoment("2월"));
    expect(momentsOf(last, "2026-12-31").map((m) => [m.time, m.text])).toEqual([["23:59", "올해 마지막"]]);
    expect(momentsOf(last, "2027-01-01").map((m) => [m.time, m.text])).toEqual([["00:00", "새해 첫 조각"]]);
    expect(momentsOf(last, "2027-02-01").map((m) => [m.time, m.text])).toEqual([["00:01", "2월"]]);
    expect(reread(api, storage)).toEqual(last);
  });

  it("text is trimmed and must be 1..300 code points (astral characters count once); invalid text writes nothing", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    ok(s.addMoment("기존 조각"));
    const before = storage.raw();
    const sets = storage.sets;
    for (const bad of ["", "   ", "\n\t ", "a".repeat(301), "😀".repeat(301), ` ${"가".repeat(301)} `, 42, null, undefined, ["x"]]) {
      expectNoWrite(s.addMoment(bad), "invalid_input", `add ${JSON.stringify(bad)?.slice(0, 20)}`);
    }
    expect(storage.sets, "no setItem for invalid input").toBe(sets);
    expect(storage.raw()).toBe(before);
    const max = ok(s.addMoment("a".repeat(300)));
    expect(momentsOf(max, "2026-11-04").some((m) => m.text === "a".repeat(300))).toBe(true);
    const astral = ok(s.addMoment(` ${"😀".repeat(300)} `));
    expect(momentsOf(astral, "2026-11-04").some((m) => m.text === "😀".repeat(300)), "300 astral code points").toBe(true);
    const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>&amp;';
    const withXss = ok(s.addMoment(xss));
    expect(momentsOf(withXss, "2026-11-04").some((m) => m.text === xss), "user text stored as typed, not escaped").toBe(true);
  });

  it("updateMoment changes only that moment's text (id, time, order, other moments and days unchanged) and persists", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const c = clock("2026-11-02T00:00:00.000Z"); // 11-02 09:00
    const s = api.createPreviewStore(storage, c.now);
    ok(s.addMoment("지난 날"));
    c.set(T0);
    ok(s.addMoment("하나"));
    c.set("2026-11-04T01:00:00.000Z");
    ok(s.addMoment("둘"));
    c.set("2026-11-04T02:00:00.000Z");
    const base = ok(s.addMoment("셋"));
    const target = momentsOf(base, "2026-11-04").find((m) => m.text === "둘")!;
    c.set("2026-11-04T09:00:00.000Z"); // 수정 시각이 바뀌어도 원래 시각 유지
    const after = ok(s.updateMoment("2026-11-04", target.id, "  둘(고침)  "));
    expect(momentsOf(after, "2026-11-04")).toEqual(
      momentsOf(base, "2026-11-04").map((m) => (m.id === target.id ? { ...m, text: "둘(고침)" } : m)),
    );
    expect(dayOf(after, "2026-11-02")).toEqual(dayOf(base, "2026-11-02"));
    expect(after.font).toBe(base.font);
    expect(reread(api, storage)).toEqual(after);
    // 이전 날짜의 조각도 고칠 수 있다
    const old = momentsOf(after, "2026-11-02")[0]!;
    const fixed = ok(s.updateMoment("2026-11-02", old.id, "지난 날(고침)"));
    expect(momentsOf(fixed, "2026-11-02")).toEqual([{ ...old, text: "지난 날(고침)" }]);
    expect(momentsOf(fixed, "2026-11-04")).toEqual(momentsOf(after, "2026-11-04"));
  });

  it("updateMoment / removeMoment reject invalid text, invalid dates and unknown targets without writing", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    const base = ok(s.addMoment("그대로"));
    const id = momentsOf(base, "2026-11-04")[0]!.id;
    const raw = storage.raw();
    const sets = storage.sets;
    for (const bad of ["", "  ", "a".repeat(301), 1]) {
      expectNoWrite(s.updateMoment("2026-11-04", id, bad), "invalid_input", `update text ${String(bad).slice(0, 8)}`);
    }
    for (const date of ["2026-02-30", "2026-13-01", "26-11-04", "2026-11-4", "2026/11/04", " 2026-11-04", "", 20261104, null]) {
      expectNoWrite(s.updateMoment(date, id, "x"), "invalid_input", `update date ${String(date)}`);
      expectNoWrite(s.removeMoment(date, id), "invalid_input", `remove date ${String(date)}`);
    }
    for (const [date, mid] of [
      ["2026-11-03", id],
      ["2026-11-04", "no-such-id"],
      ["2026-11-04", ""],
    ] as const) {
      expectNoWrite(s.updateMoment(date, mid, "x"), "not_found", `update ${date}/${mid}`);
      expectNoWrite(s.removeMoment(date, mid), "not_found", `remove ${date}/${mid}`);
    }
    expect(storage.sets, "no setItem").toBe(sets);
    expect(storage.raw()).toBe(raw);
  });

  it("removeMoment removes only the target; a day that still has a summary is kept", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const c = clock(T0);
    const s = api.createPreviewStore(storage, c.now);
    ok(s.addMoment("남길 것"));
    c.set("2026-11-04T01:00:00.000Z");
    ok(s.addMoment("지울 것"));
    c.set("2026-11-04T02:00:00.000Z");
    const base = ok(s.addMoment("남길 것 2"));
    const victim = momentsOf(base, "2026-11-04").find((m) => m.text === "지울 것")!;
    const after = ok(s.removeMoment("2026-11-04", victim.id));
    expect(momentsOf(after, "2026-11-04")).toEqual(momentsOf(base, "2026-11-04").filter((m) => m.id !== victim.id));
    expect(reread(api, storage)).toEqual(after);
    expect(s.removeMoment("2026-11-04", victim.id), "already removed").toEqual({ ok: false, error: "not_found" });
    // 하루 한 줄이 있는 날의 마지막 조각을 지워도 그날 한 줄은 남는다
    ok(s.setSummary("2026-11-04", "한 줄은 남는다"));
    let cur = reread(api, storage);
    for (const m of momentsOf(cur, "2026-11-04")) cur = ok(s.removeMoment("2026-11-04", m.id));
    expect(dayOf(reread(api, storage), "2026-11-04")).toEqual({ date: "2026-11-04", summary: "한 줄은 남는다", moments: [] });
  });
});

// ================================================================= 하루 한 줄·글꼴

describe("setSummary / setFont", () => {
  it("summary is trimmed 0..300 code points, empty clears it, summary-only dates are kept; invalid input writes nothing", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    ok(s.addMoment("조각"));
    const set = ok(s.setSummary("2026-11-04", "  오늘은 맑았다  "));
    expect(dayOf(set, "2026-11-04")?.summary).toBe("오늘은 맑았다");
    expect(momentsOf(set, "2026-11-04")).toHaveLength(1);
    const only = ok(s.setSummary("2026-10-30", "조각 없이 한 줄만"));
    expect(dayOf(only, "2026-10-30")).toEqual({ date: "2026-10-30", summary: "조각 없이 한 줄만", moments: [] });
    expect(dayOf(reread(api, storage), "2026-10-30")?.summary, "summary-only day survives reload").toBe("조각 없이 한 줄만");
    const max = ok(s.setSummary("2026-11-04", "😀".repeat(300)));
    expect(dayOf(max, "2026-11-04")?.summary).toBe("😀".repeat(300));
    const raw = storage.raw();
    const sets = storage.sets;
    for (const bad of ["a".repeat(301), "😀".repeat(301), 3, null]) {
      expectNoWrite(s.setSummary("2026-11-04", bad), "invalid_input", `summary ${String(bad).slice(0, 6)}`);
    }
    for (const date of ["2026-02-29", "2026-00-10", "2026-11-31", "2026-11-04T00:00", "", undefined]) {
      expectNoWrite(s.setSummary(date, "x"), "invalid_input", `summary date ${String(date)}`);
    }
    expect(storage.sets).toBe(sets);
    expect(storage.raw()).toBe(raw);
    const cleared = ok(s.setSummary("2026-11-04", "   "));
    expect(dayOf(cleared, "2026-11-04")).toMatchObject({ summary: "", moments: momentsOf(max, "2026-11-04") });
    const clearedOnly = ok(s.setSummary("2026-10-30", ""));
    expect(dayOf(clearedOnly, "2026-10-30")?.summary ?? "", "cleared summary-only day").toBe("");
    expect(reread(api, storage)).toEqual(clearedOnly);
  });

  it("font accepts exactly gothic/serif/hand and persists; anything else writes nothing", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    ok(s.addMoment("글꼴과 무관한 조각"));
    for (const f of ["serif", "hand", "gothic", "hand"] as const) {
      const r = ok(s.setFont(f));
      expect(r.font).toBe(f);
      expect(reread(api, storage).font, `${f} after reload`).toBe(f);
    }
    const raw = storage.raw();
    for (const bad of ["Gothic", "mono", "", " serif", null, 1]) {
      expectNoWrite(s.setFont(bad), "invalid_input", `font ${String(bad)}`);
    }
    expect(storage.raw()).toBe(raw);
    expect(momentsOf(reread(api, storage), "2026-11-04").map((m) => m.text)).toEqual(["글꼴과 무관한 조각"]);
  });
});

// ================================================================= 손상·저장소 실패

describe("corrupt data is never overwritten or deleted automatically", () => {
  const CORRUPT: [string, string][] = [
    ["not JSON", "{not json"],
    ["JSON null", "null"],
    ["array", "[]"],
    ["unknown version", JSON.stringify({ v: 2, font: "gothic", days: [] })],
    ["unknown font", JSON.stringify({ v: 1, font: "mono", days: [] })],
    ["days not array", JSON.stringify({ v: 1, font: "gothic", days: {} })],
    ["invalid date", JSON.stringify({ v: 1, font: "gothic", days: [{ date: "2026-02-30", summary: "", moments: [] }] })],
    ["moment missing text", JSON.stringify({ v: 1, font: "gothic", days: [{ date: "2026-11-04", summary: "", moments: [{ id: "a", time: "09:00" }] }] })],
  ];

  it("read and every write return corrupt_data with no setItem/removeItem; export returns the raw text for safekeeping", async () => {
    const api = await loadStore();
    for (const [label, raw] of CORRUPT) {
      const storage = new FakeStorage();
      storage.map.set(KEY, raw);
      const s = api.createPreviewStore(storage, () => new Date(T0));
      const corrupt = { ok: false, error: "corrupt_data" };
      expect(s.read(), `${label} read`).toEqual(corrupt);
      expect(s.addMoment("새 조각"), `${label} add`).toEqual(corrupt);
      expect(s.updateMoment("2026-11-04", "a", "x"), `${label} update`).toEqual(corrupt);
      expect(s.removeMoment("2026-11-04", "a"), `${label} remove`).toEqual(corrupt);
      expect(s.setSummary("2026-11-04", "x"), `${label} summary`).toEqual(corrupt);
      expect(s.setFont("serif"), `${label} font`).toEqual(corrupt);
      expect(storage.sets, `${label}: no setItem`).toBe(0);
      expect(storage.removes, `${label}: no removeItem`).toBe(0);
      expect(storage.raw(), `${label}: raw kept`).toBe(raw);
      expect(s.exportJSON(), `${label} export raw`).toEqual({ ok: true, value: raw });
      expectOtherKeysKept(storage);
    }
  });
});

describe("storage failures are reported and never turned into success", () => {
  it("getItem throwing → storage_error for read, writes and export; nothing is written", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    ok(s.addMoment("남아 있어야 함"));
    const raw = storage.raw();
    const sets = storage.sets;
    storage.failGet = true;
    const err = { ok: false, error: "storage_error" };
    expect(s.read()).toEqual(err);
    expect(s.addMoment("x")).toEqual(err);
    expect(s.setSummary("2026-11-04", "x")).toEqual(err);
    expect(s.setFont("serif")).toEqual(err);
    expect(s.exportJSON()).toEqual(err);
    expect(storage.sets).toBe(sets);
    storage.failGet = false;
    expect(storage.raw()).toBe(raw);
  });

  it("setItem throwing → storage_error and the stored record stays as it was (no false success)", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    const base = ok(s.addMoment("원래 글"));
    const id = momentsOf(base, "2026-11-04")[0]!.id;
    storage.failSet = true;
    const err = { ok: false, error: "storage_error" };
    expect(s.addMoment("저장 안 될 글")).toEqual(err);
    expect(s.updateMoment("2026-11-04", id, "바뀌면 안 됨")).toEqual(err);
    expect(s.removeMoment("2026-11-04", id)).toEqual(err);
    expect(s.setSummary("2026-11-04", "안 됨")).toEqual(err);
    expect(s.setFont("hand")).toEqual(err);
    storage.failSet = false;
    expect(s.read(), "same instance still sees the stored record").toEqual({ ok: true, value: base });
    expect(reread(api, storage), "new instance sees the stored record").toEqual(base);
    // 저장소가 회복되면 같은 입력을 다시 저장할 수 있다
    expect(momentsOf(ok(s.addMoment("저장 안 될 글")), "2026-11-04").map((m) => m.text)).toEqual(["원래 글", "저장 안 될 글"]);
  });

  it("clear removes only the dedicated key; removeItem throwing → storage_error and the record stays", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    const base = ok(s.addMoment("지우기 전"));
    storage.failRemove = true;
    expect(s.clear()).toEqual({ ok: false, error: "storage_error" });
    expect(reread(api, storage)).toEqual(base);
    storage.failRemove = false;
    expect(s.clear()).toEqual({ ok: true, value: EMPTY });
    expect(storage.raw()).toBeNull();
    expectOtherKeysKept(storage);
    expect(reread(api, storage)).toEqual(EMPTY);
  });

  it("exportJSON returns the stored snapshot as JSON", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const s = api.createPreviewStore(storage, () => new Date(T0));
    ok(s.addMoment("내려받을 조각"));
    ok(s.setSummary("2026-11-04", "내려받을 한 줄"));
    const snap = ok(s.setFont("serif"));
    expect(JSON.parse(ok(s.exportJSON()))).toEqual(snap);
  });
});

// ================================================================= 인스턴스 간

describe("two store instances on the same storage (sequential, no multi-tab atomicity claimed)", () => {
  it("each write re-reads the latest stored value so unrelated changes from the other instance are not overwritten", async () => {
    const api = await loadStore();
    const storage = new FakeStorage();
    const c = clock(T0);
    const a = api.createPreviewStore(storage, c.now);
    const b = api.createPreviewStore(storage, c.now);
    expect(ok(a.read())).toEqual(EMPTY);
    expect(ok(b.read())).toEqual(EMPTY);
    const afterA = ok(a.addMoment("A의 조각"));
    const aId = momentsOf(afterA, "2026-11-04")[0]!.id;
    c.set("2026-11-04T01:00:00.000Z");
    const afterB = ok(b.addMoment("B의 조각"));
    expect(momentsOf(afterB, "2026-11-04").map((m) => m.text)).toEqual(["A의 조각", "B의 조각"]);
    ok(b.setFont("hand"));
    ok(a.setSummary("2026-11-04", "A의 한 줄"));
    const afterUpd = ok(a.updateMoment("2026-11-04", aId, "A의 조각(고침)"));
    expect(afterUpd.font, "A did not revert B's font").toBe("hand");
    expect(momentsOf(afterUpd, "2026-11-04").map((m) => m.text)).toEqual(["A의 조각(고침)", "B의 조각"]);
    const bView = ok(b.read());
    expect(bView).toEqual(afterUpd);
    expect(dayOf(bView, "2026-11-04")?.summary).toBe("A의 한 줄");
    expect(reread(api, storage)).toEqual(afterUpd);
  });
});
