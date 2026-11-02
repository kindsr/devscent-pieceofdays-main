// F2 제약 시험(DATA_CONTRACT §4, PLAN_mvp-database §5.3). app role(pod_ci_app)로 실행하고,
// 사용자·디자인 삭제처럼 app 권한 밖의 경로만 owner(migrator → SET ROLE pod_ci_owner)로 실행한다.
// 오류는 SQLSTATE로 비교한다. F3 범위(병렬 첫 지급·잔액 합계·소유자 조건 조회)는 여기서 다루지 않는다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupAll, createDisposableDatabase, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  VALID_MANIFEST,
  expectSqlError,
  firstLoginGrantKey,
  insertAccountWithGrant,
  insertDesignVersion,
  insertMoment,
  insertUser,
  lazyMigrated,
  withApp,
  withOwner,
} from "./f2-support";

let env: HarnessEnv;
let db: DisposableDatabase | undefined;

beforeAll(async () => {
  env = readDisposableEnv();
  db = await createDisposableDatabase(env, "cons");
});

afterAll(async () => {
  if (env) await cleanupAll(env);
});

const migrated = lazyMigrated(() => {
  if (!db) throw new Error("beforeAll did not create the disposable database");
  return db;
});

const LEDGER_INSERT =
  "INSERT INTO pod.emotion_ledger (user_id, delta, reason, grant_key, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6)";

describe("CHECK constraints (23514)", () => {
  it("credit_accounts.balance must be >= 0 (0 allowed, -1 rejected on insert and update)", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await expectSqlError(c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, -1)", [a]), "23514");
      await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 0)", [a]);
      await expectSqlError(c.query("UPDATE pod.credit_accounts SET balance = -1 WHERE user_id = $1", [a]), "23514");
    });
  });

  it("preferences.font_key accepts only gothic/serif/hand and defaults to gothic", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await c.query("INSERT INTO pod.preferences (user_id) VALUES ($1)", [a]);
      const def = await c.query("SELECT font_key FROM pod.preferences WHERE user_id = $1", [a]);
      expect(def.rows).toEqual([{ font_key: "gothic" }]);
      for (const k of ["serif", "hand", "gothic"]) {
        await c.query("UPDATE pod.preferences SET font_key = $2 WHERE user_id = $1", [a, k]);
      }
      for (const bad of ["comic", "Gothic", ""]) {
        await expectSqlError(c.query("UPDATE pod.preferences SET font_key = $2 WHERE user_id = $1", [a, bad]), "23514");
      }
      const b = await insertUser(c);
      await expectSqlError(c.query("INSERT INTO pod.preferences (user_id, font_key) VALUES ($1, 'comic')", [b]), "23514");
    });
  });

  for (const table of ["diary_moments", "day_summaries"] as const) {
    it(`${table}.body accepts 1 and 300 Korean characters and rejects empty, 301 characters and blank`, async () => {
      const d = await migrated();
      await withApp(env, d, async (c) => {
        const a = await insertUser(c);
        const insert = (body: string, day: number) =>
          table === "diary_moments"
            ? c.query(
                `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body)
                 VALUES ($1, DATE '2026-11-01' + $3::int, TIMESTAMPTZ '2026-11-01 09:00:00+09', $2)`,
                [a, body, day],
              )
            : c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, DATE '2026-11-01' + $3::int, $2)", [
                a,
                body,
                day,
              ]);
        await insert("가", 1);
        await insert("가".repeat(300), 2);
        await expectSqlError(insert("", 3), "23514");
        await expectSqlError(insert("가".repeat(301), 4), "23514");
        await expectSqlError(insert("   ", 5), "23514");
        const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pod.${table} WHERE user_id = $1`, [a]);
        expect(n.rows[0]?.n).toBe(2);
      });
    });
  }

  it("diary_moments.time_zone is Asia/Seoul only and version must be >= 1", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await expectSqlError(
        c.query(
          `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, time_zone, body)
           VALUES ($1, DATE '2026-11-02', now(), 'UTC', '조각')`,
          [a],
        ),
        "23514",
      );
      const mid = await insertMoment(c, a);
      await expectSqlError(c.query("UPDATE pod.diary_moments SET version = 0 WHERE id = $1", [mid]), "23514");
    });
  });

  it("first_login_grant requires delta=10, grant_key 'first_login:<user_id>' and null refs", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 0)", [a]);
      const key = firstLoginGrantKey(a);
      await expectSqlError(c.query(LEDGER_INSERT, [a, 5, "first_login_grant", key, null, null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", firstLoginGrantKey(b), null, null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", `first_login:${a.toUpperCase()}`, null, null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", "first-login", null, null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", key, "design", null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", key, null, b]), "23514");
      const none = await c.query("SELECT 1 FROM pod.emotion_ledger WHERE user_id = $1", [a]);
      expect(none.rowCount).toBe(0);
      await c.query(LEDGER_INSERT, [a, 10, "first_login_grant", key, null, null]);
    });
  });

  it("emotion_ledger rejects reasons outside the set (purchase) and delta = 0", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await c.query("INSERT INTO pod.credit_accounts (user_id, balance) VALUES ($1, 10)", [a]);
      await expectSqlError(c.query(LEDGER_INSERT, [a, -1, "purchase", `purchase:${a}`, null, null]), "23514");
      await expectSqlError(c.query(LEDGER_INSERT, [a, 0, "first_login_grant", firstLoginGrantKey(a), null, null]), "23514");
    });
  });

  it("auth_identities.provider must match ^[a-z][a-z0-9_-]{0,31}$ and subject must be 1..255 chars", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const ins = (provider: string, subject: string) =>
        c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, $2, $3)", [a, provider, subject]);
      await ins("g", "s1");
      await ins(`k${"a".repeat(31)}`, "s2");
      await ins("kakao-1_x", "s3");
      for (const bad of ["Google", "", "1abc", "-abc", `k${"a".repeat(32)}`, "goo gle"]) {
        await expectSqlError(ins(bad, `bad-${bad.length}`), "23514");
      }
      await expectSqlError(ins("testprov", ""), "23514");
      await expectSqlError(ins("testprov", "x".repeat(256)), "23514");
      await ins("testprov", "x".repeat(255));
    });
  });

  it("design_versions.manifest must be an object with schema and base; visibility is private only", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const ins = (manifest: string, visibility = "private") =>
        c.query("INSERT INTO pod.design_versions (owner_id, manifest, visibility) VALUES ($1, $2::jsonb, $3)", [a, manifest, visibility]);
      await ins(VALID_MANIFEST);
      await expectSqlError(ins("[]"), "23514");
      await expectSqlError(ins(JSON.stringify({ schema: 1 })), "23514");
      await expectSqlError(ins(JSON.stringify({ base: "d" })), "23514");
      await expectSqlError(ins(VALID_MANIFEST, "public"), "23514");
    });
  });
});

describe("UNIQUE constraints (23505)", () => {
  it("a second first_login_grant for the same user (same grant_key) is rejected; balance stays 10", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await insertAccountWithGrant(c, a);
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", firstLoginGrantKey(a), null, null]), "23505");
      const rows = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.emotion_ledger WHERE user_id = $1", [a]);
      expect(rows.rows[0]?.n).toBe(1);
      const bal = await c.query("SELECT balance FROM pod.credit_accounts WHERE user_id = $1", [a]);
      expect(bal.rows).toEqual([{ balance: 10 }]);
    });
  });

  it("each user can receive exactly one first_login_grant of their own", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await insertAccountWithGrant(c, a);
      await insertAccountWithGrant(c, b);
      const n = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pod.emotion_ledger WHERE user_id = ANY($1::uuid[])",
        [[a, b]],
      );
      expect(n.rows[0]?.n).toBe(2);
    });
  });

  it("day_summaries allows one row per (user, local_date)", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const ins = (u: string, date: string) =>
        c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, $2::date, '한 줄')", [u, date]);
      await ins(a, "2026-11-02");
      await expectSqlError(ins(a, "2026-11-02"), "23505");
      await ins(a, "2026-11-03");
      await ins(b, "2026-11-02");
    });
  });

  it("auth_identities (provider, subject) is unique across users", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const ins = (u: string, provider: string) =>
        c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, $2, 'same-subject')", [u, provider]);
      await ins(a, "testprov");
      await expectSqlError(ins(b, "testprov"), "23505");
      await ins(b, "otherprov");
    });
  });
});

describe("FOREIGN KEY constraints (23503) and delete actions", () => {
  it("ledger rows require an existing credit account; rows for unknown users are rejected", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      await expectSqlError(c.query(LEDGER_INSERT, [a, 10, "first_login_grant", firstLoginGrantKey(a), null, null]), "23503");
      const ghost = "00000000-0000-7000-8000-000000000000";
      await expectSqlError(insertMoment(c, ghost), "23503");
      await expectSqlError(c.query("INSERT INTO pod.credit_accounts (user_id) VALUES ($1)", [ghost]), "23503");
    });
  });

  it("preferences can apply only the user's own design version", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const va = await insertDesignVersion(c, a);
      const vb = await insertDesignVersion(c, b);
      await expectSqlError(
        c.query("INSERT INTO pod.preferences (user_id, applied_design_version_id) VALUES ($1, $2)", [a, vb]),
        "23503",
      );
      await c.query("INSERT INTO pod.preferences (user_id, applied_design_version_id) VALUES ($1, $2)", [a, va]);
      await expectSqlError(
        c.query("UPDATE pod.preferences SET applied_design_version_id = $2 WHERE user_id = $1", [a, vb]),
        "23503",
      );
      const p = await c.query("SELECT applied_design_version_id FROM pod.preferences WHERE user_id = $1", [a]);
      expect(p.rows).toEqual([{ applied_design_version_id: va }]);
    });
  });

  it("owner cannot delete a user or account that has ledger rows (RESTRICT); nothing is cascaded", async () => {
    const d = await migrated();
    const uid = await withApp(env, d, async (c) => {
      const id = await insertUser(c);
      await insertMoment(c, id);
      await insertAccountWithGrant(c, id);
      return id;
    });
    await withOwner(env, d, async (c) => {
      await expectSqlError(c.query("DELETE FROM pod.users WHERE id = $1", [uid]), "23503");
      await expectSqlError(c.query("DELETE FROM pod.credit_accounts WHERE user_id = $1", [uid]), "23503");
      const counts = await c.query(
        `SELECT (SELECT count(*)::int FROM pod.users WHERE id = $1) AS users,
                (SELECT count(*)::int FROM pod.diary_moments WHERE user_id = $1) AS moments,
                (SELECT count(*)::int FROM pod.credit_accounts WHERE user_id = $1) AS accounts,
                (SELECT count(*)::int FROM pod.emotion_ledger WHERE user_id = $1) AS ledger`,
        [uid],
      );
      expect(counts.rows).toEqual([{ users: 1, moments: 1, accounts: 1, ledger: 1 }]);
    });
  });

  it("owner deleting an applied design version sets only applied_design_version_id to NULL and keeps user_id", async () => {
    const d = await migrated();
    const { uid, vid } = await withApp(env, d, async (c) => {
      const u = await insertUser(c);
      const v = await insertDesignVersion(c, u);
      await c.query("INSERT INTO pod.preferences (user_id, font_key, applied_design_version_id) VALUES ($1, 'serif', $2)", [u, v]);
      return { uid: u, vid: v };
    });
    await withOwner(env, d, async (c) => {
      const del = await c.query("DELETE FROM pod.design_versions WHERE id = $1", [vid]);
      expect(del.rowCount).toBe(1);
    });
    await withApp(env, d, async (c) => {
      const p = await c.query("SELECT user_id, font_key, applied_design_version_id FROM pod.preferences WHERE user_id = $1", [uid]);
      expect(p.rows).toEqual([{ user_id: uid, font_key: "serif", applied_design_version_id: null }]);
    });
  });
});
