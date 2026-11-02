import type { Db } from "../db/pool";
import { isUuid } from "../ids";

/** 감정덩어리 잔액. 읽기 전용이며 계정이 없거나 userId가 UUID가 아니면 0이다(비UUID는 SQL 없이). */
export async function getBalance(db: Db, userId: string): Promise<number> {
  if (!isUuid(userId)) return 0;
  const r = await db.query<{ balance: number }>("SELECT balance FROM pod.credit_accounts WHERE user_id = $1::uuid", [
    userId,
  ]);
  return r.rows[0]?.balance ?? 0;
}
