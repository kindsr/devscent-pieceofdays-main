import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// F2 migration 파일 정책(PLAN_mvp-database §3·§5.3·§9): 작은 문장 분리기로 최상위 문장의 첫 키워드만 검사한다.
// 주석(--, 중첩 /* */)·작은따옴표 문자열·큰따옴표 식별자·달러 인용 본문은 건너뛴다. 위반이면 throw, 통과면 void.
// 제품 모듈이 아직 없어도 이 파일의 시험이 수집·실행되도록 각 시험 안에서 동적으로 불러온다.
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const POLICY_MODULE = path.join(APP_DIR, "src", "server", "db", "sql-policy.ts");
const MIGRATIONS_DIR = path.join(APP_DIR, "migrations");

type Policy = { validateSqlPolicy: (sql: string) => void };

async function loadPolicy(): Promise<Policy["validateSqlPolicy"]> {
  const mod = (await import(/* @vite-ignore */ POLICY_MODULE)) as Partial<Policy>;
  expect(typeof mod.validateSqlPolicy, "sql-policy.ts must export validateSqlPolicy").toBe("function");
  return mod.validateSqlPolicy as Policy["validateSqlPolicy"];
}

async function expectAllowed(sql: string): Promise<void> {
  const validate = await loadPolicy();
  expect(() => validate(sql), sql).not.toThrow();
  expect(validate(sql)).toBeUndefined();
}

async function expectRejected(sql: string): Promise<Error> {
  const validate = await loadPolicy();
  let caught: unknown;
  try {
    validate(sql);
  } catch (err) {
    caught = err;
  }
  expect(caught, `policy should reject: ${JSON.stringify(sql)}`).toBeInstanceOf(Error);
  return caught as Error;
}

describe("validateSqlPolicy: allowed SQL (PL/pgSQL blocks, comments, literals)", () => {
  it("allows a DO block whose dollar-quoted body uses BEGIN/END", async () => {
    await expectAllowed("DO $$ BEGIN RAISE NOTICE 'x'; END $$;");
  });

  it("allows a tagged dollar-quoted plpgsql function body with BEGIN/END and semicolons", async () => {
    await expectAllowed(
      "CREATE FUNCTION pod.f() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n  RAISE EXCEPTION 'emotion_ledger is append-only';\nEND\n$fn$;",
    );
  });

  it("keeps a different dollar tag inside the body ($$ COMMIT; $$ inside $a$...$a$)", async () => {
    await expectAllowed("DO $a$ BEGIN PERFORM $$ COMMIT; $$; END $a$;\nSELECT 1;");
  });

  it("ignores transaction words inside line comments", async () => {
    await expectAllowed("-- BEGIN;\n-- COMMIT;\nCREATE TABLE pod.t (id int);");
  });

  it("ignores transaction words inside block comments, including nested ones", async () => {
    await expectAllowed("/* COMMIT; */ SELECT 1;");
    await expectAllowed("/* outer /* nested ROLLBACK; */ still comment; END; */ SELECT 1;");
  });

  it("ignores transaction words inside string literals, including escaped quotes", async () => {
    await expectAllowed("SELECT 'COMMIT';");
    await expectAllowed("SELECT 'it''s; COMMIT; BEGIN';\nSELECT 2;");
    await expectAllowed("COMMENT ON TABLE pod.t IS 'BEGIN ATOMIC is not used; COMMIT;';");
  });

  it("ignores transaction words inside quoted identifiers", async () => {
    await expectAllowed('CREATE TABLE pod."begin" (id int);\nSELECT * FROM pod."commit;";');
  });

  it("only checks the first keyword of each statement (END in CASE, column names, plain CREATE INDEX)", async () => {
    await expectAllowed("SELECT CASE WHEN true THEN 1 END;");
    await expectAllowed("CREATE TABLE pod.t (begin_at int, end_at int);");
    await expectAllowed("CREATE INDEX t_idx ON pod.t (end_at);");
  });

  it("allows a realistic multi-statement migration", async () => {
    await expectAllowed(
      [
        "CREATE SCHEMA pod;",
        "CREATE TABLE pod.users (id uuid PRIMARY KEY DEFAULT uuidv7());",
        "REVOKE ALL ON pod.users FROM PUBLIC;",
        "DO $$",
        "BEGIN",
        "  EXECUTE format('GRANT SELECT ON pod.users TO %I', 'pod_ci_app');",
        "END",
        "$$;",
        "CREATE FUNCTION pod.guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$;",
        "",
      ].join("\n"),
    );
  });
});

describe("validateSqlPolicy: top-level transaction control is rejected", () => {
  const cases = [
    "BEGIN;",
    "begin;",
    "  Begin\n;",
    "BEGIN",
    "BEGIN TRANSACTION;",
    "START TRANSACTION;",
    "start\n\ttransaction isolation level serializable;",
    "COMMIT;",
    "commit work;",
    "END;",
    "end",
    "ROLLBACK;",
    "ROLLBACK TO SAVEPOINT a;",
    "ABORT;",
    "abort work;",
    "ABORT AND CHAIN;",
    "SAVEPOINT a;",
    "RELEASE SAVEPOINT a;",
    "RELEASE a;",
    "PREPARE TRANSACTION 'x';",
    "prepare\ntransaction 'x';",
  ];
  for (const sql of cases) {
    it(`rejects ${JSON.stringify(sql)}`, async () => {
      await expectRejected(sql);
    });
  }

  it("rejects transaction control placed after a leading comment", async () => {
    await expectRejected("-- note\nCOMMIT;");
    await expectRejected("/* note /* nested */ */ COMMIT;");
  });

  it("rejects transaction control that follows valid statements", async () => {
    await expectRejected("CREATE TABLE pod.t (id int);\nCOMMIT;\nCREATE TABLE pod.u (id int);");
  });

  it("rejects COMMIT right after a dollar-quoted body ends", async () => {
    await expectRejected("DO $$ BEGIN NULL; END $$; COMMIT;");
    await expectRejected("CREATE FUNCTION pod.f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN NULL; END $fn$;COMMIT;");
    await expectRejected("DO $$ BEGIN NULL; END $$;\ncommit;");
  });

  it("reports the location and keyword of the violating statement", async () => {
    // 3번째 줄·3번째 문장이 위반이다. 위치 표기 형식(줄/문장 번호)은 GREEN이 정하되 3이 드러나야 한다.
    const err = await expectRejected("SELECT 1;\nSELECT 2;\nCOMMIT;\n");
    expect(err.message).toMatch(/COMMIT/i);
    expect(err.message).toMatch(/\b3\b/);
  });
});

describe("validateSqlPolicy: statements that cannot run inside the runner transaction are rejected", () => {
  const cases = [
    "CREATE INDEX CONCURRENTLY t_idx ON pod.t (id);",
    "create unique index concurrently t_idx ON pod.t (id);",
    "CREATE INDEX\n  CONCURRENTLY IF NOT EXISTS t_idx ON pod.t (id);",
    "VACUUM;",
    "vacuum analyze pod.t;",
    "CREATE DATABASE other;",
    "create   database other;",
    "ALTER SYSTEM SET work_mem = '1MB';",
    "alter system reset all;",
  ];
  for (const sql of cases) {
    it(`rejects ${JSON.stringify(sql)}`, async () => {
      await expectRejected(sql);
    });
  }

  it("rejects such a statement even after allowed statements", async () => {
    await expectRejected("CREATE TABLE pod.t (id int);\nCREATE INDEX CONCURRENTLY t_idx ON pod.t (id);");
  });
});

describe("validateSqlPolicy: SQL-standard BEGIN ATOMIC bodies are rejected", () => {
  it("rejects a BEGIN ATOMIC function body with inner statements", async () => {
    await expectRejected("CREATE FUNCTION pod.one() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;");
  });

  it("rejects an empty BEGIN ATOMIC body (no inner semicolon)", async () => {
    await expectRejected("CREATE PROCEDURE pod.p() LANGUAGE sql BEGIN ATOMIC END;");
  });

  it("rejects lower-case / multi-line begin atomic", async () => {
    await expectRejected("create function pod.one() returns int language sql\nbegin\n  atomic\n  select 1;\nend;");
  });
});

describe("product migration files", () => {
  it("every app/migrations/*.sql file passes the policy and up/down files come in numbered pairs", async () => {
    const validate = await loadPolicy();
    const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql")).sort();
    expect(names).toContain("0001_init.up.sql");
    expect(names).toContain("0001_init.down.sql");
    for (const n of names) {
      expect(n).toMatch(/^\d{4}_[a-z0-9_]+\.(up|down)\.sql$/);
      const sql = await readFile(path.join(MIGRATIONS_DIR, n), "utf8");
      expect(sql.includes("\r"), `${n} must use LF`).toBe(false);
      expect(() => validate(sql), n).not.toThrow();
    }
  });
});
