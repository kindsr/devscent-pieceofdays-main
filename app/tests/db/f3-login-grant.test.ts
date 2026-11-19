// F3 slice ① RED — 공급자 중립 계정 해석 + 첫 성공 로그인 10개 지급(PLAN_mvp-domain-storage §2, §5 ①-b;
// DATA_CONTRACT §4.1·§4.2·§4.8·§5). 실제 app role 연결(pg.Pool)로 제품 함수를 호출해 판정한다.
//
// - 시험마다 이번 실행 전용 일회용 DB를 만들고 F2 CLI up으로 스키마를 준비한다(실패 주입 사례도 각자 DB).
// - 제품 함수에는 db.urls.app의 Pool만 넘긴다. 관리자·migrator URL은 넘기지 않는다.
// - 새 제품 모듈은 각 it 안에서 동적 import한다(beforeAll 실패로 사례 전체가 skip되지 않게).
// - 실패 주입은 owner 경로의 시험 전용 트리거로만 하고 finally에서 제거한다. 제품 코드 플래그·가짜 저장 구현은 없다.
// - 실제 identity 연결 API·정책은 F4 [미정]이다. 여기서는 시험 데이터로만 두 identity를 한 사용자에 묶는다.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupAll, dropDisposableDatabase, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  UUID_RE,
  appBackend,
  counts,
  endAllPools,
  expectGrantedOnce,
  expectInjectedFailure,
  expectLedgerInvariants,
  expectActive,
  expectPoolSettled,
  freshMigratedDb,
  injectFailure,
  insertExistingUser,
  loadBalance,
  loadGrant,
  loadLogin,
  openAppPool,
  userState,
  type CompleteSuccessfulLogin,
  type LoginIdentity,
  type ActiveLoginOutcome,
} from "./f3-support";

const CASE_TIMEOUT = 90_000;

let env: HarnessEnv;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  await endAllPools();
  if (env) await cleanupAll(env);
});

/** 시험 하나에 일회용 DB 하나. finally에서 app Pool을 닫고 그 DB를 지운다(남은 것은 afterAll cleanupAll). */
async function withCase(label: string, fn: (db: DisposableDatabase) => Promise<void>): Promise<void> {
  const db = await freshMigratedDb(env, label);
  try {
    await fn(db);
  } finally {
    await endAllPools();
    await dropDisposableDatabase(env, db.name);
  }
}

async function loginOk(
  login: CompleteSuccessfulLogin,
  pool: pg.Pool,
  identity: LoginIdentity,
): Promise<ActiveLoginOutcome> {
  const r = await login(pool, identity);
  expect(r, `login ${JSON.stringify(identity)}`).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`unexpected ${r.error}`);
  // F4 L2: 활성 계정의 성공 값은 kind:"active" + 잠금 안에서 읽은 gen(PLAN_account-lifecycle §3·§9)
  const out = expectActive(r.value, JSON.stringify(identity));
  expect(out.userId).toMatch(UUID_RE);
  return out;
}

const GOOGLE: LoginIdentity = { provider: "google", subject: "sub-0001" };

describe("completeSuccessfulLogin: identity validation (no SQL for invalid identities)", () => {
  it(
    "returns invalid_identity before any transaction/SQL for out-of-contract provider/subject and stores nothing",
    async () => {
      await withCase("f3inv", async (db) => {
        const pool = openAppPool(db);
        await appBackend(pool);
        const login = await loadLogin();
        const invalid: LoginIdentity[] = [
          { provider: "", subject: "s" },
          { provider: "Google", subject: "s" }, // 대문자
          { provider: "1google", subject: "s" }, // 숫자로 시작
          { provider: "_google", subject: "s" },
          { provider: "-google", subject: "s" },
          { provider: `p${"a".repeat(32)}`, subject: "s" }, // 33자
          { provider: "goo.gle", subject: "s" },
          { provider: "goo gle", subject: "s" },
          { provider: "google\n", subject: "s" }, // 끝 줄바꿈도 정규식 밖
          { provider: "구글", subject: "s" },
          { provider: "google", subject: "" }, // 0 코드포인트
          { provider: "google", subject: "a".repeat(256) }, // 256 코드포인트
          { provider: "google", subject: "😀".repeat(256) }, // 256 코드포인트(512 UTF-16 단위)
        ];
        const connectSpy = vi.spyOn(pool, "connect");
        const querySpy = vi.spyOn(pool, "query");
        const results: unknown[] = [];
        try {
          for (const identity of invalid) results.push(await login(pool, identity));
          expect(connectSpy, "no connection is taken for invalid identities").not.toHaveBeenCalled();
          expect(querySpy, "no SQL is sent for invalid identities").not.toHaveBeenCalled();
        } finally {
          connectSpy.mockRestore();
          querySpy.mockRestore();
        }
        results.forEach((r, i) =>
          expect(r, JSON.stringify(invalid[i])).toEqual({ ok: false, error: "invalid_identity" }),
        );
        expect(await counts(env, db)).toEqual({ users: 0, identities: 0, accounts: 0, ledger: 0 });
        expectPoolSettled(pool);
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "accepts the provider/subject boundaries (code points, not UTF-16 units) and stores special characters verbatim",
    async () => {
      await withCase("f3bound", async (db) => {
        const pool = openAppPool(db);
        await appBackend(pool);
        const login = await loadLogin();
        const valid: LoginIdentity[] = [
          { provider: "a", subject: "s" }, // provider 1자, subject 1자
          { provider: `p${"a".repeat(31)}`, subject: "s" }, // provider 32자
          { provider: "a0_-z", subject: "x".repeat(255) }, // subject 255 코드포인트
          { provider: "kakao", subject: "😀".repeat(255) }, // 255 코드포인트 = 510 UTF-16 단위
          { provider: "naver", subject: "가".repeat(255) },
          { provider: "google", subject: "x'); DROP TABLE pod.users; --" },
          { provider: "google", subject: "$1 $2::uuid \\ \" ' % _ *" },
          { provider: "google", subject: "first_login:00000000-0000-0000-0000-000000000000" },
          { provider: "google", subject: " line1\nline2\t" },
        ];
        const ids = new Set<string>();
        for (const identity of valid) {
          const out = await loginOk(login, pool, identity);
          expect(out, JSON.stringify(identity)).toMatchObject({ kind: "active", gen: 1, createdUser: true, granted: true, balance: 10 });
          ids.add(out.userId);
          const state = await userState(env, db, out.userId);
          expect(state.identities, "stored exactly as given (parameterized)").toEqual([identity]);
          expectGrantedOnce(state, out.userId);
        }
        expect(ids.size).toBe(valid.length);
        expect(await counts(env, db)).toEqual({
          users: valid.length,
          identities: valid.length,
          accounts: valid.length,
          ledger: valid.length,
        });
        expectPoolSettled(pool);
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("completeSuccessfulLogin: first login grant and idempotency", () => {
  it(
    "new identity creates user/identity/account/ledger once with balance 10; a repeat call grants nothing and keeps first_login_at",
    async () => {
      await withCase("f3new", async (db) => {
        const pool = openAppPool(db);
        await appBackend(pool);
        const login = await loadLogin();
        const getBalance = await loadBalance();

        const first = await loginOk(login, pool, GOOGLE);
        expect(first).toEqual({ kind: "active", userId: first.userId, gen: 1, createdUser: true, granted: true, balance: 10 });
        expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });
        const s1 = await userState(env, db, first.userId);
        expect(s1.identities).toEqual([GOOGLE]);
        expectGrantedOnce(s1, first.userId);

        const again = await loginOk(login, pool, { ...GOOGLE });
        expect(again).toEqual({ kind: "active", userId: first.userId, gen: 1, createdUser: false, granted: false, balance: 10 });
        const s2 = await userState(env, db, first.userId);
        expect(s2.firstLoginAt, "first_login_at does not move on later logins").toBe(s1.firstLoginAt);
        expectGrantedOnce(s2, first.userId);
        expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });

        // 같은 subject라도 provider가 다르면 다른 사용자다.
        const other = await loginOk(login, pool, { provider: "kakao", subject: GOOGLE.subject });
        expect(other.userId).not.toBe(first.userId);
        expect(other).toMatchObject({ kind: "active", gen: 1, createdUser: true, granted: true, balance: 10 });

        expect(await getBalance(pool, first.userId)).toBe(10);
        expect(await getBalance(pool, other.userId)).toBe(10);
        expectPoolSettled(pool);
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("getBalance / grantFirstLogin", () => {
  it(
    "getBalance is read-only: 0 for unknown UUID, user without account, and (without SQL) non-UUID ids",
    async () => {
      await withCase("f3bal", async (db) => {
        const pool = openAppPool(db);
        await appBackend(pool);
        const noAccount = await insertExistingUser(env, db, [{ provider: "google", subject: "no-account" }]);
        const getBalance = await loadBalance();

        expect(await getBalance(pool, "00000000-0000-7000-8000-000000000000")).toBe(0);
        expect(await getBalance(pool, noAccount)).toBe(0);
        expect(await counts(env, db), "getBalance must not create an account").toEqual({
          users: 1,
          identities: 1,
          accounts: 0,
          ledger: 0,
        });

        const nonUuid = ["", "not-a-uuid", "1", "' OR 1=1 --", `${noAccount}x`, noAccount.toUpperCase().replace(/-/g, "")];
        const connectSpy = vi.spyOn(pool, "connect");
        const querySpy = vi.spyOn(pool, "query");
        const got: number[] = [];
        try {
          for (const id of nonUuid) got.push(await getBalance(pool, id));
          expect(connectSpy, "no connection for non-UUID user ids").not.toHaveBeenCalled();
          expect(querySpy, "no SQL for non-UUID user ids").not.toHaveBeenCalled();
        } finally {
          connectSpy.mockRestore();
          querySpy.mockRestore();
        }
        expect(got).toEqual(nonUuid.map(() => 0));
        expectPoolSettled(pool);
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "grantFirstLogin works only inside the caller's transaction: grants once, is idempotent, and rolls back with it",
    async () => {
      await withCase("f3grant", async (db) => {
        const pool = openAppPool(db);
        await appBackend(pool);
        const userId = await insertExistingUser(env, db, [{ provider: "google", subject: "grant-direct" }]);
        const grantFirstLogin = await loadGrant();

        // 호출자가 ROLLBACK하면 계정·원장·잔액이 남지 않는다(함수가 스스로 COMMIT하지 않는다).
        const tx1 = await pool.connect();
        try {
          await tx1.query("BEGIN");
          expect(await grantFirstLogin(tx1, userId)).toEqual({ granted: true, balance: 10 });
          await tx1.query("ROLLBACK");
        } finally {
          tx1.release();
        }
        expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 0, ledger: 0 });

        const tx2 = await pool.connect();
        try {
          await tx2.query("BEGIN");
          expect(await grantFirstLogin(tx2, userId)).toEqual({ granted: true, balance: 10 });
          expect(await grantFirstLogin(tx2, userId)).toEqual({ granted: false, balance: 10 });
          await tx2.query("COMMIT");
        } finally {
          tx2.release();
        }
        const tx3 = await pool.connect();
        try {
          await tx3.query("BEGIN");
          expect(await grantFirstLogin(tx3, userId)).toEqual({ granted: false, balance: 10 });
          await tx3.query("COMMIT");
        } finally {
          tx3.release();
        }
        const state = await userState(env, db, userId);
        expect(state.balance).toBe(10);
        expect(state.ledger).toEqual([{ delta: 10, reason: "first_login_grant", grant_key: `first_login:${userId}` }]);
        expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });
        expectPoolSettled(pool);
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("completeSuccessfulLogin: concurrency over real app-role connections", () => {
  async function eightPools(db: DisposableDatabase): Promise<pg.Pool[]> {
    const pools = Array.from({ length: 8 }, () => openAppPool(db, 1));
    const pids = await Promise.all(pools.map((p) => appBackend(p)));
    expect(new Set(pids).size, "8 distinct backend connections").toBe(8);
    return pools;
  }

  it(
    "8 concurrent logins with the same identity resolve to one canonical user with exactly one grant",
    async () => {
      await withCase("f3same", async (db) => {
        const pools = await eightPools(db);
        const login = await loadLogin();
        const outs = await Promise.all(pools.map((p) => loginOk(login, p, { ...GOOGLE })));
        const userId = outs[0]!.userId;
        expect(new Set(outs.map((o) => o.userId))).toEqual(new Set([userId]));
        expect(outs.filter((o) => o.granted), "granted exactly once").toHaveLength(1);
        expect(outs.filter((o) => o.createdUser), "created exactly once").toHaveLength(1);
        expect(outs.map((o) => o.balance)).toEqual(Array(8).fill(10));
        expect(await counts(env, db), "no orphan users").toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });
        expectGrantedOnce(await userState(env, db, userId), userId);
        pools.forEach((p) => expectPoolSettled(p));
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "two different identities logging in concurrently get independent users with 10 each",
    async () => {
      await withCase("f3two", async (db) => {
        const pools = await eightPools(db);
        const login = await loadLogin();
        const a: LoginIdentity = { provider: "google", subject: "user-a" };
        const b: LoginIdentity = { provider: "google", subject: "user-b" };
        const outs = await Promise.all(pools.map((p, i) => loginOk(login, p, i % 2 === 0 ? { ...a } : { ...b })));
        const aIds = new Set(outs.filter((_, i) => i % 2 === 0).map((o) => o.userId));
        const bIds = new Set(outs.filter((_, i) => i % 2 === 1).map((o) => o.userId));
        expect(aIds.size).toBe(1);
        expect(bIds.size).toBe(1);
        const [aId] = [...aIds];
        const [bId] = [...bIds];
        expect(aId).not.toBe(bId);
        expect(outs.filter((o) => o.granted)).toHaveLength(2);
        expect(outs.map((o) => o.balance)).toEqual(Array(8).fill(10));
        expect(await counts(env, db)).toEqual({ users: 2, identities: 2, accounts: 2, ledger: 2 });
        expectGrantedOnce(await userState(env, db, aId!), aId!);
        expectGrantedOnce(await userState(env, db, bId!), bId!);
        pools.forEach((p) => expectPoolSettled(p));
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "two existing identities linked (test data only) to one user are not each granted 10, even concurrently",
    async () => {
      await withCase("f3link", async (db) => {
        const g: LoginIdentity = { provider: "google", subject: "linked-g" };
        const k: LoginIdentity = { provider: "kakao", subject: "linked-k" };
        const userId = await insertExistingUser(env, db, [g, k]);
        const pools = await eightPools(db);
        const login = await loadLogin();
        const outs = await Promise.all(pools.map((p, i) => loginOk(login, p, i % 2 === 0 ? { ...g } : { ...k })));
        expect(new Set(outs.map((o) => o.userId))).toEqual(new Set([userId]));
        expect(outs.filter((o) => o.createdUser)).toHaveLength(0);
        expect(outs.filter((o) => o.granted), "one grant per account, not per login method").toHaveLength(1);
        expect(outs.map((o) => o.balance)).toEqual(Array(8).fill(10));
        expect(await counts(env, db)).toEqual({ users: 1, identities: 2, accounts: 1, ledger: 1 });
        const state = await userState(env, db, userId);
        expect(state.identities).toEqual([g, k]);
        expectGrantedOnce(state, userId);
        pools.forEach((p) => expectPoolSettled(p));
        await expectLedgerInvariants(env, db);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("completeSuccessfulLogin: atomicity under injected failures (owner test triggers)", () => {
  for (const point of ["users_first_login_update", "credit_balance_update"] as const) {
    it(
      `new identity: failure at ${point} rolls back user/identity/account/ledger/first_login_at; retry on the same pool grants once`,
      async () => {
        await withCase("f3failnew", async (db) => {
          const pool = openAppPool(db, 1);
          await appBackend(pool);
          const login = await loadLogin();
          const identity: LoginIdentity = { provider: "google", subject: `fail-${point}` };
          const drop = await injectFailure(env, db, point);
          try {
            await expectInjectedFailure(login(pool, { ...identity }));
            expect(await counts(env, db), "nothing from the failed login remains").toEqual({
              users: 0,
              identities: 0,
              accounts: 0,
              ledger: 0,
            });
            expectPoolSettled(pool);
          } finally {
            await drop();
          }
          // 같은 Pool(max 1)·같은 identity: 연결이 반환·정리됐으면 정상 지급 1회.
          const out = await loginOk(login, pool, { ...identity });
          expect(out).toMatchObject({ kind: "active", gen: 1, createdUser: true, granted: true, balance: 10 });
          expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });
          const state = await userState(env, db, out.userId);
          expect(state.identities).toEqual([identity]);
          expectGrantedOnce(state, out.userId);
          expectPoolSettled(pool);
          await expectLedgerInvariants(env, db);
        });
      },
      CASE_TIMEOUT,
    );
  }

  for (const withAccount of [true, false]) {
    it(
      `existing identity (first_login_at null, ${withAccount ? "account balance 0" : "no account"}): credit update failure keeps prior rows; retry grants once`,
      async () => {
        await withCase("f3failold", async (db) => {
          const identity: LoginIdentity = { provider: "google", subject: `existing-${withAccount}` };
          const userId = await insertExistingUser(env, db, [identity], { account: withAccount });
          const before = await counts(env, db);
          expect(before).toEqual({ users: 1, identities: 1, accounts: withAccount ? 1 : 0, ledger: 0 });
          const pool = openAppPool(db, 1);
          await appBackend(pool);
          const login = await loadLogin();
          const getBalance = await loadBalance();
          const drop = await injectFailure(env, db, "credit_balance_update");
          try {
            await expectInjectedFailure(login(pool, { ...identity }));
            expect(await counts(env, db), "prior rows kept, no new rows").toEqual(before);
            const state = await userState(env, db, userId);
            expect(state.firstLoginAt, "first_login_at unchanged").toBeNull();
            expect(state.balance).toBe(withAccount ? 0 : null);
            expect(state.ledger).toEqual([]);
            expect(state.identities).toEqual([identity]);
            expect(await getBalance(pool, userId)).toBe(0);
            expectPoolSettled(pool);
          } finally {
            await drop();
          }
          const out = await loginOk(login, pool, { ...identity });
          expect(out).toEqual({ kind: "active", userId, gen: 1, createdUser: false, granted: true, balance: 10 });
          expect(await counts(env, db)).toEqual({ users: 1, identities: 1, accounts: 1, ledger: 1 });
          expectGrantedOnce(await userState(env, db, userId), userId);
          expect(await getBalance(pool, userId)).toBe(10);
          expectPoolSettled(pool);
          await expectLedgerInvariants(env, db);
        });
      },
      CASE_TIMEOUT,
    );
  }
});
