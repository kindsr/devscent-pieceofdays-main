/**
 * 계정 탈퇴·복구·활성 확인(PLAN_account-lifecycle §2·§4·§9).
 *
 * 호출 경계: userId·gen은 F4a readSession(일반 세션) 또는 F4b/c 복구 증명 검증 결과에서만 온다.
 * HTTP 입력의 userId를 신뢰하는 경로는 없다. 이 모듈은 OAuth·HTTP·쿠키·DAL을 연결하지 않는다.
 *
 * - 기준 시각 t는 users 행 잠금을 얻은 뒤 같은 트랜잭션에서 DB clock_timestamp()로 읽는다(now() 아님).
 * - 기한 비교는 DB 안에서 한다(마이크로초 정밀도 유지). gen 비교는 auth_generation::bigint = $n::bigint다.
 * - 복구는 지급을 호출하지 않는다. 잔액·원장·first_login_at·identity는 그대로다.
 */
import "server-only";
import { withTransaction, type Db, type Tx } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";

export type SessionSubject = { userId: string; gen: number };

const isSubject = (s: SessionSubject): boolean =>
  isUuid(s.userId) && Number.isSafeInteger(s.gen) && s.gen > 0;

/** users 행을 잠근다. 행이 없으면 false. */
async function lockUser(tx: Tx, userId: string): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM pod.users WHERE id = $1::uuid FOR UPDATE", [userId]);
  return r.rowCount === 1;
}

/** 매 요청 DAL 진입 검사. 잠금·쓰기 없는 한 SELECT로 active + 현재 gen일 때만 true다. */
export async function verifyActiveAccount(db: Db, s: SessionSubject): Promise<boolean> {
  if (!isSubject(s)) return false;
  const r = await db.query(
    "SELECT 1 FROM pod.users WHERE id = $1::uuid AND status = 'active' AND auth_generation::bigint = $2::bigint",
    [s.userId, s.gen],
  );
  return r.rowCount === 1;
}

/** 탈퇴 요청. 검증된 일반 세션의 subject로만 호출한다. gen은 반환하지 않는다. */
export async function requestWithdrawal(
  db: Db,
  s: SessionSubject,
): Promise<Result<{ purgeAfter: Date; changed: boolean }, "not_found" | "stale_session">> {
  if (!isSubject(s)) return { ok: false, error: "not_found" };
  return withTransaction(db, async (tx) => {
    if (!(await lockUser(tx, s.userId))) return { ok: false, error: "not_found" };
    const cur = await tx.query<{ status: string; gen_ok: boolean; purge_after: Date | null }>(
      `SELECT status, auth_generation::bigint = $2::bigint AS gen_ok, purge_after
         FROM pod.users WHERE id = $1::uuid`,
      [s.userId, s.gen],
    );
    const row = cur.rows[0];
    if (!row) return { ok: false, error: "not_found" };
    if (row.status === "pending_deletion" && row.purge_after !== null) {
      return { ok: true, value: { purgeAfter: row.purge_after, changed: false } };
    }
    if (!row.gen_ok) return { ok: false, error: "stale_session" };
    // 같은 t로 두 시각을 기록한다(정확히 720시간, L1 CHECK와 일치).
    const upd = await tx.query<{ purge_after: Date }>(
      `UPDATE pod.users u
          SET status = 'pending_deletion', deletion_requested_at = c.t, purge_after = c.t + interval '720 hours',
              auth_generation = u.auth_generation + 1
         FROM (SELECT clock_timestamp() AS t) c
        WHERE u.id = $1::uuid
        RETURNING u.purge_after`,
      [s.userId],
    );
    const done = upd.rows[0];
    if (!done) throw new Error("requestWithdrawal: locked user row disappeared");
    return { ok: true, value: { purgeAfter: done.purge_after, changed: true } };
  });
}

/** 복구. 검증된 복구 증명(F4b/c)의 subject로만 호출한다. 판정 순서: 없음 → active → 기한 → gen. */
export async function restoreAccount(
  db: Db,
  proof: SessionSubject,
): Promise<Result<{ gen: number }, "not_found" | "not_pending" | "stale_proof" | "expired">> {
  if (!isSubject(proof)) return { ok: false, error: "not_found" };
  return withTransaction(db, async (tx) => {
    if (!(await lockUser(tx, proof.userId))) return { ok: false, error: "not_found" };
    const cur = await tx.query<{ status: string; gen_ok: boolean; due: boolean | null }>(
      `SELECT status, auth_generation::bigint = $2::bigint AS gen_ok, clock_timestamp() >= purge_after AS due
         FROM pod.users WHERE id = $1::uuid`,
      [proof.userId, proof.gen],
    );
    const row = cur.rows[0];
    if (!row) return { ok: false, error: "not_found" };
    if (row.status !== "pending_deletion") return { ok: false, error: "not_pending" };
    if (row.due !== false) return { ok: false, error: "expired" };
    if (!row.gen_ok) return { ok: false, error: "stale_proof" };
    const upd = await tx.query<{ gen: number }>(
      `UPDATE pod.users
          SET status = 'active', deletion_requested_at = NULL, purge_after = NULL, auth_generation = auth_generation + 1
        WHERE id = $1::uuid
        RETURNING auth_generation AS gen`,
      [proof.userId],
    );
    const done = upd.rows[0];
    if (!done) throw new Error("restoreAccount: locked user row disappeared");
    return { ok: true, value: { gen: done.gen } };
  });
}
