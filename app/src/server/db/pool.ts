/**
 * 앱 요청용 PostgreSQL 연결(PLAN_mvp-domain-storage §1).
 *
 * - env는 POD_DATABASE_URL과 선택 POD_DATABASE_POOL_MAX만 읽는다. import 시에는 읽거나 접속하지 않고 getAppDb() 첫 호출에 만든다.
 * - app role 연결만 쓴다. 관리자·migrator URL·SET ROLE은 쓰지 않는다.
 */
import "server-only";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

let appDb: Db | undefined;

/** 미설정(undefined)만 기존 5다. 설정하면 정규 10진수 1..5만 허용하고, 오류에 원래 값을 싣지 않는다. */
export function parseDbPoolMax(value: string | undefined): number {
  if (value === undefined) return 5;
  if (!/^[1-5]$/.test(value)) throw new Error("POD_DATABASE_POOL_MAX must be an integer from 1 to 5");
  return Number(value);
}

export function getAppDb(): Db {
  if (appDb) return appDb;
  const url = process.env.POD_DATABASE_URL;
  if (!url) throw new Error("POD_DATABASE_URL is not set");
  // 연결 예산(PLAN_dev-app-deployment §3·§4, PLAN_production-app-deployment §3): app role limit = Pool max + 단발 readiness 1.
  // dev는 미설정 5(limit 6), 운영은 3(limit 4)이다.
  const max = parseDbPoolMax(process.env.POD_DATABASE_POOL_MAX);
  appDb = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  return appDb;
}

/** Read Committed 트랜잭션 안에서 fn을 실행한다. 성공하면 COMMIT, 실패하면 ROLLBACK 후 원래 오류를 다시 던진다. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // ROLLBACK도 실패한 연결은 Pool에 돌려보내지 않고 버린다. 호출자에게는 원래 오류를 전한다.
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
