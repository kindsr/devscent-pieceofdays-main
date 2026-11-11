// PLAN_ai-daily-story-storage §1·§2 S1 RED(단위). DB·네트워크·키·실제 API 0. 가짜 Db 객체와 mock만 쓴다.
// 새 제품 모듈은 절대경로 변수로 동적 import하고, 먼저 existsSync와 named export를 명시 단언한다
// (정적 import가 없어 제품 부재가 TS2307/import 오류가 아니라 assert 실패로 드러난다).
// 이미 있는 실행기(migrate.ts)만 정적으로 import한다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_DATA_TABLES } from "@/server/db/migrate";

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type Subject = { userId: string; gen: number };
type Ref = { id: string; version: number };
type StoryMoment = Ref & { time: string; text: string };
type StoryInput = { date: string; revision: string; moments: StoryMoment[] };
type Payload = { date: string; moments: { time: string; text: string }[] };
type Generator = { generate: (input: Payload, signal: AbortSignal) => Promise<Result<{ body: string }, string>> };
type GenerateArgs = { date: string; expectedInputRevision: string | null };
type Generate = (db: unknown, generator: Generator | null, subject: Subject, args: GenerateArgs, opts?: { now?: () => Date }) => Promise<Result<unknown, string>>;
type Read = (db: unknown, subject: Subject, date: string) => Promise<Result<unknown, string>>;

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SHARED = path.join(APP_DIR, "src", "shared", "stories.ts");
const DIR = path.join(APP_DIR, "src", "server", "stories");
const INPUT = path.join(DIR, "input.pg.ts");
const STORE = path.join(DIR, "store.pg.ts");
const GENERATOR = path.join(DIR, "generator.ts");
const GENERATE = path.join(DIR, "generate.ts");
const READ = path.join(DIR, "read.ts");
const SERVER_MODULES = [INPUT, STORE, GENERATOR, GENERATE, READ] as const;

/** 파일 존재 → 동적 import → 이름별 export 종류를 순서대로 단언한다. */
async function load(file: string, exports: Record<string, "function" | "number">): Promise<Record<string, unknown>> {
  const rel = path.relative(APP_DIR, file);
  expect(existsSync(file), `${rel} must exist (PLAN_ai-daily-story-storage §1)`).toBe(true);
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  for (const [name, kind] of Object.entries(exports)) expect(typeof mod[name], `${rel} must export ${kind} ${name}`).toBe(kind);
  return mod;
}

const loadInput = async () => {
  const mod = await load(INPUT, { storyRevision: "function", storyPayload: "function", captureStoryInput: "function" });
  return mod as unknown as { storyRevision: (date: string, refs: readonly Ref[]) => string; storyPayload: (input: StoryInput) => Payload };
};
const loadGenerate = async () => {
  const mod = await load(GENERATE, { generateDailyStory: "function", STORY_GENERATE_TIMEOUT_MS: "number" });
  return mod as unknown as { generateDailyStory: Generate; STORY_GENERATE_TIMEOUT_MS: number };
};
const loadRead = async () => (await load(READ, { readStoryDay: "function" })).readStoryDay as Read;

/** 주석을 지운 소스(문장 속 단어가 아니라 실제 코드만 검사한다). */
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push((m[1] ?? m[2] ?? m[3])!);
  }
  return out;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** 계획 §2 공식의 독립 계산: sha256("v1\n" + date + "\n" + id 오름차순 `${id}:${version}\n`). */
function oracle(date: string, refs: readonly Ref[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return sha256(`v1\n${date}\n${lines.join("")}`);
}

const ID_A = "0190f0a0-0000-7000-8000-00000000000a";
const ID_B = "0190f0a0-0000-7000-8000-00000000000b";
const ID_C = "0190f0a0-0000-7000-8000-00000000000c";
const USER = "0190f0a0-0000-7000-8000-0000000000ff";
const DAY = "2026-11-09";
const REV = "a".repeat(64);

/** SQL을 보내면 안 되는 단계용 가짜 Db. 호출되면 기록만 남기고 거부한다. */
function noSqlDb() {
  const query = vi.fn(async () => { throw new Error("ci-only: SQL must not run before input validation"); });
  const connect = vi.fn(async () => { throw new Error("ci-only: no connection before input validation"); });
  return { db: { query, connect }, query, connect };
}
function expectNoSql(fake: ReturnType<typeof noSqlDb>) {
  expect(fake.query, "no SQL before validation").not.toHaveBeenCalled();
  expect(fake.connect, "no connection before validation").not.toHaveBeenCalled();
}
function mockGenerator() {
  return { generate: vi.fn(async () => ({ ok: true as const, value: { body: "합성 이야기" } })) };
}
const at = (iso: string) => () => new Date(iso);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- 파일·경계

describe("daily story S1 files and boundaries", () => {
  it("shared/stories.ts exports the exact S1 limits and imports no server module", async () => {
    const mod = await load(SHARED, {
      STORY_INPUT_MAX_MOMENTS: "number", STORY_TEXT_MAX: "number", STORY_INPUT_MAX_BYTES: "number", STORY_MAX: "number",
    });
    expect({
      STORY_INPUT_MAX_MOMENTS: mod.STORY_INPUT_MAX_MOMENTS, STORY_TEXT_MAX: mod.STORY_TEXT_MAX,
      STORY_INPUT_MAX_BYTES: mod.STORY_INPUT_MAX_BYTES, STORY_MAX: mod.STORY_MAX,
    }).toEqual({ STORY_INPUT_MAX_MOMENTS: 30, STORY_TEXT_MAX: 300, STORY_INPUT_MAX_BYTES: 48 * 1024, STORY_MAX: 2000 });
    const specs = importSpecifiers(code(SHARED));
    expect(specs.filter((s) => /server/.test(s)), "shared must not import server modules or server-only").toEqual([]);
  });

  it("every new server module is server-only and reads no env, key, fetch, Claude adapter, photo or blob module", () => {
    for (const file of SERVER_MODULES) {
      const rel = path.relative(APP_DIR, file);
      expect(existsSync(file), `${rel} must exist (PLAN §1)`).toBe(true);
      const source = code(file);
      const specs = importSpecifiers(source);
      expect(specs, `${rel} imports server-only`).toContain("server-only");
      expect(specs.filter((s) => /claude|anthropic|photos|blob/i.test(s)), `${rel} forbidden imports`).toEqual([]);
      expect(source, `${rel} must not read process.env`).not.toMatch(/\bprocess\s*\.\s*env\b/);
      expect(source, `${rel} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("getStoryGenerator stays closed (null) even with a fake key configured, and importing every module makes no network call", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("ci-only: network is forbidden"); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("ANTHROPIC_API_KEY", `sk-ant-api03-ci-only-fake-${"x".repeat(40)}`);
    vi.stubEnv("POD_STORY_PROVIDER", "claude");
    const gen = await load(GENERATOR, { getStoryGenerator: "function" });
    expect((gen.getStoryGenerator as () => unknown)()).toBeNull();
    await load(INPUT, { storyRevision: "function", storyPayload: "function", captureStoryInput: "function" });
    await load(STORE, { findLatestStory: "function", findStoryByRevision: "function", appendStoryVersion: "function" });
    await load(GENERATE, { generateDailyStory: "function", STORY_GENERATE_TIMEOUT_MS: "number" });
    await load(READ, { readStoryDay: "function" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the migration runner protects story_versions and the three 0006 story generation tables as user data (fifteen tables)", () => {
    const existing = [
      "users", "auth_identities", "preferences", "diary_moments", "day_summaries", "design_versions",
      "credit_accounts", "emotion_ledger", "photo_uploads", "moment_photos", "photo_deletions",
    ];
    expect([...USER_DATA_TABLES].sort()).toEqual([...existing, "story_versions", "story_ai_settings", "story_jobs", "story_usage"].sort());
    expect(USER_DATA_TABLES).toHaveLength(15);
  });
});

// ---------------------------------------------------------------- revision·payload

describe("storyRevision", () => {
  it("is sha256 of v1, date and id-ascending id:version lines, independent of caller order and without mutating it", async () => {
    const { storyRevision } = await loadInput();
    const refs = Object.freeze([
      Object.freeze({ id: ID_C, version: 2 }), Object.freeze({ id: ID_A, version: 1 }), Object.freeze({ id: ID_B, version: 7 }),
    ]);
    const copy = JSON.parse(JSON.stringify(refs)) as Ref[];
    const rev = storyRevision(DAY, refs);
    expect(rev).toBe(sha256(`v1\n${DAY}\n${ID_A}:1\n${ID_B}:7\n${ID_C}:2\n`));
    expect(rev).toBe(oracle(DAY, refs));
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
    expect(refs).toEqual(copy);
    expect(storyRevision(DAY, [refs[1]!, refs[2]!, refs[0]!])).toBe(rev);
    expect(storyRevision(DAY, [])).toBe(sha256(`v1\n${DAY}\n`));
  });

  it("changes when the date, any id, any version, an added ref or a removed ref changes", async () => {
    const { storyRevision } = await loadInput();
    const base = [{ id: ID_A, version: 1 }, { id: ID_B, version: 1 }];
    const rev = storyRevision(DAY, base);
    const variants: [string, string, Ref[]][] = [
      ["date", "2026-11-10", base],
      ["id", DAY, [{ id: ID_C, version: 1 }, { id: ID_B, version: 1 }]],
      ["version", DAY, [{ id: ID_A, version: 2 }, { id: ID_B, version: 1 }]],
      ["added", DAY, [...base, { id: ID_C, version: 1 }]],
      ["removed", DAY, [base[0]!]],
    ];
    const seen = new Set([rev]);
    for (const [label, date, refs] of variants) {
      const next = storyRevision(date, refs);
      expect(next, label).toBe(oracle(date, refs));
      expect(seen.has(next), `${label} must produce a new revision`).toBe(false);
      seen.add(next);
    }
  });
});

describe("storyPayload", () => {
  it("copies only date and ordered {time,text} into fresh plain objects without identifiers or photo data", async () => {
    const { storyPayload } = await loadInput();
    const input = {
      date: DAY,
      revision: REV,
      moments: [
        Object.assign({ id: ID_B, version: 3, time: "00:00", text: "자정 직후\n\t둘째 줄" }, { photoId: ID_C, userId: USER }),
        { id: ID_A, version: 1, time: "23:59", text: "  하루 끝  " },
      ],
    } as StoryInput;
    const before = JSON.parse(JSON.stringify(input)) as unknown;
    const out = storyPayload(input);
    expect(out).toStrictEqual({ date: DAY, moments: [{ time: "00:00", text: "자정 직후\n\t둘째 줄" }, { time: "23:59", text: "  하루 끝  " }] });
    expect(Object.keys(out).sort()).toEqual(["date", "moments"]);
    for (const m of out.moments) expect(Object.keys(m).sort()).toEqual(["text", "time"]);
    expect(out.moments).not.toBe(input.moments);
    expect(out.moments[0]).not.toBe(input.moments[0]);
    const text = JSON.stringify(out);
    for (const secret of [REV, ID_A, ID_B, ID_C, USER]) expect(text.includes(secret), `payload leaks ${secret}`).toBe(false);
    out.moments[0]!.text = "변경";
    out.moments.push({ time: "12:00", text: "추가" });
    expect(input).toEqual(before);
  });
});

// ---------------------------------------------------------------- SQL 전 입력 검사

describe("generateDailyStory and readStoryDay validate before SQL", () => {
  const NOW = at("2026-11-11T14:59:59.999Z"); // 서울 2026-11-11 23:59:59.999
  const good: Subject = { userId: USER, gen: 1 };

  it("exports the 20-second generation timeout", async () => {
    expect((await loadGenerate()).STORY_GENERATE_TIMEOUT_MS).toBe(20_000);
  });

  it("rejects malformed subjects with not_signed_in before date or revision checks, SQL or the generator", async () => {
    const { generateDailyStory } = await loadGenerate();
    const subjects: Subject[] = [
      { userId: "not-a-uuid", gen: 1 }, { userId: "", gen: 1 }, { userId: USER, gen: 0 }, { userId: USER, gen: -1 },
      { userId: USER, gen: 1.5 }, { userId: USER, gen: Number.MAX_SAFE_INTEGER + 1 }, { userId: USER, gen: Number.NaN },
    ];
    for (const subject of subjects) {
      const fake = noSqlDb();
      const generator = mockGenerator();
      const r = await generateDailyStory(fake.db, generator, subject, { date: "2026-02-30", expectedInputRevision: "BAD" }, { now: NOW });
      expect(r, JSON.stringify(subject)).toEqual({ ok: false, error: "not_signed_in" });
      expectNoSql(fake);
      expect(generator.generate).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed and future Seoul dates with invalid_date before the revision check and SQL, but accepts Seoul today", async () => {
    const { generateDailyStory } = await loadGenerate();
    const dates = ["2026-02-30", "2026-13-01", "2026-1-09", "20261109", "2026-11-09T00:00", " 2026-11-09", "", "0000-01-01", "2026-11-12"];
    for (const date of dates) {
      const fake = noSqlDb();
      const generator = mockGenerator();
      const r = await generateDailyStory(fake.db, generator, good, { date, expectedInputRevision: "BAD" }, { now: NOW });
      expect(r, `date ${JSON.stringify(date)}`).toEqual({ ok: false, error: "invalid_date" });
      expectNoSql(fake);
      expect(generator.generate).not.toHaveBeenCalled();
    }
    // 서울 자정이 지나면(15:00Z) 2026-11-12가 오늘이므로 날짜 검사를 통과해 계정 확인 SQL로 넘어간다.
    const fake = noSqlDb();
    const r = await generateDailyStory(fake.db, null, good, { date: "2026-11-12", expectedInputRevision: null }, { now: at("2026-11-11T15:00:00.000Z") })
      .catch((err: unknown) => ({ thrown: err }));
    expect(r).not.toEqual({ ok: false, error: "invalid_date" });
    expect(fake.query.mock.calls.length + fake.connect.mock.calls.length, "Seoul today proceeds to the account check").toBeGreaterThan(0);
  });

  it("rejects a malformed expectedInputRevision with conflict before SQL or the generator", async () => {
    const { generateDailyStory } = await loadGenerate();
    for (const expected of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(64)}\n`, ""]) {
      const fake = noSqlDb();
      const generator = mockGenerator();
      const r = await generateDailyStory(fake.db, generator, good, { date: DAY, expectedInputRevision: expected }, { now: NOW });
      expect(r, `revision ${JSON.stringify(expected)}`).toEqual({ ok: false, error: "conflict" });
      expectNoSql(fake);
      expect(generator.generate).not.toHaveBeenCalled();
    }
  });

  it("readStoryDay returns not_signed_in, then invalid_date, before SQL and rethrows unexpected DB errors", async () => {
    const readStoryDay = await loadRead();
    for (const [subject, date, error] of [
      [{ userId: "x", gen: 1 }, "2026-02-30", "not_signed_in"],
      [{ userId: USER, gen: 0 }, DAY, "not_signed_in"],
      [good, "2026-02-30", "invalid_date"],
      [good, "2026-11-9", "invalid_date"],
    ] as const) {
      const fake = noSqlDb();
      expect(await readStoryDay(fake.db, subject, date), `${JSON.stringify(subject)} ${date}`).toEqual({ ok: false, error });
      expectNoSql(fake);
    }
    const broken = noSqlDb();
    await expect(readStoryDay(broken.db, good, DAY), "unexpected DB errors are thrown, not returned as a story state").rejects.toBeDefined();
  });
});
