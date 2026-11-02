// F3 RED 시험 전용 보조 함수(PLAN_mvp-domain-storage §5). 제품 코드가 아니며 제품 SQL을 흉내 내거나 대신하지 않는다.
// - F2 하네스(helpers.ts·f2-support.ts)의 일회용 DB·role 계약을 그대로 쓴다. 관리자 URL을 제품 함수에 넘기지 않는다.
// - 제품 함수에는 db.urls.app으로 만든 pg.Pool만 넘긴다.
// - 실패 주입은 owner(withOwner) 경로로 만든 시험 전용 트리거로만 한다. 제품 코드에 플래그를 두지 않는다.
// - 새 제품 모듈은 정적으로 import하지 않는다(TS2307 방지). 각 it 안에서 loadExport로 동적 import한다.
import path from "node:path";
import pg from "pg";
import { expect } from "vitest";
import { CI_ROLES, createDisposableDatabase, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, expectCliOk, expectSqlError, runMigrateCli, withApp, withOwner } from "./f2-support";

// ---------------------------------------------------------------- 제품 공개 계약(최소 로컬 타입)

export const LOGIN_MODULE = path.join(APP_DIR, "src", "server", "account", "login.ts");
export const GRANT_MODULE = path.join(APP_DIR, "src", "server", "credit", "first-login-grant.ts");
export const BALANCE_MODULE = path.join(APP_DIR, "src", "server", "credit", "balance.ts");

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
export type LoginIdentity = { provider: string; subject: string };
export type LoginOutcome = { userId: string; createdUser: boolean; granted: boolean; balance: number };
export type CompleteSuccessfulLogin = (
  db: pg.Pool,
  identity: LoginIdentity,
) => Promise<Result<LoginOutcome, "invalid_identity">>;
export type GrantFirstLogin = (tx: pg.PoolClient, userId: string) => Promise<{ granted: boolean; balance: number }>;
export type GetBalance = (db: pg.Pool, userId: string) => Promise<number>;

/** 제품 모듈을 동적으로 불러와 이름 붙은 함수 export를 단언한다. 없으면 이 it만 실패한다(RED). */
export async function loadExport<T>(file: string, name: string): Promise<T> {
  const rel = path.relative(APP_DIR, file);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F3 product module ${rel} could not be loaded (expected before GREEN): ${msg}`);
  }
  expect(typeof mod[name], `${rel} must export function ${name}`).toBe("function");
  return mod[name] as T;
}

export const loadLogin = () => loadExport<CompleteSuccessfulLogin>(LOGIN_MODULE, "completeSuccessfulLogin");
export const loadGrant = () => loadExport<GrantFirstLogin>(GRANT_MODULE, "grantFirstLogin");
export const loadBalance = () => loadExport<GetBalance>(BALANCE_MODULE, "getBalance");

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- 일회용 DB·app Pool

/** 이번 실행 전용 DB를 만들고 F2 CLI up으로 스키마를 준비한다(관리자 URL은 CLI에 넘기지 않는다). */
export async function freshMigratedDb(env: HarnessEnv, label: string): Promise<DisposableDatabase> {
  const db = await createDisposableDatabase(env, label);
  const r = await runMigrateCli(["up"], db.urls.migrator);
  expectCliOk(r, db.urls.migrator);
  return db;
}

const openPools = new Set<pg.Pool>();

/** app role 전용 Pool(기본 max 1: 연결 누수·트랜잭션 미정리가 다음 호출의 정지·오류로 드러난다). */
export function openAppPool(db: DisposableDatabase, max = 1): pg.Pool {
  const pool = new pg.Pool({ connectionString: db.urls.app, max, idleTimeoutMillis: 0, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  openPools.add(pool);
  return pool;
}

export async function endPool(pool: pg.Pool): Promise<void> {
  if (!openPools.delete(pool)) return;
  await pool.end().catch(() => undefined);
}

export async function endAllPools(): Promise<void> {
  await Promise.all([...openPools].map((p) => endPool(p)));
}

/** Pool의 실제 연결이 app role인지 확인하고 backend pid를 돌려준다. */
export async function appBackend(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ pid: number; u: string }>("SELECT pg_backend_pid() AS pid, current_user AS u");
  expect(r.rows[0]?.u).toBe(CI_ROLES.app);
  return Number(r.rows[0]?.pid);
}

/** 빌려 간 연결이 모두 반환됐는지(트랜잭션 뒤 release 누락이 없는지). */
export function expectPoolSettled(pool: pg.Pool): void {
  expect(pool.waitingCount, "no waiting clients").toBe(0);
  expect(pool.idleCount, "every client was released").toBe(pool.totalCount);
}

// ---------------------------------------------------------------- 상태 조회(owner)

export type Counts = { users: number; identities: number; accounts: number; ledger: number };

export async function counts(env: HarnessEnv, db: DisposableDatabase): Promise<Counts> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<Counts>(
      `SELECT (SELECT count(*)::int FROM pod.users)           AS users,
              (SELECT count(*)::int FROM pod.auth_identities) AS identities,
              (SELECT count(*)::int FROM pod.credit_accounts) AS accounts,
              (SELECT count(*)::int FROM pod.emotion_ledger)  AS ledger`,
    );
    return r.rows[0]!;
  });
}

export type UserState = {
  firstLoginAt: string | null;
  balance: number | null;
  ledger: { delta: number; reason: string; grant_key: string }[];
  identities: { provider: string; subject: string }[];
};

/** 사용자 하나의 상태(first_login_at은 정밀도 손실 없이 text로 비교한다). */
export async function userState(env: HarnessEnv, db: DisposableDatabase, userId: string): Promise<UserState> {
  return withOwner(env, db, async (c) => {
    const u = await c.query<{ f: string | null }>("SELECT first_login_at::text AS f FROM pod.users WHERE id = $1", [userId]);
    expect(u.rows, `user ${userId} exists`).toHaveLength(1);
    const a = await c.query<{ balance: number }>("SELECT balance FROM pod.credit_accounts WHERE user_id = $1", [userId]);
    const l = await c.query<{ delta: number; reason: string; grant_key: string }>(
      "SELECT delta, reason, grant_key FROM pod.emotion_ledger WHERE user_id = $1 ORDER BY entry_id",
      [userId],
    );
    const i = await c.query<{ provider: string; subject: string }>(
      "SELECT provider, subject FROM pod.auth_identities WHERE user_id = $1 ORDER BY provider, subject",
      [userId],
    );
    return { firstLoginAt: u.rows[0]!.f, balance: a.rows[0]?.balance ?? null, ledger: l.rows, identities: i.rows };
  });
}

/** 첫 지급 1회가 끝난 사용자 상태. */
export function expectGrantedOnce(state: UserState, userId: string): void {
  expect(state.firstLoginAt, "first_login_at is set").not.toBeNull();
  expect(state.balance).toBe(10);
  expect(state.ledger).toEqual([{ delta: 10, reason: "first_login_grant", grant_key: `first_login:${userId}` }]);
}

/**
 * 모든 사례 끝의 회귀: 계정별 SUM(delta) = balance, 계정 없는 원장 없음,
 * app role의 원장 UPDATE·DELETE는 42501(F2 권한 계약).
 */
export async function expectLedgerInvariants(env: HarnessEnv, db: DisposableDatabase): Promise<void> {
  const mismatched = await withOwner(env, db, async (c) => {
    const r = await c.query<{ user_id: string; balance: number; total: number }>(
      `SELECT a.user_id, a.balance, COALESCE(SUM(l.delta), 0)::int AS total
         FROM pod.credit_accounts a LEFT JOIN pod.emotion_ledger l ON l.user_id = a.user_id
        GROUP BY a.user_id, a.balance
       HAVING a.balance <> COALESCE(SUM(l.delta), 0)`,
    );
    return r.rows;
  });
  expect(mismatched, "SUM(delta) = balance for every account").toEqual([]);
  await withApp(env, db, async (c) => {
    await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = delta WHERE true"), "42501");
    await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE true"), "42501");
  });
}

// ---------------------------------------------------------------- 시험 데이터(owner)

/** 기존 사용자 + identity(들)를 owner로 미리 커밋한다. first_login_at은 null. 필요하면 잔액 0 계정도 만든다. */
export async function insertExistingUser(
  env: HarnessEnv,
  db: DisposableDatabase,
  identities: LoginIdentity[],
  opts: { account?: boolean } = {},
): Promise<string> {
  return withOwner(env, db, async (c) => {
    await c.query("BEGIN");
    try {
      const u = await c.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id");
      const userId = u.rows[0]!.id;
      for (const i of identities) {
        await c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, $2, $3)", [
          userId,
          i.provider,
          i.subject,
        ]);
      }
      if (opts.account) await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 0)", [userId]);
      await c.query("COMMIT");
      return userId;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

// ---------------------------------------------------------------- 실패 주입(owner의 시험 전용 트리거)

export const INJECTED_MARKER = "f3_test_injected_failure";

export type FailurePoint = "users_first_login_update" | "credit_balance_update";

const TRIGGER_SQL: Record<FailurePoint, { table: string; timing: string }> = {
  // completeSuccessfulLogin 5단계: UPDATE pod.users SET first_login_at
  users_first_login_update: { table: "pod.users", timing: "BEFORE UPDATE OF first_login_at" },
  // grantFirstLogin 4단계: UPDATE pod.credit_accounts SET balance
  credit_balance_update: { table: "pod.credit_accounts", timing: "BEFORE UPDATE" },
};

/** 시험 전용 실패 트리거를 owner로 만든다. 돌려준 함수로 반드시(finally) 제거한다. */
export async function injectFailure(
  env: HarnessEnv,
  db: DisposableDatabase,
  point: FailurePoint,
): Promise<() => Promise<void>> {
  const { table, timing } = TRIGGER_SQL[point];
  await withOwner(env, db, async (c) => {
    await c.query(`CREATE FUNCTION pod.f3_test_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '${INJECTED_MARKER}';
END
$fn$`);
    await c.query(`CREATE TRIGGER f3_test_fail ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION pod.f3_test_fail()`);
  });
  let dropped = false;
  return async () => {
    if (dropped) return;
    dropped = true;
    await withOwner(env, db, async (c) => {
      await c.query(`DROP TRIGGER IF EXISTS f3_test_fail ON ${table}`);
      await c.query("DROP FUNCTION IF EXISTS pod.f3_test_fail()");
    });
  };
}

/** 오류와 cause 사슬의 메시지를 모은다(제품이 오류를 감싸도 주입 표식을 찾는다). */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth += 1) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(" <- ");
}

/** 주입한 실패가 실제로 일어나 호출이 거부됐는지 확인한다. */
export async function expectInjectedFailure(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  let resolved: unknown;
  try {
    resolved = await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected the injected failure to reject, but resolved with ${JSON.stringify(resolved)}`).toBeDefined();
  expect(errorText(caught)).toContain(INJECTED_MARKER);
}
