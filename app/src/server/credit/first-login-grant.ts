import "server-only";
import type { Tx } from "../db/pool";
import { isUuid } from "../ids";

/** DATA_CONTRACT §5 첫 성공 로그인 지급량. */
const FIRST_LOGIN_GRANT = 10;

/**
 * 첫 성공 로그인 감정덩어리 지급(PLAN_mvp-domain-storage §2 4단계). 호출자의 트랜잭션 안에서만 부른다.
 * 계정 행 확보 → 잔액 잠금 → 원장 1행(멱등 키) → 삽입된 경우에만 잔액 증가.
 */
export async function grantFirstLogin(tx: Tx, userId: string): Promise<{ granted: boolean; balance: number }> {
  if (!isUuid(userId)) throw new Error("grantFirstLogin: userId must be a UUID");
  await tx.query("INSERT INTO pod.credit_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING", [userId]);
  const locked = await tx.query<{ balance: number }>(
    "SELECT balance FROM pod.credit_accounts WHERE user_id = $1::uuid FOR UPDATE",
    [userId],
  );
  const current = locked.rows[0];
  if (!current) throw new Error("grantFirstLogin: credit account row is missing");
  const inserted = await tx.query(
    `INSERT INTO pod.emotion_ledger (user_id, delta, reason, grant_key)
     VALUES ($1::uuid, $2, 'first_login_grant', 'first_login:' || $1::uuid::text)
     ON CONFLICT DO NOTHING
     RETURNING entry_id`,
    [userId, FIRST_LOGIN_GRANT],
  );
  if (inserted.rowCount !== 1) return { granted: false, balance: current.balance };
  const updated = await tx.query<{ balance: number }>(
    "UPDATE pod.credit_accounts SET balance = balance + $2, updated_at = now() WHERE user_id = $1::uuid RETURNING balance",
    [userId, FIRST_LOGIN_GRANT],
  );
  const after = updated.rows[0];
  if (!after) throw new Error("grantFirstLogin: credit account row is missing");
  return { granted: true, balance: after.balance };
}
