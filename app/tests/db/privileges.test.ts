// F2 권한 시험(DATA_CONTRACT §5, PLAN_mvp-database §5.2·§5.3). 실제 SQL을 app role로 실행해 판정한다.
// introspection이나 슈퍼유저 성공으로 대체하지 않는다. owner 경로는 migrator → SET ROLE pod_ci_owner다.
// 거부 단언은 autocommit 연결에서 문장 단위로 실행하므로 앞 오류가 다음 단언을 중단시키지 않는다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupAll, createDisposableDatabase, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import {
  APPEND_ONLY_MESSAGE,
  expectSqlError,
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
  db = await createDisposableDatabase(env, "priv");
});

afterAll(async () => {
  if (env) await cleanupAll(env);
});

// up은 각 시험 안에서 단언한다(CLI 누락이 beforeAll 실패로 모든 시험을 건너뛰게 하지 않는다).
const migrated = lazyMigrated(() => {
  if (!db) throw new Error("beforeAll did not create the disposable database");
  return db;
});

describe("app role: statements outside its grants fail with 42501", () => {
  it("cannot UPDATE, DELETE or TRUNCATE emotion_ledger", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      await insertAccountWithGrant(c, uid);
      await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = 20 WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "42501");
      await expectSqlError(c.query("TRUNCATE pod.emotion_ledger"), "42501");
      const left = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.emotion_ledger WHERE user_id = $1", [uid]);
      expect(left.rows[0]?.n).toBe(1);
    });
  });

  it("cannot DELETE users", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      await expectSqlError(c.query("DELETE FROM pod.users WHERE id = $1", [uid]), "42501");
      const left = await c.query("SELECT 1 FROM pod.users WHERE id = $1", [uid]);
      expect(left.rowCount).toBe(1);
    });
  });

  it("cannot UPDATE users columns other than first_login_at", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      await expectSqlError(c.query("UPDATE pod.users SET created_at = now() WHERE id = $1", [uid]), "42501");
    });
  });

  it("cannot UPDATE or DELETE design_versions (versions are immutable)", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      const vid = await insertDesignVersion(c, uid);
      await expectSqlError(c.query("UPDATE pod.design_versions SET visibility = 'private' WHERE id = $1", [vid]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.design_versions WHERE id = $1", [vid]), "42501");
    });
  });

  it("cannot UPDATE credit_accounts.user_id or DELETE credit_accounts", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await insertAccountWithGrant(c, a);
      await expectSqlError(c.query("UPDATE pod.credit_accounts SET user_id = $2 WHERE user_id = $1", [a, b]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.credit_accounts WHERE user_id = $1", [a]), "42501");
    });
  });

  it("cannot UPDATE preferences.user_id, nor UPDATE/DELETE auth_identities", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await c.query("INSERT INTO pod.preferences (user_id) VALUES ($1)", [a]);
      await expectSqlError(c.query("UPDATE pod.preferences SET user_id = $2 WHERE user_id = $1", [a, b]), "42501");
      await c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, 'testprov', $2)", [a, `sub-${a}`]);
      await expectSqlError(c.query("UPDATE pod.auth_identities SET subject = 'x' WHERE user_id = $1", [a]), "42501");
      await expectSqlError(c.query("DELETE FROM pod.auth_identities WHERE user_id = $1", [a]), "42501");
    });
  });

  it("cannot read pod_meta.schema_migrations or pod_meta.db_environment", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      await expectSqlError(c.query("SELECT * FROM pod_meta.schema_migrations"), "42501");
      await expectSqlError(c.query("SELECT * FROM pod_meta.db_environment"), "42501");
    });
  });

  it("cannot create objects in pod or public", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      await expectSqlError(c.query("CREATE TABLE pod.x (id int)"), "42501");
      await expectSqlError(c.query("CREATE TABLE public.x (id int)"), "42501");
      await expectSqlError(
        c.query("CREATE FUNCTION pod.x() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END $fn$"),
        "42501",
      );
    });
  });
});

describe("app role: granted paths succeed", () => {
  it("inserts and reads users, accounts and the first-login ledger row; updates first_login_at and balance", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      await insertAccountWithGrant(c, uid);
      await c.query("UPDATE pod.users SET first_login_at = now() WHERE id = $1", [uid]);
      await c.query("UPDATE pod.credit_accounts SET balance = balance, updated_at = now() WHERE user_id = $1", [uid]);
      const acct = await c.query<{ balance: number }>("SELECT balance FROM pod.credit_accounts WHERE user_id = $1", [uid]);
      expect(acct.rows).toEqual([{ balance: 10 }]);
      const ledger = await c.query<{ delta: number; reason: string; grant_key: string }>(
        "SELECT delta, reason, grant_key FROM pod.emotion_ledger WHERE user_id = $1",
        [uid],
      );
      expect(ledger.rows).toEqual([{ delta: 10, reason: "first_login_grant", grant_key: `first_login:${uid}` }]);
      const user = await c.query<{ set: boolean }>("SELECT first_login_at IS NOT NULL AS set FROM pod.users WHERE id = $1", [uid]);
      expect(user.rows).toEqual([{ set: true }]);
    });
  });

  it("inserts, updates (optimistic lock) and deletes diary_moments and day_summaries", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      const mid = await insertMoment(c, uid, "처음 조각");
      const upd = await c.query<{ version: number }>(
        `UPDATE pod.diary_moments SET body = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND version = 1 RETURNING version`,
        [mid, uid, "고친 조각"],
      );
      expect(upd.rows).toEqual([{ version: 2 }]);
      const del = await c.query("DELETE FROM pod.diary_moments WHERE id = $1 AND user_id = $2 AND version = 2", [mid, uid]);
      expect(del.rowCount).toBe(1);

      await c.query("INSERT INTO pod.day_summaries (user_id, local_date, body) VALUES ($1, DATE '2026-11-02', '하루 한 줄')", [uid]);
      const s = await c.query(
        "UPDATE pod.day_summaries SET body = '바뀐 한 줄', version = version + 1 WHERE user_id = $1 AND local_date = DATE '2026-11-02'",
        [uid],
      );
      expect(s.rowCount).toBe(1);
      const sd = await c.query("DELETE FROM pod.day_summaries WHERE user_id = $1", [uid]);
      expect(sd.rowCount).toBe(1);
    });
  });

  it("inserts preferences and updates the allowed columns; inserts and reads design_versions and auth_identities", async () => {
    const d = await migrated();
    await withApp(env, d, async (c) => {
      const uid = await insertUser(c);
      const vid = await insertDesignVersion(c, uid);
      await c.query("INSERT INTO pod.preferences (user_id) VALUES ($1)", [uid]);
      await c.query(
        "UPDATE pod.preferences SET font_key = 'serif', applied_design_version_id = $2, updated_at = now() WHERE user_id = $1",
        [uid, vid],
      );
      const p = await c.query("SELECT font_key, applied_design_version_id FROM pod.preferences WHERE user_id = $1", [uid]);
      expect(p.rows).toEqual([{ font_key: "serif", applied_design_version_id: vid }]);
      const v = await c.query("SELECT owner_id FROM pod.design_versions WHERE id = $1", [vid]);
      expect(v.rows).toEqual([{ owner_id: uid }]);
      await c.query("INSERT INTO pod.auth_identities (user_id, provider, subject) VALUES ($1, 'testprov', $2)", [uid, `s-${uid}`]);
      const ai = await c.query("SELECT provider FROM pod.auth_identities WHERE user_id = $1", [uid]);
      expect(ai.rows).toEqual([{ provider: "testprov" }]);
    });
  });
});

describe("owner role: emotion_ledger is append-only (P0001)", () => {
  it("UPDATE, DELETE and TRUNCATE by the owner raise P0001 'emotion_ledger is append-only' and the row stays", async () => {
    const d = await migrated();
    const uid = await withApp(env, d, async (c) => {
      const id = await insertUser(c);
      await insertAccountWithGrant(c, id);
      return id;
    });
    await withOwner(env, d, async (c) => {
      await expectSqlError(c.query("UPDATE pod.emotion_ledger SET delta = 20 WHERE user_id = $1", [uid]), "P0001", APPEND_ONLY_MESSAGE);
      await expectSqlError(c.query("DELETE FROM pod.emotion_ledger WHERE user_id = $1", [uid]), "P0001", APPEND_ONLY_MESSAGE);
      await expectSqlError(c.query("TRUNCATE pod.emotion_ledger"), "P0001", APPEND_ONLY_MESSAGE);
      const left = await c.query("SELECT delta FROM pod.emotion_ledger WHERE user_id = $1", [uid]);
      expect(left.rows).toEqual([{ delta: 10 }]);
    });
  });
});
