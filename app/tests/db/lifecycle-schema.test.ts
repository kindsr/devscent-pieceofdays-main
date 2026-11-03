// F4 L1 RED — 계정 상태·기한·generation 스키마와 purge 함수 권한(PLAN_account-lifecycle §5·§6·§10~§13 L1).
// 대상 제품 파일 app/migrations/0002_account_lifecycle.{up,down}.sql은 아직 없다(GREEN 소유).
//
// - 실제 PG18 일회용 DB와 F2 하네스만 쓴다. app·purge·owner(migrator → SET ROLE)·migrator(SET ROLE 없음)로 각각 접속한다.
// - DB 준비(up)는 0001만 있어도 성공한다. 0002가 적용됐는지·새 열/함수/권한은 각 it 안에서 단언한다(beforeAll skip 없음).
// - 실패 주입 트리거는 이 파일이 만든 일회용 DB에서만 만들고 지운다. 제품 SQL·실행기·정책은 바꾸지 않는다.
// - 시험 값은 모두 가짜다. 실제 비밀값·서버 DB를 쓰지 않는다.
// - 오류 문구는 계약이 아니다. SQLSTATE와 제약 이름(PLAN §10 1번 고정 이름)만 본다.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CI_ROLES,
  cleanupAll,
  closeClient,
  createDisposableDatabase,
  openClient,
  readDisposableEnv,
  type DisposableDatabase,
  type HarnessEnv,
} from "./helpers";
import {
  INIT_DOWN,
  INIT_UP,
  PRODUCT_MIGRATIONS_DIR,
  USER_DATA_TABLES,
  cleanupTempDirs,
  expectCliFail,
  expectCliOk,
  expectSqlError,
  makeMigrationsDir,
  readMigrationRows,
  runMigrateCli,
  schemaSnapshot,
  withApp,
  withOwner,
} from "./f2-support";

const LIFECYCLE_UP = path.join(PRODUCT_MIGRATIONS_DIR, "0002_account_lifecycle.up.sql");
const LIFECYCLE_DOWN = path.join(PRODUCT_MIGRATIONS_DIR, "0002_account_lifecycle.down.sql");
const LIST_FN = "pod.list_purge_due(integer)";
const PURGE_FN = "pod.purge_user_if_due(uuid)";
const TRIGGER_FN = "pod.emotion_ledger_append_only()";
const T = "2026-11-03 00:00:00+00"; // CHECK 시험용 고정 시각(가짜)

let env: HarnessEnv;
let shared: Promise<DisposableDatabase> | undefined;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  try {
    await cleanupTempDirs();
  } finally {
    if (env) await cleanupAll(env);
  }
});

// ---------------------------------------------------------------- 준비·접속 도우미

/** 새 일회용 DB에 기본 app/migrations로 up한다(0001만 있어도 성공한다. 0002 적용 여부는 각 it이 단언한다). */
async function freshUp(label: string): Promise<DisposableDatabase> {
  const db = await createDisposableDatabase(env, label);
  expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
  return db;
}

/** 여러 it이 함께 쓰는 DB(사례마다 독립 사용자). 실패 주입·meta 변경·down 사례는 각자 새 DB를 쓴다. */
function sharedDb(): Promise<DisposableDatabase> {
  shared ??= freshUp("l1schema");
  return shared;
}

/** 0002_account_lifecycle이 기록돼 있어야 한다(없으면 GREEN 전의 정상 RED 원인). */
async function expectLifecycleApplied(db: DisposableDatabase): Promise<void> {
  const rows = await withOwner(env, db, (c) => readMigrationRows(c));
  expect(
    rows?.map((r) => ({ version: r.version, name: r.name })),
    "0002_account_lifecycle must be applied by the default up (missing before GREEN)",
  ).toEqual([
    { version: 1, name: "init" },
    { version: 2, name: "account_lifecycle" },
  ]);
}

async function withRole<T>(url: string, expectedUser: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await openClient(url, env.adminUrl);
  try {
    const me = await c.query<{ u: string }>("SELECT current_user AS u");
    expect(me.rows[0]?.u).toBe(expectedUser);
    return await fn(c);
  } finally {
    await closeClient(c);
  }
}

const withPurge = <T>(db: DisposableDatabase, fn: (c: pg.Client) => Promise<T>) => withRole(db.urls.purge, CI_ROLES.purge, fn);
/** migrator로 접속하되 SET ROLE을 하지 않은 연결(current_user = migrator, owner 권한은 상속). */
const withMigratorOnly = <T>(db: DisposableDatabase, fn: (c: pg.Client) => Promise<T>) =>
  withRole(db.urls.migrator, CI_ROLES.migrator, fn);

/** SQLSTATE와(주면) 제약 이름까지 확인한다. */
async function expectViolation(promise: Promise<unknown>, sqlState: string, constraint?: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected SQLSTATE ${sqlState}${constraint ? ` (${constraint})` : ""}, but it succeeded`).toBeDefined();
  const e = caught as { code?: unknown; constraint?: unknown; message?: unknown };
  expect(e.code, `unexpected error: ${String(e.message)}`).toBe(sqlState);
  if (constraint !== undefined) expect(e.constraint, String(e.message)).toBe(constraint);
}

/** 트랜잭션 안에서 실행하고 항상 ROLLBACK한다. */
async function inRollback<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    return await fn();
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- 시험 데이터(owner)

async function insertUserRow(c: pg.Client, status: "active" | "pending_deletion", requestedSql = "NULL"): Promise<string> {
  const r =
    status === "active"
      ? await c.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id::text AS id")
      : await c.query<{ id: string }>(
          `INSERT INTO pod.users (status, deletion_requested_at, purge_after)
           SELECT 'pending_deletion', r, r + interval '720 hours' FROM (SELECT ${requestedSql} AS r) s
           RETURNING id::text AS id`,
        );
  return r.rows[0]!.id;
}

/** 8개 사용자 데이터 테이블 모두에 종속 행을 만든다(owner). */
async function seedAllTables(c: pg.Client, uid: string): Promise<void> {
  await c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, 'testprov', $2)", [uid, `sub-${uid}`]);
  const v = await c.query<{ id: string }>(
    `INSERT INTO pod.design_versions (owner_id, manifest) VALUES ($1, '{"schema":1,"base":"d-warm-pieces@1","placements":[],"ink":[]}'::jsonb)
     RETURNING id::text AS id`,
    [uid],
  );
  await c.query("INSERT INTO pod.preferences (user_id, font_key, applied_design_version_id) VALUES ($1, 'serif', $2)", [
    uid,
    v.rows[0]!.id,
  ]);
  await c.query(
    `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body)
     VALUES ($1, DATE '2026-10-01', TIMESTAMPTZ '2026-10-01 09:00:00+09', '조각')`,
    [uid],
  );
  await c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, DATE '2026-10-01', '한 줄')", [uid]);
  await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 10)", [uid]);
  await c.query(
    "INSERT INTO pod.emotion_ledger (user_id, delta, reason, grant_key) VALUES ($1, 10, 'first_login_grant', $2)",
    [uid, `first_login:${uid}`],
  );
}

type PerUser = Record<(typeof USER_DATA_TABLES)[number], number>;

/** 한 사용자에 속한 행 수(8개 테이블). owner 연결로 호출한다. */
async function countsFor(c: pg.Client, uid: string): Promise<PerUser> {
  const r = await c.query<PerUser>(
    `SELECT (SELECT count(*)::int FROM pod.users WHERE id = $1)                  AS users,
            (SELECT count(*)::int FROM pod.auth_identities WHERE user_id = $1)   AS auth_identities,
            (SELECT count(*)::int FROM pod.preferences WHERE user_id = $1)       AS preferences,
            (SELECT count(*)::int FROM pod.diary_moments WHERE user_id = $1)     AS diary_moments,
            (SELECT count(*)::int FROM pod.day_summaries WHERE user_id = $1)     AS day_summaries,
            (SELECT count(*)::int FROM pod.design_versions WHERE owner_id = $1)  AS design_versions,
            (SELECT count(*)::int FROM pod.credit_accounts WHERE user_id = $1)   AS credit_accounts,
            (SELECT count(*)::int FROM pod.emotion_ledger WHERE user_id = $1)    AS emotion_ledger`,
    [uid],
  );
  return r.rows[0]!;
}

const ALL_ONE = Object.fromEntries(USER_DATA_TABLES.map((t) => [t, 1])) as PerUser;
const ALL_ZERO = Object.fromEntries(USER_DATA_TABLES.map((t) => [t, 0])) as PerUser;

// ================================================================ 열·CHECK·인덱스

describe("0002: users lifecycle columns, named CHECKs and the partial index", () => {
  it("adds status/deletion_requested_at/purge_after/auth_generation with the contracted types, defaults, named CHECKs and users_purge_due_idx", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    await withOwner(env, db, async (c) => {
      const cols = await c.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'pod' AND table_name = 'users'
            AND column_name IN ('status', 'deletion_requested_at', 'purge_after', 'auth_generation')
          ORDER BY column_name`,
      );
      expect(cols.rows).toEqual([
        { column_name: "auth_generation", data_type: "integer", is_nullable: "NO", column_default: "1" },
        { column_name: "deletion_requested_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
        { column_name: "purge_after", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
        { column_name: "status", data_type: "text", is_nullable: "NO", column_default: "'active'::text" },
      ]);
      const checks = await c.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conrelid = 'pod.users'::regclass AND contype = 'c' ORDER BY conname",
      );
      expect(checks.rows.map((r) => r.conname)).toEqual(
        expect.arrayContaining(["users_auth_generation_check", "users_lifecycle_consistency", "users_status_check"]),
      );
      const idx = await c.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'pod' AND indexname = 'users_purge_due_idx'",
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0]!.indexdef).toMatch(/ON pod\.users USING btree \(purge_after\)/);
      expect(idx.rows[0]!.indexdef).toMatch(/WHERE \(status = 'pending_deletion'::text\)/);
      // 목록은 그대로 8개 테이블
      const tables = await c.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'pod' ORDER BY 1");
      expect(tables.rows.map((r) => r.t)).toEqual([...USER_DATA_TABLES].sort());
    });
    await withApp(env, db, async (c) => {
      const r = await c.query<{ status: string; gen: number; r: unknown; p: unknown }>(
        `INSERT INTO pod.users DEFAULT VALUES
         RETURNING status, auth_generation AS gen, deletion_requested_at AS r, purge_after AS p`,
      );
      expect(r.rows).toEqual([{ status: "active", gen: 1, r: null, p: null }]);
    });
  });

  it("expand on existing data: users created under 0001 become active / gen 1 / NULL times when 0002 is applied", async () => {
    const db = await createDisposableDatabase(env, "l1expand");
    const initOnly = await makeMigrationsDir({
      "0001_init.up.sql": await readFile(INIT_UP, "utf8"),
      "0001_init.down.sql": await readFile(INIT_DOWN, "utf8"),
    });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", initOnly], db.urls.migrator), db.urls.migrator);
    const uid = await withApp(env, db, async (c) => {
      const r = await c.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id::text AS id");
      return r.rows[0]!.id;
    });
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await expectLifecycleApplied(db);
    await withOwner(env, db, async (c) => {
      const r = await c.query("SELECT status, auth_generation AS gen, deletion_requested_at AS r, purge_after AS p FROM pod.users WHERE id = $1", [uid]);
      expect(r.rows).toEqual([{ status: "active", gen: 1, r: null, p: null }]);
    });
  });

  it("CHECKs reject inconsistent lifecycle rows with 23514 (named) — including pending with NULL purge_after and pending with both times NULL", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    await withOwner(env, db, async (c) => {
      const ins = (status: string | null, requested: string | null, purge: string | null, gen: string = "1") =>
        c.query(
          `INSERT INTO pod.users (status, deletion_requested_at, purge_after, auth_generation)
           VALUES ($1, $2::timestamptz, $3::timestamptz, ${gen})`,
          [status, requested, purge],
        );
      const plus = (h: number) => new Date(Date.parse("2026-11-03T00:00:00Z") + h * 3_600_000).toISOString();
      const C = "users_lifecycle_consistency";
      await expectViolation(ins("pending_deletion", T, null), "23514", C); // pending + purge_after NULL
      await expectViolation(ins("pending_deletion", null, null), "23514", C); // pending + 두 시각 NULL
      await expectViolation(ins("pending_deletion", null, plus(720)), "23514", C);
      await expectViolation(ins("pending_deletion", T, plus(719)), "23514", C);
      await expectViolation(ins("pending_deletion", T, plus(721)), "23514", C);
      await expectViolation(ins("active", T, null), "23514", C);
      await expectViolation(ins("active", null, plus(720)), "23514", C);
      await expectViolation(ins("active", T, plus(720)), "23514", C);
      await expectViolation(ins("deleted", null, null), "23514", "users_status_check");
      await expectViolation(ins("ACTIVE", null, null), "23514", "users_status_check");
      await expectViolation(ins(null, null, null), "23502");
      await expectViolation(ins("active", null, null, "0"), "23514", "users_auth_generation_check");
      await expectViolation(ins("active", null, null, "-1"), "23514", "users_auth_generation_check");
      await expectViolation(ins("active", null, null, "NULL"), "23502");
      // 양성: 정확히 720시간, 활성 기본값
      const ok = await c.query<{ id: string }>(
        `INSERT INTO pod.users (status, deletion_requested_at, purge_after, auth_generation)
         VALUES ('pending_deletion', $1::timestamptz, $1::timestamptz + interval '720 hours', 2) RETURNING id::text AS id`,
        [T],
      );
      const uid = ok.rows[0]!.id;
      // UPDATE 경로도 같은 CHECK
      await expectViolation(c.query("UPDATE pod.users SET status = 'active' WHERE id = $1", [uid]), "23514", C);
      await expectViolation(c.query("UPDATE pod.users SET purge_after = NULL WHERE id = $1", [uid]), "23514", C);
      await expectViolation(c.query("UPDATE pod.users SET auth_generation = 0 WHERE id = $1", [uid]), "23514", "users_auth_generation_check");
      await c.query("UPDATE pod.users SET status = 'active', deletion_requested_at = NULL, purge_after = NULL WHERE id = $1", [uid]);
    });
  });
});

// ================================================================ app·purge 권한, 함수 카탈로그

describe("0002: privileges and SECURITY DEFINER purge functions", () => {
  it("app: may UPDATE the 4 lifecycle columns, but cannot DELETE users, call either purge function (42501) or UPDATE/DELETE the ledger", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    const uid = await withOwner(env, db, async (c) => {
      const id = await insertUserRow(c, "pending_deletion", "now() - interval '800 hours'");
      await seedAllTables(c, id);
      return id;
    });
    await withApp(env, db, async (c) => {
      await c.query(
        `UPDATE pod.users SET status = 'active', deletion_requested_at = NULL, purge_after = NULL,
                auth_generation = auth_generation + 1 WHERE id = $1`,
        [uid],
      );
      await c.query(
        `UPDATE pod.users SET status = 'pending_deletion', deletion_requested_at = now() - interval '800 hours',
                purge_after = now() - interval '80 hours' WHERE id = $1`,
        [uid],
      );
      await expectSqlError(c.query("DELETE FROM pod.users WHERE id = $1", [uid]), "42501");
      await expectSqlError(c.query("SELECT pod.purge_user_if_due($1::uuid)", [uid]), "42501");
      await expectSqlError(c.query("SELECT * FROM pod.list_purge_due(10)"), "42501");
      await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = delta WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "42501");
    });
    await withOwner(env, db, async (c) => expect(await countsFor(c, uid)).toEqual(ALL_ONE));
  });

  it("catalog: both functions are owner-owned plpgsql SECURITY DEFINER with search_path=pg_catalog, pg_temp; EXECUTE only for owner and purge (no PUBLIC, no app)", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    await withOwner(env, db, async (c) => {
      const fns = await c.query<{
        sig: string;
        secdef: boolean;
        config: string[] | null;
        owner: string;
        lang: string;
        args: string;
        result: string;
        acl_null: boolean;
      }>(
        `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.proconfig AS config,
                pg_get_userbyid(p.proowner) AS owner, l.lanname AS lang, oidvectortypes(p.proargtypes) AS args,
                pg_get_function_result(p.oid) AS result, p.proacl IS NULL AS acl_null
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'pod' AND p.proname IN ('list_purge_due', 'purge_user_if_due')
          ORDER BY p.proname`,
      );
      const common = { secdef: true, config: ["search_path=pg_catalog, pg_temp"], owner: CI_ROLES.owner, lang: "plpgsql", acl_null: false };
      expect(fns.rows).toEqual([
        { sig: "pod.list_purge_due(integer)", args: "integer", result: "SETOF uuid", ...common },
        { sig: "pod.purge_user_if_due(uuid)", args: "uuid", result: "text", ...common },
      ]);
      for (const fn of [LIST_FN, PURGE_FN]) {
        const acl = await c.query<{ grantee: string; priv: string }>(
          `SELECT coalesce(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS priv
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE p.oid = $1::regprocedure ORDER BY 1, 2`,
          [fn],
        );
        expect(acl.rows, `${fn} proacl`).toEqual(
          [
            { grantee: CI_ROLES.owner, priv: "EXECUTE" },
            { grantee: CI_ROLES.purge, priv: "EXECUTE" },
          ].sort((a, b) => a.grantee.localeCompare(b.grantee)),
        );
        const has = await c.query<{ app: boolean; pub: boolean; purge: boolean }>(
          `SELECT has_function_privilege($2, $1, 'EXECUTE') AS app,
                  has_function_privilege('public', $1, 'EXECUTE') AS pub,
                  has_function_privilege($3, $1, 'EXECUTE') AS purge`,
          [fn, CI_ROLES.app, CI_ROLES.purge],
        );
        expect(has.rows[0], fn).toEqual({ app: false, pub: false, purge: true });
      }
      // 트리거 함수의 PUBLIC 회수는 유지된다
      const trig = await c.query<{ pub: boolean }>("SELECT has_function_privilege('public', $1, 'EXECUTE') AS pub", [TRIGGER_FN]);
      expect(trig.rows[0]?.pub).toBe(false);
      // purge role: 스키마 USAGE만, 어떤 테이블·열 권한도 없다
      const sch = await c.query<{ usage: boolean; create: boolean }>(
        "SELECT has_schema_privilege($1, 'pod', 'USAGE') AS usage, has_schema_privilege($1, 'pod', 'CREATE') AS create",
        [CI_ROLES.purge],
      );
      expect(sch.rows[0]).toEqual({ usage: true, create: false });
      const tbl = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('pod', 'pod_meta') AND c.relkind IN ('r', 'p', 'v')
            AND (has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                 OR has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
        [CI_ROLES.purge],
      );
      expect(tbl.rows[0]?.n, "purge role has no table/column privileges").toBe(0);
    });
  });

  it("purge role: direct access to pod tables and meta is 42501", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    const uid = await withOwner(env, db, async (c) => {
      const id = await insertUserRow(c, "pending_deletion", "now() - interval '800 hours'");
      await seedAllTables(c, id);
      return id;
    });
    await withPurge(db, async (c) => {
      await expectSqlError(c.query("SELECT * FROM pod.users WHERE id = $1", [uid]), "42501");
      await expectSqlError(c.query("UPDATE pod.users SET status = 'active' WHERE id = $1", [uid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.users WHERE id = $1", [uid]), "42501");
      await expectSqlError(c.query("SELECT * FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.credit_accounts WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("SELECT * FROM pod_meta.db_environment"), "42501");
      await expectSqlError(c.query(`SET ROLE ${CI_ROLES.owner}`), "42501");
    });
    await withOwner(env, db, async (c) => expect(await countsFor(c, uid)).toEqual(ALL_ONE));
  });

  it("ledger stays append-only outside purge: owner UPDATE/TRUNCATE, DELETE without GUC or with another user's GUC, and migrator (not owner) DELETE raise P0001", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    const [uid, other] = await withOwner(env, db, async (c) => {
      const a = await insertUserRow(c, "pending_deletion", "now() - interval '800 hours'");
      const b = await insertUserRow(c, "active");
      await seedAllTables(c, a);
      return [a, b];
    });
    await withOwner(env, db, async (c) => {
      await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = delta WHERE user_id = $1", [uid]), "P0001");
      await expectSqlError(c.query("TRUNCATE pod.emotion_ledger"), "P0001");
      await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "P0001");
      await inRollback(c, async () => {
        await c.query("SELECT set_config('pod.purge_user_id', $1, true)", [other]);
        await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "P0001");
      });
      await inRollback(c, async () => {
        await c.query("SELECT set_config('pod.purge_user_id', '', true)");
        await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "P0001");
      });
      await inRollback(c, async () => {
        await c.query("SELECT set_config('pod.purge_user_id', $1, true)", [uid]);
        await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = delta WHERE user_id = $1", [uid]), "P0001");
      });
    });
    // current_user가 owner role이 아니면(SET ROLE 없는 migrator) 맞는 GUC여도 거부
    await withMigratorOnly(db, async (c) => {
      await inRollback(c, async () => {
        await c.query("SELECT set_config('pod.purge_user_id', $1, true)", [uid]);
        await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "P0001");
      });
    });
    await withOwner(env, db, async (c) => expect((await countsFor(c, uid)).emotion_ledger).toBe(1));
  });
});

// ================================================================ list_purge_due

describe("0002: pod.list_purge_due(limit)", () => {
  it("rejects NULL/0/1001/negative limits with P0001, accepts 1 and 1000, orders due users by purge_after then id and excludes not-due/active", async () => {
    const db = await freshUp("l1list");
    await expectLifecycleApplied(db);
    const ids = await withOwner(env, db, async (c) => {
      const base = (await c.query<{ t: string }>("SELECT now()::text AS t")).rows[0]!.t;
      const at = (hoursAgo: number) => `('${base}'::timestamptz - interval '${hoursAgo} hours')`;
      const a = await insertUserRow(c, "pending_deletion", at(800)); // purge_after = base − 80h
      const b = await insertUserRow(c, "pending_deletion", at(760)); // base − 40h (동률)
      const b2 = await insertUserRow(c, "pending_deletion", at(760)); // base − 40h (동률)
      const d = await insertUserRow(c, "pending_deletion", at(721)); // base − 1h
      const notDue = await insertUserRow(c, "pending_deletion", at(10)); // base + 710h
      const active = await insertUserRow(c, "active");
      return { a, ties: [b, b2].sort(), d, notDue, active };
    });
    const expected = [ids.a, ...ids.ties, ids.d];
    await withPurge(db, async (c) => {
      for (const bad of ["NULL::int", "0", "1001", "-1"]) {
        await expectSqlError(c.query(`SELECT * FROM pod.list_purge_due(${bad})`), "P0001");
      }
      const list = async (n: number) =>
        (await c.query<{ id: string }>("SELECT x::text AS id FROM pod.list_purge_due($1::int) AS x", [n])).rows.map((r) => r.id);
      expect(await list(1000)).toEqual(expected);
      expect(await list(1)).toEqual([ids.a]);
      expect(await list(2)).toEqual([ids.a, ids.ties[0]]);
      expect(await list(3)).toEqual([ids.a, ...ids.ties]);
      expect(await list(1000)).not.toContain(ids.notDue);
      expect(await list(1000)).not.toContain(ids.active);
    });
  });
});

// ================================================================ purge_user_if_due

describe("0002: pod.purge_user_if_due(uuid)", () => {
  it("not_due / purged (all 8 tables, GUC cleared in the same tx) / absent on rerun and for unknown ids; NULL raises P0001; other users untouched", async () => {
    const db = await sharedDb();
    await expectLifecycleApplied(db);
    const u = await withOwner(env, db, async (c) => {
      const due = await insertUserRow(c, "pending_deletion", "now() - interval '721 hours'");
      const notDue = await insertUserRow(c, "pending_deletion", "now() - interval '1 hour'");
      const active = await insertUserRow(c, "active");
      for (const id of [due, notDue, active]) await seedAllTables(c, id);
      return { due, notDue, active };
    });
    const call = (c: pg.Client, id: string) =>
      c.query<{ r: string }>("SELECT pod.purge_user_if_due($1::uuid) AS r", [id]).then((x) => x.rows[0]?.r);
    // not_due·absent는 GUC를 설정하지 않는다(새 연결에서 확인)
    for (const [id, want] of [
      [u.notDue, "not_due"],
      [u.active, "not_due"],
      ["00000000-0000-4000-8000-00000000f4a1", "absent"],
    ] as const) {
      await withPurge(db, async (c) => {
        await inRollback(c, async () => {
          expect(await call(c, id), id).toBe(want);
          const g = await c.query<{ g: string | null }>("SELECT current_setting('pod.purge_user_id', true) AS g");
          expect(g.rows[0]?.g, `GUC is not set for ${want}`).toBeNull();
        });
      });
    }
    await withPurge(db, async (c) => {
      await c.query("BEGIN");
      expect(await call(c, u.due)).toBe("purged");
      const g = await c.query<{ g: string | null }>("SELECT current_setting('pod.purge_user_id', true) AS g");
      expect(g.rows[0]?.g, "GUC is cleared before returning").toBe("");
      await c.query("COMMIT");
      expect(await call(c, u.due), "rerun").toBe("absent");
      await expectSqlError(c.query("SELECT pod.purge_user_if_due(NULL::uuid)"), "P0001");
    });
    await withOwner(env, db, async (c) => {
      expect(await countsFor(c, u.due)).toEqual(ALL_ZERO);
      expect(await countsFor(c, u.notDue)).toEqual(ALL_ONE);
      expect(await countsFor(c, u.active)).toEqual(ALL_ONE);
      const s = await c.query("SELECT status FROM pod.users WHERE id = $1", [u.notDue]);
      expect(s.rows).toEqual([{ status: "pending_deletion" }]);
    });
  });

  it("an injected failure during the delete rolls back everything (ledger and account included); after removing it the retry purges", async () => {
    const db = await freshUp("l1purgefail");
    await expectLifecycleApplied(db);
    const uid = await withOwner(env, db, async (c) => {
      const id = await insertUserRow(c, "pending_deletion", "now() - interval '800 hours'");
      await seedAllTables(c, id);
      // 시험 전용 실패 트리거(이 일회용 DB에서만): users 삭제 단계에서 실패 → 앞서 지운 원장·계정도 롤백돼야 한다
      await c.query(`CREATE FUNCTION pod.l1_test_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'l1_test_injected_failure';
END
$fn$`);
      await c.query("CREATE TRIGGER l1_test_fail BEFORE DELETE ON pod.users FOR EACH ROW EXECUTE FUNCTION pod.l1_test_fail()");
      return id;
    });
    try {
      await withPurge(db, async (c) => {
        let caught: unknown;
        try {
          await c.query("SELECT pod.purge_user_if_due($1::uuid)", [uid]);
        } catch (err) {
          caught = err;
        }
        expect(caught, "purge must fail while the injected trigger exists").toBeDefined();
        expect(String((caught as Error).message)).toContain("l1_test_injected_failure");
      });
      await withOwner(env, db, async (c) => {
        expect(await countsFor(c, uid), "nothing was partially deleted").toEqual(ALL_ONE);
        const s = await c.query("SELECT status FROM pod.users WHERE id = $1", [uid]);
        expect(s.rows).toEqual([{ status: "pending_deletion" }]);
      });
    } finally {
      await withOwner(env, db, async (c) => {
        await c.query("DROP TRIGGER IF EXISTS l1_test_fail ON pod.users");
        await c.query("DROP FUNCTION IF EXISTS pod.l1_test_fail()");
      });
    }
    await withPurge(db, async (c) => {
      const r = await c.query<{ r: string }>("SELECT pod.purge_user_if_due($1::uuid) AS r", [uid]);
      expect(r.rows[0]?.r).toBe("purged");
    });
    await withOwner(env, db, async (c) => expect(await countsFor(c, uid)).toEqual(ALL_ZERO));
  });
});

// ================================================================ meta purge_role fail closed

describe("0002: purge_role from pod_meta.db_environment fails closed", () => {
  type MetaCase = { label: string; tag: string; mutate: string; sqlState: string };
  const cases: MetaCase[] = [
    { label: "purge_role = app_role", tag: "l1metaapp", mutate: `UPDATE pod_meta.db_environment SET purge_role = '${CI_ROLES.app}'`, sqlState: "P0001" },
    { label: "purge_role = owner_role", tag: "l1metaowner", mutate: `UPDATE pod_meta.db_environment SET purge_role = '${CI_ROLES.owner}'`, sqlState: "P0001" },
    {
      label: "purge_role = migration session_user (migrator)",
      tag: "l1metamig",
      mutate: `UPDATE pod_meta.db_environment SET purge_role = '${CI_ROLES.migrator}'`,
      sqlState: "P0001",
    },
    { label: "purge_role names a role that does not exist", tag: "l1metanone", mutate: "UPDATE pod_meta.db_environment SET purge_role = 'pod_ci_no_such_role'", sqlState: "P0001" },
    {
      label: "purge_role is NULL",
      tag: "l1metanull",
      mutate: "ALTER TABLE pod_meta.db_environment ALTER COLUMN purge_role DROP NOT NULL; UPDATE pod_meta.db_environment SET purge_role = NULL",
      sqlState: "P0001",
    },
    { label: "purge_role column is missing", tag: "l1metacol", mutate: "ALTER TABLE pod_meta.db_environment DROP COLUMN purge_role", sqlState: "42703" },
  ];

  for (const k of cases) {
    it(`${k.label}: up fails (0002 rolled back, no record row, no GRANT) and the 0002 file itself raises ${k.sqlState}`, async () => {
      const db = await createDisposableDatabase(env, k.tag);
      await withOwner(env, db, (c) => c.query(k.mutate));
      const r = await runMigrateCli(["up"], db.urls.migrator);
      expectCliFail(r, db.urls.migrator);
      await withOwner(env, db, async (c) => {
        expect((await readMigrationRows(c))?.map((x) => x.version)).toEqual([1]);
        const objs = await c.query<{ col: number; list: string | null; purge: string | null; usage: boolean }>(
          `SELECT (SELECT count(*)::int FROM information_schema.columns
                    WHERE table_schema = 'pod' AND table_name = 'users' AND column_name = 'status') AS col,
                  to_regprocedure('pod.list_purge_due(integer)')::text AS list,
                  to_regprocedure('pod.purge_user_if_due(uuid)')::text AS purge,
                  has_schema_privilege($1, 'pod', 'USAGE') AS usage`,
          [CI_ROLES.purge],
        );
        expect(objs.rows[0]).toEqual({ col: 0, list: null, purge: null, usage: false });
      });
      // 실행기와 같은 문맥(migrator 접속 + SET LOCAL ROLE owner, session_user = migrator)으로 0002 up 파일을 직접 실행
      const upSql = await readFile(LIFECYCLE_UP, "utf8");
      await withMigratorOnly(db, async (c) => {
        await inRollback(c, async () => {
          await c.query(`SET LOCAL ROLE ${CI_ROLES.owner}`);
          await expectSqlError(c.query(upSql), k.sqlState);
        });
      });
    });
  }
});

// ================================================================ down 대칭

describe("0002 down: symmetric to 0001-only and guarded", () => {
  it("up → down --to 1 equals a 0001-only database (snapshot incl. trigger function body; ACLs checked separately)", async () => {
    const full = await freshUp("l1down");
    await expectLifecycleApplied(full);
    expectCliOk(await runMigrateCli(["down", "--to", "1", "--allow-down"], full.urls.migrator), full.urls.migrator);

    const initOnly = await makeMigrationsDir({
      "0001_init.up.sql": await readFile(INIT_UP, "utf8"),
      "0001_init.down.sql": await readFile(INIT_DOWN, "utf8"),
    });
    const base = await createDisposableDatabase(env, "l1base");
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", initOnly], base.urls.migrator), base.urls.migrator);

    const acl = (c: pg.Client) =>
      c.query<{ trig_acl: string | null; trig_pub: boolean; list: string | null; purge: string | null; usage: boolean }>(
        `SELECT (SELECT proacl::text FROM pg_proc WHERE oid = $1::regprocedure) AS trig_acl,
                has_function_privilege('public', $1, 'EXECUTE') AS trig_pub,
                to_regprocedure('pod.list_purge_due(integer)')::text AS list,
                to_regprocedure('pod.purge_user_if_due(uuid)')::text AS purge,
                has_schema_privilege($2, 'pod', 'USAGE') AS usage`,
        [TRIGGER_FN, CI_ROLES.purge],
      );
    const afterDown = await withOwner(env, full, async (c) => ({
      rows: (await readMigrationRows(c))?.map((x) => x.version),
      snap: await schemaSnapshot(c),
      acl: (await acl(c)).rows[0],
    }));
    const only1 = await withOwner(env, base, async (c) => ({ snap: await schemaSnapshot(c), acl: (await acl(c)).rows[0] }));
    expect(afterDown.rows).toEqual([1]);
    expect(afterDown.snap).toEqual(only1.snap);
    expect(afterDown.acl).toEqual(only1.acl);
    expect(afterDown.acl).toMatchObject({ trig_pub: false, list: null, purge: null, usage: false });
  });

  it("down --to 1 is refused when user data exists (pending user), and the 0002 down file itself raises P0001", async () => {
    const db = await freshUp("l1downguard");
    await expectLifecycleApplied(db);
    await withOwner(env, db, (c) => insertUserRow(c, "pending_deletion", "now()"));
    const before = await withOwner(env, db, async (c) => ({ snap: await schemaSnapshot(c), rows: await readMigrationRows(c) }));
    expectCliFail(await runMigrateCli(["down", "--to", "1", "--allow-down"], db.urls.migrator), db.urls.migrator);
    const downSql = await readFile(LIFECYCLE_DOWN, "utf8");
    await withOwner(env, db, async (c) => {
      await expectSqlError(c.query(downSql), "P0001");
    });
    await withOwner(env, db, async (c) => {
      expect(await schemaSnapshot(c)).toEqual(before.snap);
      expect(await readMigrationRows(c)).toEqual(before.rows);
      const n = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.users WHERE status = 'pending_deletion'");
      expect(n.rows[0]?.n).toBe(1);
    });
  });
});
