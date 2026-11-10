// F2 RED 시험 전용 보조 함수. 제품 코드가 아니며 제품 실행기·SQL을 흉내 내거나 대신하지 않는다.
// 계약: docs/plans/PLAN_mvp-database.md §3·§5·§9, docs/product/DATA_CONTRACT.md §4~§6.
//
// - CLI는 `process.execPath src/server/db/migrate-cli.ts ...`로 직접 실행한다(npm script에 의존하지 않는다).
// - CLI에는 POD_MIGRATE_DATABASE_URL(migrator)만 넘기고 관리자 URL은 넘기지 않는다.
// - 출력에 URL·비밀번호가 없어야 한다. 단언 메시지에도 비밀번호를 가려서 넣는다.
// - 부정 시험이 "CLI 파일 없음"으로 거짓 통과하지 않도록 expectCliRan으로 CLI가 실제로 실행됐는지 확인한다.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect } from "vitest";
import { CI_ROLES, closeClient, openClient, type DisposableDatabase, type HarnessEnv } from "./helpers";

export const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const CLI_PATH = path.join(APP_DIR, "src", "server", "db", "migrate-cli.ts");
export const PRODUCT_MIGRATIONS_DIR = path.join(APP_DIR, "migrations");
export const INIT_UP = path.join(PRODUCT_MIGRATIONS_DIR, "0001_init.up.sql");
export const INIT_DOWN = path.join(PRODUCT_MIGRATIONS_DIR, "0001_init.down.sql");

/** DATA_CONTRACT §4.1~§4.8 사용자 데이터 테이블(down 보호 대상). */
export const USER_DATA_TABLES = [
  "users",
  "auth_identities",
  "preferences",
  "diary_moments",
  "day_summaries",
  "design_versions",
  "credit_accounts",
  "emotion_ledger",
  "photo_uploads",
  "moment_photos",
  "photo_deletions",
] as const;

export const APPEND_ONLY_MESSAGE = "emotion_ledger is append-only";

// ---------------------------------------------------------------- CLI

export type CliResult = { code: number | null; stdout: string; stderr: string; output: string };

function secretsOfUrl(url: string): string[] {
  const u = new URL(url);
  return [url, u.password, decodeURIComponent(u.password)].filter((s) => s.length > 0);
}

/** 단언 메시지용: 비밀번호·URL을 가린 출력. */
export function redact(text: string, url: string): string {
  let out = text;
  for (const s of secretsOfUrl(url)) out = out.split(s).join("***");
  return out;
}

/** migrate-cli.ts를 현재 Node로 직접 실행한다. 종료 코드와 출력을 돌려준다(예외를 던지지 않는다). */
export function runMigrateCli(args: string[], databaseUrl: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        cwd: APP_DIR,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          POD_MIGRATE_DATABASE_URL: databaseUrl,
        },
        timeout: 60_000,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        let code: number | null = 0;
        if (err) {
          const c = (err as { code?: unknown }).code;
          code = typeof c === "number" ? c : null;
        }
        resolve({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** CLI 파일이 있고, 모듈 누락·문법 오류가 아니라 CLI 자체가 실행됐는지 확인한다. */
export function expectCliRan(r: CliResult, url: string): void {
  expect(existsSync(CLI_PATH), `missing product CLI ${path.relative(APP_DIR, CLI_PATH)}`).toBe(true);
  expect(r.code, `CLI did not exit normally: ${redact(r.output, url)}`).not.toBeNull();
  expect(redact(r.output, url)).not.toMatch(
    /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|SyntaxError|ReferenceError/,
  );
}

export function expectNoSecrets(r: CliResult, url: string): void {
  for (const s of secretsOfUrl(url)) expect(r.output.includes(s), "CLI output must not contain the URL or password").toBe(false);
}

export function expectCliOk(r: CliResult, url: string): void {
  expectCliRan(r, url);
  expect(r.code, redact(r.output, url)).toBe(0);
  expectNoSecrets(r, url);
}

export function expectCliFail(r: CliResult, url: string): void {
  expectCliRan(r, url);
  expect(r.code, redact(r.output, url)).toBe(1);
  expectNoSecrets(r, url);
}

/** 기본 디렉터리(app/migrations)로 up을 한 번만 실행한다. 실패하면 이후 호출도 같은 이유로 실패한다. */
export function lazyMigrated(getDb: () => DisposableDatabase): () => Promise<DisposableDatabase> {
  let pending: Promise<DisposableDatabase> | undefined;
  return () => {
    pending ??= (async () => {
      const db = getDb();
      const r = await runMigrateCli(["up"], db.urls.migrator);
      expectCliOk(r, db.urls.migrator);
      return db;
    })();
    return pending;
  };
}

// ---------------------------------------------------------------- 임시 migration 디렉터리(시험 데이터)

const tempDirs = new Set<string>();

/** 시험 데이터용 임시 migration 디렉터리를 만든다. 파일은 UTF-8·LF로 쓴다. */
export async function makeMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pod-f2-migrations-"));
  tempDirs.add(dir);
  await writeMigrationFiles(dir, files);
  return dir;
}

export async function writeMigrationFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, "utf8");
}

export async function removeMigrationFile(dir: string, name: string): Promise<void> {
  await unlink(path.join(dir, name));
}

export async function cleanupTempDirs(): Promise<void> {
  for (const dir of [...tempDirs]) {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
}

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

// ---------------------------------------------------------------- 연결

export async function withApp<T>(env: HarnessEnv, db: DisposableDatabase, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await openClient(db.urls.app, env.adminUrl);
  try {
    const me = await c.query<{ u: string }>("SELECT current_user AS u");
    expect(me.rows[0]?.u).toBe(CI_ROLES.app);
    return await fn(c);
  } finally {
    await closeClient(c);
  }
}

/** migrator로 접속해 SET ROLE owner 한 연결(DATA_CONTRACT §5 owner 경로). */
export async function withOwner<T>(env: HarnessEnv, db: DisposableDatabase, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await openClient(db.urls.migrator, env.adminUrl);
  try {
    await c.query(`SET ROLE ${CI_ROLES.owner}`);
    const me = await c.query<{ u: string }>("SELECT current_user AS u");
    expect(me.rows[0]?.u).toBe(CI_ROLES.owner);
    return await fn(c);
  } finally {
    await closeClient(c);
  }
}

/** SQLSTATE(필요하면 계약 메시지)까지 확인한다. */
export async function expectSqlError(promise: Promise<unknown>, sqlState: string, message?: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected SQLSTATE ${sqlState}, but the statement succeeded`).toBeDefined();
  const e = caught as { code?: unknown; message?: unknown };
  expect(e.code, `unexpected error: ${String(e.message)}`).toBe(sqlState);
  if (message !== undefined) expect(String(e.message)).toContain(message);
}

// ---------------------------------------------------------------- 조회

export async function relationExists(c: pg.Client, qualified: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [qualified]);
  return r.rows[0]?.ok === true;
}

export async function schemaExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1", [name]);
  return r.rows[0]?.n === 1;
}

export type MigrationRow = { version: number; name: string; checksum: string };

/** schema_migrations 행(없으면 null). owner 연결로 호출한다. */
export async function readMigrationRows(c: pg.Client): Promise<MigrationRow[] | null> {
  if (!(await relationExists(c, "pod_meta.schema_migrations"))) return null;
  const r = await c.query<{ version: number; name: string; checksum: string }>(
    "SELECT version, name, trim(checksum) AS checksum FROM pod_meta.schema_migrations ORDER BY version",
  );
  return r.rows.map((x) => ({ version: Number(x.version), name: x.name, checksum: x.checksum }));
}

/** 사용자 데이터 테이블별 행 수. owner 연결로 호출한다. */
export async function userDataCounts(c: pg.Client, tables: readonly (typeof USER_DATA_TABLES)[number][] = USER_DATA_TABLES): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    expect(await relationExists(c, `pod.${t}`), `required user-data table pod.${t} must exist before counting`).toBe(true);
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pod.${t}`);
    out[t] = r.rows[0]?.n ?? -1;
  }
  return out;
}

/**
 * pod 스키마 스냅샷(PLAN §5.3): 테이블·열·제약(pg_get_constraintdef)·인덱스(pg_get_indexdef)·트리거·함수·
 * information_schema 권한 목록·스키마 ACL. OID·시각처럼 매번 달라지는 값은 넣지 않는다.
 */
export async function schemaSnapshot(c: pg.Client): Promise<string[]> {
  const r = await c.query<{ k: string; v: string }>(`
    SELECT 'table' AS k, schemaname || '.' || tablename || ' owner=' || tableowner AS v
      FROM pg_tables WHERE schemaname = 'pod'
    UNION ALL
    SELECT 'column', table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
                     || ' default=' || coalesce(column_default, '')
      FROM information_schema.columns WHERE table_schema = 'pod'
    UNION ALL
    SELECT 'constraint', con.conrelid::regclass::text || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid)
      FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname = 'pod'
    UNION ALL
    SELECT 'index', pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
     WHERE n.nspname = 'pod'
    UNION ALL
    SELECT 'trigger', pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class tc ON tc.oid = t.tgrelid JOIN pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'pod' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function', pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pod'
    UNION ALL
    SELECT 'table_privilege', table_name || ' ' || grantee || ' ' || privilege_type
      FROM information_schema.table_privileges WHERE table_schema = 'pod'
    UNION ALL
    SELECT 'column_privilege', table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type
      FROM information_schema.column_privileges WHERE table_schema = 'pod'
    UNION ALL
    SELECT 'schema_acl', nspname || ' owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, '')
      FROM pg_namespace WHERE nspname IN ('pod', 'pod_meta')
    ORDER BY 1, 2`);
  return r.rows.map((x) => `${x.k}|${x.v}`);
}

// ---------------------------------------------------------------- 시험 데이터 (app 연결에서 사용)

export const VALID_MANIFEST = JSON.stringify({ schema: 1, base: "d" });

export async function insertUser(c: pg.Client): Promise<string> {
  const r = await c.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id");
  const id = r.rows[0]?.id;
  if (!id) throw new Error("user insert returned no id");
  return id;
}

export async function insertMoment(c: pg.Client, userId: string, body = "오늘의 조각"): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body)
     VALUES ($1, DATE '2026-11-02', TIMESTAMPTZ '2026-11-02 09:00:00+09', $2) RETURNING id`,
    [userId, body],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("moment insert returned no id");
  return id;
}

export async function insertDesignVersion(c: pg.Client, ownerId: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO pod.design_versions (owner_id, manifest) VALUES ($1, $2::jsonb) RETURNING id",
    [ownerId, VALID_MANIFEST],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("design version insert returned no id");
  return id;
}

export function firstLoginGrantKey(userId: string): string {
  return `first_login:${userId}`;
}

/** 계정 + 첫 지급 원장 1행(잔액 10). */
export async function insertAccountWithGrant(c: pg.Client, userId: string): Promise<void> {
  await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 10)", [userId]);
  await c.query(
    "INSERT INTO pod.emotion_ledger (user_id, delta, reason, grant_key) VALUES ($1, 10, 'first_login_grant', $2)",
    [userId, firstLoginGrantKey(userId)],
  );
}
