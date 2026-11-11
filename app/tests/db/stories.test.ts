// PLAN_ai-daily-story-storage §1~§3 S1 RED(DB). 일회용 PG18·app role·owner/purge 하네스만 쓴다. 실제 API·키·서비스 DB 0.
// - 생성기는 주입한 mock만 쓴다(성공 mock은 시험 안에만 있다). 제품 getStoryGenerator()는 단위 시험에서 null로 확인한다.
// - 모든 사례는 먼저 기존 하네스가 0001~0004를 적용했는지 확인한 뒤, 0005 파일 existsSync·적용 기록·
//   to_regclass('pod.story_versions')를 명시 단언한다. 제품 TS 모듈은 existsSync 뒤 변수 경로로 동적 import한다.
//   (제품 부재는 TS2307/import 오류가 아니라 이 단언의 실패로 드러난다.)
// - 날짜는 고정 과거 날짜이며 생성의 '오늘'은 opts.now로 주입한다(실제 현재 시각에 기대는 시한폭탄 없음).
// - 20초 시한은 setTimeout만 가짜로 두고 AbortSignal.timeout을 그 시계에 묶어 정확한 시각만 진행한다(vi.waitFor 금지).
// - 이 파일 안의 도우미만 새로 둔다. 공통 helper·global setup·fixture는 import만 한다.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CI_ROLES, cleanupAll, closeClient, createDisposableDatabase, openClient, readDisposableEnv, withAdmin,
  type DisposableDatabase, type HarnessEnv,
} from "./helpers";
import {
  APP_DIR, PRODUCT_MIGRATIONS_DIR, USER_DATA_TABLES, cleanupTempDirs, expectCliFail, expectCliOk, expectSqlError,
  makeMigrationsDir, readMigrationRows, relationExists, runMigrateCli, schemaSnapshot, withApp, withOwner,
} from "./f2-support";
import { UUID_RE, appBackend, endAllPools, expectLedgerInvariants, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { MISSING_UUID, loadCreatePgDiaryStore, okValue } from "./f3-diary-support";
import { loadLifecycle, openOwner, seedUser, setPending } from "./f4-lifecycle-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §2)

type Subject = { userId: string; gen: number };
type StoryRef = { id: string; version: number; body: string; createdAt: string };
type StoredStory = StoryRef & { sourceRevision: string };
type StoryDay = { date: string; inputRevision: string | null; story: StoryRef | null; state: "none" | "current" | "outdated"; generation: "unavailable" };
type StoryMoment = { id: string; version: number; time: string; text: string };
type StoryInput = { date: string; revision: string; moments: StoryMoment[] };
type Payload = { date: string; moments: { time: string; text: string }[] };
type StoryError = "invalid_date" | "not_signed_in" | "no_input" | "input_too_large" | "invalid_input" | "conflict" | "unavailable" | "timeout" | "invalid_output";
type GenResult = Result<{ body: string }, "unavailable" | "timeout" | "invalid_output">;
type Generator = { generate: (input: Payload, signal: AbortSignal) => Promise<GenResult> };
type Generated = Result<{ story: StoryRef; replayed: boolean }, StoryError>;
type Api = {
  storyRevision: (date: string, refs: readonly { id: string; version: number }[]) => string;
  captureStoryInput: (db: Pick<pg.Pool, "query">, userId: string, date: string) => Promise<Result<StoryInput, "invalid_date" | "no_input" | "input_too_large" | "invalid_input">>;
  findLatestStory: (db: Pick<pg.Pool, "query">, userId: string, date: string) => Promise<StoredStory | null>;
  findStoryByRevision: (db: Pick<pg.Pool, "query">, userId: string, date: string, revision: string) => Promise<StoryRef | null>;
  appendStoryVersion: (db: pg.Pool, subject: Subject, date: string, revision: string, body: string) => Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in">>;
  getStoryGenerator: () => Generator | null;
  generateDailyStory: (db: pg.Pool, generator: Generator | null, subject: Subject, args: { date: string; expectedInputRevision: string | null }, opts?: { now?: () => Date }) => Promise<Generated>;
  readStoryDay: (db: pg.Pool, subject: Subject, date: string) => Promise<Result<StoryDay, "invalid_date" | "not_signed_in">>;
  STORY_GENERATE_TIMEOUT_MS: number;
};

const SRC = path.join(APP_DIR, "src");
const MODULES: [string, string[]][] = [
  [path.join(SRC, "shared", "stories.ts"), []],
  [path.join(SRC, "server", "stories", "input.pg.ts"), ["storyRevision", "captureStoryInput"]],
  [path.join(SRC, "server", "stories", "store.pg.ts"), ["findLatestStory", "findStoryByRevision", "appendStoryVersion"]],
  [path.join(SRC, "server", "stories", "generator.ts"), ["getStoryGenerator"]],
  [path.join(SRC, "server", "stories", "generate.ts"), ["generateDailyStory"]],
  [path.join(SRC, "server", "stories", "read.ts"), ["readStoryDay"]],
];
const STORY_UP = path.join(PRODUCT_MIGRATIONS_DIR, "0005_daily_stories.up.sql");
const STORY_DOWN = path.join(PRODUCT_MIGRATIONS_DIR, "0005_daily_stories.down.sql");
const BASE_MIGRATIONS = [[1, "init"], [2, "account_lifecycle"], [3, "reflection_time"], [4, "private_photos"]];
const BASE_FILES = ["0001_init", "0002_account_lifecycle", "0003_reflection_time", "0004_private_photos"];
// 공통 helper 목록(story_versions 포함 12)과 같게, 중복 없이 12표로 둔다.
const TWELVE = [...new Set<string>([...USER_DATA_TABLES, "story_versions"])].sort();

const DAY = "2026-11-09";
const NOW = () => new Date("2026-11-09T12:00:00.000Z"); // 서울 2026-11-09 21:00(주입 시계)
const STORY = "합성 메모로 만든 하루 이야기.";
const LEAK = "ci-only-story-upstream-detail-must-not-leak";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const R1 = sha256("ci-only-revision-1");
const R2 = sha256("ci-only-revision-2");
const R3 = sha256("ci-only-revision-3");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

let env: HarnessEnv;
beforeAll(() => { env = readDisposableEnv(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  try { await endAllPools(); await cleanupTempDirs(); } finally { if (env) await cleanupAll(env); }
});

// ---------------------------------------------------------------- 이 파일 전용 도우미

async function loadStories(): Promise<Api> {
  const out: Record<string, unknown> = {};
  for (const [file, names] of MODULES) {
    const rel = path.relative(APP_DIR, file);
    expect(existsSync(file), `${rel} must exist (PLAN_ai-daily-story-storage §1)`).toBe(true);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const name of names) {
      expect(typeof mod[name], `${rel} must export function ${name}`).toBe("function");
      out[name] = mod[name];
    }
    if (rel.endsWith("generate.ts")) {
      expect(mod.STORY_GENERATE_TIMEOUT_MS, `${rel} must export STORY_GENERATE_TIMEOUT_MS`).toBe(20_000);
      out.STORY_GENERATE_TIMEOUT_MS = mod.STORY_GENERATE_TIMEOUT_MS;
    }
  }
  return out as unknown as Api;
}

/** 기존 하네스가 0001~0004를 적용했는지 먼저 확인하고, 그 뒤 0005 파일·기록·표를 각각 명시 단언한다. */
async function expectStoriesApplied(db: DisposableDatabase): Promise<void> {
  const rows = await withOwner(env, db, (c) => readMigrationRows(c));
  const pairs = (rows ?? []).map((r) => [r.version, r.name]);
  expect(pairs.slice(0, 4), "the existing harness migrates the 0001~0004 chain").toEqual(BASE_MIGRATIONS);
  for (const file of [STORY_UP, STORY_DOWN]) {
    expect(existsSync(file), `${path.relative(APP_DIR, file)} must exist (PLAN §1)`).toBe(true);
  }
  expect(pairs, "the default up must apply 0005_daily_stories").toEqual([...BASE_MIGRATIONS, [5, "daily_stories"]]);
  expect(await withOwner(env, db, (c) => relationExists(c, "pod.story_versions")), "to_regclass('pod.story_versions') IS NOT NULL").toBe(true);
}

async function withStories(label: string, fn: (api: Api, pool: pg.Pool, db: DisposableDatabase) => Promise<void>, poolMax = 2): Promise<void> {
  const db = await freshMigratedDb(env, label);
  await expectStoriesApplied(db);
  const api = await loadStories();
  const pool = openAppPool(db, poolMax);
  try {
    await appBackend(pool);
    await fn(api, pool, db);
    await expectLedgerInvariants(env, db);
  } finally {
    await endAllPools();
  }
}

type Seed = { at: string; body: string; date?: string; id?: string };
async function seedMoments(db: DisposableDatabase, userId: string, seeds: Seed[]): Promise<void> {
  await withOwner(env, db, async (c) => {
    for (const s of seeds) {
      await c.query(
        `INSERT INTO pod.diary_moments (id, user_id, local_date, occurred_at, body)
         VALUES (COALESCE($1::uuid, uuidv7()), $2::uuid, $3::date, $4::timestamptz, $5)`,
        [s.id ?? null, userId, s.date ?? DAY, s.at, s.body],
      );
    }
  });
}
/** 같은 날 n개의 유효 조각(서울 08:00부터 1분 간격). */
const many = (n: number, prefix = "조각"): Seed[] =>
  Array.from({ length: n }, (_, i) => ({ at: `${DAY}T08:${String(i).padStart(2, "0")}:00+09:00`, body: `${prefix} ${i + 1}` }));

async function momentRefs(db: DisposableDatabase, userId: string, date = DAY): Promise<{ id: string; version: number }[]> {
  return withOwner(env, db, async (c) => (await c.query<{ id: string; version: number }>(
    "SELECT id::text AS id, version FROM pod.diary_moments WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY occurred_at, id",
    [userId, date],
  )).rows);
}
async function momentDump(db: DisposableDatabase): Promise<unknown[]> {
  return withOwner(env, db, async (c) => (await c.query(
    "SELECT id::text, user_id::text, local_date::text, occurred_at::text, body, version, updated_at::text FROM pod.diary_moments ORDER BY id",
  )).rows);
}

/** 계획 §2 revision 공식의 독립 계산. */
function oracle(date: string, refs: readonly { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return sha256(`v1\n${date}\n${lines.join("")}`);
}

type StoryRow = { id: string; local_date: string; version: number; source_revision: string; body: string; created_ms: number };
async function storyRows(db: DisposableDatabase, userId?: string): Promise<StoryRow[]> {
  return withOwner(env, db, async (c) => (await c.query<Omit<StoryRow, "created_ms"> & { created_ms: string }>(
    `SELECT id::text AS id, to_char(local_date, 'YYYY-MM-DD') AS local_date, version, source_revision, body,
            floor(extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms
       FROM pod.story_versions WHERE ($1::uuid IS NULL OR user_id = $1::uuid) ORDER BY user_id, local_date, version`,
    [userId ?? null],
  )).rows.map((r) => ({ ...r, created_ms: Number(r.created_ms) })));
}

/** StoryRef DTO가 정확히 네 필드이고 저장 행과 같은지(createdAt은 ISO 문자열, 1ms 이내). */
function expectRef(story: unknown, row: StoryRow | undefined, label = "story"): void {
  expect(row, `${label}: stored row exists`).toBeDefined();
  expect(story, `${label}: StoryRef`).toBeTypeOf("object");
  expect(Object.keys(story as object).sort(), `${label}: StoryRef keys`).toEqual(["body", "createdAt", "id", "version"]);
  const s = story as StoryRef;
  expect({ id: s.id, version: s.version, body: s.body }, label).toEqual({ id: row!.id, version: row!.version, body: row!.body });
  expect(s.id).toMatch(UUID_RE);
  expect(s.createdAt, `${label}: createdAt is an ISO 8601 string`).toMatch(ISO_RE);
  expect(Math.abs(Date.parse(s.createdAt) - row!.created_ms), `${label}: createdAt matches the row`).toBeLessThanOrEqual(1);
}

function okGen(body: unknown = STORY): GenResult {
  return { ok: true, value: { body } } as GenResult;
}
function generatorOf(impl: (input: Payload, signal: AbortSignal) => Promise<GenResult> | GenResult = () => okGen()) {
  const calls: { input: Payload; signal: AbortSignal; aborted: boolean }[] = [];
  const generate = vi.fn(async (input: Payload, signal: AbortSignal) => {
    calls.push({ input, signal, aborted: signal.aborted });
    return impl(input, signal);
  });
  return { generator: { generate } as Generator, generate, calls };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** 가짜 시계와 무관한 실제 시계로 제한한다. */
async function bounded<T>(promise: Promise<T>, label = "story test barrier", ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error(`${label} not reached within ${ms}ms`)), ms); })]);
  } finally { realClearTimeout(timer); }
}
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  void promise.then(() => (state.settled = true), () => (state.settled = true));
  return state;
}
/** setTimeout만 가짜로 두고 AbortSignal.timeout을 그 시계에 묶는다(claude-story·photo-routes 시험과 같은 방식). */
function fakeDeadlineClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), milliseconds);
    return deadline.signal;
  });
}

/** 이 DB에서 잠금 대기 중인 backend가 n개 이상이 될 때까지 기다린다(실제 시계 polling). */
async function waitLockWaiters(db: DisposableDatabase, n: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  await withAdmin(env, async (a) => {
    for (;;) {
      const r = await a.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
      );
      if ((r.rows[0]?.n ?? 0) >= n) return;
      if (Date.now() > until) throw new Error(`expected ${n} backends waiting on the user row lock`);
      await new Promise((res) => realSetTimeout(res, 25));
    }
  }, db.name);
}

/** 콘솔 출력 관찰(원문·stack 비노출 확인용). */
function captureConsole(): () => string {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  return () => spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "))).join("\n");
}

async function purgeNow(db: DisposableDatabase, userId: string): Promise<string> {
  const purge = await openClient(db.urls.purge, env.adminUrl);
  try { return (await purge.query<{ result: string }>("SELECT pod.purge_user_if_due($1) AS result", [userId])).rows[0]!.result; }
  finally { await closeClient(purge); }
}

const userCount = (db: DisposableDatabase, userId: string) =>
  withOwner(env, db, async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.users WHERE id = $1::uuid", [userId])).rows[0]!.n);

// ---------------------------------------------------------------- schema·권한·migration

describe("0005_daily_stories schema, privileges and down guard", () => {
  it("applies on an existing 0004 database adding only pod.story_versions and preserving users, moments, summaries and the ledger", async () => {
    const db = await createDisposableDatabase(env, "storyexpand");
    const files: Record<string, string> = {};
    for (const name of BASE_FILES) {
      for (const kind of ["up", "down"]) files[`${name}.${kind}.sql`] = await readFile(path.join(PRODUCT_MIGRATIONS_DIR, `${name}.${kind}.sql`), "utf8");
    }
    const baseOnly = await makeMigrationsDir(files);
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", baseOnly], db.urls.migrator), db.urls.migrator);
    const userId = await seedUser(env, db, [{ provider: "testprov", subject: `story-${randomUUID()}` }], { granted: true });
    await seedMoments(db, userId, many(2));
    await withOwner(env, db, (c) => c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, $2::date, '정리 한 줄')", [userId, DAY]));
    const data = (c: pg.Client) => Promise.all([
      c.query("SELECT id::text, status, auth_generation, first_login_at::text FROM pod.users ORDER BY id"),
      c.query("SELECT entry_id::text, user_id::text, delta, reason, grant_key FROM pod.emotion_ledger ORDER BY entry_id"),
      c.query("SELECT user_id::text, balance FROM pod.credit_accounts ORDER BY user_id"),
      c.query("SELECT user_id::text, local_date::text, body, version FROM pod.day_summaries ORDER BY user_id"),
    ]).then((rs) => rs.map((r) => r.rows));
    const before = await withOwner(env, db, async (c) => ({ snap: await schemaSnapshot(c), data: await data(c) }));
    const momentsBefore = await momentDump(db);

    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectStoriesApplied(db);
    await withOwner(env, db, async (c) => {
      const snap = await schemaSnapshot(c);
      expect(snap.filter((line) => !line.includes("story_versions")), "0005 changes nothing outside story_versions").toEqual(before.snap);
      expect(snap.some((line) => line.startsWith("table|pod.story_versions owner=")), "story_versions table is in the snapshot").toBe(true);
      expect(await data(c)).toEqual(before.data);
      const tables = await c.query<{ t: string; o: string }>("SELECT tablename AS t, tableowner AS o FROM pg_tables WHERE schemaname = 'pod' ORDER BY 1");
      expect(tables.rows.map((r) => r.t), "exactly the twelve user-data tables").toEqual(TWELVE);
      expect(tables.rows.find((r) => r.t === "story_versions")?.o).toBe(CI_ROLES.owner);
    });
    expect(await momentDump(db)).toEqual(momentsBefore);
    expect(await storyRows(db)).toEqual([]);
    await expectLedgerInvariants(env, db);
  }, 90_000);

  it("defines exact NOT NULL columns, PK/FK CASCADE/two UNIQUE keys, CHECKs and no extra trigger/index, with app SELECT/INSERT only", async () => {
    const db = await freshMigratedDb(env, "storyschema");
    await expectStoriesApplied(db);
    await withOwner(env, db, async (c) => {
      const cols = await c.query<{ column_name: string; data_type: string; is_nullable: string }>(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = 'story_versions' ORDER BY column_name",
      );
      expect(cols.rows).toEqual([
        { column_name: "body", data_type: "text", is_nullable: "NO" },
        { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "local_date", data_type: "date", is_nullable: "NO" },
        { column_name: "source_revision", data_type: "text", is_nullable: "NO" },
        { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "version", data_type: "integer", is_nullable: "NO" },
      ]);
      const defaults = await c.query<{ column_name: string; column_default: string | null }>(
        "SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = 'story_versions' AND column_name IN ('id', 'created_at') ORDER BY 1",
      );
      expect(defaults.rows).toEqual([{ column_name: "created_at", column_default: "now()" }, { column_name: "id", column_default: "uuidv7()" }]);
      const cons = await c.query<{ contype: string; def: string }>(
        "SELECT contype::text, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'pod.story_versions'::regclass AND contype IN ('p', 'f', 'u') ORDER BY 1, 2",
      );
      expect(cons.rows).toEqual([
        { contype: "f", def: "FOREIGN KEY (user_id) REFERENCES pod.users(id) ON DELETE CASCADE" },
        { contype: "p", def: "PRIMARY KEY (id)" },
        { contype: "u", def: "UNIQUE (user_id, local_date, source_revision)" },
        { contype: "u", def: "UNIQUE (user_id, local_date, version)" },
      ]);
      const extra = await c.query<{ idx: number; trg: number }>(
        `SELECT (SELECT count(*)::int FROM pg_index WHERE indrelid = 'pod.story_versions'::regclass) AS idx,
                (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'pod.story_versions'::regclass AND NOT tgisinternal) AS trg`,
      );
      expect(extra.rows, "only the PK and two UNIQUE indexes; no trigger").toEqual([{ idx: 3, trg: 0 }]);
      const priv = await c.query<Record<string, boolean>>(
        `SELECT has_table_privilege($1, 'pod.story_versions', 'SELECT') AS app_select,
                has_table_privilege($1, 'pod.story_versions', 'INSERT') AS app_insert,
                has_table_privilege($1, 'pod.story_versions', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS app_other,
                has_any_column_privilege($1, 'pod.story_versions', 'UPDATE,REFERENCES') AS app_column,
                has_table_privilege('public', 'pod.story_versions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS public_any,
                has_table_privilege($2, 'pod.story_versions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS purge_any,
                has_any_column_privilege($2, 'pod.story_versions', 'SELECT,INSERT,UPDATE,REFERENCES') AS purge_column`,
        [CI_ROLES.app, CI_ROLES.purge],
      );
      expect(priv.rows).toEqual([{ app_select: true, app_insert: true, app_other: false, app_column: false, public_any: false, purge_any: false, purge_column: false }]);
    });

    const a = await seedUser(env, db, []);
    const b = await seedUser(env, db, []);
    await withApp(env, db, async (c) => {
      const ins = (user: string, version: unknown, rev: unknown, body: unknown, date: unknown = DAY) => c.query(
        "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, $3, $4, $5)", [user, date, version, rev, body],
      );
      const r = await c.query<{ id: string; created: boolean }>(
        "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '첫 이야기') RETURNING id::text, created_at IS NOT NULL AS created",
        [a, DAY, R1],
      );
      expect(r.rows[0]!.id).toMatch(UUID_RE);
      expect(r.rows[0]!.created).toBe(true);
      await ins(a, 2, R2, "😀".repeat(2000)); // 2000 codepoint 경계
      await ins(a, 1, R1, "다른 날", "2026-11-10"); // 같은 revision·version도 다른 날이면 허용
      await ins(b, 1, R1, "다른 사용자");
      await expectSqlError(ins(a, 3, R1, "같은 날 같은 revision"), "23505");
      await expectSqlError(ins(a, 1, R3, "같은 날 같은 version"), "23505");
      for (const version of [0, -1]) await expectSqlError(ins(a, version, R3, "본문"), "23514");
      for (const rev of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(64)}\n`, ""]) await expectSqlError(ins(a, 3, rev, "본문"), "23514");
      for (const body of ["", "   ", "a".repeat(2001)]) await expectSqlError(ins(a, 3, R3, body), "23514");
      await expectSqlError(ins(MISSING_UUID, 1, R3, "없는 사용자"), "23503");
      await expectSqlError(ins(a, null, R3, "본문"), "23502");
      await expectSqlError(ins(a, 3, null, "본문"), "23502");
      await expectSqlError(ins(a, 3, R3, null), "23502");
      await expectSqlError(ins(a, 3, R3, "본문", null), "23502");
      await expectSqlError(ins(null as unknown as string, 3, R3, "본문"), "23502");
      await expectSqlError(c.query("INSERT INTO pod.story_versions (id, user_id, local_date, version, source_revision, body) VALUES (NULL, $1, $2, 3, $3, 'x')", [a, DAY, R3]), "23502");
      await expectSqlError(c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body, created_at) VALUES ($1, $2, 3, $3, 'x', NULL)", [a, DAY, R3]), "23502");
      await expectSqlError(c.query("UPDATE pod.story_versions SET body = body WHERE user_id = $1", [a]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.story_versions WHERE user_id = $1", [a]), "42501");
      await expectSqlError(c.query("TRUNCATE pod.story_versions"), "42501");
    });
    expect((await storyRows(db, a)).map((r) => [r.local_date, r.version])).toEqual([[DAY, 1], [DAY, 2], ["2026-11-10", 1]]);
    await withOwner(env, db, (c) => c.query("DELETE FROM pod.users WHERE id = $1", [a]));
    expect(await storyRows(db, a), "deleting the user cascades its stories").toEqual([]);
    expect(await storyRows(db, b)).toHaveLength(1);
  }, 90_000);

  it("purging a due account removes only that user's stories and keeps other ledgers intact", async () => {
    const db = await freshMigratedDb(env, "storypurge");
    await expectStoriesApplied(db);
    const gone = await seedUser(env, db, [{ provider: "testprov", subject: `gone-${randomUUID()}` }], { granted: true });
    const kept = await seedUser(env, db, [{ provider: "testprov", subject: `kept-${randomUUID()}` }], { granted: true });
    await withOwner(env, db, async (c) => {
      for (const u of [gone, kept]) {
        await c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '보존될까')", [u, DAY, R1]);
      }
    });
    const keptBefore = await storyRows(db, kept);
    await setPending(env, db, gone, "now() - interval '721 hours'", 2);
    expect(await purgeNow(db, gone)).toBe("purged");
    expect(await storyRows(db, gone)).toEqual([]);
    expect(await userCount(db, gone)).toBe(0);
    expect(await storyRows(db, kept)).toEqual(keptBefore);
    await withOwner(env, db, async (c) => {
      expect((await c.query("SELECT delta, reason FROM pod.emotion_ledger WHERE user_id = $1", [kept])).rows).toEqual([{ delta: 10, reason: "first_login_grant" }]);
    });
    await expectLedgerInvariants(env, db);
  }, 90_000);

  it("refuses runner and direct SQL down while a story exists, and the down SQL itself refuses non-ci and guards all twelve tables", async () => {
    const db = await freshMigratedDb(env, "storydownguard");
    await expectStoriesApplied(db);
    const downSql = await readFile(STORY_DOWN, "utf8");
    const firstDrop = downSql.search(/^\s*DROP\s+TABLE\b/m);
    expect(firstDrop, "down drops the table").toBeGreaterThan(0);
    const guard = downSql.slice(0, firstDrop);
    expect(guard, "the DO guard runs before any DROP").toMatch(/db_environment[\s\S]*'ci'/);
    for (const t of TWELVE) expect(guard, `down guard checks pod.${t} before DROP`).toMatch(new RegExp(`\\bFROM\\s+pod\\.${t}\\b`));
    const user = await seedUser(env, db, []);
    await withOwner(env, db, (c) => c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '지켜야 할 이야기')", [user, DAY, R1]));
    const before = await withOwner(env, db, async (c) => ({ snap: await schemaSnapshot(c), rows: await readMigrationRows(c) }));
    const stories = await storyRows(db);
    expectCliFail(await runMigrateCli(["down", "--to", "4", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      await expectSqlError(c.query(downSql), "P0001");
      expect(await schemaSnapshot(c)).toEqual(before.snap);
      expect(await readMigrationRows(c)).toEqual(before.rows);
    });
    expect(await storyRows(db)).toEqual(stories);
    // 비어 있어도 ci가 아니면 SQL 자체가 거부한다.
    await withOwner(env, db, async (c) => {
      await c.query("DELETE FROM pod.users");
      const empty = await schemaSnapshot(c);
      await c.query("UPDATE pod_meta.db_environment SET name = 'dev'");
      try {
        await expectSqlError(c.query(downSql), "P0001");
        expect(await schemaSnapshot(c)).toEqual(empty);
      } finally {
        await c.query("UPDATE pod_meta.db_environment SET name = 'ci'");
      }
    });
  }, 90_000);

  it("empty CI down --to 4 removes only story_versions and up restores the identical schema", async () => {
    const db = await freshMigratedDb(env, "storydown");
    await expectStoriesApplied(db);
    const full = await withOwner(env, db, (c) => schemaSnapshot(c));
    expectCliOk(await runMigrateCli(["down", "--to", "4", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect((await readMigrationRows(c))?.map((r) => [r.version, r.name])).toEqual(BASE_MIGRATIONS);
      expect(await relationExists(c, "pod.story_versions")).toBe(false);
      expect(await schemaSnapshot(c)).toEqual(full.filter((line) => !line.includes("story_versions")));
    });
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectStoriesApplied(db);
    expect(await withOwner(env, db, (c) => schemaSnapshot(c)), "down/up round trip").toEqual(full);
  }, 90_000);
});

// ---------------------------------------------------------------- captureStoryInput

describe("captureStoryInput", () => {
  it("captures one ordered Seoul-local snapshot in a single SQL statement, matching getDay and excluding other days, users and settings", async () => {
    await withStories("storycapture", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      const other = await seedUser(env, db, []);
      const tieA = "0190f0a0-0000-7000-8000-0000000000a1";
      const tieB = "0190f0a0-0000-7000-8000-0000000000b2";
      await seedMoments(db, userId, [
        { at: `${DAY}T23:59:59+09:00`, body: "하루 끝\n\t둘째 줄\r셋째" },
        { at: `${DAY}T12:00:00+09:00`, body: "같은 시각 B", id: tieB },
        { at: `${DAY}T00:00:00+09:00`, body: "자정 직후" },
        { at: `${DAY}T12:00:00+09:00`, body: "같은 시각 A", id: tieA },
        { at: "2026-11-08T23:59:59+09:00", body: "전날 마지막", date: "2026-11-08" },
        { at: "2026-11-10T00:00:00+09:00", body: "다음날 처음", date: "2026-11-10" },
      ]);
      await seedMoments(db, other, [{ at: `${DAY}T10:00:00+09:00`, body: "남의 조각" }]);
      const sql: string[] = [];
      const spy = {
        query: (...args: unknown[]) => {
          const q = args[0];
          sql.push(typeof q === "string" ? q : String((q as { text?: unknown } | null)?.text));
          return (pool.query as unknown as (...a: unknown[]) => unknown).apply(pool, args);
        },
      } as unknown as Pick<pg.Pool, "query">;
      const r = await api.captureStoryInput(spy, userId, DAY);
      expect(sql, "exactly one SQL statement").toHaveLength(1);
      expect(sql[0], "no photo join or day summary").not.toMatch(/moment_photos|photo_uploads|day_summaries|preferences/);
      const refs = await momentRefs(db, userId);
      const value = okValue(r, "capture");
      expect(value).toStrictEqual({
        date: DAY,
        revision: oracle(DAY, refs),
        moments: [
          { id: refs[0]!.id, version: 1, time: "00:00", text: "자정 직후" },
          { id: tieA, version: 1, time: "12:00", text: "같은 시각 A" },
          { id: tieB, version: 1, time: "12:00", text: "같은 시각 B" },
          { id: refs[3]!.id, version: 1, time: "23:59", text: "하루 끝\n\t둘째 줄\r셋째" },
        ],
      });
      const day = await (await loadCreatePgDiaryStore())(pool).getDay(userId, DAY);
      expect(value.moments, "same visibility as getDay").toEqual(day!.moments.map((m) => ({ id: m.id, version: m.version, time: m.time, text: m.text })));
      // 정리 한 줄·글꼴·회고 시간은 입력이 아니다.
      await withOwner(env, db, async (c) => {
        await c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, $2::date, '정리 한 줄')", [userId, DAY]);
        await c.query("INSERT INTO pod.preferences (user_id, font_key, reflection_time) VALUES ($1, 'serif', '21:30')", [userId]);
      });
      expect(okValue(await api.captureStoryInput(pool, userId, DAY), "after settings").revision).toBe(value.revision);
      // 실제 DELETE된 조각은 사라지고 revision이 바뀐다.
      expect(await (await loadCreatePgDiaryStore())(pool).deleteMoment(userId, tieB, 1)).toEqual({ ok: true, value: null });
      const after = okValue(await api.captureStoryInput(pool, userId, DAY), "after delete");
      expect(after.moments.map((m) => m.id)).not.toContain(tieB);
      expect(after.revision).toBe(oracle(DAY, await momentRefs(db, userId)));
      expect(after.revision).not.toBe(value.revision);
      expect(okValue(await api.captureStoryInput(pool, other, DAY), "other user").moments.map((m) => m.text)).toEqual(["남의 조각"]);
    });
  }, 90_000);

  it("returns no_input for 0, accepts 30 (300 astral codepoints), input_too_large for 31, and invalid_date before SQL", async () => {
    await withStories("storylimits", async (api, pool, db) => {
      const empty = await seedUser(env, db, []);
      expect(await api.captureStoryInput(pool, empty, DAY)).toEqual({ ok: false, error: "no_input" });
      const thirty = await seedUser(env, db, []);
      await seedMoments(db, thirty, [...many(29), { at: `${DAY}T09:00:00+09:00`, body: "😀".repeat(300) }]);
      const v = okValue(await api.captureStoryInput(pool, thirty, DAY), "30 moments");
      expect(v.moments).toHaveLength(30);
      expect(v.moments[29]!.text).toBe("😀".repeat(300));
      const over = await seedUser(env, db, []);
      await seedMoments(db, over, many(31));
      expect(await api.captureStoryInput(pool, over, DAY)).toEqual({ ok: false, error: "input_too_large" });
      const noSql = vi.fn(async () => { throw new Error("must not run SQL"); });
      const fake = { query: noSql } as unknown as Pick<pg.Pool, "query">;
      for (const [user, date] of [["not-a-uuid", DAY], [thirty, "2026-02-30"], [thirty, "2026-11-9"], [thirty, ""]] as const) {
        expect(await api.captureStoryInput(fake, user, date), `${user} ${date}`).toEqual({ ok: false, error: "invalid_date" });
      }
      expect(noSql, "no SQL before validation").not.toHaveBeenCalled();
    });
  }, 90_000);

  it("rejects the whole day as invalid_input when any text is blank after trim or has a forbidden control character", async () => {
    await withStories("storycontrol", async (api, pool, db) => {
      for (const bad of ["\t", "　", "a\u0001b", "끝\u001f", "\u007f", "x\u0080", "x\u009f"]) {
        const userId = await seedUser(env, db, []);
        await seedMoments(db, userId, [{ at: `${DAY}T07:00:00+09:00`, body: "정상 조각" }, { at: `${DAY}T08:00:00+09:00`, body: bad }]);
        expect(await api.captureStoryInput(pool, userId, DAY), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid_input" });
      }
    });
  }, 90_000);
});

// ---------------------------------------------------------------- store

describe("story store", () => {
  it("appendStoryVersion fences active/gen, numbers versions per user and day, replays a revision and finds stories", async () => {
    await withStories("storyappend", async (api, pool, db) => {
      const a = await seedUser(env, db, []);
      const b = await seedUser(env, db, []);
      const pending = await seedUser(env, db, []);
      await setPending(env, db, pending, "now()", 2);
      const sa = { userId: a, gen: 1 };
      const first = okValue(await api.appendStoryVersion(pool, sa, DAY, R1, "첫 이야기"), "first");
      expect(Object.keys(first).sort()).toEqual(["replayed", "story"]);
      expect(first.replayed).toBe(false);
      const second = okValue(await api.appendStoryVersion(pool, sa, DAY, R2, "둘째 이야기"), "second");
      expect(second.replayed).toBe(false);
      const replay = okValue(await api.appendStoryVersion(pool, sa, DAY, R1, "다른 본문"), "replay");
      expect(replay).toStrictEqual({ story: first.story, replayed: true });
      okValue(await api.appendStoryVersion(pool, sa, "2026-11-10", R1, "다른 날"), "other day");
      okValue(await api.appendStoryVersion(pool, { userId: b, gen: 1 }, DAY, R1, "다른 사용자"), "other user");
      const rows = await storyRows(db, a);
      expect(rows.map((r) => [r.local_date, r.version, r.source_revision, r.body])).toEqual([
        [DAY, 1, R1, "첫 이야기"], [DAY, 2, R2, "둘째 이야기"], ["2026-11-10", 1, R1, "다른 날"],
      ]);
      expectRef(first.story, rows[0], "first");
      expectRef(second.story, rows[1], "second");
      expect((await storyRows(db, b)).map((r) => r.version)).toEqual([1]);
      const all = await storyRows(db);
      for (const subject of [{ userId: a, gen: 2 }, { userId: pending, gen: 2 }, { userId: MISSING_UUID, gen: 1 }]) {
        expect(await api.appendStoryVersion(pool, subject, DAY, R3, "거부"), JSON.stringify(subject)).toEqual({ ok: false, error: "not_signed_in" });
      }
      expect(await storyRows(db)).toEqual(all);
      const latest = await api.findLatestStory(pool, a, DAY);
      expect(latest).toStrictEqual({ ...second.story, sourceRevision: R2 });
      const byRev = await api.findStoryByRevision(pool, a, DAY, R1);
      expect(byRev).toStrictEqual(first.story);
      expect(Object.keys(byRev!).sort(), "findStoryByRevision returns StoryRef without sourceRevision").toEqual(["body", "createdAt", "id", "version"]);
      expect(await api.findStoryByRevision(pool, b, DAY, R2)).toBeNull();
      expect(await api.findLatestStory(pool, a, "2026-11-11")).toBeNull();
      expect(await api.findLatestStory(pool, pending, DAY)).toBeNull();
    });
  }, 90_000);

  it("serializes concurrent appends on the user row lock: distinct versions, one row per revision, no unique error", async () => {
    await withStories("storyrace", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      const subject = { userId, gen: 1 };
      const owner = await openOwner(env, db);
      let results: Awaited<ReturnType<Api["appendStoryVersion"]>>[] = [];
      try {
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [userId]);
        const pending = [
          api.appendStoryVersion(pool, subject, DAY, R1, "가"),
          api.appendStoryVersion(pool, subject, DAY, R2, "나"),
          api.appendStoryVersion(pool, subject, DAY, R1, "가 다시"),
        ];
        await waitLockWaiters(db, 3);
        await owner.client.query("COMMIT");
        results = await bounded(Promise.all(pending), "concurrent appends", 15_000);
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
      }
      const values = results.map((r, i) => okValue(r, `append ${i}`));
      expect(values.filter((v) => !v.replayed).map((v) => v.story.version).sort()).toEqual([1, 2]);
      expect(values.filter((v) => v.replayed)).toHaveLength(1);
      const rows = await storyRows(db, userId);
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
      expect(rows.map((r) => r.source_revision).sort()).toEqual([R1, R2].sort());
      const r1 = rows.find((r) => r.source_revision === R1)!;
      expect(values[0]!.story.id).toBe(r1.id);
      expect(values[2]!.story.id).toBe(r1.id);
    }, 4);
  }, 90_000);
});

// ---------------------------------------------------------------- generateDailyStory

describe("generateDailyStory", () => {
  it("sends the exact identifier-free payload with a live signal, stores version 1 with the captured revision and replays without the generator", async () => {
    await withStories("storygenerate", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      const other = await seedUser(env, db, []);
      await seedMoments(db, userId, [
        { at: `${DAY}T21:30:00+09:00`, body: "저녁 산책" },
        { at: `${DAY}T00:00:00+09:00`, body: "자정 직후" },
        { at: `${DAY}T23:59:59+09:00`, body: "하루 끝\n\t메모" },
        { at: "2026-11-10T00:00:00+09:00", body: "다음날", date: "2026-11-10" },
      ]);
      await seedMoments(db, other, [{ at: `${DAY}T10:00:00+09:00`, body: "남의 조각" }]);
      const refs = await momentRefs(db, userId);
      const g = generatorOf();
      const r = await api.generateDailyStory(pool, g.generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW });
      const value = okValue(r, "generate");
      expect(Object.keys(value).sort()).toEqual(["replayed", "story"]);
      expect(value.replayed).toBe(false);
      expect(g.calls).toHaveLength(1);
      const call = g.calls[0]!;
      expect(call.input).toStrictEqual({ date: DAY, moments: [{ time: "00:00", text: "자정 직후" }, { time: "21:30", text: "저녁 산책" }, { time: "23:59", text: "하루 끝\n\t메모" }] });
      const sent = JSON.stringify(call.input);
      for (const secret of [userId, ...refs.map((m) => m.id), oracle(DAY, refs)]) expect(sent.includes(secret), "payload has no identifiers or revision").toBe(false);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.aborted, "signal is live when the generator starts").toBe(false);
      const rows = await storyRows(db, userId);
      expect(rows.map((x) => [x.version, x.source_revision, x.body])).toEqual([[1, oracle(DAY, refs), STORY]]);
      expectRef(value.story, rows[0], "generated");

      const again = await api.generateDailyStory(pool, g.generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: oracle(DAY, refs) }, { now: NOW });
      expect(again).toStrictEqual({ ok: true, value: { story: value.story, replayed: true } });
      const closed = await api.generateDailyStory(pool, null, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW });
      expect(closed, "a stored same-revision story is reused even without a generator").toStrictEqual({ ok: true, value: { story: value.story, replayed: true } });
      expect(g.calls).toHaveLength(1);
      expect(await storyRows(db, userId)).toEqual(rows);
    });
  }, 90_000);

  it("creates the next version after the input changes and rejects a stale expectedInputRevision as conflict", async () => {
    await withStories("storyversion", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      await seedMoments(db, userId, many(2));
      const subject = { userId, gen: 1 };
      const oldRev = oracle(DAY, await momentRefs(db, userId));
      okValue(await api.generateDailyStory(pool, generatorOf().generator, subject, { date: DAY, expectedInputRevision: oldRev }, { now: NOW }), "v1");
      const [m1] = await momentRefs(db, userId);
      okValue(await (await loadCreatePgDiaryStore())(pool).updateMoment(userId, m1!.id, 1, "고친 조각"), "update");
      const newRev = oracle(DAY, await momentRefs(db, userId));
      const stale = generatorOf();
      expect(await api.generateDailyStory(pool, stale.generator, subject, { date: DAY, expectedInputRevision: oldRev }, { now: NOW })).toEqual({ ok: false, error: "conflict" });
      expect(stale.generate).not.toHaveBeenCalled();
      const g2 = generatorOf(() => okGen("두 번째 이야기"));
      const v2 = okValue(await api.generateDailyStory(pool, g2.generator, subject, { date: DAY, expectedInputRevision: newRev }, { now: NOW }), "v2");
      expect(v2.replayed).toBe(false);
      expect(v2.story.version).toBe(2);
      expect(g2.calls[0]!.input.moments.map((m) => m.text)).toEqual(["고친 조각", "조각 2"]);
      expect((await storyRows(db, userId)).map((x) => [x.version, x.source_revision])).toEqual([[1, oldRev], [2, newRev]]);
    });
  }, 90_000);

  it("rejects stale, pending or missing accounts before capture, then input, conflict and closed-generator failures, without calling the generator", async () => {
    await withStories("storyprecheck", async (api, pool, db) => {
      const g = generatorOf();
      const run = (subject: Subject, date = DAY, expectedInputRevision: string | null = null, gen: Generator | null = g.generator, now = NOW) =>
        api.generateDailyStory(pool, gen, subject, { date, expectedInputRevision }, { now });
      const stale = await seedUser(env, db, [], { gen: 2 });
      await seedMoments(db, stale, many(31));
      expect(await run({ userId: stale, gen: 1 }), "stale gen is checked before capture (31 moments)").toEqual({ ok: false, error: "not_signed_in" });
      const pending = await seedUser(env, db, []);
      await seedMoments(db, pending, many(31));
      await setPending(env, db, pending, "now()", 2);
      expect(await run({ userId: pending, gen: 2 }), "pending is checked before capture").toEqual({ ok: false, error: "not_signed_in" });
      expect(await run({ userId: MISSING_UUID, gen: 1 })).toEqual({ ok: false, error: "not_signed_in" });

      const empty = await seedUser(env, db, []);
      expect(await run({ userId: empty, gen: 1 })).toEqual({ ok: false, error: "no_input" });
      const over = await seedUser(env, db, []);
      await seedMoments(db, over, many(31));
      expect(await run({ userId: over, gen: 1 })).toEqual({ ok: false, error: "input_too_large" });
      const bad = await seedUser(env, db, []);
      await seedMoments(db, bad, [...many(2), { at: `${DAY}T10:00:00+09:00`, body: "제어\u0007문자" }]);
      expect(await run({ userId: bad, gen: 1 })).toEqual({ ok: false, error: "invalid_input" });
      const ok = await seedUser(env, db, []);
      await seedMoments(db, ok, many(2));
      expect(await run({ userId: ok, gen: 1 }, DAY, R1), "expected revision mismatch").toEqual({ ok: false, error: "conflict" });
      expect(await run({ userId: ok, gen: 1 }, DAY, null, null), "closed generator").toEqual({ ok: false, error: "unavailable" });
      // 서울 현재일 경계(주입 시계): 23:59:59.999에는 다음날이 미래, 자정(15:00Z)에는 오늘.
      expect(await run({ userId: ok, gen: 1 }, "2026-11-10", null, g.generator, () => new Date("2026-11-09T14:59:59.999Z"))).toEqual({ ok: false, error: "invalid_date" });
      expect(await run({ userId: ok, gen: 1 }, "2026-11-10", null, g.generator, () => new Date("2026-11-09T15:00:00.000Z"))).toEqual({ ok: false, error: "no_input" });
      expect(g.generate).not.toHaveBeenCalled();
      expect(await storyRows(db)).toEqual([]);
    });
  }, 90_000);

  it("aborts the generator signal at exactly 20000 ms and returns timeout without storing", async () => {
    await withStories("storytimeout", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      await seedMoments(db, userId, many(1));
      const called = gate();
      let signal: AbortSignal | undefined;
      const g = generatorOf((_input, s) => {
        signal = s;
        called.resolve();
        return new Promise<GenResult>((resolve) => {
          const done = () => resolve({ ok: false, error: "timeout" });
          if (s.aborted) done();
          else s.addEventListener("abort", done, { once: true });
        });
      });
      fakeDeadlineClock();
      const pending = api.generateDailyStory(pool, g.generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW });
      const state = track(pending);
      await bounded(called.promise, "generator call");
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(signal!.aborted, "not aborted 1 ms before 20 s").toBe(false);
      expect(state.settled, "still generating 1 ms before 20 s").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal!.aborted, "aborted at exactly 20000 ms").toBe(true);
      expect(await bounded(pending, "timeout result")).toEqual({ ok: false, error: "timeout" });
      vi.useRealTimers();
      expect(await storyRows(db, userId)).toEqual([]);
    });
  }, 90_000);

  it("maps invalid output, port errors, throws and SQL failures without leaking details, preserving the existing story and moments", async () => {
    await withStories("storyfailures", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      await seedMoments(db, userId, many(2));
      const subject = { userId, gen: 1 };
      okValue(await api.generateDailyStory(pool, generatorOf().generator, subject, { date: DAY, expectedInputRevision: null }, { now: NOW }), "existing");
      const [m1] = await momentRefs(db, userId);
      okValue(await (await loadCreatePgDiaryStore())(pool).updateMoment(userId, m1!.id, 1, "바뀐 입력"), "update");
      const storiesBefore = await storyRows(db);
      const momentsBefore = await momentDump(db);
      const err = new Error(LEAK);
      const cases: [string, () => Promise<GenResult> | GenResult, StoryError][] = [
        ["empty body", () => okGen(""), "invalid_output"],
        ["blank body", () => okGen(" \n\t　 "), "invalid_output"],
        ["2001 codepoints", () => okGen("😀".repeat(2001)), "invalid_output"],
        ["C0 control", () => okGen("이야기\u0007"), "invalid_output"],
        ["DEL", () => okGen("이야기\u007f"), "invalid_output"],
        ["C1 control", () => okGen("이야기\u0085"), "invalid_output"],
        ["non-string body", () => okGen(42), "invalid_output"],
        ["inherited body", () => ({ ok: true, value: Object.create({ body: STORY }) as { body: string } }), "invalid_output"],
        ["port invalid_output", () => ({ ok: false, error: "invalid_output" }), "invalid_output"],
        ["port unavailable", () => ({ ok: false, error: "unavailable" }), "unavailable"],
        ["port timeout", () => ({ ok: false, error: "timeout" }), "timeout"],
        ["unknown port error", () => ({ ok: false, error: LEAK } as unknown as GenResult), "unavailable"],
        ["throw", () => { throw err; }, "unavailable"],
        ["rejection", () => Promise.reject(err), "unavailable"],
      ];
      const output = captureConsole();
      for (const [label, impl, error] of cases) {
        const r = await api.generateDailyStory(pool, generatorOf(impl).generator, subject, { date: DAY, expectedInputRevision: null }, { now: NOW });
        expect(r, label).toEqual({ ok: false, error });
        expect(JSON.stringify(r).includes(LEAK), `${label}: no raw detail in the result`).toBe(false);
      }
      // 예상 밖 SQL 오류(시험 전용 owner 트리거)는 unavailable이다.
      await withOwner(env, db, async (c) => {
        await c.query(`CREATE FUNCTION pod.story_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${LEAK}'; END $$`);
        await c.query("CREATE TRIGGER story_test_fail BEFORE INSERT ON pod.story_versions FOR EACH ROW EXECUTE FUNCTION pod.story_test_fail()");
      });
      try {
        const r = await api.generateDailyStory(pool, generatorOf().generator, subject, { date: DAY, expectedInputRevision: null }, { now: NOW });
        expect(r, "unexpected SQL error").toEqual({ ok: false, error: "unavailable" });
        expect(JSON.stringify(r).includes(LEAK)).toBe(false);
      } finally {
        await withOwner(env, db, async (c) => {
          await c.query("DROP TRIGGER story_test_fail ON pod.story_versions");
          await c.query("DROP FUNCTION pod.story_test_fail()");
        });
      }
      expect(output().includes(LEAK), "no raw detail or stack in logs").toBe(false);
      expect(await storyRows(db)).toEqual(storiesBefore);
      expect(await momentDump(db)).toEqual(momentsBefore);
      // 경계 안의 출력은 저장된다: null-prototype value, 2000 codepoint, 내부 줄바꿈.
      const nullProto = Object.assign(Object.create(null) as { body: string }, { body: `${"😀".repeat(1000)}\n${"😀".repeat(999)}` });
      const accepted = okValue(await api.generateDailyStory(pool, generatorOf(() => ({ ok: true, value: nullProto })).generator, subject, { date: DAY, expectedInputRevision: null }, { now: NOW }), "accepted");
      expect(accepted.story.version).toBe(2);
      expect(accepted.story.body).toBe(nullProto.body);
    });
  }, 90_000);

  it("holds no lock during generation: separate-connection CRUD succeeds and the saved story later reads as outdated", async () => {
    await withStories("storycrud", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      await seedMoments(db, userId, many(2));
      const captured = await momentRefs(db, userId);
      const other = openAppPool(db, 1);
      const store = (await loadCreatePgDiaryStore())(other, { now: () => new Date(`${DAY}T05:00:00.000Z`) }); // 서울 14:00
      const called = gate();
      const release = gate();
      const g = generatorOf(async () => { called.resolve(); await release.promise; return okGen(); });
      const pending = api.generateDailyStory(pool, g.generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW });
      try {
        await bounded(called.promise, "generator call");
        await bounded(withOwner(env, db, (c) => c.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE NOWAIT", [userId])), "user row is not locked");
        okValue(await bounded(store.updateMoment(userId, captured[0]!.id, 1, "생성 중 수정")), "update during generation");
        okValue(await bounded(store.createMoment(userId, "생성 중 추가")), "create during generation");
        expect(await bounded(store.deleteMoment(userId, captured[1]!.id, 1))).toEqual({ ok: true, value: null });
      } finally {
        release.resolve();
      }
      const saved = okValue(await bounded(pending, "generation result"), "generate");
      expect(saved.story.version).toBe(1);
      expect((await storyRows(db, userId)).map((r) => r.source_revision), "stored with the captured revision").toEqual([oracle(DAY, captured)]);
      const nowRev = oracle(DAY, await momentRefs(db, userId));
      const day = okValue(await api.readStoryDay(pool, { userId, gen: 1 }, DAY), "read");
      expect(day).toStrictEqual({ date: DAY, inputRevision: nowRev, story: saved.story, state: "outdated", generation: "unavailable" });
      const next = okValue(await api.generateDailyStory(pool, generatorOf().generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: nowRev }, { now: NOW }), "regenerate");
      expect(next.story.version).toBe(2);
      expect(okValue(await api.readStoryDay(pool, { userId, gen: 1 }, DAY), "read current").state).toBe("current");
    }, 3);
  }, 90_000);

  it("refuses a late result after a generation change, withdrawal or purge during generation and stores nothing", async () => {
    await withStories("storyfence", async (api, pool, db) => {
      const lifecycle = await loadLifecycle();
      const other = openAppPool(db, 1);
      for (const mutation of ["generation", "withdrawal", "purge"] as const) {
        const userId = await seedUser(env, db, [{ provider: "testprov", subject: `${mutation}-${randomUUID()}` }], { granted: true });
        await seedMoments(db, userId, many(2));
        const g = generatorOf(async () => {
          if (mutation === "generation") {
            await withOwner(env, db, (c) => c.query("UPDATE pod.users SET auth_generation = auth_generation + 1 WHERE id = $1", [userId]));
          } else {
            expect((await lifecycle.withdraw(other, { userId, gen: 1 })).ok, `${mutation}: withdraw`).toBe(true);
            if (mutation === "purge") {
              await setPending(env, db, userId, "now() - interval '721 hours'", 2);
              expect(await purgeNow(db, userId)).toBe("purged");
            }
          }
          return okGen();
        });
        const r = await bounded(api.generateDailyStory(pool, g.generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW }), `${mutation} result`, 15_000);
        expect(r, mutation).toEqual({ ok: false, error: "not_signed_in" });
        expect(g.calls, `${mutation}: generator was reached`).toHaveLength(1);
        expect(await storyRows(db, userId), mutation).toEqual([]);
      }
    }, 3);
  }, 90_000);
});

// ---------------------------------------------------------------- readStoryDay

describe("readStoryDay", () => {
  it("returns none/current/outdated with an exact identifier-free DTO, the latest version and no writes", async () => {
    await withStories("storyread", async (api, pool, db) => {
      const userId = await seedUser(env, db, []);
      const stranger = await seedUser(env, db, []);
      await seedMoments(db, userId, many(2));
      const subject = { userId, gen: 1 };
      const rev0 = oracle(DAY, await momentRefs(db, userId));
      expect(await api.readStoryDay(pool, subject, DAY)).toStrictEqual({ ok: true, value: { date: DAY, inputRevision: rev0, story: null, state: "none", generation: "unavailable" } });
      expect(await api.readStoryDay(pool, { userId: stranger, gen: 1 }, DAY)).toStrictEqual({ ok: true, value: { date: DAY, inputRevision: null, story: null, state: "none", generation: "unavailable" } });

      const v1 = okValue(await api.generateDailyStory(pool, generatorOf().generator, subject, { date: DAY, expectedInputRevision: rev0 }, { now: NOW }), "v1");
      const stories = await storyRows(db);
      const moments = await momentDump(db);
      const current = okValue(await api.readStoryDay(pool, subject, DAY), "current");
      expect(current).toStrictEqual({ date: DAY, inputRevision: rev0, story: v1.story, state: "current", generation: "unavailable" });
      expect(Object.keys(current).sort()).toEqual(["date", "generation", "inputRevision", "state", "story"]);
      expectRef(current.story, stories[0], "read story");
      const text = JSON.stringify(current);
      for (const secret of [userId, ...(await momentRefs(db, userId)).map((m) => m.id)]) expect(text.includes(secret), "DTO has no user or moment id").toBe(false);
      expect(text).not.toMatch(/sourceRevision|userId|"gen"|photo|object_?key/i);
      expect(await storyRows(db), "read writes nothing").toEqual(stories);
      expect(await momentDump(db), "read writes nothing").toEqual(moments);
      expect(await api.readStoryDay(pool, { userId: stranger, gen: 1 }, DAY), "another user's story is invisible").toStrictEqual({
        ok: true, value: { date: DAY, inputRevision: null, story: null, state: "none", generation: "unavailable" },
      });

      const [m1] = await momentRefs(db, userId);
      okValue(await (await loadCreatePgDiaryStore())(pool).updateMoment(userId, m1!.id, 1, "고친 조각"), "update");
      const rev1 = oracle(DAY, await momentRefs(db, userId));
      expect(await api.readStoryDay(pool, subject, DAY)).toStrictEqual({ ok: true, value: { date: DAY, inputRevision: rev1, story: v1.story, state: "outdated", generation: "unavailable" } });
      const v2 = okValue(await api.generateDailyStory(pool, generatorOf(() => okGen("최신 이야기")).generator, subject, { date: DAY, expectedInputRevision: rev1 }, { now: NOW }), "v2");
      expect(await api.readStoryDay(pool, subject, DAY)).toStrictEqual({ ok: true, value: { date: DAY, inputRevision: rev1, story: v2.story, state: "current", generation: "unavailable" } });
    });
  }, 90_000);

  it("keeps the existing story readable as outdated when the current input is empty, over 30 or invalid, and refuses inactive viewers", async () => {
    await withStories("storyreadkeep", async (api, pool, db) => {
      const expectKept = async (userId: string, label: string) => {
        const story = okValue(await api.generateDailyStory(pool, generatorOf().generator, { userId, gen: 1 }, { date: DAY, expectedInputRevision: null }, { now: NOW }), `${label}: generate`).story;
        return story;
      };
      const cases: [string, (userId: string) => Promise<void>][] = [
        ["all deleted", (u) => withOwner(env, db, async (c) => { await c.query("DELETE FROM pod.diary_moments WHERE user_id = $1", [u]); })],
        ["31 moments", (u) => seedMoments(db, u, many(29, "추가"))],
        ["invalid text", (u) => seedMoments(db, u, [{ at: `${DAY}T22:00:00+09:00`, body: "제어\u0085문자" }])],
      ];
      for (const [label, change] of cases) {
        const userId = await seedUser(env, db, []);
        await seedMoments(db, userId, [{ at: `${DAY}T06:00:00+09:00`, body: "첫 조각" }, { at: `${DAY}T06:30:00+09:00`, body: "둘째 조각" }]);
        const story = await expectKept(userId, label);
        await change(userId);
        const before = await storyRows(db, userId);
        expect(await api.readStoryDay(pool, { userId, gen: 1 }, DAY), label).toStrictEqual({ ok: true, value: { date: DAY, inputRevision: null, story, state: "outdated", generation: "unavailable" } });
        expect(await storyRows(db, userId), `${label}: story preserved`).toEqual(before);
      }
      const stale = await seedUser(env, db, []);
      await seedMoments(db, stale, many(1));
      await expectKept(stale, "stale");
      await withOwner(env, db, (c) => c.query("UPDATE pod.users SET auth_generation = 2 WHERE id = $1", [stale]));
      expect(await api.readStoryDay(pool, { userId: stale, gen: 1 }, DAY)).toEqual({ ok: false, error: "not_signed_in" });
      await setPending(env, db, stale, "now()", 3);
      expect(await api.readStoryDay(pool, { userId: stale, gen: 3 }, DAY)).toEqual({ ok: false, error: "not_signed_in" });
      expect(await api.readStoryDay(pool, { userId: MISSING_UUID, gen: 1 }, DAY)).toEqual({ ok: false, error: "not_signed_in" });
    });
  }, 90_000);
});
