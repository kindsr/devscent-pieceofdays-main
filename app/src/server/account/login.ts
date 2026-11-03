/**
 * 공급자 중립 계정 해석 + 첫 성공 로그인 지급(PLAN_mvp-domain-storage §2).
 *
 * identity는 F4에서 검증한 서버 인증 사건에서만 온다. 이 함수는 OAuth·HTTP·세션을 다루지 않는다.
 * user·identity·계정·원장·잔액·first_login_at은 한 트랜잭션에서 모두 커밋되거나 모두 남지 않는다.
 */
import "server-only";
import { withTransaction, type Db, type Tx } from "../db/pool";
import { grantFirstLogin } from "../credit/first-login-grant";
import type { Result } from "../result";

export type LoginIdentity = { provider: string; subject: string };
export type LoginOutcome = { userId: string; createdUser: boolean; granted: boolean; balance: number };

const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SUBJECT_MAX = 255;

/** DATA_CONTRACT §4.1 형식. subject는 opaque 값이라 다듬지 않고 코드포인트 수만 센다. */
function isValidIdentity(identity: LoginIdentity): boolean {
  const { provider, subject } = identity;
  if (typeof provider !== "string" || typeof subject !== "string") return false;
  if (!PROVIDER_RE.test(provider)) return false;
  // 코드포인트 수 ≥ UTF-16 단위 수 / 2. 아주 긴 값은 펼치기 전에 거부한다.
  if (subject.length === 0 || subject.length > SUBJECT_MAX * 2) return false;
  return Array.from(subject).length <= SUBJECT_MAX;
}

/** 같은 identity를 다른 연결이 먼저 만들었다. 이 트랜잭션은 고아 user 없이 ROLLBACK되어야 한다. */
class IdentityRaceLost extends Error {}

async function attempt(tx: Tx, identity: LoginIdentity): Promise<LoginOutcome> {
  const found = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM pod.auth_identities WHERE provider = $1 AND subject = $2",
    [identity.provider, identity.subject],
  );
  let userId = found.rows[0]?.user_id;
  let createdUser = false;
  if (userId === undefined) {
    const user = await tx.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id");
    const newId = user.rows[0]?.id;
    if (newId === undefined) throw new Error("completeSuccessfulLogin: user insert returned no id");
    const linked = await tx.query<{ user_id: string }>(
      `INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (provider, subject) DO NOTHING
       RETURNING user_id`,
      [newId, identity.provider, identity.subject],
    );
    if (linked.rowCount !== 1) throw new IdentityRaceLost("identity was created by a concurrent login");
    userId = newId;
    createdUser = true;
  }
  const grant = await grantFirstLogin(tx, userId);
  await tx.query("UPDATE pod.users SET first_login_at = now() WHERE id = $1::uuid AND first_login_at IS NULL", [userId]);
  return { userId, createdUser, granted: grant.granted, balance: grant.balance };
}

export async function completeSuccessfulLogin(
  db: Db,
  identity: LoginIdentity,
): Promise<Result<LoginOutcome, "invalid_identity">> {
  if (!isValidIdentity(identity)) return { ok: false, error: "invalid_identity" };
  try {
    return { ok: true, value: await withTransaction(db, (tx) => attempt(tx, identity)) };
  } catch (err) {
    if (!(err instanceof IdentityRaceLost)) throw err;
  }
  // 경합 패자: 앞 트랜잭션은 user INSERT까지 ROLLBACK됐다. 새 트랜잭션에서 한 번만 다시 시도한다.
  return { ok: true, value: await withTransaction(db, (tx) => attempt(tx, identity)) };
}
