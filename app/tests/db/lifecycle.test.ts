// F4 L2 RED — 계정 탈퇴·복구·활성 확인과 로그인 상태 분기(PLAN_account-lifecycle §2·§3·§4·§7·§9·§12 L2).
// 대상: 신규 app/src/server/account/lifecycle.ts(아직 없음)와 변경될 app/src/server/account/login.ts(kind·gen·상태 분기 없음).
//
// - L1 스키마(0002)와 하네스 role 4개를 기반으로, 실제 PG18 일회용 DB와 app role Pool로 제품 함수를 호출한다.
// - lifecycle.ts는 각 it 안에서 동적 import한다(없으면 명시적인 모듈 부재 RED). 계약 타입은 최소 로컬 타입이다.
// - 시험 데이터·탈퇴 상태 준비와 결과 확인만 owner 경로로 한다. 경합은 서로 다른 실제 연결과 pg_blocking_pids 관찰로 맞춘다.
// - 복구 증명(proof)은 F4b/c가 fresh OAuth의 pending 분기에서만 발급한다(PLAN §9 R6). 여기서는 그 결과 subject를 인자로 넘길 뿐
//   복구 쿠키·HTTP·화면을 구현하지 않는다.
// - 전역 시계·pg_catalog·제품 시간 플래그는 바꾸지 않는다. 시각 판정은 DB clock 전후 범위와 행 잠금 관찰로 안정화한다.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeClient, cleanupAll, openClient, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  UUID_RE,
  appBackend,
  endAllPools,
  freshMigratedDb,
  loadLogin,
  openAppPool,
  type CompleteSuccessfulLogin,
  type LoginIdentity,
} from "./f3-support";
import { expectNoSql } from "./f3-diary-support";
import {
  SEVEN_TWENTY_HOURS_S,
  dbNowMs,
  lifeState,
  loadLifecycle,
  openOwner,
  openPurge,
  seedUser,
  setPending,
  settle,
  totals,
  waitBlocked,
  waitDbPastPurgeAfter,
  type LifeState,
} from "./f4-lifecycle-support";

const CASE_TIMEOUT = 90_000;
const MISSING = "00000000-0000-4000-8000-00000000f4b2";
const BAD_GENS: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined];
const BAD_IDS: unknown[] = ["", "not-a-uuid", `${MISSING}x`, MISSING.replace(/-/g, ""), 1, null];

let env: HarnessEnv;
let shared: Promise<DisposableDatabase> | undefined;
let seq = 0;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  await endAllPools();
  if (env) await cleanupAll(env);
});

/** 파일 공용 일회용 DB(0001+0002 up). 사례마다 독립 사용자·identity를 쓴다. */
function sharedDb(): Promise<DisposableDatabase> {
  shared ??= freshMigratedDb(env, "f4life");
  return shared;
}

const ident = (provider: "google" | "kakao" = "google"): LoginIdentity => ({ provider, subject: `l2-${provider}-${++seq}-${Date.now()}` });

/** app Pool(max 1)과 그 실제 backend pid. */
async function appPool(db: DisposableDatabase): Promise<{ pool: pg.Pool; pid: number }> {
  const pool = openAppPool(db, 1);
  return { pool, pid: await appBackend(pool) };
}

const stateOf = async (db: DisposableDatabase, uid: string): Promise<LifeState> => {
  const s = await lifeState(env, db, uid);
  expect(s, `user ${uid} exists`).not.toBeNull();
  return s!;
};

async function loginValue(login: CompleteSuccessfulLogin, pool: pg.Pool, identity: LoginIdentity) {
  const r = await login(pool, identity);
  expect(r, `login ${JSON.stringify(identity)}`).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`unexpected ${r.error}`);
  return r.value;
}

// ================================================================ 입력 검사·int4 경계

describe("lifecycle: input checks before SQL and safe integers beyond int4", () => {
  it(
    "non-UUID ids or non-safe-positive gens: verify → false, withdraw/restore → not_found, with no connection or query and no data change",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        const before = await stateOf(db, uid);
        const cases: { userId: unknown; gen: unknown }[] = [
          ...BAD_IDS.map((userId) => ({ userId, gen: 1 })),
          ...BAD_GENS.map((gen) => ({ userId: uid, gen })),
        ];
        const got = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const s of cases) {
            const subject = s as { userId: string; gen: number };
            out.push([await api.verify(pool, subject), await api.withdraw(pool, subject), await api.restore(pool, subject)]);
          }
          return out;
        });
        cases.forEach((s, i) =>
          expect(got[i], JSON.stringify(s) ?? String(s.gen)).toEqual([
            false,
            { ok: false, error: "not_found" },
            { ok: false, error: "not_found" },
          ]),
        );
        expect(await stateOf(db, uid)).toEqual(before);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "safe integers beyond int4 (2^31, MAX_SAFE_INTEGER) are mismatches, not raw 22003: verify false, active → stale_session, pending restore → stale_proof",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const active = await seedUser(env, db, [ident()], { granted: true });
        const pending = await seedUser(env, db, [ident()], { granted: true });
        await setPending(env, db, pending, "clock_timestamp()", 2);
        const before = { active: await stateOf(db, active), pending: await stateOf(db, pending) };
        for (const gen of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
          expect(await api.verify(pool, { userId: active, gen }), `verify ${gen}`).toBe(false);
          expect(await api.withdraw(pool, { userId: active, gen }), `withdraw ${gen}`).toEqual({ ok: false, error: "stale_session" });
          expect(await api.restore(pool, { userId: pending, gen }), `restore ${gen}`).toEqual({ ok: false, error: "stale_proof" });
          // 이미 pending이면 탈퇴 요청은 gen을 비교하지 않고 변화 없이 changed:false(최종 계약 §9 표)
          const dup = await api.withdraw(pool, { userId: pending, gen });
          expect(dup, `withdraw on pending ${gen}`).toEqual({ ok: true, value: { purgeAfter: expect.any(Date), changed: false } });
        }
        expect(await stateOf(db, active)).toEqual(before.active);
        expect(await stateOf(db, pending)).toEqual(before.pending);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );
});

// ================================================================ verifyActiveAccount

describe("verifyActiveAccount (per-request DAL check)", () => {
  it(
    "true only for an active user with the current gen; old gen, pending and missing users are false; it does not change rows",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true, gen: 3 });
        const before = await stateOf(db, uid);
        expect(await api.verify(pool, { userId: uid, gen: 3 })).toBe(true);
        expect(await api.verify(pool, { userId: uid, gen: 2 })).toBe(false);
        expect(await api.verify(pool, { userId: uid, gen: 4 })).toBe(false);
        expect(await api.verify(pool, { userId: MISSING, gen: 1 })).toBe(false);
        expect(await stateOf(db, uid), "read-only").toEqual(before);
        await setPending(env, db, uid, "clock_timestamp()", 3);
        expect(await api.verify(pool, { userId: uid, gen: 3 }), "pending").toBe(false);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );
});

// ================================================================ requestWithdrawal

describe("requestWithdrawal", () => {
  it(
    "active + current gen: records pending, t, t + 720h and gen + 1 atomically; returns only {purgeAfter, changed:true}; grant state unchanged",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        const before = await stateOf(db, uid);
        const t0 = await dbNowMs(env, db);
        const r = await api.withdraw(pool, { userId: uid, gen: 1 });
        const t1 = await dbNowMs(env, db);
        expect(r).toMatchObject({ ok: true, value: { changed: true } });
        if (!r.ok) throw new Error(r.error);
        expect(Object.keys(r.value).sort(), "response has no gen").toEqual(["changed", "purgeAfter"]);
        expect(r.value.purgeAfter).toBeInstanceOf(Date);
        const after = await stateOf(db, uid);
        expect(after).toMatchObject({ status: "pending_deletion", gen: 2, lifetimeS: SEVEN_TWENTY_HOURS_S });
        expect(after.requestedMs!).toBeGreaterThanOrEqual(t0);
        expect(after.requestedMs!).toBeLessThanOrEqual(t1);
        expect(Math.abs(r.value.purgeAfter.getTime() - after.purgeMs!), "purgeAfter equals DB purge_after").toBeLessThanOrEqual(1);
        expect({ fla: after.firstLoginAt, balance: after.balance, ledger: after.ledger, identities: after.identities }).toEqual({
          fla: before.firstLoginAt,
          balance: before.balance,
          ledger: before.ledger,
          identities: before.identities,
        });
        expect(await api.verify(pool, { userId: uid, gen: 1 }), "old session is refused at once").toBe(false);
        expect(await api.verify(pool, { userId: uid, gen: 2 }), "pending is never active").toBe(false);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "already pending → changed:false with the existing deadline and no gen bump (any gen); active with another gen → stale_session; missing → not_found",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        const first = await api.withdraw(pool, { userId: uid, gen: 1 });
        if (!first.ok) throw new Error(first.error);
        const s1 = await stateOf(db, uid);
        for (const gen of [1, 2, 7]) {
          const dup = await api.withdraw(pool, { userId: uid, gen });
          expect(dup, `dup gen ${gen}`).toEqual({ ok: true, value: { purgeAfter: first.value.purgeAfter, changed: false } });
        }
        expect(await stateOf(db, uid), "deadline and gen unchanged").toEqual(s1);

        const other = await seedUser(env, db, [ident()], { granted: true, gen: 4 });
        const o0 = await stateOf(db, other);
        expect(await api.withdraw(pool, { userId: other, gen: 3 })).toEqual({ ok: false, error: "stale_session" });
        expect(await api.withdraw(pool, { userId: other, gen: 5 })).toEqual({ ok: false, error: "stale_session" });
        expect(await stateOf(db, other)).toEqual(o0);
        const t = await totals(env, db);
        expect(await api.withdraw(pool, { userId: MISSING, gen: 1 })).toEqual({ ok: false, error: "not_found" });
        expect(await totals(env, db)).toEqual(t);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );
});

// ================================================================ restoreAccount

describe("restoreAccount", () => {
  it(
    "missing → not_found, active → not_pending, pending before the deadline: wrong gen → stale_proof, right gen → active/NULL times/gen + 1 with no re-grant",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        expect(await api.restore(pool, { userId: MISSING, gen: 1 })).toEqual({ ok: false, error: "not_found" });
        const active = await seedUser(env, db, [ident()], { granted: true });
        const a0 = await stateOf(db, active);
        expect(await api.restore(pool, { userId: active, gen: 1 })).toEqual({ ok: false, error: "not_pending" });
        expect(await stateOf(db, active)).toEqual(a0);

        const uid = await seedUser(env, db, [ident()], { granted: true });
        const w = await api.withdraw(pool, { userId: uid, gen: 1 });
        expect(w).toMatchObject({ ok: true, value: { changed: true } });
        const pending = await stateOf(db, uid);
        expect(await api.restore(pool, { userId: uid, gen: 1 }), "proof from before withdrawal").toEqual({
          ok: false,
          error: "stale_proof",
        });
        expect(await stateOf(db, uid)).toEqual(pending);
        expect(await api.restore(pool, { userId: uid, gen: 2 })).toEqual({ ok: true, value: { gen: 3 } });
        const restored = await stateOf(db, uid);
        expect(restored).toEqual({
          ...pending,
          status: "active",
          gen: 3,
          requestedMs: null,
          purgeMs: null,
          lifetimeS: null,
        });
        expect(await api.verify(pool, { userId: uid, gen: 3 })).toBe(true);
        expect(await api.verify(pool, { userId: uid, gen: 2 })).toBe(false);

        // 지급 전 사용자(계정·원장 없음)도 복구가 지급을 만들지 않는다
        const never = await seedUser(env, db, [ident()], { granted: false });
        await setPending(env, db, never, "clock_timestamp()", 1);
        expect(await api.restore(pool, { userId: never, gen: 1 })).toEqual({ ok: true, value: { gen: 2 } });
        expect(await stateOf(db, never)).toMatchObject({ status: "active", gen: 2, balance: null, ledger: 0, firstLoginAt: null });
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "deadline: just before purge_after restores; at/after purge_after → expired even with a wrong gen (deadline is checked first)",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const soon = await seedUser(env, db, [ident()], { granted: true });
        // purge_after = 지금 + 30초(기한 직전)
        await setPending(env, db, soon, "clock_timestamp() - interval '720 hours' + interval '30 seconds'", 2);
        expect(await api.restore(pool, { userId: soon, gen: 2 })).toEqual({ ok: true, value: { gen: 3 } });

        const due = await seedUser(env, db, [ident()], { granted: true });
        await setPending(env, db, due, "clock_timestamp() - interval '720 hours' - interval '1 millisecond'", 2);
        const d0 = await stateOf(db, due);
        expect(await api.restore(pool, { userId: due, gen: 2 })).toEqual({ ok: false, error: "expired" });
        expect(await api.restore(pool, { userId: due, gen: 9 }), "expired before stale_proof").toEqual({ ok: false, error: "expired" });
        expect(await stateOf(db, due)).toEqual(d0);
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "restore → withdraw again → the old proof is refused (gen moved); only the latest pending gen restores",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        expect(await api.withdraw(pool, { userId: uid, gen: 1 })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await api.restore(pool, { userId: uid, gen: 2 })).toEqual({ ok: true, value: { gen: 3 } });
        expect(await api.withdraw(pool, { userId: uid, gen: 3 })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await api.restore(pool, { userId: uid, gen: 2 }), "old recovery proof").toEqual({ ok: false, error: "stale_proof" });
        expect(await stateOf(db, uid)).toMatchObject({ status: "pending_deletion", gen: 4 });
        expect(await api.restore(pool, { userId: uid, gen: 4 })).toEqual({ ok: true, value: { gen: 5 } });
        expect(await stateOf(db, uid)).toMatchObject({ status: "active", gen: 5, balance: 10, ledger: 1 });
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );
});

// ================================================================ completeSuccessfulLogin 상태 분기

describe("completeSuccessfulLogin: kind/gen and lifecycle branches", () => {
  it(
    "active users: new identity → kind active gen 1 granted; returning user keeps createdUser false; a user at gen 3 gets gen 3",
    async () => {
      const db = await sharedDb();
      const { pool } = await appPool(db);
      try {
        const login = await loadLogin();
        const fresh = ident("google");
        const first = await loginValue(login, pool, fresh);
        expect(first).toEqual({ kind: "active", userId: expect.stringMatching(UUID_RE), gen: 1, createdUser: true, granted: true, balance: 10 });
        const again = await loginValue(login, pool, fresh);
        expect(again).toEqual({ kind: "active", userId: (first as { userId: string }).userId, gen: 1, createdUser: false, granted: false, balance: 10 });
        const k = ident("kakao");
        const uid = await seedUser(env, db, [k], { granted: true, gen: 3 });
        expect(await loginValue(login, pool, k)).toEqual({ kind: "active", userId: uid, gen: 3, createdUser: false, granted: false, balance: 10 });
      } finally {
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  for (const provider of ["google", "kakao"] as const) {
    it(
      `${provider}: pending before the deadline → pending_deletion {userId, gen, purgeAfter} with no grant, no first_login_at change and no new rows`,
      async () => {
        const db = await sharedDb();
        const { pool } = await appPool(db);
        try {
          const login = await loadLogin();
          // 지급이 끝난 사용자와 아직 지급 전인 사용자 둘 다
          for (const granted of [true, false]) {
            const id = ident(provider);
            const uid = await seedUser(env, db, [id], { granted });
            await setPending(env, db, uid, "clock_timestamp()", 2);
            const before = await stateOf(db, uid);
            const t = await totals(env, db);
            const out = await loginValue(login, pool, id);
            expect(out, `granted=${granted}`).toEqual({ kind: "pending_deletion", userId: uid, gen: 2, purgeAfter: expect.any(Date) });
            expect(Math.abs((out as { purgeAfter: Date }).purgeAfter.getTime() - before.purgeMs!)).toBeLessThanOrEqual(1);
            expect(await stateOf(db, uid), "no grant, first_login_at unchanged").toEqual(before);
            expect(await totals(env, db)).toEqual(t);
          }
        } finally {
          await endAllPools();
        }
      },
      CASE_TIMEOUT,
    );

    it(
      `${provider}: pending past the deadline → purge_due, creating no user, identity, account or ledger row`,
      async () => {
        const db = await sharedDb();
        const { pool } = await appPool(db);
        try {
          const login = await loadLogin();
          const id = ident(provider);
          const uid = await seedUser(env, db, [id], { granted: true });
          await setPending(env, db, uid, "clock_timestamp() - interval '721 hours'", 2);
          const before = await stateOf(db, uid);
          const t = await totals(env, db);
          expect(await loginValue(login, pool, id)).toEqual({ kind: "purge_due" });
          expect(await stateOf(db, uid)).toEqual(before);
          expect(await totals(env, db)).toEqual(t);
        } finally {
          await endAllPools();
        }
      },
      CASE_TIMEOUT,
    );
  }
});

// ================================================================ 결정적 경합(서로 다른 실제 연결)

describe("concurrency over distinct real connections", () => {
  // 하네스 양성 대조(PR34 독립 검토 P1): lifecycle 제품 없이 순수 SQL만 쓴다.
  // 같은 users 행에 대기자가 둘이면 두 번째의 직접 blocker는 owner가 아니라 첫 대기자일 수 있다(tuple lock).
  // waitBlocked(B, owner)는 직접 blocker가 아니라 owner로 이어지는 잠금 사슬을 관찰해야 한다.
  it(
    "harness control: with two app waiters queued behind an owner lock on one users row, waitBlocked(second, owner) observes the lock chain",
    async () => {
      const db = await sharedDb();
      const uid = await seedUser(env, db, [ident()], { granted: true });
      const owner = await openOwner(env, db);
      const openApp = async () => {
        const client = await openClient(db.urls.app, env.adminUrl);
        const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return { client, pid: Number(r.rows[0]!.pid) };
      };
      const a = await openApp();
      const b = await openApp();
      expect(new Set([owner.pid, a.pid, b.pid]).size, "three distinct backends").toBe(3);
      let aP: Promise<unknown> | undefined;
      let bP: Promise<unknown> | undefined;
      try {
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]);
        await a.client.query("BEGIN");
        aP = settle(a.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]));
        await waitBlocked(env, db, a.pid, owner.pid); // 첫 대기자: owner가 직접 blocker
        await b.client.query("BEGIN");
        bP = settle(b.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]));
        await waitBlocked(env, db, b.pid); // 두 번째 대기자도 막혀 있다
        await waitBlocked(env, db, b.pid, owner.pid); // owner로 이어지는 사슬을 관찰해야 한다
      } finally {
        // owner → A → B 순서로 잠금을 풀어 대기 중인 쿼리를 끝내고 연결을 닫는다(hang 방지)
        await owner.client.query("ROLLBACK").catch(() => undefined);
        if (aP) await aP;
        await a.client.query("ROLLBACK").catch(() => undefined);
        if (bP) await bP;
        await b.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await closeClient(a.client);
        await closeClient(b.client);
      }
    },
    CASE_TIMEOUT,
  );

  async function twoPools(db: DisposableDatabase) {
    const a = await appPool(db);
    const b = await appPool(db);
    expect(a.pid, "distinct backends").not.toBe(b.pid);
    return [a, b] as const;
  }

  it(
    "login vs withdrawal under a held users lock: either order is allowed, and the end state is pending with gen 2, one grant and the old gen refused",
    async () => {
      const db = await sharedDb();
      const [a, b] = await twoPools(db);
      const owner = await openOwner(env, db);
      try {
        const api = await loadLifecycle();
        const login = await loadLogin();
        const id = ident("google");
        const uid = await seedUser(env, db, [id], { granted: true });
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]);
        const loginP = settle(login(a.pool, id));
        const withdrawP = settle(api.withdraw(b.pool, { userId: uid, gen: 1 }));
        await waitBlocked(env, db, a.pid, owner.pid);
        await waitBlocked(env, db, b.pid, owner.pid);
        await owner.client.query("COMMIT");
        const [l, w] = await Promise.all([loginP, withdrawP]);
        expect(l.error, "login raised").toBeUndefined();
        expect(w.error, "withdraw raised").toBeUndefined();
        expect(w.value).toMatchObject({ ok: true, value: { changed: true } });
        const lv = (l.value as { ok: true; value: unknown }).value;
        const loginFirst = { kind: "active", userId: uid, gen: 1, createdUser: false, granted: false, balance: 10 };
        const withdrawFirst = { kind: "pending_deletion", userId: uid, gen: 2, purgeAfter: expect.any(Date) };
        expect([loginFirst, withdrawFirst]).toContainEqual(lv);
        expect(await stateOf(db, uid)).toMatchObject({ status: "pending_deletion", gen: 2, balance: 10, ledger: 1 });
        expect(await api.verify(a.pool, { userId: uid, gen: 1 }), "a session issued with the old gen is refused next request").toBe(false);
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "two concurrent withdrawals: exactly one changed:true, the same deadline for both, gen bumped once",
    async () => {
      const db = await sharedDb();
      const [a, b] = await twoPools(db);
      const owner = await openOwner(env, db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]);
        const p1 = settle(api.withdraw(a.pool, { userId: uid, gen: 1 }));
        const p2 = settle(api.withdraw(b.pool, { userId: uid, gen: 1 }));
        await waitBlocked(env, db, a.pid, owner.pid);
        await waitBlocked(env, db, b.pid, owner.pid);
        await owner.client.query("COMMIT");
        const rs = (await Promise.all([p1, p2])).map((x) => {
          expect(x.error).toBeUndefined();
          return x.value as { ok: true; value: { purgeAfter: Date; changed: boolean } };
        });
        expect(rs.every((r) => r.ok)).toBe(true);
        expect(rs.filter((r) => r.value.changed)).toHaveLength(1);
        expect(rs[0]!.value.purgeAfter.getTime()).toBe(rs[1]!.value.purgeAfter.getTime());
        expect(await stateOf(db, uid)).toMatchObject({ status: "pending_deletion", gen: 2, lifetimeS: SEVEN_TWENTY_HOURS_S });
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "restore vs purge: before the deadline only restore takes effect, after it only purge does; never a partial delete; two purges → purged then absent",
    async () => {
      const db = await sharedDb();
      const { pool, pid } = await appPool(db);
      const owner = await openOwner(env, db);
      const purgeA = await openPurge(env, db);
      const purgeB = await openPurge(env, db);
      try {
        const api = await loadLifecycle();
        const purgeCall = (c: pg.Client, uid: string) =>
          c.query<{ r: string }>("SELECT pod.purge_user_if_due($1::uuid) AS r", [uid]).then((x) => x.rows[0]?.r);

        // 기한 전: 복구만 효과, purge는 not_due
        const before = await seedUser(env, db, [ident()], { granted: true });
        await setPending(env, db, before, "clock_timestamp()", 2);
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [before]);
        const r1 = settle(api.restore(pool, { userId: before, gen: 2 }));
        const p1 = settle(purgeCall(purgeA.client, before));
        await waitBlocked(env, db, pid, owner.pid);
        await waitBlocked(env, db, purgeA.pid, owner.pid);
        await owner.client.query("COMMIT");
        expect((await r1).value).toEqual({ ok: true, value: { gen: 3 } });
        expect((await p1).value).toBe("not_due");
        expect(await stateOf(db, before)).toMatchObject({ status: "active", gen: 3, balance: 10, ledger: 1, identities: 1 });

        // 기한 뒤: purge만 효과, 복구는 expired(또는 이미 지워져 not_found)
        const after = await seedUser(env, db, [ident()], { granted: true });
        await setPending(env, db, after, "clock_timestamp() - interval '721 hours'", 2);
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [after]);
        const r2 = settle(api.restore(pool, { userId: after, gen: 2 }));
        const p2 = settle(purgeCall(purgeA.client, after));
        await waitBlocked(env, db, pid, owner.pid);
        await waitBlocked(env, db, purgeA.pid, owner.pid);
        await owner.client.query("COMMIT");
        expect([{ ok: false, error: "expired" }, { ok: false, error: "not_found" }]).toContainEqual((await r2).value);
        expect((await p2).value).toBe("purged");
        expect(await lifeState(env, db, after), "fully deleted, no partial rows").toBeNull();

        // purge 2건 동시: 최초 purged, 나중 absent
        const twice = await seedUser(env, db, [ident()], { granted: true });
        await setPending(env, db, twice, "clock_timestamp() - interval '721 hours'", 2);
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [twice]);
        const q1 = settle(purgeCall(purgeA.client, twice));
        const q2 = settle(purgeCall(purgeB.client, twice));
        await waitBlocked(env, db, purgeA.pid, owner.pid);
        await waitBlocked(env, db, purgeB.pid, owner.pid);
        await owner.client.query("COMMIT");
        expect([(await q1).value, (await q2).value].sort()).toEqual(["absent", "purged"]);
        expect(await lifeState(env, db, twice)).toBeNull();
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await purgeA.close();
        await purgeB.close();
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "lock-wait boundary: a restore started before the deadline that gets the users lock after it is refused as expired (t read after the lock)",
    async () => {
      const db = await sharedDb();
      const { pool, pid } = await appPool(db);
      const owner = await openOwner(env, db);
      try {
        const api = await loadLifecycle();
        const uid = await seedUser(env, db, [ident()], { granted: true });
        // purge_after = 지금 + 2초
        await setPending(env, db, uid, "clock_timestamp() - interval '720 hours' + interval '2 seconds'", 2);
        const p0 = await stateOf(db, uid);
        await owner.client.query("BEGIN");
        await owner.client.query("SELECT 1 FROM pod.users WHERE id = $1 FOR UPDATE", [uid]);
        const restoreP = settle(api.restore(pool, { userId: uid, gen: 2 }));
        await waitBlocked(env, db, pid, owner.pid);
        expect(await dbNowMs(env, db), "the restore is already waiting before the deadline").toBeLessThan(p0.purgeMs!);
        await waitDbPastPurgeAfter(env, db, uid);
        await owner.client.query("COMMIT");
        const r = await restoreP;
        expect(r.error).toBeUndefined();
        expect(r.value).toEqual({ ok: false, error: "expired" });
        expect(await stateOf(db, uid)).toEqual(p0);
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "login vs purge: owner purges (uncommitted) → login sees the old identity and waits on users → owner commits → purge_due with no new rows, no raw 23503, no retry; the next login creates a new canonical user with 10",
    async () => {
      const db = await sharedDb();
      const { pool, pid } = await appPool(db);
      const owner = await openOwner(env, db);
      try {
        const login = await loadLogin();
        const id = ident("kakao");
        const uid = await seedUser(env, db, [id], { granted: true });
        await setPending(env, db, uid, "clock_timestamp() - interval '721 hours'", 2);
        await owner.client.query("BEGIN");
        const purged = await owner.client.query<{ r: string }>("SELECT pod.purge_user_if_due($1::uuid) AS r", [uid]);
        expect(purged.rows[0]?.r).toBe("purged");
        const loginP = settle(login(pool, id));
        await waitBlocked(env, db, pid, owner.pid);
        await owner.client.query("COMMIT");
        const t = await totals(env, db); // purge 커밋 직후
        const r = await loginP;
        expect(r.error, "no raw error (e.g. 23503) escapes").toBeUndefined();
        expect(r.value).toEqual({ ok: true, value: { kind: "purge_due" } });
        expect(await totals(env, db), "this request created no user/identity/account/ledger").toEqual(t);
        expect(await lifeState(env, db, uid)).toBeNull();

        const next = await loginValue(login, pool, id);
        expect(next).toEqual({ kind: "active", userId: expect.stringMatching(UUID_RE), gen: 1, createdUser: true, granted: true, balance: 10 });
        expect((next as { userId: string }).userId).not.toBe(uid);
      } finally {
        await owner.client.query("ROLLBACK").catch(() => undefined);
        await owner.close();
        await endAllPools();
      }
    },
    CASE_TIMEOUT,
  );
});
