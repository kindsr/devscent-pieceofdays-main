// 일회용 PostgreSQL 18 시험 하네스 (F2 bootstrap). 시험 전용이며 제품 코드가 import하지 않는다.
// 계약: docs/product/DATA_CONTRACT.md §5·§6, docs/plans/PLAN_mvp-database.md §6.
//
// - 그 실행 전용의 로컬 컨테이너나 CI 서비스 컨테이너에서만 쓴다. 공용·실서버 DB에 연결하지 않는다.
// - POD_TEST_DB_DISPOSABLE=1 이고 POD_TEST_ADMIN_URL 호스트가 localhost/127.0.0.1일 때만 연결한다.
// - role은 없으면 만들고, 있으면 속성만 확인한다. 다르면 고치지 않고 실패한다. 비밀번호를 덮어쓰지 않는다.
// - DB는 이번 프로세스가 만든 무작위 pod_ci_ 이름만 추적·삭제한다. 삭제 직전 이름·owner를 다시 확인한다.
// - 관리자 URL·비밀번호를 로그·오류 메시지에 넣지 않는다.
// - pod 스키마·제품 테이블·제품 트리거·schema_migrations는 만들지 않는다(제품 migration 책임).
import { randomBytes } from "node:crypto";
import pg from "pg";

export const CI_ROLES = {
  owner: "pod_ci_owner",
  migrator: "pod_ci_migrator",
  app: "pod_ci_app",
} as const;

// CI·로컬 일회용 컨테이너 전용 가짜 값. 실제 환경의 비밀값이 아니다.
const CI_PASSWORDS = {
  migrator: "ci-only-migrator-not-a-secret",
  app: "ci-only-app-not-a-secret",
} as const;

export const DB_NAME_PREFIX = "pod_ci_";
const DB_NAME_RE = /^pod_ci_[a-z0-9]{1,20}_[0-9a-f]{16}$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
// 동시 실행이 role을 함께 만들 때 순서를 정하는 하네스 전용 advisory lock 키(제품 실행기 키와 별개).
const BOOTSTRAP_LOCK_KEY = 7_042_018_001;

export class DisposableEnvError extends Error {
  constructor(message: string) {
    super(`[db-harness] ${message} (환경 오류이며 RED/GREEN 결과가 아니다)`);
    this.name = "DisposableEnvError";
  }
}

export type HarnessEnv = { adminUrl: string };

/** 환경을 검사한다. 실패 메시지에 URL·비밀번호를 넣지 않는다. */
export function readDisposableEnv(env: Record<string, string | undefined> = process.env): HarnessEnv {
  if (env.POD_TEST_DB_DISPOSABLE !== "1") {
    throw new DisposableEnvError("POD_TEST_DB_DISPOSABLE=1 이 없다. 전용 일회용 컨테이너에서만 DB 시험을 실행한다");
  }
  const raw = env.POD_TEST_ADMIN_URL;
  if (!raw) throw new DisposableEnvError("POD_TEST_ADMIN_URL 이 없다");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DisposableEnvError("POD_TEST_ADMIN_URL 형식이 올바르지 않다");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DisposableEnvError("POD_TEST_ADMIN_URL 은 postgres:// 형식이어야 한다");
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new DisposableEnvError("POD_TEST_ADMIN_URL 호스트는 localhost 또는 127.0.0.1 이어야 한다");
  }
  // ?host= 등 쿼리 인자는 연결 대상을 바꿀 수 있으므로 받지 않는다.
  if (url.search !== "" || url.hash !== "") {
    throw new DisposableEnvError("POD_TEST_ADMIN_URL 에 쿼리·조각을 붙이지 않는다");
  }
  if (!url.username) throw new DisposableEnvError("POD_TEST_ADMIN_URL 에 관리자 사용자명이 없다");
  return { adminUrl: raw };
}

/** 관리자 URL에서 같은 호스트·포트로 다른 role·DB 접속 URL을 만든다. */
function urlFor(adminUrl: string, user: string, password: string | null, database: string): string {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password ?? url.password;
  url.pathname = `/${database}`;
  return url.toString();
}

function sanitize(err: unknown, secrets: string[]): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  let message = e.message;
  for (const s of secrets) if (s) message = message.split(s).join("***");
  const out = new Error(message.startsWith("[db-harness]") ? message : `[db-harness] ${message}`);
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") (out as Error & { code: string }).code = code;
  return out;
}

function secretsOf(adminUrl: string): string[] {
  const u = new URL(adminUrl);
  return [adminUrl, decodeURIComponent(u.password), u.password, CI_PASSWORDS.app, CI_PASSWORDS.migrator];
}

/** 열린 연결을 추적해 실패 경로에서도 닫는다. */
const openClients = new Set<pg.Client>();

export async function openClient(connectionString: string, adminUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  // 연결 끊김 오류가 처리되지 않은 예외로 프로세스를 죽이지 않게 한다.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw sanitize(err, secretsOf(adminUrl));
  }
  openClients.add(client);
  return client;
}

export async function closeClient(client: pg.Client): Promise<void> {
  openClients.delete(client);
  await client.end().catch(() => undefined);
}

export async function closeAllClients(): Promise<void> {
  await Promise.all([...openClients].map((c) => closeClient(c)));
}

export async function withAdmin<T>(env: HarnessEnv, fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const url = database ? urlFor(env.adminUrl, new URL(env.adminUrl).username, null, database) : env.adminUrl;
  const client = await openClient(url, env.adminUrl);
  try {
    return await fn(client);
  } catch (err) {
    throw sanitize(err, secretsOf(env.adminUrl));
  } finally {
    await closeClient(client);
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------- 서버·role 확인

export async function assertServerIs18(client: pg.Client): Promise<number> {
  const r = await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  const v = Number(r.rows[0]?.v);
  if (!(v >= 180000 && v < 190000)) throw new DisposableEnvError(`PostgreSQL 18.x 가 아니다 (server_version_num=${v})`);
  return v;
}

export type RoleRow = {
  rolname: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
  member_of: string[];
};

export type RoleSpec = {
  login: boolean;
  /** 이 role이 구성원이어야 하는 role 목록(정확히 이것만). */
  memberOf: string[];
};

export const ROLE_SPECS: Record<keyof typeof CI_ROLES, RoleSpec> = {
  owner: { login: false, memberOf: [] },
  migrator: { login: true, memberOf: [CI_ROLES.owner] },
  app: { login: true, memberOf: [] },
};

/** 기존 role 속성이 기대와 같은지 확인한다(순수 함수). 다른 점 목록을 돌려준다. */
export function roleProblems(row: RoleRow, spec: RoleSpec): string[] {
  const problems: string[] = [];
  for (const attr of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolbypassrls", "rolreplication"] as const) {
    if (row[attr]) problems.push(`${attr}=true`);
  }
  if (row.rolcanlogin !== spec.login) problems.push(`rolcanlogin=${row.rolcanlogin} (expected ${spec.login})`);
  const have = [...row.member_of].sort().join(",");
  const want = [...spec.memberOf].sort().join(",");
  if (have !== want) problems.push(`member_of=[${have}] (expected [${want}])`);
  return problems;
}

const ROLE_QUERY = `
  SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, r.rolcanlogin,
         COALESCE(array_agg(g.rolname::text ORDER BY g.rolname) FILTER (WHERE g.rolname IS NOT NULL), '{}'::text[]) AS member_of
    FROM pg_roles r
    LEFT JOIN pg_auth_members m ON m.member = r.oid
    LEFT JOIN pg_roles g ON g.oid = m.roleid
   WHERE r.rolname = $1
   GROUP BY r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, r.rolcanlogin`;

export async function readRole(client: pg.Client, name: string): Promise<RoleRow | null> {
  const r = await client.query<RoleRow>(ROLE_QUERY, [name]);
  return r.rows[0] ?? null;
}

/** migrator→owner 구성원 관계 옵션(SET 가능, ADMIN 없음)을 확인한다. */
async function membershipProblems(client: pg.Client): Promise<string[]> {
  const r = await client.query<{ admin_option: boolean; set_option: boolean; inherit_option: boolean }>(
    `SELECT m.admin_option, m.set_option, m.inherit_option
       FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles u ON u.oid = m.member
      WHERE g.rolname = $1 AND u.rolname = $2`,
    [CI_ROLES.owner, CI_ROLES.migrator],
  );
  const problems: string[] = [];
  if (r.rows.length === 0) problems.push("migrator is not a member of owner");
  for (const row of r.rows) {
    if (row.admin_option) problems.push("migrator has ADMIN OPTION on owner");
    if (!row.set_option) problems.push("migrator cannot SET ROLE owner");
    if (!row.inherit_option) problems.push("migrator does not INHERIT owner");
  }
  // owner의 구성원은 migrator 하나뿐이어야 한다. app은 누구의 구성원도, 누구를 구성원으로도 갖지 않는다.
  const members = await client.query<{ g: string; u: string }>(
    `SELECT g.rolname AS g, u.rolname AS u
       FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
      WHERE g.rolname = ANY($1::text[])`,
    [[CI_ROLES.owner, CI_ROLES.app, CI_ROLES.migrator]],
  );
  for (const row of members.rows) {
    if (!(row.g === CI_ROLES.owner && row.u === CI_ROLES.migrator)) problems.push(`unexpected member ${row.u} of ${row.g}`);
  }
  return problems;
}

async function assertAdminIsSuperuser(client: pg.Client): Promise<void> {
  const r = await client.query<{ s: boolean }>("SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user");
  if (!r.rows[0]?.s) throw new DisposableEnvError("POD_TEST_ADMIN_URL 사용자가 일회용 컨테이너의 슈퍼유저가 아니다");
}

const CREATE_ROLE_SQL: Record<keyof typeof CI_ROLES, string> = {
  owner: `CREATE ROLE ${CI_ROLES.owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  migrator: `CREATE ROLE ${CI_ROLES.migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${CI_PASSWORDS.migrator}'`,
  app: `CREATE ROLE ${CI_ROLES.app} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${CI_PASSWORDS.app}'`,
};

/**
 * role을 준비한다(반복 실행 안전). 없으면 만들고, 있으면 속성만 확인한다.
 * 기대와 다르면 아무것도 고치지 않고 실패한다(fail closed). 기존 비밀번호를 바꾸지 않는다.
 */
export async function bootstrapRoles(client: pg.Client): Promise<{ created: string[] }> {
  await assertServerIs18(client);
  await assertAdminIsSuperuser(client);
  const created: string[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);
    for (const key of ["owner", "migrator", "app"] as const) {
      const name = CI_ROLES[key];
      const existing = await readRole(client, name);
      if (existing) {
        const problems = roleProblems(existing, ROLE_SPECS[key]);
        if (problems.length) {
          throw new DisposableEnvError(`기존 role ${name} 이 계약과 다르다: ${problems.join("; ")}. 수정하지 않고 중단한다`);
        }
        continue;
      }
      await client.query(CREATE_ROLE_SQL[key]);
      if (key === "migrator") {
        await client.query(`GRANT ${CI_ROLES.owner} TO ${CI_ROLES.migrator} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
      }
      created.push(name);
    }
    const problems = await membershipProblems(client);
    for (const key of ["owner", "migrator", "app"] as const) {
      const row = await readRole(client, CI_ROLES[key]);
      if (!row) problems.push(`${CI_ROLES[key]} missing`);
      else problems.push(...roleProblems(row, ROLE_SPECS[key]).map((p) => `${CI_ROLES[key]}: ${p}`));
    }
    if (problems.length) throw new DisposableEnvError(`role 계약 위반: ${problems.join("; ")}. 수정하지 않고 중단한다`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
  return { created };
}

// ---------------------------------------------------------------- 일회용 DB

/** 이번 프로세스가 직접 만든 DB 이름만 담는다. 여기에 없는 DB는 절대 삭제하지 않는다. */
const createdDatabases = new Set<string>();

export function trackedDatabases(): readonly string[] {
  return [...createdDatabases];
}

export type DisposableDatabase = {
  name: string;
  urls: { admin: string; migrator: string; app: string };
};

/**
 * 무작위 이름의 DB를 OWNER pod_ci_owner로 만들고 pod_meta.db_environment('ci', app, owner)만 넣는다.
 * pod 스키마·제품 테이블·schema_migrations는 만들지 않는다.
 */
export async function createDisposableDatabase(env: HarnessEnv, label: string): Promise<DisposableDatabase> {
  if (!/^[a-z0-9]{1,20}$/.test(label)) throw new Error(`[db-harness] label must match [a-z0-9]{1,20}: ${label}`);
  const name = `${DB_NAME_PREFIX}${label}_${randomBytes(8).toString("hex")}`;
  if (!DB_NAME_RE.test(name)) throw new Error("[db-harness] generated name does not match the contract");

  // CREATE부터 권한·메타 설정까지 전체를 감싼다. 어느 단계에서 실패해도 이번 실행이 만들어
  // 추적 중인 DB만 지우고 다시 던진다(호출자의 cleanupAll에 기대지 않는다).
  try {
    await withAdmin(env, async (admin) => {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount) throw new DisposableEnvError(`DB ${name} 가 이미 있다. 재사용하지 않는다`);
      await admin.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${CI_ROLES.owner} TEMPLATE template0 ENCODING 'UTF8'`);
      createdDatabases.add(name);
      await admin.query(`REVOKE ALL ON DATABASE ${quoteIdent(name)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(name)} TO ${CI_ROLES.migrator}, ${CI_ROLES.app}`);
    });

    await withAdmin(
      env,
      async (admin) => {
        await admin.query("BEGIN");
        try {
          await admin.query(`CREATE SCHEMA pod_meta AUTHORIZATION ${CI_ROLES.owner}`);
          await admin.query(`REVOKE ALL ON SCHEMA pod_meta FROM PUBLIC`);
          await admin.query(`SET LOCAL ROLE ${CI_ROLES.owner}`);
          await admin.query(`
            CREATE TABLE pod_meta.db_environment (
              singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
              name       text NOT NULL CHECK (name IN ('ci','dev','prod')),
              app_role   name NOT NULL,
              owner_role name NOT NULL
            )`);
          await admin.query("REVOKE ALL ON pod_meta.db_environment FROM PUBLIC");
          await admin.query("INSERT INTO pod_meta.db_environment (name, app_role, owner_role) VALUES ('ci', $1, $2)", [
            CI_ROLES.app,
            CI_ROLES.owner,
          ]);
          await admin.query("COMMIT");
        } catch (err) {
          await admin.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      },
      name,
    );
  } catch (err) {
    if (createdDatabases.has(name)) await dropDisposableDatabase(env, name).catch(() => undefined);
    throw err;
  }

  return {
    name,
    urls: {
      admin: urlFor(env.adminUrl, new URL(env.adminUrl).username, null, name),
      migrator: urlFor(env.adminUrl, CI_ROLES.migrator, CI_PASSWORDS.migrator, name),
      app: urlFor(env.adminUrl, CI_ROLES.app, CI_PASSWORDS.app, name),
    },
  };
}

/** 이번 실행이 만든 DB만 이름·owner를 다시 확인한 뒤 삭제한다. 다르면 삭제하지 않고 실패한다. */
export async function dropDisposableDatabase(env: HarnessEnv, name: string): Promise<void> {
  if (!createdDatabases.has(name)) {
    throw new DisposableEnvError(`DB ${name} 는 이번 실행이 만든 DB가 아니다. 삭제하지 않는다`);
  }
  if (!DB_NAME_RE.test(name)) throw new DisposableEnvError(`DB 이름 ${name} 이 pod_ci_ 계약과 다르다. 삭제하지 않는다`);
  await withAdmin(env, async (admin) => {
    const r = await admin.query<{ owner: string }>(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [name],
    );
    if (r.rows.length === 0) return; // 이미 없다
    if (r.rows[0]?.owner !== CI_ROLES.owner) {
      throw new DisposableEnvError(`DB ${name} owner 가 ${CI_ROLES.owner} 가 아니다. 삭제하지 않는다`);
    }
    await admin.query(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`);
  });
  createdDatabases.delete(name);
}

/** 연결을 모두 닫고 이번 실행이 만든 DB를 모두 삭제한다. 실패를 모아 마지막에 던진다. */
export async function cleanupAll(env: HarnessEnv): Promise<void> {
  await closeAllClients();
  const errors: unknown[] = [];
  for (const name of [...createdDatabases]) {
    try {
      await dropDisposableDatabase(env, name);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length) throw new AggregateError(errors, "[db-harness] cleanup failed");
}

/** SQLSTATE로 실패를 확인한다(메시지 문자열에 의존하지 않는다). */
export async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === sqlState) return;
    throw new Error(`expected SQLSTATE ${sqlState}, got ${String(code)}`);
  }
  throw new Error(`expected SQLSTATE ${sqlState}, but the statement succeeded`);
}
