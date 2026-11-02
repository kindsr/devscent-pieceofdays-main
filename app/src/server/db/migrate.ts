/**
 * migration 실행기(PLAN_mvp-database §3, DATA_CONTRACT §6).
 *
 * - 파일 규칙(번호·쌍·연속성·UTF-8·LF·SQL 정책)은 DB에 접속하기 전에 모두 검사한다.
 * - migration 1개마다: BEGIN → pg_advisory_xact_lock → 기록·체크섬 재확인 → SET LOCAL ROLE owner →
 *   파일 SQL → 기록 → COMMIT. 실패하면 그 migration 전체가 롤백되고 뒤의 파일은 실행하지 않는다.
 * - 기록표 pod_meta.schema_migrations도 같은 잠금 안에서 만든다(동시 첫 실행 경합 없음).
 * - owner role은 pod_meta.db_environment에서 읽는다. role을 만들거나 ALTER ROLE 하지 않는다.
 * - down은 명시 허용 + db_environment.name='ci' + pod 사용자 데이터 테이블이 모두 빈 경우만 실행한다.
 *
 * Node가 TS를 직접 실행하므로 상대 .ts import만 쓴다(Next의 @/ 별칭 금지).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { validateSqlPolicy } from "./sql-policy.ts";

/** 실행기 전용 advisory lock 키(시험 하네스 키와 별개). 모든 실행기 프로세스가 같은 값을 쓴다. */
export const MIGRATION_LOCK_KEY = "7042018100";

/** DATA_CONTRACT §4.1~§4.8. 하나라도 행이 있으면 down을 거부한다. */
export const USER_DATA_TABLES = [
  "users",
  "auth_identities",
  "preferences",
  "diary_moments",
  "day_summaries",
  "design_versions",
  "credit_accounts",
  "emotion_ledger",
] as const;

/** 실행기가 의도적으로 거부한 경우(종료 코드 1). 메시지에 URL·비밀번호를 넣지 않는다. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export type MigrationFile = {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  /** up 파일 바이트의 SHA-256 hex. */
  checksum: string;
};

export type AppliedRow = { version: number; name: string; checksum: string };

export type DbEnvironment = { name: string; appRole: string; ownerRole: string };

export type Log = (line: string) => void;

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
// ignoreBOM: 디코더가 BOM을 조용히 지우지 않게 해 아래 BOM 검사가 실제로 동작하도록 한다.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(file: string, bytes: Buffer): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new MigrationError(`${file}: not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) throw new MigrationError(`${file}: UTF-8 BOM is not allowed`);
  if (text.includes("\r")) throw new MigrationError(`${file}: line endings must be LF`);
  return text;
}

/**
 * 디렉터리의 migration 파일을 읽고 규칙을 검사한다(DB 접속 전).
 * `.sql` 파일은 모두 `NNNN_name.up|down.sql` 형식이어야 하고, 번호는 0001부터 빈 번호 없이 이어지며
 * 번호마다 같은 이름의 up/down 한 쌍이 있어야 한다.
 */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new MigrationError(`cannot read migrations directory ${dir}`);
  }
  const byVersion = new Map<number, { name: string; up?: string; down?: string }>();
  for (const file of entries.filter((e) => e.endsWith(".sql")).sort()) {
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError(`${file}: file name must match NNNN_snake_name.up.sql / .down.sql`);
    const version = Number(m[1]);
    const name = m[2] as string;
    const kind = m[3] as "up" | "down";
    if (version < 1) throw new MigrationError(`${file}: version must start at 0001`);
    const slot = byVersion.get(version) ?? { name };
    if (slot.name !== name) throw new MigrationError(`${file}: version ${m[1]} has two names (${slot.name}, ${name})`);
    slot[kind] = file;
    byVersion.set(version, slot);
  }

  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  const out: MigrationFile[] = [];
  for (const [i, version] of versions.entries()) {
    if (version !== i + 1) throw new MigrationError(`migration numbering gap: expected ${i + 1}, found ${version}`);
    const slot = byVersion.get(version) as { name: string; up?: string; down?: string };
    if (!slot.up || !slot.down) {
      throw new MigrationError(`migration ${version} (${slot.name}) needs both .up.sql and .down.sql`);
    }
    const upBytes = await readFile(path.join(dir, slot.up));
    const downBytes = await readFile(path.join(dir, slot.down));
    const upSql = decode(slot.up, upBytes);
    const downSql = decode(slot.down, downBytes);
    for (const [file, sql] of [
      [slot.up, upSql],
      [slot.down, downSql],
    ] as const) {
      try {
        validateSqlPolicy(sql);
      } catch (err) {
        throw new MigrationError(`${file}: ${(err as Error).message}`);
      }
    }
    out.push({ version, name: slot.name, upSql, downSql, checksum: createHash("sha256").update(upBytes).digest("hex") });
  }
  return out;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** pod_meta.db_environment를 읽는다. 없거나 비어 있으면 시작하지 않는다. */
export async function readEnvironment(client: pg.Client): Promise<DbEnvironment> {
  const exists = await client.query<{ ok: boolean }>("SELECT to_regclass('pod_meta.db_environment') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) throw new MigrationError("pod_meta.db_environment is missing; refusing to start");
  const r = await client.query<{ name: string; app_role: string; owner_role: string }>(
    "SELECT name, app_role, owner_role FROM pod_meta.db_environment",
  );
  const row = r.rows[0];
  if (r.rows.length !== 1 || !row) throw new MigrationError("pod_meta.db_environment has no row; refusing to start");
  return { name: row.name, appRole: row.app_role, ownerRole: row.owner_role };
}

async function readApplied(client: pg.Client): Promise<AppliedRow[]> {
  const exists = await client.query<{ ok: boolean }>("SELECT to_regclass('pod_meta.schema_migrations') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return [];
  const r = await client.query<{ version: number; name: string; checksum: string }>(
    "SELECT version, name, trim(checksum) AS checksum FROM pod_meta.schema_migrations ORDER BY version",
  );
  return r.rows.map((x) => ({ version: Number(x.version), name: x.name, checksum: x.checksum }));
}

/** 적용 기록이 파일과 일치하는지 확인한다(누락·이름·체크섬·기록의 빈 번호). */
function verifyApplied(applied: AppliedRow[], files: MigrationFile[]): void {
  for (const [i, row] of applied.entries()) {
    if (row.version !== i + 1) throw new MigrationError(`schema_migrations has a gap: expected ${i + 1}, found ${row.version}`);
    const file = files[i];
    if (!file) throw new MigrationError(`applied migration ${row.version} (${row.name}) has no file`);
    if (file.name !== row.name) {
      throw new MigrationError(`applied migration ${row.version} name differs: recorded ${row.name}, file ${file.name}`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(`checksum mismatch for applied migration ${row.version} (${row.name})`);
    }
  }
}

const CREATE_RECORD_TABLE = `
  CREATE TABLE IF NOT EXISTS pod_meta.schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    checksum   char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by name NOT NULL DEFAULT current_user
  )`;

async function inLockedTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

export async function status(client: pg.Client, files: MigrationFile[], log: Log): Promise<void> {
  const env = await readEnvironment(client);
  const applied = await readApplied(client);
  verifyApplied(applied, files);
  log(`environment: ${env.name}`);
  for (const f of files) log(`${String(f.version).padStart(4, "0")}_${f.name}: ${f.version <= applied.length ? "applied" : "pending"}`);
  if (files.length === 0) log("no migration files");
}

/** 대기 중인 migration을 하나씩 적용한다. 동시에 실행되면 잠금을 기다린 쪽은 다시 확인해 건너뛴다. */
export async function up(client: pg.Client, files: MigrationFile[], log: Log): Promise<void> {
  const env = await readEnvironment(client);
  const owner = quoteIdent(env.ownerRole);
  for (;;) {
    const applied = await inLockedTransaction(client, async () => {
      const done = await readApplied(client);
      verifyApplied(done, files);
      const next = files[done.length];
      if (!next) return null;
      await client.query(`SET LOCAL ROLE ${owner}`);
      await client.query(next.upSql);
      // 파일이 role을 바꿨더라도 기록은 owner로 남긴다.
      await client.query(`SET LOCAL ROLE ${owner}`);
      await client.query(CREATE_RECORD_TABLE);
      await client.query("REVOKE ALL ON pod_meta.schema_migrations FROM PUBLIC");
      await client.query("INSERT INTO pod_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        next.version,
        next.name,
        next.checksum,
      ]);
      return next;
    });
    if (!applied) break;
    log(`applied ${String(applied.version).padStart(4, "0")}_${applied.name}`);
  }
  log("up: database is up to date");
}

async function assertNoUserData(client: pg.Client): Promise<void> {
  for (const t of USER_DATA_TABLES) {
    const exists = await client.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [`pod.${t}`]);
    if (!exists.rows[0]?.ok) continue;
    const r = await client.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM pod.${quoteIdent(t)}) AS any`);
    if (r.rows[0]?.any) throw new MigrationError(`down refused: pod.${t} has user data`);
  }
}

/**
 * `target` 번호까지 되돌린다(0은 전체). 빈 CI DB의 리허설 전용이다.
 * 허용 플래그는 호출자(CLI)가 확인한다. 여기서는 환경과 사용자 데이터를 migration마다 잠금 안에서 확인한다.
 */
export async function down(client: pg.Client, files: MigrationFile[], target: number, log: Log): Promise<void> {
  const env = await readEnvironment(client);
  if (env.name !== "ci") throw new MigrationError(`down refused: db_environment.name is '${env.name}', only 'ci' allows down`);
  const owner = quoteIdent(env.ownerRole);
  for (;;) {
    const reverted = await inLockedTransaction(client, async () => {
      const done = await readApplied(client);
      verifyApplied(done, files);
      if (done.length <= target) return null;
      const last = files[done.length - 1] as MigrationFile;
      const current = await readEnvironment(client);
      if (current.name !== "ci") throw new MigrationError(`down refused: db_environment.name is '${current.name}'`);
      await client.query(`SET LOCAL ROLE ${owner}`);
      await assertNoUserData(client);
      await client.query(last.downSql);
      await client.query(`SET LOCAL ROLE ${owner}`);
      await client.query("DELETE FROM pod_meta.schema_migrations WHERE version = $1", [last.version]);
      return last;
    });
    if (!reverted) break;
    log(`reverted ${String(reverted.version).padStart(4, "0")}_${reverted.name}`);
  }
  log(`down: database is at version ${target} or below`);
}
