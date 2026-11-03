// F4 L2 RED 시험 전용 보조 함수(PLAN_account-lifecycle §3·§4·§7·§9·§12). 제품 코드가 아니며 lifecycle 동작을 대신하지 않는다.
// - owner 경로는 시험 데이터(사용자·identity·지급 상태·탈퇴 상태) 준비와 결과 확인에만 쓴다.
// - 잠금 관찰은 하네스 관리자 연결의 pg_blocking_pids로 한다(고정 sleep 대신 상태 polling).
// - 새 제품 모듈(src/server/account/lifecycle.ts)은 f3-support의 loadExport로 각 it 안에서 동적 import한다.
import path from "node:path";
import pg from "pg";
import { expect } from "vitest";
import { CI_ROLES, closeClient, openClient, withAdmin, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, withOwner } from "./f2-support";
import { loadExport, type LoginIdentity, type Result } from "./f3-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §9)

export const LIFECYCLE_MODULE = path.join(APP_DIR, "src", "server", "account", "lifecycle.ts");

export type SessionSubject = { userId: string; gen: number };
export type VerifyActiveAccount = (db: pg.Pool, s: SessionSubject) => Promise<boolean>;
export type RequestWithdrawal = (
  db: pg.Pool,
  s: SessionSubject,
) => Promise<Result<{ purgeAfter: Date; changed: boolean }, "not_found" | "stale_session">>;
export type RestoreAccount = (
  db: pg.Pool,
  proof: SessionSubject,
) => Promise<Result<{ gen: number }, "not_found" | "not_pending" | "stale_proof" | "expired">>;
export type LifecycleApi = { verify: VerifyActiveAccount; withdraw: RequestWithdrawal; restore: RestoreAccount };

export async function loadLifecycle(): Promise<LifecycleApi> {
  return {
    verify: await loadExport<VerifyActiveAccount>(LIFECYCLE_MODULE, "verifyActiveAccount"),
    withdraw: await loadExport<RequestWithdrawal>(LIFECYCLE_MODULE, "requestWithdrawal"),
    restore: await loadExport<RestoreAccount>(LIFECYCLE_MODULE, "restoreAccount"),
  };
}

export const SEVEN_TWENTY_HOURS_S = 720 * 3600;

// ---------------------------------------------------------------- 시험 데이터(owner)

/**
 * 사용자 + identity(들)를 owner로 만든다. granted면 첫 지급이 끝난 상태(계정 잔액 10·원장 1행·first_login_at)로 둔다.
 * gen은 auth_generation 초기값(기본 1).
 */
export async function seedUser(
  env: HarnessEnv,
  db: DisposableDatabase,
  identities: LoginIdentity[],
  opts: { granted?: boolean; gen?: number } = {},
): Promise<string> {
  return withOwner(env, db, async (c) => {
    await c.query("BEGIN");
    try {
      const u = await c.query<{ id: string }>(
        `INSERT INTO pod.users (auth_generation, first_login_at)
         VALUES ($1, CASE WHEN $2::boolean THEN now() ELSE NULL END) RETURNING id::text AS id`,
        [opts.gen ?? 1, opts.granted ?? false],
      );
      const uid = u.rows[0]!.id;
      for (const i of identities) {
        await c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, $2, $3)", [uid, i.provider, i.subject]);
      }
      if (opts.granted) {
        await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 10)", [uid]);
        await c.query(
          "INSERT INTO pod.emotion_ledger (user_id, delta, reason, grant_key) VALUES ($1, 10, 'first_login_grant', $2)",
          [uid, `first_login:${uid}`],
        );
      }
      await c.query("COMMIT");
      return uid;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** owner가 탈퇴 대기 상태로 만든다. requestedSql은 deletion_requested_at을 만드는 SQL 식(purge_after = 그 + 720h). */
export async function setPending(
  env: HarnessEnv,
  db: DisposableDatabase,
  userId: string,
  requestedSql: string,
  gen?: number,
): Promise<void> {
  await withOwner(env, db, (c) =>
    c.query(
      `UPDATE pod.users SET status = 'pending_deletion', deletion_requested_at = r, purge_after = r + interval '720 hours',
              auth_generation = COALESCE($2::int, auth_generation)
         FROM (SELECT ${requestedSql} AS r) s WHERE id = $1::uuid`,
      [userId, gen ?? null],
    ),
  );
}

export type LifeState = {
  status: string;
  gen: number;
  requestedMs: number | null;
  purgeMs: number | null;
  lifetimeS: number | null; // purge_after − deletion_requested_at(초)
  firstLoginAt: string | null;
  balance: number | null;
  ledger: number;
  identities: number;
};

/** 사용자 하나의 lifecycle·지급 상태(없으면 null). 시각은 ms 정수로 읽는다. */
export async function lifeState(env: HarnessEnv, db: DisposableDatabase, userId: string): Promise<LifeState | null> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{
      status: string;
      gen: number;
      req: string | null;
      purge: string | null;
      life: string | null;
      fla: string | null;
      balance: number | null;
      ledger: number;
      identities: number;
    }>(
      `SELECT u.status, u.auth_generation AS gen,
              floor(extract(epoch FROM u.deletion_requested_at) * 1000)::bigint::text AS req,
              floor(extract(epoch FROM u.purge_after) * 1000)::bigint::text AS purge,
              extract(epoch FROM (u.purge_after - u.deletion_requested_at))::text AS life,
              u.first_login_at::text AS fla,
              (SELECT balance FROM pod.credit_accounts a WHERE a.user_id = u.id) AS balance,
              (SELECT count(*)::int FROM pod.emotion_ledger l WHERE l.user_id = u.id) AS ledger,
              (SELECT count(*)::int FROM pod.auth_identities i WHERE i.user_id = u.id) AS identities
         FROM pod.users u WHERE u.id = $1::uuid`,
      [userId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      status: x.status,
      gen: x.gen,
      requestedMs: x.req === null ? null : Number(x.req),
      purgeMs: x.purge === null ? null : Number(x.purge),
      lifetimeS: x.life === null ? null : Number(x.life),
      firstLoginAt: x.fla,
      balance: x.balance,
      ledger: x.ledger,
      identities: x.identities,
    };
  });
}

export type Totals = { users: number; identities: number; accounts: number; ledger: number };

export async function totals(env: HarnessEnv, db: DisposableDatabase): Promise<Totals> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<Totals>(
      `SELECT (SELECT count(*)::int FROM pod.users) AS users,
              (SELECT count(*)::int FROM pod.auth_identities) AS identities,
              (SELECT count(*)::int FROM pod.credit_accounts) AS accounts,
              (SELECT count(*)::int FROM pod.emotion_ledger) AS ledger`,
    );
    return r.rows[0]!;
  });
}

/** DB 시계(clock_timestamp) ms. */
export async function dbNowMs(env: HarnessEnv, db: DisposableDatabase): Promise<number> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ t: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS t");
    return Number(r.rows[0]!.t);
  });
}

// ---------------------------------------------------------------- 열린 연결·잠금 관찰

export type OpenConn = { client: pg.Client; pid: number; close: () => Promise<void> };

/** owner(migrator → SET ROLE owner) 연결을 열어 둔다. 호출자가 BEGIN/COMMIT을 직접 한다. */
export async function openOwner(env: HarnessEnv, db: DisposableDatabase): Promise<OpenConn> {
  const client = await openClient(db.urls.migrator, env.adminUrl);
  await client.query(`SET ROLE ${CI_ROLES.owner}`);
  const r = await client.query<{ pid: number; u: string }>("SELECT pg_backend_pid() AS pid, current_user AS u");
  expect(r.rows[0]?.u).toBe(CI_ROLES.owner);
  return { client, pid: Number(r.rows[0]!.pid), close: () => closeClient(client) };
}

/** purge role 연결을 열어 둔다. */
export async function openPurge(env: HarnessEnv, db: DisposableDatabase): Promise<OpenConn> {
  const client = await openClient(db.urls.purge, env.adminUrl);
  const r = await client.query<{ pid: number; u: string }>("SELECT pg_backend_pid() AS pid, current_user AS u");
  expect(r.rows[0]?.u).toBe(CI_ROLES.purge);
  return { client, pid: Number(r.rows[0]!.pid), close: () => closeClient(client) };
}

/** backend pid가 blocker pid(주면 그것) 때문에 잠금 대기 중이 될 때까지 기다린다(polling, 제한 시간 안). */
export async function waitBlocked(
  env: HarnessEnv,
  db: DisposableDatabase,
  pid: number,
  blocker?: number,
  timeoutMs = 15_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  await withAdmin(
    env,
    async (a) => {
      for (;;) {
        const r = await a.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [pid]);
        const b = (r.rows[0]?.b ?? []).map(Number);
        if (b.length > 0 && (blocker === undefined || b.includes(blocker))) return;
        if (Date.now() > until) throw new Error(`backend ${pid} did not wait on a lock${blocker ? ` held by ${blocker}` : ""}`);
        await new Promise((res) => setTimeout(res, 25));
      }
    },
    db.name,
  );
}

/** DB 시계가 사용자의 purge_after에 이를 때까지 기다린다(polling, 제한 시간 안). */
export async function waitDbPastPurgeAfter(env: HarnessEnv, db: DisposableDatabase, userId: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  await withAdmin(
    env,
    async (a) => {
      for (;;) {
        const r = await a.query<{ past: boolean }>(
          "SELECT clock_timestamp() >= purge_after AS past FROM pod.users WHERE id = $1::uuid",
          [userId],
        );
        if (r.rows[0]?.past) return;
        if (Date.now() > until) throw new Error("DB clock did not reach purge_after in time");
        await new Promise((res) => setTimeout(res, 50));
      }
    },
    db.name,
  );
}

/** 결과나 예외를 값으로 받는다(경합 결과 비교용). raw 오류는 code와 message로 남긴다. */
export async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: { code?: string; message: string } }> {
  try {
    return { value: await p };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return { error: { code: typeof e.code === "string" ? e.code : undefined, message: String(e.message ?? err) } };
  }
}
