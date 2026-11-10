// PLAN_reflection-time-settings §2~§5 RED. 기존 일회용 PG18/app role 하네스만 사용한다.
// 제품 모듈·migration 부재는 각 it의 명시 단언으로 실패한다. 관리자 연결은 fixture·조회·권한 검증 전용이다.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CI_ROLES, cleanupAll, createDisposableDatabase, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  APP_DIR, PRODUCT_MIGRATIONS_DIR, cleanupTempDirs, expectCliOk, expectSqlError, insertDesignVersion,
  insertMoment, insertUser, makeMigrationsDir, readMigrationRows, runMigrateCli, schemaSnapshot, userDataCounts, withApp, withOwner,
} from "./f2-support";
import { endAllPools, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { MISSING_UUID, createUser, expectNoSql } from "./f3-diary-support";
import { loadPreferences } from "./f3-decoration-support";

const MODULE = path.join(APP_DIR, "src", "server", "account", "reflection-time.pg.ts");
const CASE_TIMEOUT = 90_000;
const LEGACY_TABLES = ["users", "auth_identities", "preferences", "diary_moments", "day_summaries", "design_versions", "credit_accounts", "emotion_ledger"] as const;
type Api = {
  getReflectionTime: (db: pg.Pool, userId: string) => Promise<string>;
  setReflectionTime: (db: pg.Pool, userId: string, input: unknown) => Promise<Result<string, "invalid_reflection_time" | "not_found">>;
};
let env: HarnessEnv;
let shared: Promise<DisposableDatabase> | undefined;

beforeAll(() => { env = readDisposableEnv(); });
afterAll(async () => {
  try {
    await endAllPools();
    await cleanupTempDirs();
  } finally {
    if (env) await cleanupAll(env);
  }
});

async function loadApi(): Promise<Api> {
  let mod: Record<string, unknown> = {};
  try {
    mod = await import(/* @vite-ignore */ MODULE);
  } catch (err) {
    if (existsSync(MODULE)) throw err;
  }
  for (const name of ["getReflectionTime", "setReflectionTime"]) {
    expect(typeof mod[name], `account/reflection-time.pg.ts must export function ${name}`).toBe("function");
  }
  return mod as unknown as Api;
}

async function expectMigration3(db: DisposableDatabase): Promise<void> {
  const rows = await withOwner(env, db, (c) => readMigrationRows(c));
  expect(rows?.map((r) => ({ version: r.version, name: r.name })), "default migrations must include reflection_time").toEqual([
    { version: 1, name: "init" }, { version: 2, name: "account_lifecycle" }, { version: 3, name: "reflection_time" },
    { version: 4, name: "private_photos" },
  ]);
}

async function migration3(direction: "up" | "down"): Promise<string> {
  const file = path.join(PRODUCT_MIGRATIONS_DIR, `0003_reflection_time.${direction}.sql`);
  expect(existsSync(file), `0003_reflection_time.${direction}.sql must exist`).toBe(true);
  return readFile(file, "utf8");
}

async function withApi(fn: (api: Api, pool: pg.Pool, db: DisposableDatabase) => Promise<void>): Promise<void> {
  const api = await loadApi();
  shared ??= freshMigratedDb(env, "reflection");
  const db = await shared;
  await expectMigration3(db);
  const pool = openAppPool(db);
  try {
    await fn(api, pool, db);
  } finally {
    await endAllPools();
  }
}

const preferenceRow = (db: DisposableDatabase, userId: string) => withOwner(env, db, async (c) =>
  (await c.query<{ user_id: string; font_key: string; applied: string | null; reflection_time: string; updated_at: string }>(
    `SELECT user_id::text, font_key, applied_design_version_id::text AS applied, reflection_time, updated_at::text
       FROM pod.preferences WHERE user_id = $1::uuid`, [userId],
  )).rows[0] ?? null,
);

describe("reflection time account storage", () => {
  it("returns 20:00 without inserting a row for missing preferences or invalid UUIDs; invalid UUIDs send SQL 0", async () => {
    await withApi(async (api, pool, db) => {
      const user = await createUser(env, db);
      expect(await expectNoSql(pool, async () => Promise.all(["", "not-a-uuid"].map((id) => api.getReflectionTime(pool, id))))).toEqual(["20:00", "20:00"]);
      expect(await api.getReflectionTime(pool, user)).toBe("20:00");
      expect(await api.getReflectionTime(pool, MISSING_UUID)).toBe("20:00");
      expect(await preferenceRow(db, user), "read does not create preferences").toBeNull();
    });
  }, CASE_TIMEOUT);

  it("upserts valid minute boundaries for one account, preserves font/design in both directions and keeps the existing preferences shape", async () => {
    await withApi(async (api, pool, db) => {
      const user = await createUser(env, db);
      const other = await createUser(env, db);
      const prefs = await loadPreferences();
      const design = await withOwner(env, db, (c) => insertDesignVersion(c, user));
      const momentsBefore = await withOwner(env, db, async (c) => {
        await insertMoment(c, user);
        return (await c.query("SELECT * FROM pod.diary_moments WHERE user_id = $1", [user])).rows;
      });
      expect(await prefs.setFontKey(pool, user, "hand")).toEqual({ ok: true, value: "hand" });
      expect(await prefs.applyDesign(pool, user, design)).toEqual({ ok: true, value: null });
      await withOwner(env, db, (c) => c.query("UPDATE pod.preferences SET updated_at = '2000-01-01 00:00:00+00' WHERE user_id = $1", [user]));
      const before = await preferenceRow(db, user);
      for (const time of ["00:00", "23:59", "21:35"]) {
        expect(await api.setReflectionTime(pool, user, time)).toEqual({ ok: true, value: time });
        expect(await api.getReflectionTime(pool, user)).toBe(time);
        expect(await preferenceRow(db, user)).toMatchObject({ user_id: user, font_key: "hand", applied: design, reflection_time: time });
      }
      expect((await preferenceRow(db, user))!.updated_at).not.toBe(before!.updated_at);
      expect(await api.setReflectionTime(pool, other, "06:10")).toEqual({ ok: true, value: "06:10" });
      expect(await api.getReflectionTime(pool, user)).toBe("21:35");
      expect(await api.getReflectionTime(pool, other)).toBe("06:10");
      expect(await prefs.getPreferences(pool, user), "existing getter shape is unchanged").toEqual({ fontKey: "hand", appliedDesignVersionId: design });
      expect(await prefs.setFontKey(pool, user, "serif")).toEqual({ ok: true, value: "serif" });
      expect(await prefs.applyDesign(pool, user, null)).toEqual({ ok: true, value: null });
      expect(await api.getReflectionTime(pool, user), "existing preference upserts preserve time").toBe("21:35");
      expect(await preferenceRow(db, other)).toMatchObject({ font_key: "gothic", applied: null, reflection_time: "06:10" });
      await withOwner(env, db, async (c) => {
        expect((await c.query("SELECT * FROM pod.diary_moments WHERE user_id = $1", [user])).rows, "reflection settings never change original moment timestamps or dates").toEqual(momentsBefore);
      });
    });
  }, CASE_TIMEOUT);

  it("rejects malformed values and invalid owners with SQL 0; a well-formed missing owner returns not_found without creating preferences", async () => {
    await withApi(async (api, pool, db) => {
      const user = await createUser(env, db);
      const invalid: unknown[] = [undefined, null, 2000, {}, ["20:00"], "", "24:00", "23:60", "0:00", "20:00:00", " 20:00", "20:00\n", "２０:００"];
      await expectNoSql(pool, async () => {
        for (const value of invalid) expect(await api.setReflectionTime(pool, user, value)).toEqual({ ok: false, error: "invalid_reflection_time" });
        for (const id of ["", "not-a-uuid"]) expect(await api.setReflectionTime(pool, id, "21:00")).toEqual({ ok: false, error: "not_found" });
      });
      expect(await api.setReflectionTime(pool, MISSING_UUID, "21:00")).toEqual({ ok: false, error: "not_found" });
      expect(await preferenceRow(db, user)).toBeNull();
      expect(await preferenceRow(db, MISSING_UUID)).toBeNull();
    });
  }, CASE_TIMEOUT);

  it("propagates DB read/write failures instead of returning an editable default or a false save", async () => {
    const api = await loadApi();
    const failure = new Error("ci-only-reflection-db-failure");
    const db = { query: async () => { throw failure; } } as unknown as pg.Pool;
    await expect(api.getReflectionTime(db, MISSING_UUID)).rejects.toBe(failure);
    await expect(api.setReflectionTime(db, MISSING_UUID, "21:30")).rejects.toBe(failure);
  });
});

describe("0003 reflection_time schema and permissions", () => {
  it("backfills existing preferences to 20:00 while preserving font/design, timestamps, records and all existing rows", async () => {
    const files: Record<string, string> = {};
    for (const name of ["0001_init", "0002_account_lifecycle"]) for (const direction of ["up", "down"]) {
      const file = `${name}.${direction}.sql`;
      files[file] = await readFile(path.join(PRODUCT_MIGRATIONS_DIR, file), "utf8");
    }
    const dir = await makeMigrationsDir(files);
    const db = await createDisposableDatabase(env, "reflectionlegacy");
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, async (c) => {
      const user = await insertUser(c);
      const design = await insertDesignVersion(c, user);
      await insertMoment(c, user);
      await c.query("INSERT INTO pod.preferences (user_id, font_key, applied_design_version_id) VALUES ($1, 'serif', $2)", [user, design]);
      return { user, design, counts: await userDataCounts(c, LEGACY_TABLES), row: (await c.query("SELECT * FROM pod.preferences WHERE user_id = $1", [user])).rows[0] };
    });
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectMigration3(db);
    await withOwner(env, db, async (c) => {
      const counts = await userDataCounts(c);
      expect(Object.fromEntries(LEGACY_TABLES.map((name) => [name, counts[name]]))).toEqual(before.counts);
      for (const name of ["photo_uploads", "moment_photos", "photo_deletions"]) expect(counts[name], `${name}: no rows were created by the reflection upgrade`).toBe(0);
      expect((await c.query("SELECT * FROM pod.preferences WHERE user_id = $1", [before.user])).rows).toEqual([{ ...before.row, reflection_time: "20:00" }]);
    });
  }, CASE_TIMEOUT);

  it("enforces NOT NULL and exact ASCII HH:mm in SQL, grants only the new UPDATE column, and preserves the existing cascade", async () => {
    const db = await freshMigratedDb(env, "reflectioncheck");
    await expectMigration3(db);
    const user = await createUser(env, db);
    await withApp(env, db, async (c) => {
      await c.query("INSERT INTO pod.preferences (user_id) VALUES ($1)", [user]);
      expect((await c.query("SELECT reflection_time FROM pod.preferences WHERE user_id = $1", [user])).rows).toEqual([{ reflection_time: "20:00" }]);
      for (const time of ["00:00", "23:59"]) await c.query("UPDATE pod.preferences SET reflection_time = $2 WHERE user_id = $1", [user, time]);
      for (const time of ["24:00", "23:60", "0:00", "20:00:00", " 20:00", "20:00\n", "２０:００"]) {
        await expectSqlError(c.query("UPDATE pod.preferences SET reflection_time = $2 WHERE user_id = $1", [user, time]), "23514");
      }
      await expectSqlError(c.query("UPDATE pod.preferences SET reflection_time = NULL WHERE user_id = $1", [user]), "23502");
      await expectSqlError(c.query("UPDATE pod.preferences SET user_id = user_id WHERE user_id = $1", [user]), "42501");
      await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = delta WHERE false"), "42501");
    });
    await withOwner(env, db, async (c) => {
      const r = await c.query<{ table_update: boolean; time_update: boolean; public_update: boolean }>(
        `SELECT has_table_privilege($1, 'pod.preferences', 'UPDATE') AS table_update,
                has_column_privilege($1, 'pod.preferences', 'reflection_time', 'UPDATE') AS time_update,
                has_column_privilege('public', 'pod.preferences', 'reflection_time', 'UPDATE') AS public_update`, [CI_ROLES.app],
      );
      expect(r.rows).toEqual([{ table_update: false, time_update: true, public_update: false }]);
      await c.query("DELETE FROM pod.users WHERE id = $1", [user]);
      expect((await c.query("SELECT 1 FROM pod.preferences WHERE user_id = $1", [user])).rows).toEqual([]);
    });
  }, CASE_TIMEOUT);

  it("direct down refuses dev and user data before changing anything; empty CI down/up restores the schema and column ACLs", async () => {
    const db = await freshMigratedDb(env, "reflectiondown");
    await expectMigration3(db);
    const down = await migration3("down");
    const up = await migration3("up");
    const snapshot = () => withOwner(env, db, (c) => schemaSnapshot(c));
    const full = await snapshot();
    await withOwner(env, db, async (c) => {
      await c.query("UPDATE pod_meta.db_environment SET name = 'dev'");
      await expectSqlError(c.query(down), "P0001");
      expect(await schemaSnapshot(c)).toEqual(full);
      await c.query("UPDATE pod_meta.db_environment SET name = 'ci'");
      const user = await insertUser(c);
      await expectSqlError(c.query(down), "P0001");
      expect(await schemaSnapshot(c)).toEqual(full);
      expect((await c.query("SELECT id FROM pod.users WHERE id = $1", [user])).rowCount).toBe(1);
      await c.query("DELETE FROM pod.users WHERE id = $1", [user]);
      await c.query(down);
      expect((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'pod' AND table_name = 'preferences' AND column_name = 'reflection_time'")).rows).toEqual([]);
      await c.query(up);
      expect(await schemaSnapshot(c), "up/down/up preserves all objects and ACLs").toEqual(full);
    });
  }, CASE_TIMEOUT);
});
