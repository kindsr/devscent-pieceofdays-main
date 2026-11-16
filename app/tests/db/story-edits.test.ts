// PLAN_story-edit-regenerate §1·§2·§4 RED(DB). 일회용 PG18·실제 app/purge role·mock fetch만 쓴다(실제 API·키·서비스 DB 0).
// - 모든 사례는 먼저 0001~0006이 기존대로 적용됐는지 본 뒤 0007 파일 existsSync·적용 기록을 명시 단언한다.
//   제품 TS 모듈은 existsSync 뒤 변수 경로로 동적 import한다(부재는 TS/import 오류가 아니라 이 단언의 실패).
// - 날짜는 고정 과거 날짜이고 수동 요청의 '오늘'은 opts.now로 주입한다(실제 현재 시각 의존 0, 시한 폭탄 0).
// - 이야기 v1(AI 최초 생성)은 owner fixture로 넣는다. 수정·재생성은 제품 함수로만 만든다(직접 INSERT로 결과를 꾸미지 않는다).
// - purge는 기존 helper(setPending + openPurge + pod.purge_user_if_due)만 쓴다. raw DELETE users로 우회하지 않는다.
// - 기존 0005 UNIQUE 제약은 이름이 아니라 conkey 열 목록으로 판정한다(63자 절단 여부와 무관).
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupAll, createDisposableDatabase, readDisposableEnv, CI_ROLES, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  APP_DIR, PRODUCT_MIGRATIONS_DIR, USER_DATA_TABLES, cleanupTempDirs, expectCliFail, expectCliOk, expectSqlError, makeMigrationsDir,
  readMigrationRows, runMigrateCli, schemaSnapshot, withApp, withOwner,
} from "./f2-support";
import { appBackend, endAllPools, expectLedgerInvariants, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { openPurge, seedUser, setPending } from "./f4-lifecycle-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §2)

type Subject = { userId: string; gen: number };
type StoryRef = { id: string; version: number; body: string; createdAt: string; edited?: true };
type StoryDay = { date: string; inputRevision: string | null; story: StoryRef | null; state: "none" | "current" | "outdated"; generation: "unavailable" };
type InputV2 = { date: string; revision: string; revisionV1: string; moments: unknown[] };
type Claimed = {
  id: string; userId: string; date: string; kind: "manual" | "scheduled"; leaseToken: string; gen: number;
  consentVersion: number; consentRevision: number; input: InputV2; baseVersion?: number | null;
};
type ClaimResult = { kind: "none" } | { kind: "skipped" | "failed"; jobId: string } | { kind: "claimed"; job: Claimed };
type Usage = { inputTokens: number; outputTokens: number };
type Outcome = { ok: true; body: string; usage: Usage } | { ok: false; error: string; sent: boolean; usage: Usage | null };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Blobs = { get: (key: string, signal?: AbortSignal) => Promise<Buffer | null> };
type EditError = "not_signed_in" | "invalid_date" | "invalid_body" | "conflict" | "busy";
type Api = {
  saveStoryAiSettings: (db: pg.Pool, subject: Subject, input: unknown) => Promise<Result<{ manualEnabled: boolean; autoEnabled: boolean }, string>>;
  captureStoryInputV2: (db: pg.Pool, userId: string, date: string) => Promise<Result<InputV2, string>>;
  editStoryVersion: (db: pg.Pool, subject: Subject, date: string, input: unknown) => Promise<Result<{ story: StoryRef; unchanged: boolean }, EditError>>;
  findLatestStory: (db: pg.Pool, userId: string, date: string) => Promise<(StoryRef & { sourceRevision: string }) | null>;
  findStoryByRevision: (db: pg.Pool, userId: string, date: string, revision: string) => Promise<StoryRef | null>;
  readStoryDay: (db: pg.Pool, subject: Subject, date: string) => Promise<Result<StoryDay, string>>;
  requestManualStory: (db: pg.Pool, subject: Subject, date: string, opts?: { now?: () => Date; expectedStoryVersion?: unknown }) => Promise<Result<{ jobId: string }, string>>;
  claimStoryJob: (db: pg.Pool) => Promise<ClaimResult>;
  markStorySent: (db: pg.Pool, job: Claimed, model: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  finishStoryJob: (db: pg.Pool, job: Claimed, outcome: Outcome) => Promise<"succeeded" | "failed">;
  runOneStoryJob: (deps: { db: pg.Pool; blobs: Blobs | null; claude: { apiKey: string; model: string } | null; fetch?: FetchLike }) => Promise<{ result: string }>;
};

const SRC = path.join(APP_DIR, "src", "server", "stories");
const MODULES: [string, string[]][] = [
  [path.join(SRC, "settings.pg.ts"), ["saveStoryAiSettings"]],
  [path.join(SRC, "input-v2.pg.ts"), ["captureStoryInputV2"]],
  [path.join(SRC, "store.pg.ts"), ["editStoryVersion", "findLatestStory", "findStoryByRevision", "appendStoryVersionTx"]],
  [path.join(SRC, "read.ts"), ["readStoryDay"]],
  [path.join(SRC, "jobs.pg.ts"), ["requestManualStory", "claimStoryJob", "markStorySent", "finishStoryJob"]],
  [path.join(SRC, "worker.ts"), ["runOneStoryJob"]],
];
const EDITS_UP = path.join(PRODUCT_MIGRATIONS_DIR, "0007_story_edits.up.sql");
const EDITS_DOWN = path.join(PRODUCT_MIGRATIONS_DIR, "0007_story_edits.down.sql");
const BEFORE_0007 = [[1, "init"], [2, "account_lifecycle"], [3, "reflection_time"], [4, "private_photos"], [5, "daily_stories"], [6, "story_generation"]];
const FILES_0006 = ["0001_init", "0002_account_lifecycle", "0003_reflection_time", "0004_private_photos", "0005_daily_stories", "0006_story_generation"];

const DAY = "2026-11-09";
const OTHER_DAY = "2026-11-08";
const NOW = () => new Date("2026-11-09T12:00:00.000Z"); // 서울 2026-11-09 21:00(주입 시계)
const MODEL = "claude-sonnet-5-5";
const CLAUDE = { apiKey: `sk-ant-api03-ci-only-edits-${"e".repeat(40)}`, model: MODEL };
const V1_BODY = "ci-only AI가 처음 쓴 하루 이야기.\n두 번째 줄.";
const REGEN_BODY = "ci-only AI가 다시 쓴 하루 이야기.";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let env: HarnessEnv;
beforeAll(() => { env = readDisposableEnv(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  try { await endAllPools(); await cleanupTempDirs(); } finally { if (env) await cleanupAll(env); }
});

// ---------------------------------------------------------------- 이 파일 전용 도우미

async function loadApi(): Promise<Api> {
  const out: Record<string, unknown> = {};
  for (const [file, names] of MODULES) {
    const rel = path.relative(APP_DIR, file);
    expect(existsSync(file), `${rel} must exist`).toBe(true);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const name of names) {
      expect(typeof mod[name], `${rel} must export function ${name} (PLAN_story-edit-regenerate §2)`).toBe("function");
      out[name] = mod[name];
    }
  }
  return out as unknown as Api;
}

/** 기존 0001~0006이 그대로 적용됐는지 먼저 보고, 그 뒤 0007 파일·기록을 각각 명시 단언한다. */
async function expectEditsApplied(db: DisposableDatabase): Promise<void> {
  const pairs = ((await withOwner(env, db, (c) => readMigrationRows(c))) ?? []).map((r) => [r.version, r.name]);
  expect(pairs.slice(0, 6), "the existing harness migrates the 0001~0006 chain").toEqual(BEFORE_0007);
  for (const file of [EDITS_UP, EDITS_DOWN]) expect(existsSync(file), `${path.relative(APP_DIR, file)} must exist (PLAN §1)`).toBe(true);
  expect(pairs, "the default up must apply 0007_story_edits").toEqual([...BEFORE_0007, [7, "story_edits"]]);
}

async function withEdits(label: string, fn: (api: Api, pool: pg.Pool, db: DisposableDatabase) => Promise<void>, poolMax = 2): Promise<void> {
  const db = await freshMigratedDb(env, label);
  await expectEditsApplied(db);
  const api = await loadApi();
  const pool = openAppPool(db, poolMax);
  try {
    await appBackend(pool);
    await fn(api, pool, db);
    await expectLedgerInvariants(env, db);
  } finally {
    await endAllPools();
  }
}

const owner = <T>(db: DisposableDatabase, fn: (c: pg.Client) => Promise<T>) => withOwner(env, db, fn);
const q = async <T extends Record<string, unknown>>(db: DisposableDatabase, sql: string, params: unknown[] = []): Promise<T[]> =>
  owner(db, async (c) => (await c.query<T>(sql, params)).rows);

function ok<T, E extends string>(r: Result<T, E>, label: string): T {
  expect(r.ok, `${label}: ${r.ok ? "" : r.error}`).toBe(true);
  if (!r.ok) throw new Error(label);
  return r.value;
}

async function newUser(db: DisposableDatabase, gen = 1): Promise<Subject> {
  const userId = await seedUser(env, db, [{ provider: "testprov", subject: `edits-${randomUUID()}` }], { granted: true, gen });
  return { userId, gen };
}
async function seedMoment(db: DisposableDatabase, userId: string, at: string, body: string, date = DAY): Promise<{ id: string; version: number }> {
  const rows = await q<{ id: string; version: number }>(db,
    "INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body) VALUES ($1::uuid, $2::date, $3::timestamptz, $4) RETURNING id::text AS id, version",
    [userId, date, at, body]);
  return rows[0]!;
}
/** S1 v1 revision 공식의 독립 계산(PLAN_ai-daily-story-storage §2). */
function oracleV1(date: string, refs: readonly { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return sha256(`v1\n${date}\n${lines.join("")}`);
}

type Row = { id: string; local_date: string; version: number; source_revision: string; body: string; origin: string; base_version: number | null };
const storyRows = (db: DisposableDatabase, userId: string) => q<Row>(db,
  "SELECT id::text, local_date::text, version, source_revision, body, origin, base_version FROM pod.story_versions WHERE user_id = $1::uuid ORDER BY local_date, version", [userId]);
type JobRow = { id: string; local_date: string; kind: string; state: string; base_version: number | null; story_id: string | null; error: string | null };
const jobRows = (db: DisposableDatabase, userId: string) => q<JobRow>(db,
  "SELECT id::text, local_date::text, kind, state, base_version, story_id::text, error FROM pod.story_jobs WHERE user_id = $1::uuid ORDER BY created_at, id", [userId]);
type UsageRow = { job_id: string; state: string; input_tokens: number | null; output_tokens: number | null };
const usageRows = (db: DisposableDatabase) => q<UsageRow>(db, "SELECT job_id::text, state, input_tokens, output_tokens FROM pod.story_usage ORDER BY created_at, id");
const momentDump = (db: DisposableDatabase, userId: string) => q(db,
  "SELECT id::text, local_date::text, occurred_at::text, body, version, updated_at::text FROM pod.diary_moments WHERE user_id = $1::uuid ORDER BY id", [userId]);

/** 메모 2개인 하루 + owner fixture v1(AI 최초, base NULL, 실제 v1 revision). 수동 동의는 manual=true일 때만. */
async function storyDay(api: Api, pool: pg.Pool, db: DisposableDatabase, opts: { manual?: boolean; date?: string } = {}) {
  const date = opts.date ?? DAY;
  const s = await newUser(db);
  const m1 = await seedMoment(db, s.userId, `${date}T09:00:00+09:00`, "ci-only 아침 산책", date);
  const m2 = await seedMoment(db, s.userId, `${date}T20:10:00+09:00`, "ci-only 저녁 메모", date);
  const revision = oracleV1(date, [m1, m2]);
  await owner(db, (c) => c.query(
    "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1::uuid, $2::date, 1, $3, $4)",
    [s.userId, date, revision, V1_BODY]));
  if (opts.manual) ok(await api.saveStoryAiSettings(pool, s, { manual: true, auto: false }), "consent");
  return { s, m1, m2, revision, date };
}

/** 기존 v1 행이 바이트 그대로인지(UPDATE 0). */
async function expectV1Kept(db: DisposableDatabase, userId: string, date = DAY): Promise<void> {
  const v1 = (await storyRows(db, userId)).find((r) => r.local_date === date && r.version === 1);
  expect(v1, "v1 row kept").toBeDefined();
  expect(sha256(v1!.body), "v1 body bytes unchanged").toBe(sha256(V1_BODY));
  expect(v1).toMatchObject({ origin: "ai", base_version: null });
}

function claudeMessage(text = REGEN_BODY) {
  return {
    id: "msg_ci_edits", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    usage: { input_tokens: 900, output_tokens: 120 },
  };
}
function mockFetch(text = REGEN_BODY, before?: () => Promise<void>) {
  const bodies: string[] = [];
  const fn = vi.fn<FetchLike>(async (target, init) => {
    bodies.push(await new Request(target, init).text());
    if (before) await before();
    return new Response(JSON.stringify(claudeMessage(text)), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fn, bodies };
}
const noBlobs: Blobs = { async get() { throw new Error("no photo is read in memo-only days"); } };

/** owner가 사용자 수정본 1행을 직접 끼워 넣는다(경쟁 상황 재현용 fixture: 최신 version을 바꾼다). */
async function interleaveUserEdit(db: DisposableDatabase, userId: string, base: number, revision: string, date = DAY): Promise<void> {
  await owner(db, (c) => c.query(
    "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body, origin, base_version) VALUES ($1::uuid, $2::date, $3, $4, 'ci-only 끼어든 수정', 'user_edit', $5)",
    [userId, date, base + 1, revision, base]));
}

async function purgeNow(db: DisposableDatabase, userId: string): Promise<void> {
  await setPending(env, db, userId, "clock_timestamp() - interval '721 hours'");
  const purge = await openPurge(env, db);
  try {
    const r = await purge.client.query<{ r: string }>("SELECT pod.purge_user_if_due($1::uuid) AS r", [userId]);
    expect(r.rows[0]?.r, "the real purge function removed the due account").toBe("purged");
  } finally {
    await purge.close();
  }
}

/** UNIQUE 제약을 이름이 아니라 열 목록으로 찾는다. */
const uniqueByColumns = (c: pg.Client, table: string) => c.query<{ conname: string; cols: string }>(
  `SELECT con.conname, string_agg(a.attname, ',' ORDER BY k.ord) AS cols
     FROM pg_constraint con
     CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE con.conrelid = $1::regclass AND con.contype = 'u'
    GROUP BY con.conname ORDER BY 2`, [table]).then((r) => r.rows);
const indexDefs = (c: pg.Client, table: string) => c.query<{ name: string; def: string }>(
  "SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'pod' AND tablename = $1 ORDER BY 1", [table]).then((r) => r.rows);

async function migrated0006(label: string): Promise<DisposableDatabase> {
  const db = await createDisposableDatabase(env, label);
  const files: Record<string, string> = {};
  for (const name of FILES_0006) for (const kind of ["up", "down"]) files[`${name}.${kind}.sql`] = await readFile(path.join(PRODUCT_MIGRATIONS_DIR, `${name}.${kind}.sql`), "utf8");
  expectCliOk(await runMigrateCli(["up", "--migrations-dir", await makeMigrationsDir(files)], db.urls.migrator), db.urls.migrator);
  expect((await owner(db, (c) => readMigrationRows(c)))?.map((r) => [r.version, r.name]), "0006-only database").toEqual(BEFORE_0007);
  return db;
}

// ---------------------------------------------------------------- 0007 schema·권한·down

describe("0007_story_edits schema, privileges and down guard", () => {
  it("applies on an existing 0006 database, keeps every story row as origin ai/base NULL and changes nothing outside story_versions/story_jobs", async () => {
    const db = await migrated0006("editsexpand");
    const s = await seedUser(env, db, [{ provider: "testprov", subject: `edits-${randomUUID()}` }], { granted: true });
    const r1 = sha256("ci-only-rev-1");
    await owner(db, async (c) => {
      const cons = await uniqueByColumns(c, "pod.story_versions");
      expect(cons.map((x) => x.cols).sort(), "0005 keys by columns").toEqual(["user_id,local_date,source_revision", "user_id,local_date,version"]);
      expect(cons.every((x) => x.conname.length <= 63), "PG identifier limit").toBe(true);
      await c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '보존할 이야기 1'), ($1, $2, 2, $4, '보존할 이야기 2')",
        [s, DAY, r1, sha256("ci-only-rev-2")]);
      await c.query("INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, error) VALUES ($1, $2, 'manual', 'failed', $3, 1, 1, 1, 'unavailable')", [s, DAY, r1]);
    });
    const before = await owner(db, async (c) => ({
      snap: await schemaSnapshot(c),
      stories: (await c.query("SELECT id::text, version, source_revision, body, created_at::text FROM pod.story_versions ORDER BY version")).rows,
      jobs: (await c.query("SELECT id::text, state, source_revision, error FROM pod.story_jobs ORDER BY id")).rows,
    }));
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectEditsApplied(db);
    await owner(db, async (c) => {
      const outside = (line: string) => !line.includes("story_versions") && !line.includes("story_jobs");
      expect((await schemaSnapshot(c)).filter(outside), "0007 changes nothing outside story_versions/story_jobs").toEqual(before.snap.filter(outside));
      expect((await c.query("SELECT id::text, version, source_revision, body, created_at::text FROM pod.story_versions ORDER BY version")).rows).toEqual(before.stories);
      expect((await c.query("SELECT origin, base_version FROM pod.story_versions ORDER BY version")).rows).toEqual([{ origin: "ai", base_version: null }, { origin: "ai", base_version: null }]);
      expect((await c.query("SELECT id::text, state, source_revision, error FROM pod.story_jobs ORDER BY id")).rows).toEqual(before.jobs);
      expect((await c.query("SELECT base_version FROM pod.story_jobs")).rows).toEqual([{ base_version: null }]);
      const tables = (await c.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'pod' ORDER BY 1")).rows.map((r) => r.t);
      expect(tables, "no new table: still the fifteen user-data tables").toEqual([...USER_DATA_TABLES].sort());
    });
  }, 120_000);

  it("adds origin/base_version columns, the self FK, the partial revision index and job base_version without new UPDATE privileges", async () => {
    const db = await freshMigratedDb(env, "editsschema");
    await expectEditsApplied(db);
    await owner(db, async (c) => {
      const cols = (await c.query<{ t: string; col: string; type: string; nul: string; def: string | null }>(
        `SELECT table_name AS t, column_name AS col, data_type AS type, is_nullable AS nul, column_default AS def FROM information_schema.columns
          WHERE table_schema = 'pod' AND ((table_name = 'story_versions' AND column_name IN ('origin', 'base_version')) OR (table_name = 'story_jobs' AND column_name = 'base_version'))
          ORDER BY 1, 2`)).rows;
      expect(cols).toEqual([
        { t: "story_jobs", col: "base_version", type: "integer", nul: "YES", def: null },
        { t: "story_versions", col: "base_version", type: "integer", nul: "YES", def: null },
        { t: "story_versions", col: "origin", type: "text", nul: "NO", def: "'ai'::text" },
      ]);
      expect((await uniqueByColumns(c, "pod.story_versions")).map((x) => x.cols), "the full-table revision key is gone; the version key stays").toEqual(["user_id,local_date,version"]);
      const fks = (await c.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'pod.story_versions'::regclass AND contype = 'f' ORDER BY 1")).rows.map((r) => r.def);
      expect(fks).toEqual([
        "FOREIGN KEY (user_id) REFERENCES pod.users(id) ON DELETE CASCADE",
        "FOREIGN KEY (user_id, local_date, base_version) REFERENCES pod.story_versions(user_id, local_date, version)",
      ]);
      const sv = await indexDefs(c, "story_versions");
      expect(sv.find((i) => i.name === "story_versions_first_per_revision")?.def)
        .toBe("CREATE UNIQUE INDEX story_versions_first_per_revision ON pod.story_versions USING btree (user_id, local_date, source_revision) WHERE (base_version IS NULL)");
      expect(sv, "PK, version key and the partial revision index only").toHaveLength(3);
      const jobs = await indexDefs(c, "story_jobs");
      const manualOnce = jobs.find((i) => i.name === "story_jobs_manual_once")?.def ?? "";
      expect(manualOnce).toMatch(/^CREATE UNIQUE INDEX story_jobs_manual_once ON pod\.story_jobs USING btree \(user_id, local_date, source_revision\) WHERE /);
      expect(manualOnce).toMatch(/base_version IS NULL/);
      const regenOnce = jobs.find((i) => i.name === "story_jobs_regen_once")?.def ?? "";
      expect(regenOnce).toMatch(/^CREATE UNIQUE INDEX story_jobs_regen_once ON pod\.story_jobs USING btree \(user_id, local_date, base_version\) WHERE /);
      expect(regenOnce).toMatch(/base_version IS NOT NULL/);
      for (const name of ["story_jobs_one_inflight", "story_jobs_scheduled_once", "story_jobs_queue", "story_jobs_by_day"]) expect(jobs.some((i) => i.name === name), `${name} kept`).toBe(true);
      const priv = (await c.query<Record<string, boolean>>(
        `SELECT has_table_privilege($1, 'pod.story_versions', 'SELECT') AS sel, has_table_privilege($1, 'pod.story_versions', 'INSERT') AS ins,
                has_table_privilege($1, 'pod.story_versions', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS other,
                has_any_column_privilege($1, 'pod.story_versions', 'UPDATE,REFERENCES') AS col,
                has_column_privilege($1, 'pod.story_jobs', 'base_version', 'UPDATE') AS job_base_update`, [CI_ROLES.app])).rows[0];
      expect(priv).toEqual({ sel: true, ins: true, other: false, col: false, job_base_update: false });
    });
  }, 90_000);

  it("enforces origin/base CHECKs, the self FK and partial uniqueness, and the app role cannot UPDATE or DELETE versions or job bases", async () => {
    await withEdits("editsconstraints", async (api, pool, db) => {
      const { s, revision } = await storyDay(api, pool, db, { manual: true });
      const r2 = sha256("ci-only-other-rev");
      await withApp(env, db, async (c) => {
        const ins = (version: number, rev: string, origin: string | null, base: number | null, date = DAY) => c.query(
          `INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body, origin, base_version)
           VALUES ($1, $2, $3, $4, 'ci-only 본문', COALESCE($5, 'ai'), $6)`, [s.userId, date, version, rev, origin, base]);
        await expectSqlError(ins(2, revision, "other", 1), "23514");
        await expectSqlError(ins(2, revision, "user_edit", null), "23514"); // 수정본은 base 필수
        await expectSqlError(ins(2, revision, "ai", 0), "23514");
        await expectSqlError(ins(2, revision, "ai", 2), "23514"); // base < version
        await expectSqlError(ins(3, revision, "ai", 2), "23503"); // 없는 version을 base로
        await expectSqlError(ins(2, revision, "ai", 1, OTHER_DAY), "23503"); // 다른 날의 version은 base가 아니다
        await expectSqlError(ins(2, revision, "ai", null), "23505"); // base NULL끼리는 같은 revision 1행
        await ins(2, revision, "user_edit", 1); // base 있는 행은 같은 revision 허용
        await ins(3, revision, "ai", 2);
        await ins(4, r2, null, null); // 새 입력의 최초 생성
        await expectSqlError(c.query("UPDATE pod.story_versions SET body = body WHERE user_id = $1", [s.userId]), "42501");
        await expectSqlError(c.query("UPDATE pod.story_versions SET base_version = base_version WHERE user_id = $1", [s.userId]), "42501");
        await expectSqlError(c.query("DELETE FROM pod.story_versions WHERE user_id = $1", [s.userId]), "42501");
        const job = (kind: string, state: string, base: number | null, rev: string | null = revision, error: string | null = null, date = DAY) => c.query(
          `INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, base_version, error)
           VALUES ($1, $2, $3, $4, $5, 1, 1, 1, $6, $7) RETURNING id::text`, [s.userId, date, kind, state, rev, base, error]);
        await expectSqlError(job("manual", "failed", 0, revision, "unavailable"), "23514");
        await expectSqlError(job("scheduled", "skipped", 1, null, "no_input"), "23514"); // base는 manual만
        await job("manual", "succeeded", null);
        await expectSqlError(job("manual", "succeeded", null), "23505"); // 기존 manual_once(base NULL)
        await job("manual", "succeeded", 1); // 재생성은 같은 revision의 성공 job과 공존
        await expectSqlError(job("manual", "succeeded", 1), "23505"); // regen_once
        await job("manual", "failed", 1, revision, "unavailable"); // 실패는 regen_once 밖
        await job("manual", "succeeded", 1, revision, null, OTHER_DAY); // 다른 날은 별개
        const [one] = (await c.query<{ id: string }>("SELECT id::text FROM pod.story_jobs WHERE user_id = $1 AND base_version = 1 LIMIT 1", [s.userId])).rows;
        await expectSqlError(c.query("UPDATE pod.story_jobs SET base_version = 2 WHERE id = $1", [one!.id]), "42501");
      });
    });
  }, 90_000);

  it("cascades a whole edit/regeneration chain on the real purge and keeps only the anonymous usage ledger", async () => {
    await withEdits("editspurge", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      const other = await storyDay(api, pool, db, { manual: true });
      ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: "ci-only 고친 글" }), "edit");
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 2 }), "regen request");
      expect((await api.runOneStoryJob({ db: pool, blobs: noBlobs, claude: CLAUDE, fetch: mockFetch().fn })).result).toBe("succeeded");
      expect((await storyRows(db, d.s.userId)).map((r) => [r.version, r.origin, r.base_version])).toEqual([[1, "ai", null], [2, "user_edit", 1], [3, "ai", 2]]);
      const usageBefore = await usageRows(db);
      expect(usageBefore).toHaveLength(1);
      const otherBefore = await storyRows(db, other.s.userId);
      await purgeNow(db, d.s.userId);
      expect(await storyRows(db, d.s.userId)).toEqual([]);
      expect(await jobRows(db, d.s.userId)).toEqual([]);
      expect(await usageRows(db), "usage ledger survives the purge").toEqual(usageBefore);
      expect(await storyRows(db, other.s.userId), "other accounts untouched").toEqual(otherBefore);
    });
  }, 120_000);

  it("down refuses with user data or outside ci, and an empty CI down --to 6 restores exactly the 0006 schema; up restores 0007", async () => {
    const reference = await migrated0006("edits0006ref");
    const snap0006 = await owner(reference, (c) => schemaSnapshot(c));
    const db = await freshMigratedDb(env, "editsdown");
    await expectEditsApplied(db);
    const downSql = await readFile(EDITS_DOWN, "utf8");
    const firstChange = downSql.search(/^\s*(?:DROP|ALTER|CREATE)\b/m);
    expect(firstChange, "down changes the schema").toBeGreaterThan(0);
    const guard = downSql.slice(0, firstChange);
    expect(guard, "the DO guard runs before any schema change").toMatch(/db_environment[\s\S]*'ci'/);
    for (const t of USER_DATA_TABLES) expect(guard, `down guard checks pod.${t}`).toMatch(new RegExp(`\\bFROM\\s+pod\\.${t}\\b`));
    const full = await owner(db, (c) => schemaSnapshot(c));
    const s = await seedUser(env, db, []);
    expectCliFail(await runMigrateCli(["down", "--to", "6", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await owner(db, async (c) => {
      await expectSqlError(c.query(downSql), "P0001");
      expect(await schemaSnapshot(c)).toEqual(full);
      expect((await readMigrationRows(c))?.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
    await purgeNow(db, s);
    await owner(db, async (c) => {
      expect((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.users")).rows[0]!.n).toBe(0);
      await c.query("UPDATE pod_meta.db_environment SET name = 'dev'");
      try { await expectSqlError(c.query(downSql), "P0001"); } finally { await c.query("UPDATE pod_meta.db_environment SET name = 'ci'"); }
    });
    expectCliOk(await runMigrateCli(["down", "--to", "6", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await owner(db, async (c) => {
      expect((await readMigrationRows(c))?.map((r) => [r.version, r.name])).toEqual(BEFORE_0007);
      expect(await schemaSnapshot(c), "down --to 6 equals a 0006-only database").toEqual(snap0006);
      expect((await uniqueByColumns(c, "pod.story_versions")).map((x) => x.cols)).toEqual(["user_id,local_date,source_revision", "user_id,local_date,version"]);
    });
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectEditsApplied(db);
    expect(await owner(db, (c) => schemaSnapshot(c)), "down/up round trip").toEqual(full);
  }, 150_000);
});

// ---------------------------------------------------------------- 직접 수정

describe("editStoryVersion", () => {
  it("appends a user_edit version on the latest story with the inherited v1 revision, stays current, keeps v1 and never touches moments", async () => {
    await withEdits("editsok", async (api, pool, db) => {
      const d = await storyDay(api, pool, db);
      const moments = await momentDump(db, d.s.userId);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const edited = "  ci-only 아침 산책이 좋았다.\n두 번째 줄.\t끝  ";
      const value = ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: edited }), "edit");
      expect(Object.keys(value).sort()).toEqual(["story", "unchanged"]);
      expect(value.unchanged).toBe(false);
      expect(Object.keys(value.story).sort(), "edited DTO keys").toEqual(["body", "createdAt", "edited", "id", "version"]);
      expect(value.story).toMatchObject({ version: 2, body: edited.trim(), edited: true });
      const rows = await storyRows(db, d.s.userId);
      expect(rows.map((r) => [r.version, r.origin, r.base_version, r.source_revision, r.body])).toEqual([
        [1, "ai", null, d.revision, V1_BODY],
        [2, "user_edit", 1, d.revision, edited.trim()],
      ]);
      expect(rows[1]!.id).toBe(value.story.id);
      await expectV1Kept(db, d.s.userId);
      expect(await momentDump(db, d.s.userId), "moments are neither read for writing nor changed").toEqual(moments);
      expect(fetchSpy, "no external request").not.toHaveBeenCalled();

      const day = ok(await api.readStoryDay(pool, d.s, DAY), "read");
      expect(day).toStrictEqual({ date: DAY, inputRevision: d.revision, story: value.story, state: "current", generation: "unavailable" });
      const latest = await api.findLatestStory(pool, d.s.userId, DAY);
      expect(latest).toStrictEqual({ ...value.story, sourceRevision: d.revision });
      expect(await api.findStoryByRevision(pool, d.s.userId, DAY, d.revision), "the latest version of a revision").toStrictEqual(value.story);

      // 이후 조각 변경 → outdated(수정본 revision은 실제 입력 그대로였다).
      await owner(db, (c) => c.query("UPDATE pod.diary_moments SET body = 'ci-only 바뀐 메모', version = version + 1 WHERE id = $1", [d.m1.id]));
      const after = ok(await api.readStoryDay(pool, d.s, DAY), "read after change");
      expect(after.state).toBe("outdated");
      expect(after.story).toStrictEqual(value.story);
      // outdated여도 직접 수정은 가능하고 revision은 그대로 승계한다(가짜 current 0).
      const again = ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 2, body: "ci-only 다시 고침" }), "edit outdated");
      expect(again.story.version).toBe(3);
      expect((await storyRows(db, d.s.userId))[2]).toMatchObject({ origin: "user_edit", base_version: 2, source_revision: d.revision });
      expect(ok(await api.readStoryDay(pool, d.s, DAY), "read").state).toBe("outdated");
    });
  }, 90_000);

  it("AI versions keep the four-key DTO without an edited key", async () => {
    await withEdits("editsaikeys", async (api, pool, db) => {
      const d = await storyDay(api, pool, db);
      const day = ok(await api.readStoryDay(pool, d.s, DAY), "read");
      expect(Object.keys(day.story!).sort()).toEqual(["body", "createdAt", "id", "version"]);
      expect("edited" in day.story!).toBe(false);
      const latest = await api.findLatestStory(pool, d.s.userId, DAY);
      expect(Object.keys(latest!).sort()).toEqual(["body", "createdAt", "id", "sourceRevision", "version"]);
    });
  }, 90_000);

  it("returns unchanged without inserting when the trimmed body equals the latest body", async () => {
    await withEdits("editsnoop", async (api, pool, db) => {
      const d = await storyDay(api, pool, db);
      for (const body of [V1_BODY, `  ${V1_BODY}\n`, `\t${V1_BODY}  `]) {
        const value = ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body }), "noop");
        expect(value.unchanged).toBe(true);
        expect(value.story).toMatchObject({ version: 1, body: V1_BODY });
        expect("edited" in value.story).toBe(false);
      }
      expect(await storyRows(db, d.s.userId)).toHaveLength(1);
    });
  }, 90_000);

  it("validates the exact input shape and body before SQL: control characters, blank and 2001 codepoints are invalid_body; 2000 codepoints and LF/CR/TAB pass", async () => {
    await withEdits("editsvalidate", async (api, pool, db) => {
      const d = await storyDay(api, pool, db);
      const invalidBody: [string, unknown][] = [
        ["null", null], ["string", "본문"], ["array", [1, "본문"]], ["missing body", { expectedVersion: 1 }],
        ["number body", { expectedVersion: 1, body: 1 }], ["extra key", { expectedVersion: 1, body: "본문", extra: true }],
        ["empty", { expectedVersion: 1, body: "" }], ["blank", { expectedVersion: 1, body: " \n\t " }],
        ["2001 codepoints", { expectedVersion: 1, body: "😀".repeat(2001) }],
        ["C0 BEL", { expectedVersion: 1, body: "이야기\u0007" }], ["C0 VT at the edge (trim must not hide it)", { expectedVersion: 1, body: "\u000b이야기" }],
        ["DEL", { expectedVersion: 1, body: "이야기\u007f" }], ["C1 NEL", { expectedVersion: 1, body: "이야기\u0085" }],
        ["C1 CSI", { expectedVersion: 1, body: "이야기\u009b" }], ["NUL", { expectedVersion: 1, body: "이야\u0000기" }],
      ];
      for (const [label, input] of invalidBody) expect(await api.editStoryVersion(pool, d.s, DAY, input), label).toEqual({ ok: false, error: "invalid_body" });
      for (const expectedVersion of [0, -1, 1.5, "1", null, Number.NaN, 2 ** 53]) {
        expect(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion, body: "본문" }), `expectedVersion ${String(expectedVersion)}`).toEqual({ ok: false, error: "conflict" });
      }
      for (const date of ["2026-02-30", "2026-11-9", "", "x"]) expect(await api.editStoryVersion(pool, d.s, date, { expectedVersion: 1, body: "본문" }), date).toEqual({ ok: false, error: "invalid_date" });
      expect(await storyRows(db, d.s.userId), "nothing stored by refused input").toHaveLength(1);

      const max = "😀".repeat(2000); // 4000 UTF-16 units, 2000 codepoints
      expect(ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: max }), "max").story.body).toBe(max);
      const lines = "첫 줄\r\n둘째\t칸\n셋째";
      expect(ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 2, body: lines }), "LF/CR/TAB").story.body).toBe(lines);
      const html = "<b>굵게</b> <script>x</script>";
      expect(ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 3, body: html }), "html as text").story.body).toBe(html);
    });
  }, 90_000);

  it("refuses stale gen, pending deletion and malformed subjects as not_signed_in, and isolates other accounts", async () => {
    await withEdits("editsauth", async (api, pool, db) => {
      const d = await storyDay(api, pool, db);
      const input = { expectedVersion: 1, body: "ci-only 남의 글 고치기" };
      expect(await api.editStoryVersion(pool, { userId: d.s.userId, gen: 2 }, DAY, input)).toEqual({ ok: false, error: "not_signed_in" });
      for (const subject of [null, {}, { userId: "x", gen: 1 }, { userId: d.s.userId, gen: 0 }]) {
        expect(await api.editStoryVersion(pool, subject as unknown as Subject, DAY, input)).toEqual({ ok: false, error: "not_signed_in" });
      }
      const stranger = await newUser(db);
      expect(await api.editStoryVersion(pool, stranger, DAY, input), "another account has no story on that date").toEqual({ ok: false, error: "conflict" });
      expect(ok(await api.readStoryDay(pool, stranger, DAY), "stranger read").story, "another account cannot read it").toBeNull();
      const pending = await storyDay(api, pool, db);
      await setPending(env, db, pending.s.userId, "now()");
      expect(await api.editStoryVersion(pool, pending.s, DAY, input)).toEqual({ ok: false, error: "not_signed_in" });
      expect(await storyRows(db, d.s.userId)).toHaveLength(1);
      expect(await storyRows(db, stranger.userId)).toEqual([]);
      expect(await storyRows(db, pending.s.userId)).toHaveLength(1);
    });
  }, 90_000);

  it("is a conflict when the expected version is not the latest (or there is no story) and busy while a job for that date is queued or running", async () => {
    await withEdits("editsconflict", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      expect(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 2, body: "미래 버전" })).toEqual({ ok: false, error: "conflict" });
      expect(await api.editStoryVersion(pool, d.s, OTHER_DAY, { expectedVersion: 1, body: "없는 날" })).toEqual({ ok: false, error: "conflict" });
      ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: "첫 수정" }), "first edit");
      expect(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: "옛 화면에서 수정" }), "stale screen").toEqual({ ok: false, error: "conflict" });

      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 2 }), "regen queued");
      expect(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 2, body: "생성 중 수정" }), "queued").toEqual({ ok: false, error: "busy" });
      const claim = await api.claimStoryJob(pool);
      expect(claim.kind).toBe("claimed");
      expect(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 2, body: "실행 중 수정" }), "running").toEqual({ ok: false, error: "busy" });
      expect((await storyRows(db, d.s.userId)).map((r) => r.version)).toEqual([1, 2]);

      // 다른 날짜의 진행 중 job은 이 날짜 수정을 막지 않는다.
      const e = await storyDay(api, pool, db, { manual: true });
      await seedMoment(db, e.s.userId, `${OTHER_DAY}T10:00:00+09:00`, "ci-only 다른 날", OTHER_DAY);
      ok(await api.requestManualStory(pool, e.s, OTHER_DAY, { now: NOW }), "other day job");
      ok(await api.editStoryVersion(pool, e.s, DAY, { expectedVersion: 1, body: "다른 날 job과 무관" }), "edit while other day queued");
    });
  }, 90_000);

  it("serializes two concurrent edits from the same version on two pools: exactly one version 2 and one conflict", async () => {
    await withEdits("editsrace", async (api, _pool, db) => {
      const a = openAppPool(db, 1);
      const b = openAppPool(db, 1);
      const d = await storyDay(api, a, db);
      const results = await Promise.all([
        api.editStoryVersion(a, d.s, DAY, { expectedVersion: 1, body: "ci-only 폰에서 고침" }),
        api.editStoryVersion(b, d.s, DAY, { expectedVersion: 1, body: "ci-only PC에서 고침" }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "conflict" }]);
      const rows = await storyRows(db, d.s.userId);
      expect(rows.map((r) => [r.version, r.origin, r.base_version])).toEqual([[1, "ai", null], [2, "user_edit", 1]]);
      await expectV1Kept(db, d.s.userId);
    });
  }, 90_000);
});

// ---------------------------------------------------------------- 같은 입력 재생성

describe("requestManualStory with expectedStoryVersion (regeneration)", () => {
  it("queues one manual job with base_version for the current latest story; without the option the existing already_current stays", async () => {
    await withEdits("regenrequest", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW }), "legacy path unchanged").toEqual({ ok: false, error: "already_current" });
      const { jobId } = ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen");
      const [job] = await jobRows(db, d.s.userId);
      expect(job).toEqual({ id: jobId, local_date: DAY, kind: "manual", state: "queued", base_version: 1, story_id: null, error: null });
      const snap = await q<{ rev: string; gen: string; cv: number; cr: string }>(db,
        "SELECT source_revision AS rev, auth_generation::text AS gen, consent_version AS cv, consent_revision::text AS cr FROM pod.story_jobs WHERE id = $1", [jobId]);
      const input = ok(await api.captureStoryInputV2(pool, d.s.userId, DAY), "capture");
      expect(snap).toEqual([{ rev: input.revision, gen: "1", cv: 1, cr: "1" }]);
      expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "one in flight").toEqual({ ok: false, error: "busy" });
      expect(await jobRows(db, d.s.userId)).toHaveLength(1);
    });
  }, 90_000);

  it("is a conflict for a malformed or stale expected version, a missing story or an outdated latest story (outdated uses the normal path)", async () => {
    await withEdits("regenconflict", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      for (const expectedStoryVersion of [0, -1, 1.5, "1", Number.NaN, 2 ** 53, 2]) {
        expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion }), String(expectedStoryVersion)).toEqual({ ok: false, error: "conflict" });
      }
      const fresh = await newUser(db);
      await seedMoment(db, fresh.userId, `${DAY}T09:00:00+09:00`, "ci-only 이야기 없는 날");
      ok(await api.saveStoryAiSettings(pool, fresh, { manual: true, auto: false }), "consent");
      expect(await api.requestManualStory(pool, fresh, DAY, { now: NOW, expectedStoryVersion: 1 }), "no story yet").toEqual({ ok: false, error: "conflict" });
      await owner(db, (c) => c.query("UPDATE pod.diary_moments SET body = 'ci-only 바뀐 메모', version = version + 1 WHERE id = $1", [d.m1.id]));
      expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "outdated").toEqual({ ok: false, error: "conflict" });
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW }), "outdated → normal generation");
      expect((await jobRows(db, d.s.userId)).map((j) => j.base_version)).toEqual([null]);
      expect(await jobRows(db, fresh.userId)).toEqual([]);
    });
  }, 90_000);

  it("keeps consent, account and the shared three-a-day limit, and maps a regen_once conflict to already_current", async () => {
    await withEdits("regenlimits", async (api, pool, db) => {
      const off = await storyDay(api, pool, db);
      expect(await api.requestManualStory(pool, off.s, DAY, { now: NOW, expectedStoryVersion: 1 })).toEqual({ ok: false, error: "consent_missing" });
      const stale = await storyDay(api, pool, db, { manual: true });
      expect(await api.requestManualStory(pool, { userId: stale.s.userId, gen: 2 }, DAY, { now: NOW, expectedStoryVersion: 1 })).toEqual({ ok: false, error: "not_signed_in" });

      const d = await storyDay(api, pool, db, { manual: true });
      const failedManual = (date: string) => owner(db, (c) => c.query(
        "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, error) VALUES ($1, $2, 'manual', 'failed', $3, 1, 1, 1, 'unavailable')",
        [d.s.userId, date, sha256(`ci-only-limit-${date}`)]));
      await failedManual("2026-11-01");
      await failedManual("2026-11-02");
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "third request of the day is a regeneration");
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable' WHERE user_id = $1 AND base_version = 1", [d.s.userId]));
      expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regeneration shares the limit").toEqual({ ok: false, error: "limited" });

      const dup = await storyDay(api, pool, db, { manual: true });
      // 같은 base의 성공 job이 이미 있는 상태(owner fixture) → regen_once 고유 위반은 already_current.
      await owner(db, (c) => c.query(
        "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, base_version) VALUES ($1, $2, 'manual', 'succeeded', $3, 1, 1, 1, 1)",
        [dup.s.userId, DAY, sha256("ci-only-dup")]));
      expect(await api.requestManualStory(pool, dup.s, DAY, { now: NOW, expectedStoryVersion: 1 })).toEqual({ ok: false, error: "already_current" });
      expect(await jobRows(db, dup.s.userId)).toHaveLength(1);
    });
  }, 90_000);

  it("lets only one of two concurrent regeneration requests on two pools in (busy for the other)", async () => {
    await withEdits("regenrace", async (api, _pool, db) => {
      const a = openAppPool(db, 1);
      const b = openAppPool(db, 1);
      const d = await storyDay(api, a, db, { manual: true });
      const results = await Promise.all([
        api.requestManualStory(a, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }),
        api.requestManualStory(b, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "busy" }]);
      expect(await jobRows(db, d.s.userId)).toHaveLength(1);
    });
  }, 90_000);
});

describe("regeneration worker path (claim → markSent → finish) with mock fetch", () => {
  it("claims instead of skipping, sends the same memo input once, appends an ai version with base and settles usage; the story stays current", async () => {
    await withEdits("regenworker", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      const { jobId } = ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen");
      const f = mockFetch();
      expect((await api.runOneStoryJob({ db: pool, blobs: noBlobs, claude: CLAUDE, fetch: f.fn })).result).toBe("succeeded");
      expect(f.fn).toHaveBeenCalledTimes(1);
      expect(f.bodies[0], "the memo input is sent").toContain("ci-only 아침 산책");
      expect(f.bodies[0], "the current story body is not sent").not.toContain("AI가 처음 쓴");
      const rows = await storyRows(db, d.s.userId);
      expect(rows.map((r) => [r.version, r.origin, r.base_version, r.source_revision, r.body])).toEqual([
        [1, "ai", null, d.revision, V1_BODY],
        [2, "ai", 1, d.revision, REGEN_BODY],
      ]);
      await expectV1Kept(db, d.s.userId);
      expect(await jobRows(db, d.s.userId)).toEqual([{ id: jobId, local_date: DAY, kind: "manual", state: "succeeded", base_version: 1, story_id: rows[1]!.id, error: null }]);
      expect(await usageRows(db)).toEqual([{ job_id: jobId, state: "settled", input_tokens: 900, output_tokens: 120 }]);
      const day = ok(await api.readStoryDay(pool, d.s, DAY), "read");
      expect(day.state).toBe("current");
      expect(day.story).toStrictEqual({ id: rows[1]!.id, version: 2, body: REGEN_BODY, createdAt: day.story!.createdAt });
      expect(await api.requestManualStory(pool, d.s, DAY, { now: NOW }), "legacy path still already_current").toEqual({ ok: false, error: "already_current" });
    });
  }, 120_000);

  it("carries baseVersion on the claimed job (null for a normal job)", async () => {
    await withEdits("regenclaimbase", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen");
      const claim = await api.claimStoryJob(pool);
      expect(claim.kind).toBe("claimed");
      if (claim.kind === "claimed") expect(claim.job.baseVersion).toBe(1);
      const n = await newUser(db);
      await seedMoment(db, n.userId, `${DAY}T09:00:00+09:00`, "ci-only 새 날");
      ok(await api.saveStoryAiSettings(pool, n, { manual: true, auto: false }), "consent");
      ok(await api.requestManualStory(pool, n, DAY, { now: NOW }), "normal");
      const normal = await api.claimStoryJob(pool);
      expect(normal.kind).toBe("claimed");
      if (normal.kind === "claimed") expect(normal.job.baseVersion ?? null).toBeNull();
    });
  }, 90_000);

  it("fails as input_changed without sending when the latest version moved before claim or before markSent", async () => {
    await withEdits("regenfence", async (api, pool, db) => {
      // claim 전 최신 변경
      const a = await storyDay(api, pool, db, { manual: true });
      ok(await api.requestManualStory(pool, a.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen a");
      await interleaveUserEdit(db, a.s.userId, 1, a.revision);
      const claim = await api.claimStoryJob(pool);
      expect(claim.kind).toBe("failed");
      expect((await jobRows(db, a.s.userId))[0]).toMatchObject({ state: "failed", error: "input_changed", story_id: null });

      // claim 뒤·송신 직전 최신 변경
      const b = await storyDay(api, pool, db, { manual: true });
      ok(await api.requestManualStory(pool, b.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen b");
      const claimed = await api.claimStoryJob(pool);
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") return;
      await interleaveUserEdit(db, b.s.userId, 1, b.revision);
      expect(await api.markStorySent(pool, claimed.job, MODEL)).toEqual({ ok: false, error: "input_changed" });
      expect((await jobRows(db, b.s.userId))[0]).toMatchObject({ state: "failed", error: "input_changed" });
      expect(await usageRows(db), "nothing sent, no usage row").toEqual([]);
      for (const s of [a.s, b.s]) expect((await storyRows(db, s.userId)).map((r) => r.version)).toEqual([1, 2]);
    });
  }, 90_000);

  it("stores nothing but settles usage when the latest version, input or consent changes while the request is in flight", async () => {
    await withEdits("regenfinish", async (api, pool, db) => {
      type D = Awaited<ReturnType<typeof storyDay>>;
      const changes: [string, (d: D) => Promise<unknown>, string, number[]][] = [
        ["latest version moved", (d) => interleaveUserEdit(db, d.s.userId, 1, d.revision), "input_changed", [1, 2]],
        ["memo edited", (d) => owner(db, (c) => c.query("UPDATE pod.diary_moments SET body = 'ci-only 바뀐 메모', version = version + 1 WHERE id = $1", [d.m1.id])), "input_changed", [1]],
        ["re-consented", (d) => owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_revision = consent_revision + 1 WHERE user_id = $1", [d.s.userId])), "consent_missing", [1]],
      ];
      for (const [label, change, error, versions] of changes) {
        const d = await storyDay(api, pool, db, { manual: true });
        const { jobId } = ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), label);
        const f = mockFetch(REGEN_BODY, async () => { await change(d); });
        expect((await api.runOneStoryJob({ db: pool, blobs: noBlobs, claude: CLAUDE, fetch: f.fn })).result, label).toBe("failed");
        expect((await jobRows(db, d.s.userId))[0], label).toMatchObject({ state: "failed", error, story_id: null });
        expect((await storyRows(db, d.s.userId)).map((r) => r.version), `${label}: no ai regeneration row`).toEqual(versions);
        expect((await storyRows(db, d.s.userId)).some((r) => r.body === REGEN_BODY), label).toBe(false);
        expect((await usageRows(db)).find((u) => u.job_id === jobId), label).toMatchObject({ state: "settled", input_tokens: 900, output_tokens: 120 });
        await expectV1Kept(db, d.s.userId);
      }
    });
  }, 240_000);

  it("refuses to store after the lease expired", async () => {
    await withEdits("regenlease", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 1 }), "regen");
      const claim = await api.claimStoryJob(pool);
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      expect(await api.markStorySent(pool, claim.job, MODEL)).toEqual({ ok: true });
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [claim.job.id]));
      expect(await api.finishStoryJob(pool, claim.job, { ok: true, body: REGEN_BODY, usage: { inputTokens: 5, outputTokens: 6 } })).toBe("failed");
      expect((await jobRows(db, d.s.userId))[0]).toMatchObject({ state: "failed", error: "lease_expired" });
      expect((await storyRows(db, d.s.userId)).map((r) => r.version)).toEqual([1]);
      expect((await usageRows(db))[0]).toMatchObject({ state: "settled", input_tokens: 5, output_tokens: 6 });
    });
  }, 90_000);

  it("chains versions: edit → regenerate → edit → regenerate, each based on the previous latest with the same revision", async () => {
    await withEdits("regenchain", async (api, pool, db) => {
      const d = await storyDay(api, pool, db, { manual: true });
      ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 1, body: "ci-only 첫 수정" }), "edit 2");
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 2 }), "regen 3");
      expect((await api.runOneStoryJob({ db: pool, blobs: noBlobs, claude: CLAUDE, fetch: mockFetch().fn })).result).toBe("succeeded");
      const afterRegen = ok(await api.readStoryDay(pool, d.s, DAY), "read 3");
      expect(afterRegen.story).toMatchObject({ version: 3, body: REGEN_BODY });
      expect("edited" in afterRegen.story!, "a regeneration is not an edit").toBe(false);
      ok(await api.editStoryVersion(pool, d.s, DAY, { expectedVersion: 3, body: "ci-only 두 번째 수정" }), "edit 4");
      ok(await api.requestManualStory(pool, d.s, DAY, { now: NOW, expectedStoryVersion: 4 }), "regen 5");
      expect((await api.runOneStoryJob({ db: pool, blobs: noBlobs, claude: CLAUDE, fetch: mockFetch("ci-only 세 번째 AI 글.").fn })).result).toBe("succeeded");
      const rows = await storyRows(db, d.s.userId);
      expect(rows.map((r) => [r.version, r.origin, r.base_version])).toEqual([[1, "ai", null], [2, "user_edit", 1], [3, "ai", 2], [4, "user_edit", 3], [5, "ai", 4]]);
      expect(new Set(rows.map((r) => r.source_revision))).toEqual(new Set([d.revision]));
      await expectV1Kept(db, d.s.userId);
      const day = ok(await api.readStoryDay(pool, d.s, DAY), "read 5");
      expect(day.state).toBe("current");
      expect(day.story?.version).toBe(5);
      expect(await usageRows(db)).toHaveLength(2);
    });
  }, 180_000);
});
