// PLAN_private-photo-moments §2.1/2.2/3 RED: real disposable PG/app role, observable fake blob port.
// No product import at collection: missing files/exports are explicit requirement failures.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CI_ROLES, cleanupAll, closeClient, openClient, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, expectCliFail, expectSqlError, insertDesignVersion, insertMoment, readMigrationRows, runMigrateCli, schemaSnapshot, withApp, withOwner } from "./f2-support";
import { appBackend, endAllPools, expectLedgerInvariants, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { createUser, loadCreatePgDiaryStore, momentRows, okValue, type MomentRef } from "./f3-diary-support";
import { loadLifecycle, setPending } from "./f4-lifecycle-support";

type Photo = { bytes: Buffer; sha256: string; width: number; height: number; contentType: "image/jpeg" };
type Viewer = { userId: string; gen: number };
type ErrorCode = "invalid_request" | "invalid_body" | "invalid_photo" | "photo_too_large" | "not_signed_in" | "forbidden" | "conflict" | "busy" | "unavailable";
type Blobs = { put: (key: string, photo: Photo, signal?: AbortSignal) => Promise<void>; get: (key: string, signal?: AbortSignal) => Promise<Buffer | null>; delete: (key: string, signal?: AbortSignal) => Promise<void> };
type Stats = { processed: number; deleted: number; failed: number; busy: number };
type Api = {
  create: (db: pg.Pool, blobs: Blobs, viewer: Viewer, input: { requestId: string; memo: string; photo: Photo }) => Promise<Result<{ moment: MomentRef; replayed: boolean }, ErrorCode>>;
  read: (db: pg.Pool, blobs: Blobs, viewer: Viewer, id: string, signal?: AbortSignal) => Promise<Result<{ bytes: Buffer; contentType: "image/jpeg" }, "not_found" | "unavailable">>;
  cleanup: (db: pg.Pool, blobs: Blobs, opts: { limit: number; now?: Date }) => Promise<Stats>;
};
type Upload = { id: string; user_id: string | null; request_id: string; fingerprint: string; object_key: string; status: string; lease_token: string; lease_until: Date };
const KEY = /^photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
const PHOTO_TABLES = ["photo_uploads", "moment_photos", "photo_deletions"] as const;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let env: HarnessEnv;

beforeAll(() => { env = readDisposableEnv(); });
afterAll(async () => { try { await endAllPools(); } finally { if (env) await cleanupAll(env); } });

async function loadApi(): Promise<Api> {
  const exports: Record<string, unknown> = {};
  for (const [key, file, name] of [["create", "create-moment.ts", "createPhotoMoment"], ["read", "read-photo.ts", "readPhoto"], ["cleanup", "cleanup.ts", "cleanupPhotos"]]) {
    const filename = path.join(APP_DIR, "src/server/photos", file!);
    expect(existsSync(filename), `photos/${file} must exist before its ${name} behavior can be tested`).toBe(true);
    const mod = await import(/* @vite-ignore */ filename) as Record<string, unknown>;
    expect(typeof mod[name!], `photos/${file} must export function ${name}`).toBe("function");
    exports[key!] = mod[name!];
  }
  return exports as unknown as Api;
}

async function expectPhotosApplied(db: DisposableDatabase) {
  expect((await withOwner(env, db, (c) => readMigrationRows(c)))?.map((row) => [row.version, row.name]), "default schema must include the new private photo migration").toEqual([
    [1, "init"], [2, "account_lifecycle"], [3, "reflection_time"], [4, "private_photos"], [5, "daily_stories"], [6, "story_generation"],
  ]);
}

async function withApi(label: string, fn: (api: Api, pool: pg.Pool, db: DisposableDatabase) => Promise<void>) {
  const api = await loadApi();
  const db = await freshMigratedDb(env, label);
  await expectPhotosApplied(db);
  const pool = openAppPool(db, 2);
  try { await appBackend(pool); await fn(api, pool, db); await expectLedgerInvariants(env, db); }
  finally { await endAllPools(); }
}

async function withCleanup<T>(db: DisposableDatabase, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: db.urls.purge, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  try {
    const role = await pool.query<{ name: string; allowed: boolean }>("SELECT current_user::text AS name, pod.is_photo_cleanup_role() AS allowed");
    expect(role.rows).toEqual([{ name: CI_ROLES.purge, allowed: true }]);
    return await fn(pool);
  } finally { await pool.end(); }
}

async function photo(color = "#5c88ae"): Promise<Photo> {
  const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer();
  return { bytes, sha256: digest(bytes), width: 48, height: 32, contentType: "image/jpeg" };
}

class FakeBlobs implements Blobs {
  objects = new Map<string, Buffer>();
  puts: string[] = [];
  gets: string[] = [];
  deletes: string[] = [];
  beforePut?: (key: string, value: Photo) => Promise<void>;
  beforeGet?: (key: string) => Promise<void>;
  beforeDelete?: (key: string) => Promise<void>;
  async put(key: string, value: Photo) { this.puts.push(key); await this.beforePut?.(key, value); this.objects.set(key, Buffer.from(value.bytes)); }
  async get(key: string) { this.gets.push(key); const bytes = this.objects.get(key); await this.beforeGet?.(key); return bytes ? Buffer.from(bytes) : null; }
  async delete(key: string) { this.deletes.push(key); await this.beforeDelete?.(key); this.objects.delete(key); }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("photo test barrier not reached within 5s")), 5000); })]); }
  finally { clearTimeout(timer); }
}

const uploads = (db: DisposableDatabase, uid: string) => withOwner(env, db, async (c) => (await c.query<Upload>(
  "SELECT id::text, user_id::text, request_id::text, fingerprint, object_key, status, lease_token::text, lease_until FROM pod.photo_uploads WHERE user_id = $1 ORDER BY created_at, id", [uid],
)).rows);
const metadataRows = (db: DisposableDatabase, uid: string) => withOwner(env, db, async (c) => (await c.query(
  "SELECT id::text, user_id::text, moment_id::text, sha256, mime_type, byte_length, width, height FROM pod.moment_photos WHERE user_id = $1 ORDER BY id", [uid],
)).rows);
const tracked = (db: DisposableDatabase, key: string) => withOwner(env, db, async (c) => Number((await c.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM pod.photo_deletions WHERE object_key = $1", [key],
)).rows[0]!.n));
const later = () => new Date(Date.now() + 7 * 86_400_000);

async function inject(db: DisposableDatabase, table: "photo_uploads" | "diary_moments") {
  await withOwner(env, db, async (c) => {
    await c.query("CREATE FUNCTION pod.photo_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ci-only-photo-db-failure'; END $$");
    await c.query(`CREATE TRIGGER photo_test_fail BEFORE INSERT ON pod.${table} FOR EACH ROW EXECUTE FUNCTION pod.photo_test_fail()`);
  });
  return () => withOwner(env, db, async (c) => {
    await c.query(`DROP TRIGGER photo_test_fail ON pod.${table}`);
    await c.query("DROP FUNCTION pod.photo_test_fail()");
  });
}

describe("private photo journal, app-role storage and account boundaries", () => {
  it("adds exactly the three owner tables, keeps app/PUBLIC/ledger privileges narrow and enforces photo metadata plus same-owner FK", async () => {
    const db = await freshMigratedDb(env, "photoschema");
    await expectPhotosApplied(db);
    await withOwner(env, db, async (c) => {
      const tables = await c.query<{ tablename: string; tableowner: string }>("SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'pod' AND tablename = ANY($1::text[]) ORDER BY tablename", [PHOTO_TABLES]);
      expect(tables.rows).toEqual([...PHOTO_TABLES].sort().map((tablename) => ({ tablename, tableowner: CI_ROLES.owner })));
      for (const table of PHOTO_TABLES) {
        const permissions = await c.query<{ public_access: boolean; app_delete: boolean }>(
          "SELECT has_table_privilege('public', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS public_access, has_table_privilege($2, $1, 'DELETE') AS app_delete", [`pod.${table}`, CI_ROLES.app],
        );
        expect(permissions.rows[0]!.public_access).toBe(false);
        if (table !== "moment_photos") expect(permissions.rows[0]!.app_delete, "journals/tombstones cannot be unconditionally deleted by the app").toBe(false);
        const purge = await c.query<{ can_select: boolean; can_insert: boolean; whole_update: boolean; destructive: boolean }>(
          "SELECT has_table_privilege($2, $1, 'SELECT') AS can_select, has_table_privilege($2, $1, 'INSERT') AS can_insert, has_table_privilege($2, $1, 'UPDATE') AS whole_update, has_table_privilege($2, $1, 'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS destructive", [`pod.${table}`, CI_ROLES.purge],
        );
        expect(purge.rows).toEqual([{ can_select: true, can_insert: table === "photo_deletions", whole_update: false, destructive: false }]);
      }
      const appQueue = await c.query<{ can_insert: boolean; cleanup_access: boolean }>(
        `SELECT has_table_privilege($1, 'pod.photo_deletions', 'INSERT') AS can_insert,
                (has_table_privilege($1, 'pod.photo_deletions', 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR has_any_column_privilege($1, 'pod.photo_deletions', 'SELECT,UPDATE,REFERENCES')) AS cleanup_access`, [CI_ROLES.app],
      );
      expect(appQueue.rows, "the app can enqueue deletion but cannot read or update cleanup bookkeeping").toEqual([{ can_insert: true, cleanup_access: false }]);
      const functions = await c.query<{ public_execute: boolean }>(
        "SELECT has_function_privilege('public', t.tgfoid, 'EXECUTE') AS public_execute FROM pg_trigger t WHERE t.tgrelid = 'pod.moment_photos'::regclass AND NOT t.tgisinternal",
      );
      expect(functions.rows.length, "photo DELETE journaling trigger exists").toBeGreaterThan(0);
      for (const row of functions.rows) expect(row.public_execute).toBe(false);
      const columns = await c.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = ANY($1::text[])", [PHOTO_TABLES]);
      expect(columns.rows.filter((r) => /^(?:body|memo|bytes|filename|original_filename)$/.test(r.column_name))).toEqual([]);
      expect(columns.rows.filter((r) => r.table_name === "photo_deletions" && r.column_name === "user_id")).toEqual([]);
      const roleCheck = await c.query<{ secdef: boolean; config: string[]; owner: string; pub: boolean; app: boolean; purge: boolean }>(
        `SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege($1, p.oid, 'EXECUTE') AS app,
                has_function_privilege($2, p.oid, 'EXECUTE') AS purge
           FROM pg_proc p WHERE p.oid = to_regprocedure('pod.is_photo_cleanup_role()')`, [CI_ROLES.app, CI_ROLES.purge],
      );
      expect(roleCheck.rows).toEqual([{ secdef: true, config: ["search_path=pg_catalog, pg_temp"], owner: CI_ROLES.owner, pub: false, app: false, purge: true }]);
      expect((await c.query("SELECT pod.is_photo_cleanup_role() AS allowed")).rows, "owner SET ROLE cannot substitute for the actual purge login").toEqual([{ allowed: false }]);
    });
    const purgeRole = await openClient(db.urls.purge, env.adminUrl);
    try {
      expect((await purgeRole.query("SELECT pod.is_photo_cleanup_role() AS allowed")).rows).toEqual([{ allowed: true }]);
      await expectSqlError(purgeRole.query("SELECT * FROM pod_meta.db_environment"), "42501");
    } finally { await closeClient(purgeRole); }
    await withApp(env, db, async (c) => { await expectSqlError(c.query("SELECT pod.is_photo_cleanup_role()"), "42501"); });
    const api = await loadApi();
    const pool = openAppPool(db);
    try {
      const uid = await createUser(env, db);
      const foreign = await createUser(env, db);
      const foreignMoment = await withApp(env, db, (c) => insertMoment(c, foreign));
      const blobs = new FakeBlobs();
      const created = okValue(await api.create(pool, blobs, { userId: uid, gen: 1 }, { requestId: randomUUID(), memo: "소유자 사진", photo: await photo() }), "create");
      await withOwner(env, db, async (c) => {
        await expectSqlError(c.query("UPDATE pod.moment_photos SET moment_id = $2 WHERE moment_id = $1", [created.moment.id, foreignMoment]), "23503");
        for (const [column, value] of [["width", 0], ["height", 2561], ["byte_length", 0], ["byte_length", 4 * 1024 * 1024 + 1], ["mime_type", "image/png"], ["sha256", "bad"]] as const) {
          await expectSqlError(c.query(`UPDATE pod.moment_photos SET ${column} = $2 WHERE moment_id = $1`, [created.moment.id, value]), "23514");
        }
      });
      expect(await (await loadCreatePgDiaryStore())(pool).deleteMoment(uid, created.moment.id, 1)).toEqual({ ok: true, value: null });
      expect(await tracked(db, blobs.puts[0]!)).toBe(1);
      await expect(api.cleanup(pool, blobs, { limit: 1 })).rejects.toBeDefined();
      expect(blobs.deletes, "ordinary app cleanup is refused before object DELETE").toEqual([]);
      expect(blobs.objects.has(blobs.puts[0]!)).toBe(true);
      await expectLedgerInvariants(env, db);
    } finally { await endAllPools(); }
  }, 90_000);

  it("journals before PUT without holding a user lock, returns one idempotent moment and a private DTO, and preserves the photo when memo changes", async () => {
    await withApi("photoidempotent", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const preferencesBefore = await withOwner(env, db, async (c) => {
        const design = await insertDesignVersion(c, userId);
        await c.query("INSERT INTO pod.preferences (user_id, font_key, applied_design_version_id, reflection_time) VALUES ($1, 'serif', $2, '21:15')", [userId, design]);
        return (await c.query("SELECT * FROM pod.preferences WHERE user_id = $1", [userId])).rows;
      });
      const input = { requestId: randomUUID(), memo: "  사진 한 장\n작은 기억  ", photo: await photo() };
      const blobs = new FakeBlobs();
      blobs.beforePut = async (key) => {
        const rows = await uploads(db, userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ object_key: key, status: "staged", request_id: input.requestId });
        expect(rows[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        await withOwner(env, db, async (c) => {
          await c.query("BEGIN");
          try { await c.query("SELECT id FROM pod.users WHERE id = $1 FOR UPDATE NOWAIT", [userId]); }
          finally { await c.query("ROLLBACK"); }
        });
      };
      const viewer = { userId, gen: 1 };
      const first = okValue(await api.create(pool, blobs, viewer, input), "new photo moment");
      expect(first).toEqual({ moment: { id: expect.any(String), version: 1 }, replayed: false });
      expect(await api.create(pool, blobs, viewer, { ...input, memo: input.memo.trim() })).toEqual({ ok: true, value: { ...first, replayed: true } });
      expect(await api.create(pool, blobs, viewer, { ...input, memo: "다른 원고" })).toEqual({ ok: false, error: "conflict" });
      expect(await api.create(pool, blobs, viewer, { ...input, photo: await photo("#a06080") })).toEqual({ ok: false, error: "conflict" });
      expect(blobs.puts).toHaveLength(1);
      expect(blobs.puts[0]).toMatch(KEY);
      expect(await momentRows(env, db, userId)).toMatchObject([{ id: first.moment.id, body: input.memo.trim(), version: 1, time_zone: "Asia/Seoul" }]);
      const rows = await metadataRows(db, userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ moment_id: first.moment.id, sha256: input.photo.sha256, mime_type: "image/jpeg", byte_length: input.photo.bytes.length, width: 48, height: 32 });
      expect((await uploads(db, userId))[0]).toMatchObject({ id: rows[0]!.id, status: "ready" });
      await withOwner(env, db, async (c) => {
        expect((await c.query("SELECT * FROM pod.preferences WHERE user_id = $1", [userId])).rows, "photo creation preserves font/design/reflection preferences byte-for-value").toEqual(preferencesBefore);
      });
      const diary = (await loadCreatePgDiaryStore())(pool);
      const date = (await momentRows(env, db, userId))[0]!.local_date;
      const day = await diary.getDay(userId, date);
      const dto = day!.moments[0] as unknown as { photo?: { src: string; width: number; height: number } };
      expect(dto.photo).toEqual({ src: `/photos/${rows[0]!.id}`, width: 48, height: 32 });
      for (const secret of [userId, blobs.puts[0]!, input.photo.sha256]) expect(JSON.stringify(day).includes(secret), "client DTO omits owner/key/hash").toBe(false);
      expect(await diary.updateMoment(userId, first.moment.id, 1, "메모만 수정")).toEqual({ ok: true, value: { id: first.moment.id, version: 2 } });
      expect(await metadataRows(db, userId)).toEqual(rows);
      expect(await api.read(pool, blobs, viewer, rows[0]!.id as string)).toEqual({ ok: true, value: { bytes: input.photo.bytes, contentType: "image/jpeg" } });
      const other = await createUser(env, db);
      blobs.beforePut = undefined;
      expect((await api.create(pool, blobs, { userId: other, gen: 1 }, input)).ok, "requestId belongs to the account").toBe(true);
    });
  }, 90_000);

  it("rejects invalid request/memo and inactive, missing or stale viewers before object PUT or moment creation", async () => {
    await withApi("photoguards", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const pending = await createUser(env, db);
      await setPending(env, db, pending, "now()", 2);
      const value = await photo();
      const blobs = new FakeBlobs();
      for (const memo of ["", "   ", "가".repeat(301)]) expect(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo, photo: value })).toEqual({ ok: false, error: "invalid_body" });
      expect(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: "not-a-uuid", memo: "메모", photo: value })).toEqual({ ok: false, error: "invalid_request" });
      for (const viewer of [{ userId, gen: 2 }, { userId: pending, gen: 2 }, { userId: randomUUID(), gen: 1 }]) {
        expect((await api.create(pool, blobs, viewer, { requestId: randomUUID(), memo: "메모", photo: value })).ok).toBe(false);
      }
      expect(blobs.puts).toEqual([]);
      expect(await uploads(db, userId)).toEqual([]);
      expect(await momentRows(env, db, userId)).toEqual([]);
    });
  }, 90_000);

  it("does not PUT if journal reservation fails and keeps a durable key if the final moment transaction fails", async () => {
    await withApi("photodbfailure", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const viewer = { userId, gen: 1 };
      const blobs = new FakeBlobs();
      const input = { requestId: randomUUID(), memo: "실패해도 원고 보존", photo: await photo() };
      let remove = await inject(db, "photo_uploads");
      try { expect(await api.create(pool, blobs, viewer, input)).toEqual({ ok: false, error: "unavailable" }); }
      finally { await remove(); }
      expect(blobs.puts).toEqual([]);
      expect(await uploads(db, userId)).toEqual([]);
      remove = await inject(db, "diary_moments");
      try { expect(await api.create(pool, blobs, viewer, input)).toEqual({ ok: false, error: "unavailable" }); }
      finally { await remove(); }
      expect(blobs.puts).toHaveLength(1);
      expect(await momentRows(env, db, userId)).toEqual([]);
      expect(await metadataRows(db, userId)).toEqual([]);
      expect((await uploads(db, userId)).map((row) => row.object_key)).toContain(blobs.puts[0]);
      expect(input.memo).toBe("실패해도 원고 보존");
      expect(digest(input.photo.bytes)).toBe(input.photo.sha256);
    });
  }, 90_000);

  it("never reports PUT failure or lost PUT response as success and retains keys for later cleanup", async () => {
    await withApi("photoputfail", async (api, pool, db) => {
      for (const acceptedButResponseLost of [false, true]) {
        const userId = await createUser(env, db);
        const blobs = new FakeBlobs();
        blobs.beforePut = async (key, value) => {
          if (acceptedButResponseLost) blobs.objects.set(key, Buffer.from(value.bytes));
          throw new Error("ci-only-put-response-unavailable");
        };
        expect(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo: "전송 실패 원고", photo: await photo() })).toEqual({ ok: false, error: "unavailable" });
        expect(await momentRows(env, db, userId)).toEqual([]);
        expect(await metadataRows(db, userId)).toEqual([]);
        expect((await uploads(db, userId)).map((row) => row.object_key)).toEqual(blobs.puts);
        await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100, now: later() }));
        expect(blobs.deletes).toContain(blobs.puts[0]);
        expect(blobs.objects.has(blobs.puts[0]!)).toBe(false);
        expect(await tracked(db, blobs.puts[0]!)).toBeGreaterThan(0);
      }
    });
  }, 90_000);

  it("returns busy for the same active lease, conflict for changed input and never cleans an in-flight PUT", async () => {
    await withApi("photobusy", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const blobs = new FakeBlobs();
      const entered = gate();
      const release = gate();
      blobs.beforePut = async () => { entered.resolve(); await release.promise; };
      const input = { requestId: randomUUID(), memo: "현재 전송 중", photo: await photo() };
      const first = api.create(pool, blobs, { userId, gen: 1 }, input);
      try {
        await bounded(entered.promise);
        expect(await api.create(pool, blobs, { userId, gen: 1 }, input)).toEqual({ ok: false, error: "busy" });
        expect(await api.create(pool, blobs, { userId, gen: 1 }, { ...input, memo: "다른 입력" })).toEqual({ ok: false, error: "conflict" });
        const stats = await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100 }));
        expect(stats.deleted).toBe(0);
        expect(stats.failed).toBe(0);
        expect(stats.busy).toBeGreaterThanOrEqual(0);
        expect(blobs.puts).toHaveLength(1);
        expect(blobs.deletes).toEqual([]);
        expect((await uploads(db, userId))[0]!.status).toBe("staged");
      } finally { release.resolve(); await first; }
      expect(await momentRows(env, db, userId)).toHaveLength(1);
    });
  }, 90_000);

  it("retries an expired lease with a new id/key, fences the old completion and keeps tombstones across a late PUT", async () => {
    await withApi("photofencing", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const blobs = new FakeBlobs();
      const entered = gate();
      const release = gate();
      blobs.beforePut = async () => { if (blobs.puts.length === 1) { entered.resolve(); await release.promise; } };
      const input = { requestId: randomUUID(), memo: "같은 원고의 재시도", photo: await photo() };
      const first = api.create(pool, blobs, { userId, gen: 1 }, input);
      let old: Upload | undefined;
      let replacement: MomentRef | undefined;
      let oldResult: Awaited<ReturnType<Api["create"]>> | undefined;
      try {
        await bounded(entered.promise);
        old = (await uploads(db, userId))[0]!;
        await withOwner(env, db, (c) => c.query("UPDATE pod.photo_uploads SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [old!.id]));
        const second = okValue(await api.create(pool, blobs, { userId, gen: 1 }, input), "expired retry");
        replacement = second.moment;
        const rows = await uploads(db, userId);
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === old!.id)!.status).toBe("abandoned");
        const ready = rows.find((row) => row.status === "ready")!;
        expect(ready.id).not.toBe(old.id);
        expect(ready.object_key).not.toBe(old.object_key);
        expect(ready.lease_token).not.toBe(old.lease_token);
        expect(await api.create(pool, blobs, { userId, gen: 1 }, { ...input, memo: "과거 시도와 다른 원고" })).toEqual({ ok: false, error: "conflict" });
        await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100, now: later() }));
        expect(await tracked(db, old.object_key)).toBeGreaterThan(0);
      } finally { release.resolve(); oldResult = await bounded(first); }
      expect(oldResult!.ok, "expired token cannot finish a new request").toBe(false);
      expect((await momentRows(env, db, userId)).map((row) => row.id)).toEqual([replacement!.id]);
      expect(blobs.objects.has(old!.object_key), "late PUT really occurred in the fake port").toBe(true);
      await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100, now: new Date(Date.now() + 14 * 86_400_000) }));
      expect(blobs.objects.has(old!.object_key)).toBe(false);
      const ready = (await uploads(db, userId)).find((row) => row.status === "ready")!;
      expect(blobs.objects.has(ready.object_key)).toBe(true);
      expect(await tracked(db, old!.object_key)).toBeGreaterThan(0);
    });
  }, 90_000);

  it("rechecks generation and active status after PUT and never creates a moment for an account changed during external I/O", async () => {
    await withApi("photofinalguard", async (api, pool, db) => {
      for (const mutation of ["generation", "withdrawal"] as const) {
        const userId = await createUser(env, db);
        const blobs = new FakeBlobs();
        blobs.beforePut = async () => {
          if (mutation === "generation") await withOwner(env, db, (c) => c.query("UPDATE pod.users SET auth_generation = auth_generation + 1 WHERE id = $1", [userId]));
          else expect((await (await loadLifecycle()).withdraw(pool, { userId, gen: 1 })).ok).toBe(true);
        };
        expect((await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo: "외부 전송 중 계정 변화", photo: await photo() })).ok).toBe(false);
        expect(await momentRows(env, db, userId)).toEqual([]);
        expect(await metadataRows(db, userId)).toEqual([]);
        expect((await uploads(db, userId)).map((row) => row.object_key)).toEqual(blobs.puts);
      }
    });
  }, 90_000);

  it("reads only ready owned photos, verifies stored bytes and rechecks account generation immediately before returning bytes", async () => {
    await withApi("photoread", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const other = await createUser(env, db);
      const blobs = new FakeBlobs();
      const value = await photo();
      okValue(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo: "비공개 읽기", photo: value }), "create");
      const id = (await metadataRows(db, userId))[0]!.id as string;
      for (const [viewer, photoId] of [[{ userId: other, gen: 1 }, id], [{ userId, gen: 2 }, id], [{ userId, gen: 1 }, randomUUID()]] as const) {
        const reads = blobs.gets.length;
        expect(await api.read(pool, blobs, viewer, photoId)).toEqual({ ok: false, error: "not_found" });
        expect(blobs.gets).toHaveLength(reads);
      }
      const key = blobs.puts[0]!;
      blobs.objects.set(key, Buffer.from("ci-only-corrupt-object"));
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "unavailable" });
      blobs.objects.set(key, value.bytes);
      await withOwner(env, db, (c) => c.query("UPDATE pod.moment_photos SET byte_length = byte_length + 1 WHERE id = $1", [id]));
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "unavailable" });
      await withOwner(env, db, (c) => c.query("UPDATE pod.moment_photos SET byte_length = $2, width = width + 1 WHERE id = $1", [id, value.bytes.length]));
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "unavailable" });
      await withOwner(env, db, (c) => c.query("UPDATE pod.moment_photos SET width = $2 WHERE id = $1", [id, value.width]));
      blobs.beforeGet = async () => { await withOwner(env, db, (c) => c.query("UPDATE pod.users SET auth_generation = 2 WHERE id = $1", [userId])); };
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "not_found" });
      const replacement = okValue(await api.create(pool, blobs, { userId, gen: 2 }, { requestId: randomUUID(), memo: "읽는 중 삭제될 사진", photo: value }), "second photo");
      const secondId = (await metadataRows(db, userId)).find((row) => row.moment_id === replacement.moment.id)!.id as string;
      blobs.beforeGet = async () => {
        expect(await (await loadCreatePgDiaryStore())(pool).deleteMoment(userId, replacement.moment.id, 1)).toEqual({ ok: true, value: null });
      };
      expect(await api.read(pool, blobs, { userId, gen: 2 }, secondId), "removing ownership while bytes are in flight prevents the response").toEqual({ ok: false, error: "not_found" });
    });
  }, 90_000);

  it("journals deletion in the same transaction, restores it on rollback, immediately denies deleted reads and retries failed object deletion", async () => {
    await withApi("photodeletion", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const blobs = new FakeBlobs();
      const created = okValue(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo: "삭제와 보존", photo: await photo() }), "create");
      const id = (await metadataRows(db, userId))[0]!.id as string;
      const key = blobs.puts[0]!;
      await withOwner(env, db, async (c) => {
        await c.query("BEGIN");
        try {
          await c.query("DELETE FROM pod.diary_moments WHERE id = $1", [created.moment.id]);
          expect((await c.query("SELECT 1 FROM pod.photo_deletions WHERE object_key = $1", [key])).rows).toHaveLength(1);
        } finally { await c.query("ROLLBACK"); }
      });
      expect((await api.read(pool, blobs, { userId, gen: 1 }, id)).ok).toBe(true);
      expect(await tracked(db, key)).toBe(0);
      expect(await (await loadCreatePgDiaryStore())(pool).deleteMoment(userId, created.moment.id, 1)).toEqual({ ok: true, value: null });
      const reads = blobs.gets.length;
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "not_found" });
      expect(blobs.gets).toHaveLength(reads);
      expect(await tracked(db, key)).toBe(1);
      blobs.beforeDelete = async () => { throw new Error("ci-only-delete-unavailable"); };
      expect((await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 1, now: later() }))).failed).toBe(1);
      expect(blobs.objects.has(key)).toBe(true);
      expect(await tracked(db, key)).toBe(1);
      blobs.beforeDelete = async () => {
        await withOwner(env, db, async (c) => {
          await c.query("BEGIN");
          try {
            await c.query("SELECT id FROM pod.photo_uploads WHERE object_key = $1 FOR UPDATE NOWAIT", [key]);
            await c.query("SELECT object_key FROM pod.photo_deletions WHERE object_key = $1 FOR UPDATE NOWAIT", [key]);
          } finally { await c.query("ROLLBACK"); }
        });
      };
      expect((await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 1, now: new Date(Date.now() + 14 * 86_400_000) }))).deleted).toBe(1);
      expect(blobs.objects.has(key)).toBe(false);
      expect(await tracked(db, key), "late PUT can still be tracked after a successful delete").toBe(1);
    });
  }, 90_000);

  it("keeps bytes during the 720-hour recovery window, restores reads with a fresh generation, and retains anonymous deletion tracking after purge", async () => {
    await withApi("photolifecycle", async (api, pool, db) => {
      const userId = await createUser(env, db);
      const blobs = new FakeBlobs();
      okValue(await api.create(pool, blobs, { userId, gen: 1 }, { requestId: randomUUID(), memo: "복구할 사진", photo: await photo() }), "create");
      const id = (await metadataRows(db, userId))[0]!.id as string;
      const key = blobs.puts[0]!;
      const lifecycle = await loadLifecycle();
      expect((await lifecycle.withdraw(pool, { userId, gen: 1 })).ok).toBe(true);
      const reads = blobs.gets.length;
      expect(await api.read(pool, blobs, { userId, gen: 1 }, id)).toEqual({ ok: false, error: "not_found" });
      expect(blobs.gets).toHaveLength(reads);
      await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100 }));
      expect(blobs.objects.has(key)).toBe(true);
      expect(blobs.deletes).toEqual([]);
      await setPending(env, db, userId, "now() - interval '719 hours'", 2);
      expect(await lifecycle.restore(pool, { userId, gen: 2 })).toEqual({ ok: true, value: { gen: 3 } });
      expect((await api.read(pool, blobs, { userId, gen: 3 }, id)).ok).toBe(true);
      expect((await lifecycle.withdraw(pool, { userId, gen: 3 })).ok).toBe(true);
      await setPending(env, db, userId, "now() - interval '721 hours'", 4);
      const purge = await openClient(db.urls.purge, env.adminUrl);
      try { expect((await purge.query<{ result: string }>("SELECT pod.purge_user_if_due($1) AS result", [userId])).rows[0]!.result).toBe("purged"); }
      finally { await closeClient(purge); }
      expect(await metadataRows(db, userId)).toEqual([]);
      await withOwner(env, db, async (c) => {
        expect((await c.query("SELECT user_id FROM pod.photo_uploads WHERE object_key = $1", [key])).rows).toEqual([{ user_id: null }]);
      });
      expect(await tracked(db, key)).toBe(1);
      expect(await api.read(pool, blobs, { userId, gen: 3 }, id)).toEqual({ ok: false, error: "not_found" });
      await withCleanup(db, (purge) => api.cleanup(purge, blobs, { limit: 100, now: later() }));
      expect(blobs.objects.has(key)).toBe(false);
      expect(await tracked(db, key)).toBe(1);
    });
  }, 90_000);

  it("refuses down when only an ownerless photo journal remains, preserving the complete schema and row", async () => {
    const db = await freshMigratedDb(env, "photodown");
    await expectPhotosApplied(db);
    const key = `photos/${randomUUID()}.jpg`;
    await withOwner(env, db, (c) => c.query(
      "INSERT INTO pod.photo_uploads (id, user_id, request_id, fingerprint, object_key, status, lease_token, lease_until) VALUES ($1, NULL, $2, $3, $4, 'abandoned', $5, now() - interval '1 hour')",
      [randomUUID(), randomUUID(), "a".repeat(64), key, randomUUID()],
    ));
    const before = await withOwner(env, db, (c) => schemaSnapshot(c));
    expectCliFail(await runMigrateCli(["down", "--to", "0", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaSnapshot(c)).toEqual(before);
      expect((await c.query("SELECT object_key FROM pod.photo_uploads")).rows).toEqual([{ object_key: key }]);
      expect((await c.query("SELECT count(*)::int AS n FROM pod.users")).rows).toEqual([{ n: 0 }]);
    });
  }, 90_000);
});
