// PLAN_ai-story-live-generation §2·§4·§6 RED(DB). 일회용 PG18·실제 app role·실제 sharp·in-memory BlobStore·mock fetch만 쓴다.
// - 실제 API·키·S3·서비스 DB 0. mock fetch는 이 파일 안에만 있고 제품에 시험 경로를 요구하지 않는다.
// - 모든 사례는 먼저 0001~0005가 기존대로 적용됐는지 확인한 뒤 0006 파일 existsSync·적용 기록·to_regclass를 명시 단언한다.
//   제품 TS 모듈은 existsSync 뒤 변수 경로로 동적 import한다(부재는 TS/import 오류가 아니라 이 단언의 실패).
// - 날짜는 고정 과거 날짜다. 수동 요청의 '오늘'과 자동 enqueue의 시계는 opts.now로 주입한다(실제 현재 시각 의존 0).
//   enqueue의 opts.now는 main 확인 대기 가정(C1): enqueueDueStories(db, { now })가 SQL 시계 $::timestamptz를 대신한다.
// - lease·expire는 DB clock_timestamp 기준이다. 시험은 owner로 lease_until을 직접 과거/현재로 바꾸며 sleep·vi.waitFor를 쓰지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CI_ROLES, cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  APP_DIR, PRODUCT_MIGRATIONS_DIR, cleanupTempDirs, expectCliFail, expectCliOk, expectSqlError, readMigrationRows,
  relationExists, runMigrateCli, schemaSnapshot, withApp, withOwner,
} from "./f2-support";
import { UUID_RE, appBackend, endAllPools, expectLedgerInvariants, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { openPurge, seedUser, setPending } from "./f4-lifecycle-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §3·§4)

type Subject = { userId: string; gen: number };
type PhotoRef = { photoId: string; sha256: string; byteLength: number; objectKey: string };
type MomentV2 = { id: string; version: number; time: string; text: string; photo: PhotoRef | null };
type InputV2 = { date: string; revision: string; revisionV1: string; moments: MomentV2[] };
type View = Record<string, unknown> & { state: string };
type Claimed = { id: string; userId: string; date: string; kind: "manual" | "scheduled"; leaseToken: string; gen: number; consentVersion: number; consentRevision: number; input: InputV2 };
type ClaimResult = { kind: "none" } | { kind: "skipped" | "failed"; jobId: string } | { kind: "claimed"; job: Claimed };
type Usage = { inputTokens: number; outputTokens: number };
type Outcome = { ok: true; body: string; usage: Usage } | { ok: false; error: string; sent: boolean; usage: Usage | null };
type Blobs = {
  put: (key: string, photo: unknown, signal?: AbortSignal) => Promise<void>;
  get: (key: string, signal?: AbortSignal) => Promise<Buffer | null>;
  delete: (key: string, signal?: AbortSignal) => Promise<void>;
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type WorkerStats = { expired: number; enqueued: number; result: "closed" | "none" | "skipped" | "failed" | "succeeded" };
type Api = {
  STORY_MANUAL_DAILY_MAX: number;
  STORY_CONSENT_VERSION: number;
  getStoryAiSettings: (db: pg.Pool, userId: string) => Promise<{ manualEnabled: boolean; autoEnabled: boolean }>;
  saveStoryAiSettings: (db: pg.Pool, subject: Subject, input: unknown) => Promise<Result<{ manualEnabled: boolean; autoEnabled: boolean }, "not_signed_in" | "invalid_input">>;
  storyRevisionV2: (date: string, refs: readonly { id: string; version: number; photoSha256: string | null }[]) => string;
  captureStoryInputV2: (db: pg.Pool, userId: string, date: string) => Promise<Result<InputV2, string>>;
  storyRevision: (date: string, refs: readonly { id: string; version: number }[]) => string;
  requestManualStory: (db: pg.Pool, subject: Subject, date: string, opts?: { now?: () => Date }) => Promise<Result<{ jobId: string }, string>>;
  readStoryGeneration: (db: pg.Pool, userId: string, date: string, keyReady: boolean) => Promise<View>;
  expireStoryLeases: (db: pg.Pool) => Promise<number>;
  enqueueDueStories: (db: pg.Pool, opts?: { now?: Date }) => Promise<number>;
  claimStoryJob: (db: pg.Pool) => Promise<ClaimResult>;
  markStorySent: (db: pg.Pool, job: Claimed, model: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  finishStoryJob: (db: pg.Pool, job: Claimed, outcome: Outcome) => Promise<"succeeded" | "failed">;
  runOneStoryJob: (deps: { db: pg.Pool; blobs: Blobs | null; claude: { apiKey: string; model: string } | null; fetch?: FetchLike }) => Promise<WorkerStats>;
  STORY_JOB_DEADLINE_MS: number;
  appendStoryVersionTx: unknown;
};

const SRC = path.join(APP_DIR, "src");
const MODULES: [string, string[]][] = [
  [path.join(SRC, "shared", "stories.ts"), []],
  [path.join(SRC, "server", "stories", "input.pg.ts"), ["storyRevision"]],
  [path.join(SRC, "server", "stories", "store.pg.ts"), ["appendStoryVersionTx"]],
  [path.join(SRC, "server", "stories", "settings.pg.ts"), ["getStoryAiSettings", "saveStoryAiSettings"]],
  [path.join(SRC, "server", "stories", "input-v2.pg.ts"), ["storyRevisionV2", "captureStoryInputV2"]],
  [path.join(SRC, "server", "stories", "jobs.pg.ts"), ["requestManualStory", "readStoryGeneration", "expireStoryLeases", "enqueueDueStories", "claimStoryJob", "markStorySent", "finishStoryJob"]],
  [path.join(SRC, "server", "stories", "worker.ts"), ["runOneStoryJob"]],
];
const GEN_UP = path.join(PRODUCT_MIGRATIONS_DIR, "0006_story_generation.up.sql");
const GEN_DOWN = path.join(PRODUCT_MIGRATIONS_DIR, "0006_story_generation.down.sql");
const BEFORE_0006 = [[1, "init"], [2, "account_lifecycle"], [3, "reflection_time"], [4, "private_photos"], [5, "daily_stories"]];
const NEW_TABLES = ["story_ai_settings", "story_jobs", "story_usage"];

const DAY = "2026-11-09";
const NOW = () => new Date("2026-11-09T12:00:00.000Z"); // 서울 2026-11-09 21:00(주입 시계)
const MODEL = "claude-sonnet-5-5";
const CLAUDE = { apiKey: `sk-ant-api03-ci-only-jobs-${"q".repeat(40)}`, model: MODEL };
const STORY = "합성 사진과 메모로 만든 하루 이야기.";
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

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
    expect(existsSync(file), `${rel} must exist (PLAN_ai-story-live-generation §4)`).toBe(true);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const name of names) {
      expect(typeof mod[name], `${rel} must export function ${name}`).toBe("function");
      out[name] = mod[name];
    }
    if (rel.endsWith(path.join("shared", "stories.ts"))) {
      expect(mod.STORY_MANUAL_DAILY_MAX, "shared/stories.ts must export STORY_MANUAL_DAILY_MAX").toBe(3);
      expect(mod.STORY_CONSENT_VERSION, "shared/stories.ts must export STORY_CONSENT_VERSION").toBe(1);
      out.STORY_MANUAL_DAILY_MAX = mod.STORY_MANUAL_DAILY_MAX;
      out.STORY_CONSENT_VERSION = mod.STORY_CONSENT_VERSION;
    }
    if (rel.endsWith("worker.ts")) {
      expect(mod.STORY_JOB_DEADLINE_MS, "worker.ts must export STORY_JOB_DEADLINE_MS").toBe(80_000);
      out.STORY_JOB_DEADLINE_MS = mod.STORY_JOB_DEADLINE_MS;
    }
  }
  return out as unknown as Api;
}

/** 기존 0001~0005가 그대로 적용됐는지 먼저 보고, 그 뒤 0006 파일·기록·표를 각각 명시 단언한다. */
async function expectGenerationApplied(db: DisposableDatabase): Promise<void> {
  const pairs = ((await withOwner(env, db, (c) => readMigrationRows(c))) ?? []).map((r) => [r.version, r.name]);
  expect(pairs.slice(0, 5), "the existing harness migrates the 0001~0005 chain").toEqual(BEFORE_0006);
  for (const file of [GEN_UP, GEN_DOWN]) expect(existsSync(file), `${path.relative(APP_DIR, file)} must exist (PLAN §2)`).toBe(true);
  expect(pairs, "the default up must apply 0006_story_generation").toEqual([...BEFORE_0006, [6, "story_generation"]]);
  for (const t of NEW_TABLES) expect(await withOwner(env, db, (c) => relationExists(c, `pod.${t}`)), `to_regclass('pod.${t}') IS NOT NULL`).toBe(true);
}

async function withJobs(label: string, fn: (api: Api, pool: pg.Pool, db: DisposableDatabase) => Promise<void>, poolMax = 2): Promise<void> {
  const db = await freshMigratedDb(env, label);
  await expectGenerationApplied(db);
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

async function newUser(db: DisposableDatabase, gen = 1): Promise<Subject> {
  const userId = await seedUser(env, db, [{ provider: "testprov", subject: `jobs-${randomUUID()}` }], { granted: true, gen });
  return { userId, gen };
}
async function seedMoment(db: DisposableDatabase, userId: string, at: string, body: string, date = DAY): Promise<string> {
  const rows = await q<{ id: string }>(db,
    "INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body) VALUES ($1::uuid, $2::date, $3::timestamptz, $4) RETURNING id::text AS id",
    [userId, date, at, body]);
  return rows[0]!.id;
}
async function jpeg(width: number, height: number, seed: number): Promise<Buffer> {
  // 부드러운 그라데이션(결정적): 512px 사본이 장당 256 KiB 한도 안에 확실히 들어간다.
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    raw[i] = (x + seed * 13) & 0xff;
    raw[i + 1] = (y + seed * 29) & 0xff;
    raw[i + 2] = ((x + y) >> 1) & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}
type StoredPhoto = { photoId: string; objectKey: string; bytes: Buffer; sha: string };
/** 업로드가 ready로 확정된 사진 한 장(owner). moment_photos는 ready 뒤에만 존재한다(PLAN §4.2). */
async function seedPhoto(db: DisposableDatabase, userId: string, momentId: string, bytes: Buffer, width = 800, height = 600): Promise<StoredPhoto> {
  const photoId = randomUUID();
  const objectKey = `photos/${randomUUID()}.jpg`;
  const sha = sha256(bytes);
  await owner(db, async (c) => {
    await c.query(
      "INSERT INTO pod.photo_uploads (id, user_id, request_id, fingerprint, object_key, status, lease_token, lease_until) VALUES ($1, $2, $3, $4, $5, 'ready', $6, now())",
      [photoId, userId, randomUUID(), sha256(`fp-${photoId}`), objectKey, randomUUID()]);
    await c.query(
      "INSERT INTO pod.moment_photos (id, user_id, moment_id, sha256, mime_type, byte_length, width, height) VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7)",
      [photoId, userId, momentId, sha, bytes.byteLength, width, height]);
  });
  return { photoId, objectKey, bytes, sha };
}

/** v2 revision 공식의 독립 계산(PLAN §4.2). */
function oracleV2(date: string, refs: readonly { id: string; version: number; sha: string | null }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}:${r.sha ?? "-"}\n`);
  return sha256(`v2\n${date}\n${lines.join("")}`);
}
function oracleV1(date: string, refs: readonly { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return sha256(`v1\n${date}\n${lines.join("")}`);
}

type JobRow = { id: string; user_id: string; local_date: string; kind: string; state: string; source_revision: string | null; auth_generation: string; consent_version: number; consent_revision: string; lease_token: string | null; lease_until: string | null; story_id: string | null; error: string | null };
const jobs = (db: DisposableDatabase, userId?: string) => q<JobRow>(db,
  `SELECT id::text, user_id::text, local_date::text, kind, state, source_revision, auth_generation::text, consent_version, consent_revision::text,
          lease_token::text, lease_until::text, story_id::text, error
     FROM pod.story_jobs WHERE ($1::uuid IS NULL OR user_id = $1::uuid) ORDER BY created_at, id`, [userId ?? null]);
type UsageRow = { job_id: string; usage_month: string; model: string; state: string; input_tokens: number | null; output_tokens: number | null; settled: boolean };
const usage = (db: DisposableDatabase) => q<UsageRow>(db,
  "SELECT job_id::text, usage_month::text, model, state, input_tokens, output_tokens, settled_at IS NOT NULL AS settled FROM pod.story_usage ORDER BY created_at, id");
const stories = (db: DisposableDatabase, userId: string) => q<{ id: string; local_date: string; version: number; source_revision: string; body: string }>(db,
  "SELECT id::text, local_date::text, version, source_revision, body FROM pod.story_versions WHERE user_id = $1::uuid ORDER BY local_date, version", [userId]);
const settingsRow = (db: DisposableDatabase, userId: string) => q<{ consent_version: number; consent_revision: string; manual_enabled: boolean; auto_enabled: boolean; auto_at: boolean }>(db,
  "SELECT consent_version, consent_revision::text, manual_enabled, auto_enabled, auto_enabled_at IS NOT NULL AS auto_at FROM pod.story_ai_settings WHERE user_id = $1::uuid", [userId]);
const dbMonth = async (db: DisposableDatabase) => (await q<{ m: string }>(db, "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date::text AS m"))[0]!.m;

/**
 * 실제 purge 경로(0002): 기한이 지난 탈퇴 대기로 둔 뒤 purge role로 pod.purge_user_if_due를 호출한다.
 * owner의 raw DELETE users는 credit_accounts(RESTRICT)·원장 append-only 때문에 거부되는 것이 맞다(시험이 우회하지 않는다).
 */
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

function ok<T, E extends string>(r: Result<T, E>, label: string): T {
  expect(r.ok, `${label}: ${r.ok ? "" : r.error}`).toBe(true);
  if (!r.ok) throw new Error(label);
  return r.value;
}
async function consent(api: Api, pool: pg.Pool, s: Subject, manual: boolean, auto = false) {
  return ok(await api.saveStoryAiSettings(pool, s, { manual, auto }), "save settings");
}

function memoryBlobs(store: Map<string, Buffer>, onGet?: (key: string) => Promise<void>) {
  const calls: string[] = [];
  const blobs: Blobs = {
    async put() { throw new Error("not used"); },
    async delete() { throw new Error("not used"); },
    async get(key) {
      calls.push(key);
      if (onGet) await onGet(key);
      return store.get(key) ?? null;
    },
  };
  return { blobs, calls };
}
function claudeMessage(over: Record<string, unknown> = {}) {
  return {
    id: "msg_ci_jobs", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "text", text: STORY }], stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    usage: { input_tokens: 2100, output_tokens: 180 }, ...over,
  };
}
function mockFetch(respond: () => Promise<Response> | Response, before?: () => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const fn = vi.fn<FetchLike>(async (target, init) => {
    const request = new Request(target, init);
    bodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
    if (before) await before();
    return respond();
  });
  return { fn, bodies };
}
const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const imageBlocks = (body: Record<string, unknown> | undefined) => {
  const messages = (body?.messages ?? []) as { content?: { type?: string; source?: { data?: string } }[] }[];
  return (messages[0]?.content ?? []).filter((b) => b.type === "image");
};

/** 사진 2장 + 메모 1개인 하루와 수동 동의, queued job 1건. */
async function manualDay(api: Api, pool: pg.Pool, db: DisposableDatabase) {
  const s = await newUser(db);
  const m1 = await seedMoment(db, s.userId, `${DAY}T09:00:00+09:00`, "ci-only 아침 산책");
  const m2 = await seedMoment(db, s.userId, `${DAY}T13:30:00+09:00`, "ci-only 점심");
  await seedMoment(db, s.userId, `${DAY}T20:10:00+09:00`, "ci-only 저녁 메모");
  const p1 = await seedPhoto(db, s.userId, m1, await jpeg(800, 600, 1));
  const p2 = await seedPhoto(db, s.userId, m2, await jpeg(1200, 900, 2), 1200, 900);
  const store = new Map<string, Buffer>([[p1.objectKey, p1.bytes], [p2.objectKey, p2.bytes]]);
  await consent(api, pool, s, true);
  const { jobId } = ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "manual request");
  return { s, m1, m2, p1, p2, store, jobId };
}

// ---------------------------------------------------------------- 0006 schema·권한·down

describe("0006_story_generation schema, privileges and down guard", () => {
  it("adds exactly three tables with app SELECT/INSERT and only the planned UPDATE columns, and no DELETE/TRUNCATE", async () => {
    const db = await freshMigratedDb(env, "jobsschema");
    await expectGenerationApplied(db);
    await owner(db, async (c) => {
      const tables = (await c.query<{ t: string; o: string }>("SELECT tablename AS t, tableowner AS o FROM pg_tables WHERE schemaname = 'pod' AND tablename = ANY($1::text[])", [NEW_TABLES])).rows;
      expect(tables.sort((a, b) => (a.t < b.t ? -1 : 1))).toEqual(NEW_TABLES.map((t) => ({ t, o: CI_ROLES.owner })));
      for (const t of NEW_TABLES) {
        const p = (await c.query<Record<string, boolean>>(
          `SELECT has_table_privilege($1, 'pod.' || $2::text, 'SELECT') AS sel, has_table_privilege($1, 'pod.' || $2::text, 'INSERT') AS ins,
                  has_table_privilege($1, 'pod.' || $2::text, 'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS other,
                  has_table_privilege('public', 'pod.' || $2::text, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS pub,
                  has_table_privilege($3, 'pod.' || $2::text, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS purge_any,
                  has_any_column_privilege($3, 'pod.' || $2::text, 'SELECT,INSERT,UPDATE,REFERENCES') AS purge_col`,
          [CI_ROLES.app, t, CI_ROLES.purge])).rows[0]!;
        expect(p, t).toEqual({ sel: true, ins: true, other: false, pub: false, purge_any: false, purge_col: false });
      }
      const updatable = (await c.query<{ t: string; col: string }>(
        `SELECT table_name AS t, column_name AS col FROM information_schema.column_privileges
          WHERE table_schema = 'pod' AND grantee = $1 AND privilege_type = 'UPDATE' AND table_name = ANY($2::text[])`,
        [CI_ROLES.app, NEW_TABLES])).rows.map((r) => `${r.t}.${r.col}`).sort();
      expect(updatable).toEqual([
        ...["auto_enabled", "auto_enabled_at", "consent_revision", "consent_version", "manual_enabled", "updated_at"].map((c2) => `story_ai_settings.${c2}`),
        ...["error", "lease_token", "lease_until", "source_revision", "state", "story_id", "updated_at"].map((c2) => `story_jobs.${c2}`),
        ...["input_tokens", "output_tokens", "settled_at", "state"].map((c2) => `story_usage.${c2}`),
      ].sort());
      const usageCols = (await c.query<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = 'story_usage'")).rows.map((r) => r.c).sort();
      expect(usageCols, "the usage ledger keeps no user id, body or request data").toEqual(["created_at", "id", "input_tokens", "job_id", "model", "output_tokens", "settled_at", "state", "usage_month"]);
      const usageFks = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'pod.story_usage'::regclass AND contype = 'f'")).rows[0]!.n;
      expect(usageFks, "story_usage has no foreign key").toBe(0);
      const snapshotNulls = (await c.query<{ col: string; nul: string }>(
        "SELECT column_name AS col, is_nullable AS nul FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = 'story_jobs' AND column_name IN ('auth_generation', 'consent_version', 'consent_revision')")).rows;
      expect(snapshotNulls.sort((a, b) => (a.col < b.col ? -1 : 1))).toEqual([{ col: "auth_generation", nul: "NO" }, { col: "consent_revision", nul: "NO" }, { col: "consent_version", nul: "NO" }]);
    });
  }, 90_000);

  it("keeps job snapshots immutable for the app role and refuses app DELETE on every new table", async () => {
    await withJobs("jobsimmutable", async (api, pool, db) => {
      const { s, jobId } = await manualDay(api, pool, db);
      await withApp(env, db, async (c) => {
        for (const col of ["auth_generation", "consent_version", "consent_revision", "user_id", "local_date", "kind", "created_at"]) {
          await expectSqlError(c.query(`UPDATE pod.story_jobs SET ${col} = ${col} WHERE id = $1`, [jobId]), "42501");
        }
        await expectSqlError(c.query("UPDATE pod.story_ai_settings SET user_id = user_id WHERE user_id = $1", [s.userId]), "42501");
        for (const t of NEW_TABLES) await expectSqlError(c.query(`DELETE FROM pod.${t}`), "42501");
        await expectSqlError(c.query("UPDATE pod.story_usage SET job_id = job_id"), "42501");
      });
      const [job] = await jobs(db, s.userId);
      expect(job).toMatchObject({ auth_generation: "1", consent_version: 1, consent_revision: "1" });
    });
  }, 90_000);

  it("enforces the planned uniqueness and row checks", async () => {
    await withJobs("jobsconstraints", async (api, pool, db) => {
      const { s } = await manualDay(api, pool, db);
      const rev = sha256("ci-only-rev");
      await withApp(env, db, async (c) => {
        await expectSqlError(c.query(
          "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision) VALUES ($1, '2026-11-08', 'manual', 'queued', $2, 1, 1, 1)", [s.userId, rev]), "23505");
        await expectSqlError(c.query(
          "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision) VALUES ($1, '2026-11-08', 'manual', 'failed', 1, 1, 1)", [s.userId]), "23514");
        await expectSqlError(c.query(
          "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, error) VALUES ($1, '2026-11-08', 'scheduled', 'running', $2, 1, 1, 1, NULL)", [s.userId, rev]), "23514");
        await expectSqlError(c.query(
          "INSERT INTO pod.story_usage (job_id, usage_month, model, state) VALUES ($1, '2026-11-02', $2, 'sent')", [randomUUID(), MODEL]), "23514");
        await expectSqlError(c.query(
          "INSERT INTO pod.story_usage (job_id, usage_month, model, state, input_tokens, output_tokens) VALUES ($1, '2026-11-01', $2, 'sent', 1, 1)", [randomUUID(), MODEL]), "23514");
      });
      await owner(db, async (c) => {
        await c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable' WHERE user_id = $1", [s.userId]);
        await c.query("INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision, error) VALUES ($1, $2, 'scheduled', 'skipped', 1, 1, 1, 'no_input')", [s.userId, DAY]);
        await expectSqlError(c.query("INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision, error) VALUES ($1, $2, 'scheduled', 'skipped', 1, 1, 1, 'no_input')", [s.userId, DAY]), "23505");
      });
    });
  }, 90_000);

  it("cascades settings and jobs on purge but keeps the anonymous usage ledger", async () => {
    await withJobs("jobspurge", async (api, pool, db) => {
      const { s, jobId } = await manualDay(api, pool, db);
      await owner(db, (c) => c.query("INSERT INTO pod.story_usage (job_id, usage_month, model, state, input_tokens, output_tokens, settled_at) VALUES ($1, '2026-11-01', $2, 'settled', 10, 5, now())", [jobId, MODEL]));
      await purgeNow(db, s.userId);
      expect(await jobs(db, s.userId)).toEqual([]);
      expect(await settingsRow(db, s.userId)).toEqual([]);
      expect(await usage(db)).toEqual([{ job_id: jobId, usage_month: "2026-11-01", model: MODEL, state: "settled", input_tokens: 10, output_tokens: 5, settled: true }]);
    });
  }, 90_000);

  it("down refuses while any of the fifteen tables has rows, refuses non-ci, and an empty CI down --to 5 removes only the three tables", async () => {
    const db = await freshMigratedDb(env, "jobsdown");
    await expectGenerationApplied(db);
    const downSql = await readFile(GEN_DOWN, "utf8");
    const firstDrop = downSql.search(/^\s*DROP\s+TABLE\b/m);
    expect(firstDrop, "down drops tables").toBeGreaterThan(0);
    const guard = downSql.slice(0, firstDrop);
    expect(guard).toMatch(/db_environment[\s\S]*'ci'/);
    for (const t of ["users", "story_versions", ...NEW_TABLES]) expect(guard, `guard checks pod.${t}`).toMatch(new RegExp(`\\bFROM\\s+pod\\.${t}\\b`));
    const full = await owner(db, (c) => schemaSnapshot(c));
    await owner(db, (c) => c.query("INSERT INTO pod.story_usage (job_id, usage_month, model, state) VALUES ($1, '2026-11-01', $2, 'sent')", [randomUUID(), MODEL]));
    expectCliFail(await runMigrateCli(["down", "--to", "5", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await owner(db, async (c) => {
      await expectSqlError(c.query(downSql), "P0001");
      await c.query("DELETE FROM pod.story_usage");
      await c.query("UPDATE pod_meta.db_environment SET name = 'dev'");
      try { await expectSqlError(c.query(downSql), "P0001"); } finally { await c.query("UPDATE pod_meta.db_environment SET name = 'ci'"); }
    });
    expectCliOk(await runMigrateCli(["down", "--to", "5", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await owner(db, async (c) => {
      expect((await readMigrationRows(c))?.map((r) => [r.version, r.name])).toEqual(BEFORE_0006);
      for (const t of NEW_TABLES) expect(await relationExists(c, `pod.${t}`)).toBe(false);
      expect(await schemaSnapshot(c)).toEqual(full.filter((line) => !NEW_TABLES.some((t) => line.includes(t))));
    });
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    expect(await owner(db, (c) => schemaSnapshot(c))).toEqual(full);
  }, 90_000);
});

// ---------------------------------------------------------------- 동의 epoch

describe("story AI settings and consent epoch", () => {
  it("defaults to both off, and every save (on, same value, off, on again) increments consent_revision", async () => {
    await withJobs("jobsconsent", async (api, pool, db) => {
      const s = await newUser(db);
      expect(await api.getStoryAiSettings(pool, s.userId)).toEqual({ manualEnabled: false, autoEnabled: false });
      expect(await consent(api, pool, s, true)).toEqual({ manualEnabled: true, autoEnabled: false });
      expect(await settingsRow(db, s.userId)).toEqual([{ consent_version: 1, consent_revision: "1", manual_enabled: true, auto_enabled: false, auto_at: false }]);
      await consent(api, pool, s, true);
      expect((await settingsRow(db, s.userId))[0]?.consent_revision, "same value saved again").toBe("2");
      await consent(api, pool, s, true, true);
      const at1 = (await q<{ at: string }>(db, "SELECT auto_enabled_at::text AS at FROM pod.story_ai_settings WHERE user_id = $1", [s.userId]))[0]!.at;
      expect((await settingsRow(db, s.userId))[0]).toMatchObject({ consent_revision: "3", auto_enabled: true, auto_at: true });
      await consent(api, pool, s, false, true);
      const at2 = (await q<{ at: string }>(db, "SELECT auto_enabled_at::text AS at FROM pod.story_ai_settings WHERE user_id = $1", [s.userId]))[0]!.at;
      expect(at2, "auto_enabled_at is kept while auto stays on").toBe(at1);
      await consent(api, pool, s, false, false);
      expect((await settingsRow(db, s.userId))[0]).toMatchObject({ consent_revision: "5", manual_enabled: false, auto_enabled: false, auto_at: false });
      await consent(api, pool, s, true);
      expect((await settingsRow(db, s.userId))[0]?.consent_revision, "re-consent after withdrawal is a new epoch").toBe("6");
      expect(await api.getStoryAiSettings(pool, s.userId)).toEqual({ manualEnabled: true, autoEnabled: false });
    });
  }, 90_000);

  it("refuses inactive or stale subjects and malformed input, and treats another consent version as off", async () => {
    await withJobs("jobsconsentguard", async (api, pool, db) => {
      const s = await newUser(db, 3);
      expect(await api.saveStoryAiSettings(pool, { userId: s.userId, gen: 2 }, { manual: true, auto: false })).toEqual({ ok: false, error: "not_signed_in" });
      for (const bad of [null, {}, { manual: "true", auto: false }, { manual: true }, { manual: true, auto: false, extra: 1 }]) {
        expect(await api.saveStoryAiSettings(pool, s, bad), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid_input" });
      }
      expect(await settingsRow(db, s.userId)).toEqual([]);
      await consent(api, pool, s, true, true);
      await owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_version = 2 WHERE user_id = $1", [s.userId]));
      expect(await api.getStoryAiSettings(pool, s.userId)).toEqual({ manualEnabled: false, autoEnabled: false });
      await setPending(env, db, s.userId, "now()");
      expect(await api.saveStoryAiSettings(pool, s, { manual: true, auto: false })).toEqual({ ok: false, error: "not_signed_in" });
    });
  }, 90_000);
});

// ---------------------------------------------------------------- v2 capture

describe("captureStoryInputV2", () => {
  it("adds each owner photo reference to the v1 input and computes v2 = sha256('v2', date, id:version:sha|-) while revisionV1 stays the S1 value", async () => {
    await withJobs("jobscapture", async (api, pool, db) => {
      const { s, m1, m2, p1, p2 } = await manualDay(api, pool, db);
      const other = await newUser(db);
      const om = await seedMoment(db, other.userId, `${DAY}T10:00:00+09:00`, "ci-only 다른 사람");
      await seedPhoto(db, other.userId, om, await jpeg(64, 48, 9), 64, 48);
      const input = ok(await api.captureStoryInputV2(pool, s.userId, DAY), "capture");
      const refs = (await q<{ id: string; version: number }>(db, "SELECT id::text, version FROM pod.diary_moments WHERE user_id = $1 ORDER BY occurred_at, id", [s.userId]));
      const shas = new Map([[m1, p1.sha], [m2, p2.sha]]);
      expect(input.date).toBe(DAY);
      expect(input.revision).toBe(oracleV2(DAY, refs.map((r) => ({ ...r, sha: shas.get(r.id) ?? null }))));
      expect(input.revisionV1).toBe(oracleV1(DAY, refs));
      expect(input.revisionV1).toBe(api.storyRevision(DAY, refs));
      expect(api.storyRevisionV2(DAY, refs.map((r) => ({ ...r, photoSha256: shas.get(r.id) ?? null })))).toBe(input.revision);
      expect(input.moments.map((m) => [m.id, m.time, m.photo?.sha256 ?? null])).toEqual([[m1, "09:00", p1.sha], [m2, "13:30", p2.sha], [refs[2]!.id, "20:10", null]]);
      expect(input.moments[0]?.photo).toEqual({ photoId: p1.photoId, sha256: p1.sha, byteLength: p1.bytes.byteLength, objectKey: p1.objectKey });
      expect(JSON.stringify(input), "no other account's moment or photo").not.toContain(om);
    });
  }, 90_000);
});

// ---------------------------------------------------------------- 수동 요청

describe("requestManualStory", () => {
  it("enqueues one queued manual job with the v2 revision and NOT NULL gen/consent snapshots", async () => {
    await withJobs("jobsmanual", async (api, pool, db) => {
      const { s, jobId } = await manualDay(api, pool, db);
      expect(jobId).toMatch(UUID_RE);
      const input = ok(await api.captureStoryInputV2(pool, s.userId, DAY), "capture");
      expect(await jobs(db, s.userId)).toEqual([expect.objectContaining({
        id: jobId, local_date: DAY, kind: "manual", state: "queued", source_revision: input.revision,
        auth_generation: "1", consent_version: 1, consent_revision: "1", lease_token: null, lease_until: null, story_id: null, error: null,
      })]);
      expect(await usage(db)).toEqual([]);
    });
  }, 90_000);

  it("refuses without manual consent, for a future date, without input, while one is in flight, for the current story and after three a day", async () => {
    await withJobs("jobsmanualguard", async (api, pool, db) => {
      const s = await newUser(db);
      await seedMoment(db, s.userId, `${DAY}T09:00:00+09:00`, "ci-only 메모");
      expect(await api.requestManualStory(pool, s, DAY, { now: NOW })).toEqual({ ok: false, error: "consent_missing" });
      await consent(api, pool, s, false, true);
      expect(await api.requestManualStory(pool, s, DAY, { now: NOW }), "auto-only consent is not manual consent").toEqual({ ok: false, error: "consent_missing" });
      await consent(api, pool, s, true);
      expect(await api.requestManualStory(pool, s, "2026-11-10", { now: NOW })).toEqual({ ok: false, error: "invalid_date" });
      expect(await api.requestManualStory(pool, s, "2026-11-07", { now: NOW })).toEqual({ ok: false, error: "no_input" });
      expect(await api.requestManualStory(pool, { userId: s.userId, gen: 2 }, DAY, { now: NOW })).toEqual({ ok: false, error: "not_signed_in" });
      await seedMoment(db, s.userId, "2026-11-08T09:00:00+09:00", "ci-only 전날 메모", "2026-11-08");
      const first = ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "first");
      expect(await api.requestManualStory(pool, s, "2026-11-08", { now: NOW }), "one in flight per account (another date)").toEqual({ ok: false, error: "busy" });
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable' WHERE id = $1", [first.jobId]));
      ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "retry after a failure");
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable' WHERE user_id = $1 AND state = 'queued'", [s.userId]));
      ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "third");
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable' WHERE user_id = $1 AND state = 'queued'", [s.userId]));
      expect(await api.requestManualStory(pool, s, "2026-11-08", { now: NOW }), "fourth on the same Seoul day counts failed jobs too").toEqual({ ok: false, error: "limited" });
      expect((await jobs(db, s.userId)).length).toBe(3);
      const t = await newUser(db);
      const tm = await seedMoment(db, t.userId, `${DAY}T09:00:00+09:00`, "ci-only 이야기 있음");
      await consent(api, pool, t, true);
      const v1 = oracleV1(DAY, [{ id: tm, version: 1 }]);
      await owner(db, (c) => c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '이미 있는 이야기')", [t.userId, DAY, v1]));
      expect(await api.requestManualStory(pool, t, DAY, { now: NOW })).toEqual({ ok: false, error: "already_current" });
      await setPending(env, db, s.userId, "now()");
      expect(await api.requestManualStory(pool, s, "2026-11-08", { now: NOW })).toEqual({ ok: false, error: "not_signed_in" });
    });
  }, 90_000);
});

// ---------------------------------------------------------------- 화면 판정(읽기 전용)

describe("readStoryGeneration", () => {
  it("maps key, consent, the latest job and today's manual count to the view without writing", async () => {
    await withJobs("jobsview", async (api, pool, db) => {
      const s = await newUser(db);
      await seedMoment(db, s.userId, `${DAY}T09:00:00+09:00`, "ci-only 메모");
      expect(await api.readStoryGeneration(pool, s.userId, DAY, false)).toEqual({ state: "unavailable" });
      expect(await api.readStoryGeneration(pool, s.userId, DAY, true)).toEqual({ state: "off", manualEnabled: false, autoEnabled: false });
      await consent(api, pool, s, false, true);
      expect(await api.readStoryGeneration(pool, s.userId, DAY, true)).toEqual({ state: "off", manualEnabled: false, autoEnabled: true });
      await consent(api, pool, s, true);
      expect(await api.readStoryGeneration(pool, s.userId, DAY, true)).toEqual({ state: "ready", autoEnabled: false });
      const { jobId } = ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "request");
      expect(await api.readStoryGeneration(pool, s.userId, DAY, true)).toEqual({ state: "queued", kind: "manual" });
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'photo_unavailable' WHERE id = $1", [jobId]));
      expect(await api.readStoryGeneration(pool, s.userId, DAY, true)).toEqual({ state: "failed", failure: "photo_unavailable", canRetry: true });
      const t = await newUser(db);
      await consent(api, pool, t, true);
      await owner(db, (c) => c.query("INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision, error) VALUES ($1, $2, 'scheduled', 'skipped', 1, 1, 1, 'already_current')", [t.userId, DAY]));
      expect(await api.readStoryGeneration(pool, t.userId, DAY, true), "a skipped job shows the current setting, not its error").toEqual({ state: "ready", autoEnabled: false });
      await consent(api, pool, t, false);
      expect(await api.readStoryGeneration(pool, t.userId, DAY, true)).toEqual({ state: "off", manualEnabled: false, autoEnabled: false });
      const before = await jobs(db);
      expect(await api.readStoryGeneration(pool, s.userId, DAY, false), "a missing key wins over job state").toEqual({ state: "unavailable" });
      expect(await jobs(db)).toEqual(before);
    });
  }, 90_000);
});

// ---------------------------------------------------------------- 자동 enqueue(주입 시계)

describe("enqueueDueStories", () => {
  const at = (seoul: string) => new Date(`${seoul}+09:00`);

  async function autoUser(api: Api, pool: pg.Pool, db: DisposableDatabase, reflection: string | null, enabledAt = "2026-11-01T00:00:00+09:00") {
    const s = await newUser(db);
    await consent(api, pool, s, false, true);
    await owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET auto_enabled_at = $2::timestamptz WHERE user_id = $1", [s.userId, enabledAt]));
    if (reflection !== null) await owner(db, (c) => c.query("INSERT INTO pod.preferences (user_id, reflection_time) VALUES ($1, $2)", [s.userId, reflection]));
    return s;
  }

  it("enqueues at the reflection time (20:00 without preferences) once per Seoul day with gen and consent snapshots", async () => {
    await withJobs("jobsenqueue", async (api, pool, db) => {
      const s = await autoUser(api, pool, db, null);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T19:59:59") }), "19:59:59 is not due").toBe(0);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T20:00:00") }), "20:00 is due").toBe(1);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T23:59:00") }), "once per day").toBe(0);
      expect(await jobs(db, s.userId)).toEqual([expect.objectContaining({ local_date: "2026-11-09", kind: "scheduled", state: "queued", source_revision: null, auth_generation: "1", consent_version: 1, consent_revision: "1" })]);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-10T00:00:00") }), "Seoul midnight starts a new day but 00:00 < 20:00").toBe(0);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-10T20:00:00") }), "the scheduled_once/one_inflight conflict is absorbed while the earlier job is queued").toBe(0);
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET state = 'skipped', error = 'no_input' WHERE user_id = $1", [s.userId]));
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-10T20:00:00") }), "next day after the first finished").toBe(1);
    });
  }, 90_000);

  it("uses the account reflection time and auto_enabled_at, and skips inactive accounts and other consent versions", async () => {
    await withJobs("jobsenqueue2", async (api, pool, db) => {
      const early = await autoUser(api, pool, db, "07:30");
      const late = await autoUser(api, pool, db, null, "2026-11-09T20:00:00+09:00");
      const pending = await autoUser(api, pool, db, null);
      await setPending(env, db, pending.userId, "now()");
      const oldPolicy = await autoUser(api, pool, db, null);
      await owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_version = 2 WHERE user_id = $1", [oldPolicy.userId]));
      const manualOnly = await newUser(db);
      await consent(api, pool, manualOnly, true, false);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T07:29:00") })).toBe(0);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T07:30:00") })).toBe(1);
      expect((await jobs(db, early.userId)).map((j) => j.local_date)).toEqual(["2026-11-09"]);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-09T21:00:00") }), "enabled exactly at today's 20:00 is not before it").toBe(0);
      expect(await jobs(db, late.userId)).toEqual([]);
      expect(await api.enqueueDueStories(pool, { now: at("2026-11-10T20:00:00") }), "late user is due the next day; early user's queued job blocks its own").toBe(1);
      expect((await jobs(db, late.userId)).map((j) => j.local_date)).toEqual(["2026-11-10"]);
      for (const u of [pending, oldPolicy, manualOnly]) expect(await jobs(db, u.userId)).toEqual([]);
    });
  }, 90_000);
});

// ---------------------------------------------------------------- claim

describe("claimStoryJob", () => {
  it("claims the oldest queued job into a 3 minute lease and records the scheduled v2 revision once", async () => {
    await withJobs("jobsclaim", async (api, pool, db) => {
      const { s, jobId } = await manualDay(api, pool, db);
      const claim = await api.claimStoryJob(pool);
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      expect(claim.job).toMatchObject({ id: jobId, userId: s.userId, date: DAY, kind: "manual", gen: 1, consentVersion: 1, consentRevision: 1 });
      expect(claim.job.leaseToken).toMatch(UUID_RE);
      const [row] = await jobs(db, s.userId);
      expect(row).toMatchObject({ state: "running", lease_token: claim.job.leaseToken, auth_generation: "1", consent_revision: "1" });
      const lease = (await q<{ secs: number }>(db, "SELECT extract(epoch FROM lease_until - clock_timestamp())::float8 AS secs FROM pod.story_jobs WHERE id = $1", [jobId]))[0]!.secs;
      expect(lease).toBeGreaterThan(170);
      expect(lease).toBeLessThanOrEqual(180);
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "none" });

      const auto = await newUser(db);
      await seedMoment(db, auto.userId, `${DAY}T08:00:00+09:00`, "ci-only 자동");
      await consent(api, pool, auto, false, true);
      await owner(db, (c) => c.query(
        "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision) VALUES ($1, $2, 'scheduled', 'queued', 1, 1, 1)", [auto.userId, DAY]));
      const scheduled = await api.claimStoryJob(pool);
      expect(scheduled.kind).toBe("claimed");
      const input = ok(await api.captureStoryInputV2(pool, auto.userId, DAY), "capture");
      expect((await jobs(db, auto.userId))[0]?.source_revision, "scheduled revision is recorded at claim").toBe(input.revision);
    });
  }, 90_000);

  it("fails or skips without rescue: gen change, consent epoch change (even after re-consent), no input, current story and changed manual input", async () => {
    await withJobs("jobsclaimfence", async (api, pool, db) => {
      const make = async () => {
        const s = await newUser(db);
        const m = await seedMoment(db, s.userId, `${DAY}T09:00:00+09:00`, "ci-only 메모");
        await consent(api, pool, s, true);
        const { jobId } = ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "request");
        return { s, m, jobId };
      };
      const genChanged = await make();
      await owner(db, (c) => c.query("UPDATE pod.users SET auth_generation = auth_generation + 1 WHERE id = $1", [genChanged.s.userId]));
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "failed", jobId: genChanged.jobId });
      expect((await jobs(db, genChanged.s.userId))[0]).toMatchObject({ state: "failed", error: "not_signed_in", auth_generation: "1" });

      const reconsented = await make();
      await consent(api, pool, reconsented.s, false);
      await consent(api, pool, reconsented.s, true);
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "failed", jobId: reconsented.jobId });
      expect((await jobs(db, reconsented.s.userId))[0]).toMatchObject({ state: "failed", error: "consent_missing", consent_revision: "1" });

      const changed = await make();
      await owner(db, (c) => c.query("UPDATE pod.diary_moments SET body = 'ci-only 고친 메모', version = version + 1 WHERE id = $1", [changed.m]));
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "failed", jobId: changed.jobId });
      expect((await jobs(db, changed.s.userId))[0]).toMatchObject({ state: "failed", error: "input_changed" });

      const emptied = await make();
      await owner(db, (c) => c.query("DELETE FROM pod.diary_moments WHERE id = $1", [emptied.m]));
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "skipped", jobId: emptied.jobId });
      expect((await jobs(db, emptied.s.userId))[0]).toMatchObject({ state: "skipped", error: "no_input" });

      const current = await make();
      await owner(db, (c) => c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1, $2, 1, $3, '이미 있음')", [current.s.userId, DAY, oracleV1(DAY, [{ id: current.m, version: 1 }])]));
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "skipped", jobId: current.jobId });
      expect((await jobs(db, current.s.userId))[0]).toMatchObject({ state: "skipped", error: "already_current" });
      expect(await usage(db)).toEqual([]);
    });
  }, 120_000);

  it("never hands the same job to two concurrent claimers (two pools, SKIP LOCKED)", async () => {
    await withJobs("jobsclaimrace", async (api, pool, db) => {
      for (let i = 0; i < 4; i++) {
        const s = await newUser(db);
        await seedMoment(db, s.userId, `${DAY}T09:0${i}:00+09:00`, `ci-only 메모 ${i}`);
        await consent(api, pool, s, true);
        ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), `request ${i}`);
      }
      const other = openAppPool(db, 2);
      const results = await Promise.all([api.claimStoryJob(pool), api.claimStoryJob(other), api.claimStoryJob(pool), api.claimStoryJob(other)]);
      const ids = results.flatMap((r) => (r.kind === "claimed" ? [r.job.id] : []));
      expect(new Set(ids).size, "no job is claimed twice").toBe(ids.length);
      const running = (await jobs(db)).filter((j) => j.state === "running").map((j) => j.id).sort();
      expect(running).toEqual([...ids].sort());
    });
  }, 90_000);
});

// ---------------------------------------------------------------- worker 전체 경로(mock fetch)

describe("runOneStoryJob", () => {
  it("is closed without a Claude key: expires leases but neither enqueues nor claims", async () => {
    await withJobs("workerclosed", async (api, pool, db) => {
      const { s } = await manualDay(api, pool, db);
      const f = mockFetch(() => json200(claudeMessage()));
      const before = await jobs(db, s.userId);
      const stats = await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(new Map()).blobs, claude: null, fetch: f.fn });
      expect(stats).toEqual({ expired: 0, enqueued: 0, result: "closed" });
      expect(await jobs(db, s.userId)).toEqual(before);
      expect(f.fn).not.toHaveBeenCalled();
      expect(await usage(db)).toEqual([]);
    });
  }, 90_000);

  it("succeeds once: 512px photo copies and memos in one request, a v1-revision story, a succeeded job and a settled usage row", async () => {
    await withJobs("workersuccess", async (api, pool, db) => {
      const { s, store, jobId } = await manualDay(api, pool, db);
      const memory = memoryBlobs(store);
      const f = mockFetch(() => json200(claudeMessage()));
      const input = ok(await api.captureStoryInputV2(pool, s.userId, DAY), "capture");
      const stats = await api.runOneStoryJob({ db: pool, blobs: memory.blobs, claude: CLAUDE, fetch: f.fn });
      expect(stats).toEqual({ expired: 0, enqueued: 0, result: "succeeded" });
      expect(f.fn).toHaveBeenCalledTimes(1);
      const images = imageBlocks(f.bodies[0]);
      expect(images).toHaveLength(2);
      for (const image of images) {
        const meta = await sharp(Buffer.from(image.source?.data ?? "", "base64")).metadata();
        expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(512);
      }
      const saved = await stories(db, s.userId);
      expect(saved).toEqual([expect.objectContaining({ local_date: DAY, version: 1, source_revision: input.revisionV1, body: STORY })]);
      expect((await jobs(db, s.userId))[0]).toMatchObject({ id: jobId, state: "succeeded", story_id: saved[0]!.id, lease_token: null, lease_until: null, error: null });
      expect(await usage(db)).toEqual([{ job_id: jobId, usage_month: await dbMonth(db), model: MODEL, state: "settled", input_tokens: 2100, output_tokens: 180, settled: true }]);
      expect(JSON.stringify(f.bodies), "object keys and ids are not sent").not.toMatch(/photos\/|[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  }, 120_000);

  it("fails the job as photo_unavailable before sending when any photo cannot be prepared or blobs are null", async () => {
    await withJobs("workerphoto", async (api, pool, db) => {
      const first = await manualDay(api, pool, db);
      first.store.delete(first.p2.objectKey);
      const f = mockFetch(() => json200(claudeMessage()));
      expect((await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(first.store).blobs, claude: CLAUDE, fetch: f.fn })).result).toBe("failed");
      expect((await jobs(db, first.s.userId))[0]).toMatchObject({ state: "failed", error: "photo_unavailable" });
      const second = await manualDay(api, pool, db);
      expect((await api.runOneStoryJob({ db: pool, blobs: null, claude: CLAUDE, fetch: f.fn })).result).toBe("failed");
      expect((await jobs(db, second.s.userId))[0]).toMatchObject({ state: "failed", error: "photo_unavailable" });
      expect(f.fn).not.toHaveBeenCalled();
      expect(await usage(db)).toEqual([]);
      expect(await stories(db, first.s.userId)).toEqual([]);
    });
  }, 120_000);

  it("sends nothing when the account, consent, input or lease changes during photo reading (markSent fence)", async () => {
    await withJobs("workermarksent", async (api, pool, db) => {
      type Change = [string, (d: Awaited<ReturnType<typeof manualDay>>) => Promise<unknown>, string];
      const changes: Change[] = [
        ["gen increment", (d) => owner(db, (c) => c.query("UPDATE pod.users SET auth_generation = auth_generation + 1 WHERE id = $1", [d.s.userId])), "not_signed_in"],
        ["withdrawal", (d) => setPending(env, db, d.s.userId, "now()"), "not_signed_in"],
        ["consent withdrawn", (d) => owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET manual_enabled = false, consent_revision = consent_revision + 1 WHERE user_id = $1", [d.s.userId])), "consent_missing"],
        ["re-consented (new epoch)", (d) => owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_revision = consent_revision + 1 WHERE user_id = $1", [d.s.userId])), "consent_missing"],
        ["moment deleted", (d) => owner(db, (c) => c.query("DELETE FROM pod.diary_moments WHERE id = $1", [d.m2])), "input_changed"],
        ["lease at the clock boundary", (d) => owner(db, (c) => c.query("UPDATE pod.story_jobs SET lease_until = clock_timestamp() WHERE id = $1", [d.jobId])), "lease_expired"],
      ];
      for (const [label, change, error] of changes) {
        const d = await manualDay(api, pool, db);
        let changed = false;
        const memory = memoryBlobs(d.store, async () => { if (!changed) { changed = true; await change(d); } });
        const f = mockFetch(() => json200(claudeMessage()));
        const stats = await api.runOneStoryJob({ db: pool, blobs: memory.blobs, claude: CLAUDE, fetch: f.fn });
        expect(stats.result, label).toBe("failed");
        expect(f.fn, `${label}: no HTTP`).not.toHaveBeenCalled();
        expect((await jobs(db, d.s.userId))[0], label).toMatchObject({ state: "failed", error, lease_token: null });
        expect(await usage(db), `${label}: no usage row`).toEqual([]);
        expect(await stories(db, d.s.userId)).toEqual([]);
      }
    });
  }, 240_000);

  it("records unknown for sent failures without usage and settled tokens for a 200 with usage but an invalid body", async () => {
    await withJobs("workersent", async (api, pool, db) => {
      const cases: [string, () => Promise<Response> | Response, string, string, number | null][] = [
        ["500", () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }), "unavailable", "unknown", null],
        ["network", () => Promise.reject(new TypeError("ci-only-network")), "unavailable", "unknown", null],
        ["max_tokens with usage", () => json200(claudeMessage({ stop_reason: "max_tokens" })), "invalid_output", "settled", 2100],
      ];
      for (const [label, respond, error, state, tokens] of cases) {
        const d = await manualDay(api, pool, db);
        const f = mockFetch(respond);
        expect((await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(d.store).blobs, claude: CLAUDE, fetch: f.fn })).result, label).toBe("failed");
        expect(f.fn).toHaveBeenCalledTimes(1);
        expect((await jobs(db, d.s.userId))[0], label).toMatchObject({ state: "failed", error });
        const row = (await usage(db)).find((u) => u.job_id === d.jobId);
        expect(row, label).toMatchObject({ state, input_tokens: tokens, settled: true });
        expect(await stories(db, d.s.userId)).toEqual([]);
      }
    });
  }, 240_000);

  it("stores nothing when the input, account or consent changes while the request is in flight, but always settles usage (finish fence)", async () => {
    await withJobs("workerfinish", async (api, pool, db) => {
      type Change = [string, (d: Awaited<ReturnType<typeof manualDay>>) => Promise<unknown>, string];
      const changes: Change[] = [
        ["memo edited", (d) => owner(db, (c) => c.query("UPDATE pod.diary_moments SET body = 'ci-only 바뀐 메모', version = version + 1 WHERE id = $1", [d.m1])), "input_changed"],
        ["moment deleted", (d) => owner(db, (c) => c.query("DELETE FROM pod.diary_moments WHERE id = $1", [d.m2])), "input_changed"],
        ["gen increment", (d) => owner(db, (c) => c.query("UPDATE pod.users SET auth_generation = auth_generation + 1 WHERE id = $1", [d.s.userId])), "not_signed_in"],
        ["re-consented", (d) => owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_revision = consent_revision + 1 WHERE user_id = $1", [d.s.userId])), "consent_missing"],
        ["policy version changed", (d) => owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET consent_version = 2 WHERE user_id = $1", [d.s.userId])), "consent_missing"],
      ];
      for (const [label, change, error] of changes) {
        const d = await manualDay(api, pool, db);
        const f = mockFetch(() => json200(claudeMessage()), async () => { await change(d); });
        expect((await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(d.store).blobs, claude: CLAUDE, fetch: f.fn })).result, label).toBe("failed");
        expect((await jobs(db, d.s.userId))[0], label).toMatchObject({ state: "failed", error, story_id: null });
        expect(await stories(db, d.s.userId), `${label}: no story`).toEqual([]);
        expect((await usage(db)).find((u) => u.job_id === d.jobId), label).toMatchObject({ state: "settled", input_tokens: 2100, output_tokens: 180 });
      }
    });
  }, 240_000);

  it("refuses to store a success after the lease expired (and settles an expire-made unknown), and keeps only usage after a purge", async () => {
    await withJobs("workerlease", async (api, pool, db) => {
      const expired = await manualDay(api, pool, db);
      const f1 = mockFetch(() => json200(claudeMessage()), async () => {
        await owner(db, (c) => c.query("UPDATE pod.story_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.jobId]));
        expect(await api.expireStoryLeases(pool)).toBe(1);
      });
      expect((await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(expired.store).blobs, claude: CLAUDE, fetch: f1.fn })).result).toBe("failed");
      expect((await jobs(db, expired.s.userId))[0]).toMatchObject({ state: "failed", error: "lease_expired", story_id: null });
      expect(await stories(db, expired.s.userId)).toEqual([]);
      expect((await usage(db)).find((u) => u.job_id === expired.jobId), "unknown corrected to settled").toMatchObject({ state: "settled", input_tokens: 2100 });

      const purged = await manualDay(api, pool, db);
      const f2 = mockFetch(() => json200(claudeMessage()), async () => { await purgeNow(db, purged.s.userId); });
      await api.runOneStoryJob({ db: pool, blobs: memoryBlobs(purged.store).blobs, claude: CLAUDE, fetch: f2.fn });
      expect(await jobs(db, purged.s.userId)).toEqual([]);
      expect(await stories(db, purged.s.userId)).toEqual([]);
      expect((await usage(db)).find((u) => u.job_id === purged.jobId), "anonymous usage survives the purge").toMatchObject({ state: "settled", input_tokens: 2100, output_tokens: 180 });
    });
  }, 240_000);
});

// ---------------------------------------------------------------- lease 만료·잠금 순서

describe("expireStoryLeases and lock order", () => {
  it("fails an expired running job as lease_expired, turns its sent usage unknown and never re-queues", async () => {
    await withJobs("jobsexpire", async (api, pool, db) => {
      const d = await manualDay(api, pool, db);
      const claim = await api.claimStoryJob(pool);
      if (claim.kind !== "claimed") throw new Error("expected a claim");
      expect(await api.markStorySent(pool, claim.job, MODEL)).toEqual({ ok: true });
      expect((await usage(db))[0]).toMatchObject({ job_id: d.jobId, state: "sent", input_tokens: null, settled: false, usage_month: await dbMonth(db) });
      expect(await api.expireStoryLeases(pool), "a live lease is not expired").toBe(0);
      await owner(db, (c) => c.query("UPDATE pod.story_jobs SET lease_until = clock_timestamp() WHERE id = $1", [d.jobId]));
      expect(await api.expireStoryLeases(pool)).toBe(1);
      expect((await jobs(db, d.s.userId))).toEqual([expect.objectContaining({ state: "failed", error: "lease_expired", lease_token: null, lease_until: null })]);
      expect((await usage(db))[0]).toMatchObject({ state: "unknown", input_tokens: null, output_tokens: null, settled: true });
      expect(await api.claimStoryJob(pool)).toEqual({ kind: "none" });
      expect(await api.finishStoryJob(pool, claim.job, { ok: false, error: "timeout", sent: true, usage: null })).toBe("failed");
      expect((await usage(db))[0]?.state, "a late failure without usage keeps unknown").toBe("unknown");
    });
  }, 90_000);

  it("runs finish, expire, enqueue and manual requests for one account concurrently on two pools without deadlock", async () => {
    await withJobs("jobsdeadlock", async (api, pool, db) => {
      const other = openAppPool(db, 2);
      for (let round = 0; round < 4; round++) {
        const s = await newUser(db);
        await seedMoment(db, s.userId, `${DAY}T09:00:00+09:00`, `ci-only 메모 ${round}`);
        await seedMoment(db, s.userId, "2026-11-08T09:00:00+09:00", "ci-only 전날", "2026-11-08");
        await consent(api, pool, s, true, true);
        await owner(db, (c) => c.query("UPDATE pod.story_ai_settings SET auto_enabled_at = '2026-11-01T00:00:00+09:00' WHERE user_id = $1", [s.userId]));
        ok(await api.requestManualStory(pool, s, DAY, { now: NOW }), "request");
        const claim = await api.claimStoryJob(pool);
        if (claim.kind !== "claimed") throw new Error("expected a claim");
        expect(await api.markStorySent(pool, claim.job, MODEL)).toEqual({ ok: true });
        const settled = await Promise.allSettled([
          api.finishStoryJob(pool, claim.job, { ok: true, body: STORY, usage: { inputTokens: 1, outputTokens: 1 } }),
          api.expireStoryLeases(other),
          api.enqueueDueStories(other, { now: new Date("2026-11-08T12:00:00.000Z") }),
          api.requestManualStory(pool, s, "2026-11-08", { now: NOW }),
        ]);
        for (const result of settled) {
          if (result.status === "rejected") expect((result.reason as { code?: string }).code, "no deadlock (40P01)").not.toBe("40P01");
          expect(result.status, `round ${round}`).toBe("fulfilled");
        }
        // 다음 round가 이전 계정의 job을 집지 않도록 진행 중 job을 닫고 자동 생성을 끈다(시험 정리, owner).
        await owner(db, async (c) => {
          await c.query("UPDATE pod.story_jobs SET state = 'failed', error = 'unavailable', lease_token = NULL, lease_until = NULL WHERE state IN ('queued', 'running')");
          await c.query("UPDATE pod.story_ai_settings SET auto_enabled = false, auto_enabled_at = NULL");
        });
      }
    });
  }, 240_000);
});
