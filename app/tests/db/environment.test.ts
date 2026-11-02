// F2 bootstrap smoke: 시험 환경과 하네스만 확인한다. 제품 스키마·migration 시험이 아니다.
// 아직 제품 migration이 없으므로 pod 스키마·schema_migrations가 없는 것이 정상이다.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CI_ROLES,
  ROLE_SPECS,
  cleanupAll,
  closeClient,
  createDisposableDatabase,
  dropDisposableDatabase,
  expectSqlState,
  openClient,
  readDisposableEnv,
  readRole,
  roleProblems,
  trackedDatabases,
  withAdmin,
  type DisposableDatabase,
  type HarnessEnv,
  type RoleRow,
} from "./helpers";

let env: HarnessEnv;
let db: DisposableDatabase | undefined;

beforeAll(async () => {
  env = readDisposableEnv();
  db = await createDisposableDatabase(env, "env");
});

afterAll(async () => {
  // beforeAll이 db 할당 전에 실패해도 정리는 실행된다(createDisposableDatabase도 자체 정리한다).
  if (!env) return;
  await cleanupAll(env);
  // 정리 뒤 이번 실행이 만든 DB가 서버에 남지 않아야 한다.
  const left = await withAdmin(env, (a) =>
    a.query("SELECT datname FROM pg_database WHERE datname LIKE 'pod\\_ci\\_env\\_%'"),
  );
  expect(left.rowCount).toBe(0);
  expect(trackedDatabases()).toEqual([]);
});

function current(): DisposableDatabase {
  if (!db) throw new Error("beforeAll did not create the disposable database");
  return db;
}

async function asRole<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await openClient(url, env.adminUrl);
  try {
    return await fn(c);
  } finally {
    await closeClient(c);
  }
}

describe("F2 DB 시험 환경 bootstrap", () => {
  it("서버는 PostgreSQL 18.x 이다", async () => {
    const v = await withAdmin(
      env,
      async (a) => (await a.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]?.v,
    );
    expect(Number(v)).toBeGreaterThanOrEqual(180000);
    expect(Number(v)).toBeLessThan(190000);
  });

  it("role 속성이 계약과 같다(owner NOLOGIN, migrator는 owner 구성원, app 비특권)", async () => {
    await withAdmin(env, async (a) => {
      for (const key of ["owner", "migrator", "app"] as const) {
        const row = await readRole(a, CI_ROLES[key]);
        expect(row, CI_ROLES[key]).not.toBeNull();
        expect(roleProblems(row as RoleRow, ROLE_SPECS[key])).toEqual([]);
      }
    });
  });

  it("app role은 실제로 비특권이다", async () => {
    await asRole(current().urls.app, async (c) => {
      const me = await c.query<RoleRow & { cu: string }>(
        `SELECT current_user AS cu, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(me.rows[0]).toMatchObject({
        cu: CI_ROLES.app,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolreplication: false,
      });
      await expectSqlState(c.query("SELECT * FROM pod_meta.db_environment"), "42501");
      await expectSqlState(c.query("CREATE SCHEMA pod_probe"), "42501");
      await expectSqlState(c.query("CREATE ROLE pod_probe_role"), "42501");
      await expectSqlState(c.query("CREATE DATABASE pod_probe_db"), "42501");
      await expectSqlState(c.query(`SET ROLE ${CI_ROLES.owner}`), "42501");
    });
  });

  it("생성 DB·pod_meta·db_environment의 owner는 pod_ci_owner이고 제품 객체는 없다", async () => {
    await asRole(current().urls.migrator, async (c) => {
      await c.query(`SET ROLE ${CI_ROLES.owner}`);
      const owners = await c.query<{ db: string; schema: string; tbl: string }>(
        `SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS db,
                (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'pod_meta') AS schema,
                (SELECT tableowner FROM pg_tables WHERE schemaname = 'pod_meta' AND tablename = 'db_environment') AS tbl`,
      );
      expect(owners.rows[0]).toEqual({ db: CI_ROLES.owner, schema: CI_ROLES.owner, tbl: CI_ROLES.owner });
      const envRow = await c.query("SELECT name, app_role, owner_role FROM pod_meta.db_environment");
      expect(envRow.rows).toEqual([{ name: "ci", app_role: CI_ROLES.app, owner_role: CI_ROLES.owner }]);
      const product = await c.query(
        `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = 'pod') AS pod_schema,
                (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'pod_meta' AND tablename <> 'db_environment') AS other_meta,
                (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_tables`,
      );
      expect(product.rows[0]).toEqual({ pod_schema: 0, other_meta: 0, public_tables: 0 });
    });
  });

  it("이번 실행이 만든 DB만 삭제하고, 삭제 뒤 서버에 남지 않는다", async () => {
    const tmp = await createDisposableDatabase(env, "drop");
    expect(tmp.name).toMatch(/^pod_ci_drop_[0-9a-f]{16}$/);
    await dropDisposableDatabase(env, tmp.name);
    const gone = await withAdmin(env, (a) => a.query("SELECT 1 FROM pg_database WHERE datname = $1", [tmp.name]));
    expect(gone.rowCount).toBe(0);
    expect(trackedDatabases()).toEqual([current().name]);

    await expect(dropDisposableDatabase(env, "postgres")).rejects.toThrow(/이번 실행이 만든 DB가 아니다/);
    await expect(dropDisposableDatabase(env, "pod_ci_untracked_0000000000000000")).rejects.toThrow(
      /이번 실행이 만든 DB가 아니다/,
    );
    const still = await withAdmin(env, (a) => a.query("SELECT 1 FROM pg_database WHERE datname = 'postgres'"));
    expect(still.rowCount).toBe(1);
  });

  it("CREATE 직후 권한 설정이 실패해도 함수가 스스로 그 DB를 지우고 추적에서 뺀다", async () => {
    const original = pg.Client.prototype.query;
    let injected = false;
    let createdName: string | undefined;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const text = typeof args[0] === "string" ? args[0] : "";
      const m = /^CREATE DATABASE "(pod_ci_fail_[0-9a-f]{16})"/.exec(text);
      if (m) createdName = m[1];
      if (!injected && text.startsWith("GRANT CONNECT ON DATABASE")) {
        injected = true;
        return Promise.reject(new Error("injected GRANT failure"));
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      await expect(createDisposableDatabase(env, "fail")).rejects.toThrow(/injected GRANT failure/);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(createdName).toMatch(/^pod_ci_fail_[0-9a-f]{16}$/);
    // 호출자가 cleanupAll을 부르기 전에 이미 서버·추적 모두 비어 있어야 한다.
    const left = await withAdmin(env, (a) =>
      a.query("SELECT datname FROM pg_database WHERE datname LIKE 'pod\\_ci\\_fail\\_%'"),
    );
    expect(left.rowCount).toBe(0);
    expect(trackedDatabases()).toEqual([current().name]);
  });

  it("환경 검사는 disposable 플래그·loopback 호스트·쿼리 없음을 요구하고 URL을 메시지에 넣지 않는다", () => {
    const secretUrl = "postgres://postgres:sekrit-value@127.0.0.1:5432/postgres";
    expect(readDisposableEnv({ POD_TEST_DB_DISPOSABLE: "1", POD_TEST_ADMIN_URL: secretUrl }).adminUrl).toBe(secretUrl);
    const bad: Record<string, string | undefined>[] = [
      { POD_TEST_ADMIN_URL: secretUrl },
      { POD_TEST_DB_DISPOSABLE: "0", POD_TEST_ADMIN_URL: secretUrl },
      { POD_TEST_DB_DISPOSABLE: "1" },
      { POD_TEST_DB_DISPOSABLE: "1", POD_TEST_ADMIN_URL: "postgres://postgres:sekrit-value@db.example.com:5432/postgres" },
      { POD_TEST_DB_DISPOSABLE: "1", POD_TEST_ADMIN_URL: "postgres://postgres:sekrit-value@10.0.0.5:5432/postgres" },
      { POD_TEST_DB_DISPOSABLE: "1", POD_TEST_ADMIN_URL: `${secretUrl}?host=db.example.com` },
      { POD_TEST_DB_DISPOSABLE: "1", POD_TEST_ADMIN_URL: "mysql://postgres:sekrit-value@127.0.0.1/x" },
    ];
    for (const e of bad) {
      let message = "";
      try {
        readDisposableEnv(e);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/환경 오류/);
      expect(message).not.toContain("sekrit-value");
    }
  });

  it("기존 role 속성이 다르면 문제로 보고한다(수정하지 않고 거부하는 근거)", () => {
    const ok: RoleRow = {
      rolname: CI_ROLES.app,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
      rolcanlogin: true,
      member_of: [],
    };
    expect(roleProblems(ok, ROLE_SPECS.app)).toEqual([]);
    expect(roleProblems({ ...ok, rolsuper: true }, ROLE_SPECS.app)).toContain("rolsuper=true");
    expect(roleProblems({ ...ok, rolcreatedb: true }, ROLE_SPECS.app)).toContain("rolcreatedb=true");
    expect(roleProblems({ ...ok, rolbypassrls: true }, ROLE_SPECS.app)).toContain("rolbypassrls=true");
    expect(roleProblems({ ...ok, member_of: [CI_ROLES.owner] }, ROLE_SPECS.app).length).toBe(1);
    expect(roleProblems({ ...ok, rolcanlogin: true }, ROLE_SPECS.owner).length).toBe(1);
    expect(roleProblems({ ...ok, member_of: [] }, ROLE_SPECS.migrator).length).toBe(1);
  });
});
