/**
 * migration CLI(PLAN_mvp-database §3·§9). Node 24/26이 이 TS 파일을 직접 실행한다.
 *
 *   node src/server/db/migrate-cli.ts status|up [--migrations-dir <dir>]
 *   node src/server/db/migrate-cli.ts down --to <N> --allow-down [--migrations-dir <dir>]
 *
 * - 접속: POD_MIGRATE_DATABASE_URL(migrator). 기본 디렉터리는 app/migrations.
 * - 성공 0, 실행기의 거부·SQL 실패·접속 실패 1. 그 밖의 예기치 않은 오류(코드 결함)는 정상 거부로
 *   숨기지 않고 "internal error"와 stack을 출력하며 2로 끝낸다.
 * - URL·비밀번호·접속 오류 원문을 출력하지 않는다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { down, loadMigrations, MigrationError, status, up, type MigrationFile } from "./migrate.ts";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const USAGE = "usage: migrate-cli.ts status|up [--migrations-dir <dir>] | down --to <N> --allow-down [--migrations-dir <dir>]";

type Args = { command: "status" | "up" | "down"; migrationsDir: string; to: number | null; allowDown: boolean };

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "up" && command !== "down") throw new MigrationError(USAGE);
  const args: Args = { command, migrationsDir: DEFAULT_MIGRATIONS_DIR, to: null, allowDown: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--migrations-dir") {
      const v = rest[++i];
      if (!v) throw new MigrationError("--migrations-dir needs a directory");
      args.migrationsDir = path.resolve(v);
    } else if (a === "--to" && command === "down") {
      const v = rest[++i];
      if (v === undefined || !/^\d{1,4}$/.test(v)) throw new MigrationError("--to needs a migration number (0 reverts everything)");
      args.to = Number(v);
    } else if (a === "--allow-down" && command === "down") {
      args.allowDown = true;
    } else {
      throw new MigrationError(`unknown argument ${JSON.stringify(a)}. ${USAGE}`);
    }
  }
  if (command === "down") {
    if (!args.allowDown) throw new MigrationError("down refused: --allow-down is required");
    if (args.to === null) throw new MigrationError("down refused: --to <N> is required");
  }
  return args;
}

function secretsOf(url: string | undefined): string[] {
  if (!url) return [];
  const out = [url];
  try {
    const u = new URL(url);
    if (u.password) out.push(u.password, decodeURIComponent(u.password));
  } catch {
    // 형식이 틀린 URL은 원문만 가린다.
  }
  return out.filter((s) => s.length > 0);
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}

/** 연결 단계 오류는 원문(호스트·사용자 등)을 내보내지 않고 SQLSTATE·시스템 코드만 남긴다. */
class ConnectionError extends MigrationError {}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: "pod-migrate" });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    const code = (err as { code?: unknown }).code;
    throw new ConnectionError(`database connection failed${typeof code === "string" ? ` (${code})` : ""}`);
  }
  return client;
}

async function main(argv: string[]): Promise<number> {
  const url = process.env.POD_MIGRATE_DATABASE_URL;
  const secrets = secretsOf(url);
  const log = (line: string) => console.log(redact(line, secrets));
  try {
    const args = parseArgs(argv);
    const files: MigrationFile[] = await loadMigrations(args.migrationsDir);
    if (!url) throw new MigrationError("POD_MIGRATE_DATABASE_URL is not set");
    const client = await connect(url);
    try {
      if (args.command === "status") await status(client, files, log);
      else if (args.command === "up") await up(client, files, log);
      else await down(client, files, args.to as number, log);
    } finally {
      await client.end().catch(() => undefined);
    }
    return 0;
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error(redact(`migrate: ${err.message}`, secrets));
      return 1;
    }
    if (err instanceof pg.DatabaseError) {
      console.error(redact(`migrate: database error ${err.code ?? ""}: ${err.message}`, secrets));
      return 1;
    }
    const code = (err as { code?: unknown }).code;
    if (err instanceof Error && typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      console.error(`migrate: system error ${code}`);
      return 1;
    }
    console.error(redact(`migrate: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, secrets));
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
