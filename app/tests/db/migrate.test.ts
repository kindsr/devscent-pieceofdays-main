// F2 migration 실행기 시험(PLAN_mvp-database §3·§5.3·§9). CLI를 Node로 직접 실행하고 migrator URL만 준다.
// 실행기 규칙(체크섬·누락·gap·동시 실행·원자성)은 시험용 임시 migration 디렉터리(시험 데이터)로,
// 0001 적용·down 보호·up→down→up 스냅샷은 제품 app/migrations로 확인한다.
// beforeAll은 환경만 읽는다. 각 시험이 자기 DB를 만들고 필요한 초기화(up)를 시험 안에서 단언한다.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CI_ROLES, cleanupAll, createDisposableDatabase, readDisposableEnv, type HarnessEnv } from "./helpers";
import {
  INIT_DOWN,
  INIT_UP,
  USER_DATA_TABLES,
  cleanupTempDirs,
  expectCliFail,
  expectCliOk,
  expectSqlError,
  insertAccountWithGrant,
  insertDesignVersion,
  insertMoment,
  insertUser,
  makeMigrationsDir,
  readMigrationRows,
  redact,
  relationExists,
  removeMigrationFile,
  runMigrateCli,
  schemaExists,
  schemaSnapshot,
  sha256File,
  userDataCounts,
  withApp,
  withOwner,
  writeMigrationFiles,
} from "./f2-support";

// F4 L1(PLAN_account-lifecycle §10·§12): 기본 app/migrations에는 0002_account_lifecycle이 함께 있다.
const LIFECYCLE_UP = path.join(path.dirname(INIT_UP), "0002_account_lifecycle.up.sql");
const REFLECTION_UP = path.join(path.dirname(INIT_UP), "0003_reflection_time.up.sql");
const PHOTOS_UP = path.join(path.dirname(INIT_UP), "0004_private_photos.up.sql");

let env: HarnessEnv;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  try {
    await cleanupTempDirs();
  } finally {
    if (env) await cleanupAll(env);
  }
});

// 시험 데이터: 실행기 규칙 확인용 최소 migration. 제품 스키마(pod)와 겹치지 않는 pod_probe 스키마를 쓴다.
const PROBE_1 = {
  "0001_alpha.up.sql": "CREATE SCHEMA pod_probe;\nCREATE TABLE pod_probe.alpha (id int PRIMARY KEY);\n",
  "0001_alpha.down.sql": "DROP TABLE pod_probe.alpha;\nDROP SCHEMA pod_probe;\n",
};
const PROBE_2 = {
  "0002_beta.up.sql": "CREATE TABLE pod_probe.beta (id int PRIMARY KEY);\n",
  "0002_beta.down.sql": "DROP TABLE pod_probe.beta;\n",
};
const PROBE_3 = {
  "0003_gamma.up.sql": "CREATE TABLE pod_probe.gamma (id int PRIMARY KEY);\n",
  "0003_gamma.down.sql": "DROP TABLE pod_probe.gamma;\n",
};

async function freshDb(label: string) {
  return createDisposableDatabase(env, label);
}

describe("migrate CLI: product 0001 up", () => {
  it("status succeeds on an empty DB without applying anything", async () => {
    const db = await freshDb("mstatus");
    const r = await runMigrateCli(["status"], db.urls.migrator);
    expectCliOk(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaExists(c, "pod")).toBe(false);
      const rows = await readMigrationRows(c);
      expect(rows ?? []).toEqual([]);
    });
  });

  it("up on an empty DB records the default init, account_lifecycle, reflection_time and private_photos migrations with sha256", async () => {
    const db = await freshDb("mup");
    const r = await runMigrateCli(["up"], db.urls.migrator);
    expectCliOk(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      const rows = await readMigrationRows(c);
      expect(rows?.map((x) => ({ version: x.version, name: x.name }))).toEqual([
        { version: 1, name: "init" },
        { version: 2, name: "account_lifecycle" },
        { version: 3, name: "reflection_time" },
        { version: 4, name: "private_photos" },
      ]);
      const checksum = await sha256File(INIT_UP);
      const lifecycleChecksum = await sha256File(LIFECYCLE_UP);
      const reflectionChecksum = await sha256File(REFLECTION_UP);
      const photosChecksum = await sha256File(PHOTOS_UP);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(rows).toEqual([
        { version: 1, name: "init", checksum },
        { version: 2, name: "account_lifecycle", checksum: lifecycleChecksum },
        { version: 3, name: "reflection_time", checksum: reflectionChecksum },
        { version: 4, name: "private_photos", checksum: photosChecksum },
      ]);
      for (const t of USER_DATA_TABLES) expect(await relationExists(c, `pod.${t}`), `pod.${t}`).toBe(true);
      const owners = await c.query<{ tablename: string; tableowner: string }>(
        "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'pod' ORDER BY tablename",
      );
      expect(owners.rows.map((x) => x.tablename).sort()).toEqual([...USER_DATA_TABLES].sort());
      for (const row of owners.rows) expect(row.tableowner, row.tablename).toBe(CI_ROLES.owner);
      const pub = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
      );
      expect(pub.rows[0]?.n).toBe(0);
    });
  });

  it("a second up is a no-op: same record row, same applied_at, same schema snapshot", async () => {
    const db = await freshDb("midem");
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, async (c) => ({
      rows: await c.query("SELECT version, name, checksum, applied_at FROM pod_meta.schema_migrations ORDER BY version"),
      snap: await schemaSnapshot(c),
    }));
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      const rows = await c.query("SELECT version, name, checksum, applied_at FROM pod_meta.schema_migrations ORDER BY version");
      expect(rows.rows).toEqual(before.rows.rows);
      expect(await schemaSnapshot(c)).toEqual(before.snap);
    });
  });

  it("refuses to start when pod_meta.db_environment has no row, and changes nothing", async () => {
    const db = await freshDb("mnoenv");
    await withOwner(env, db, (c) => c.query("DELETE FROM pod_meta.db_environment"));
    const r = await runMigrateCli(["up"], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaExists(c, "pod")).toBe(false);
      expect((await readMigrationRows(c)) ?? []).toEqual([]);
    });
  });

  it("fails with exit 1 on bad credentials and never prints the URL or password", async () => {
    const db = await freshDb("mcred");
    const bad = new URL(db.urls.migrator);
    bad.password = "wrong-ci-only-password-value";
    const r = await runMigrateCli(["up"], bad.toString());
    expectCliFail(r, bad.toString());
    expectCliFail(r, db.urls.migrator);
  });
});

describe("migrate CLI: runner rules with temporary migration directories", () => {
  it("runs each file as the owner role and records name/checksum from the file", async () => {
    const db = await freshDb("mrole");
    const dir = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual([
        { version: 1, name: "alpha", checksum: await sha256File(path.join(dir, "0001_alpha.up.sql")) },
      ]);
      const owner = await c.query<{ o: string }>(
        "SELECT tableowner AS o FROM pg_tables WHERE schemaname = 'pod_probe' AND tablename = 'alpha'",
      );
      expect(owner.rows[0]?.o).toBe(CI_ROLES.owner);
    });
  });

  it("a one-byte change in an applied file fails with 'checksum mismatch' and applies nothing new", async () => {
    const db = await freshDb("mcsum");
    const dir = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, (c) => readMigrationRows(c));

    const upFile = path.join(dir, "0001_alpha.up.sql");
    const original = await readFile(upFile, "utf8");
    await writeMigrationFiles(dir, { "0001_alpha.up.sql": original.replace("alpha (id", "alpha (Id"), ...PROBE_2 });

    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    expect(redact(r.output, db.urls.migrator)).toMatch(/checksum mismatch/);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual(before);
      expect(await relationExists(c, "pod_probe.beta")).toBe(false);
    });
  });

  it("a missing applied file fails with exit 1 and applies nothing new", async () => {
    const db = await freshDb("mmiss");
    const dir = await makeMigrationsDir({ ...PROBE_1, ...PROBE_2 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, (c) => readMigrationRows(c));
    expect(before?.map((x) => x.version)).toEqual([1, 2]);

    await removeMigrationFile(dir, "0002_beta.up.sql");
    await removeMigrationFile(dir, "0002_beta.down.sql");
    await writeMigrationFiles(dir, { ...PROBE_3 });

    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual(before);
      expect(await relationExists(c, "pod_probe.gamma")).toBe(false);
    });
  });

  it("a numbering gap after applied migrations fails with exit 1 and applies nothing", async () => {
    const db = await freshDb("mgap");
    const dir = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, (c) => readMigrationRows(c));

    await writeMigrationFiles(dir, { ...PROBE_3 });
    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual(before);
      expect(await relationExists(c, "pod_probe.gamma")).toBe(false);
    });
  });

  it("a numbering gap on an empty DB fails before applying even the first file", async () => {
    const db = await freshDb("mgap0");
    // 정상 디렉터리로 CLI가 실제로 동작하는지 먼저 확인한다(파일 부재로 인한 거짓 통과 방지).
    const ok = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["status", "--migrations-dir", ok], db.urls.migrator), db.urls.migrator);

    const dir = await makeMigrationsDir({ ...PROBE_1, ...PROBE_3 });
    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaExists(c, "pod_probe")).toBe(false);
      expect((await readMigrationRows(c)) ?? []).toEqual([]);
    });
  });

  it("a file that violates the SQL policy is refused with exit 1 and nothing from it is applied", async () => {
    const db = await freshDb("mpolicy");
    const dir = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, (c) => readMigrationRows(c));

    await writeMigrationFiles(dir, {
      "0002_beta.up.sql": "CREATE TABLE pod_probe.beta (id int PRIMARY KEY);\nCOMMIT;\n",
      "0002_beta.down.sql": "DROP TABLE pod_probe.beta;\n",
    });
    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual(before);
      expect(await relationExists(c, "pod_probe.beta")).toBe(false);
    });
  });

  it("a failing file is rolled back entirely (no partial objects, no record row) and later files are not run", async () => {
    const db = await freshDb("matomic");
    const dir = await makeMigrationsDir({ ...PROBE_1 });
    expectCliOk(await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator), db.urls.migrator);
    const before = await withOwner(env, db, (c) => readMigrationRows(c));

    await writeMigrationFiles(dir, {
      "0002_beta.up.sql": "CREATE TABLE pod_probe.beta (id int PRIMARY KEY);\nSELECT 1 / 0;\n",
      "0002_beta.down.sql": "DROP TABLE pod_probe.beta;\n",
      ...PROBE_3,
    });
    const r = await runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await readMigrationRows(c)).toEqual(before);
      expect(await relationExists(c, "pod_probe.beta")).toBe(false);
      expect(await relationExists(c, "pod_probe.gamma")).toBe(false);
    });
  });

  it("two concurrent up processes both succeed and leave exactly one record row", async () => {
    const db = await freshDb("mconc");
    const dir = await makeMigrationsDir({
      "0001_slow.up.sql": "CREATE SCHEMA pod_probe;\nCREATE TABLE pod_probe.slow (id int PRIMARY KEY);\nSELECT pg_sleep(1);\n",
      "0001_slow.down.sql": "DROP SCHEMA pod_probe CASCADE;\n",
    });
    const [a, b] = await Promise.all([
      runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator),
      runMigrateCli(["up", "--migrations-dir", dir], db.urls.migrator),
    ]);
    expectCliOk(a, db.urls.migrator);
    expectCliOk(b, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect((await readMigrationRows(c))?.map((x) => x.version)).toEqual([1]);
      expect(await relationExists(c, "pod_probe.slow")).toBe(true);
    });
  });
});

describe("migrate CLI: down protection (product 0001)", () => {
  it("down without --allow-down is refused and the schema stays", async () => {
    const db = await freshDb("mdnflag");
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    const snap = await withOwner(env, db, (c) => schemaSnapshot(c));
    const r = await runMigrateCli(["down", "--to", "0"], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaSnapshot(c)).toEqual(snap);
      expect((await readMigrationRows(c))?.map((x) => x.version)).toEqual([1, 2, 3, 4]);
    });
  });

  it("down is refused when db_environment.name is 'dev' (even with --allow-down)", async () => {
    const db = await freshDb("mdndev");
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, (c) => c.query("UPDATE pod_meta.db_environment SET name = 'dev'"));
    const snap = await withOwner(env, db, (c) => schemaSnapshot(c));
    const r = await runMigrateCli(["down", "--to", "0", "--allow-down"], db.urls.migrator);
    expectCliFail(r, db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaSnapshot(c)).toEqual(snap);
      expect((await readMigrationRows(c))?.map((x) => x.version)).toEqual([1, 2, 3, 4]);
    });
  });

  type Seed = { label: string; name: string; seed: (c: pg.Client) => Promise<void> };
  const seeds: Seed[] = [
    {
      label: "mdnuser",
      name: "users row only (no account, no ledger)",
      seed: async (c) => {
        await insertUser(c);
      },
    },
    {
      label: "mdnmoment",
      name: "users + diary_moments (diary before any ledger row)",
      seed: async (c) => {
        await insertMoment(c, await insertUser(c));
      },
    },
    {
      label: "mdndesign",
      name: "users + design_versions",
      seed: async (c) => {
        await insertDesignVersion(c, await insertUser(c));
      },
    },
    {
      label: "mdnledger",
      name: "users + credit_accounts + emotion_ledger",
      seed: async (c) => insertAccountWithGrant(c, await insertUser(c)),
    },
  ];

  for (const s of seeds) {
    it(`down --allow-down is refused when user data exists: ${s.name}; the down file itself also raises P0001`, async () => {
      const db = await freshDb(s.label);
      expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
      await withApp(env, db, s.seed);
      const before = await withOwner(env, db, async (c) => ({
        snap: await schemaSnapshot(c),
        counts: await userDataCounts(c),
        rows: await readMigrationRows(c),
      }));
      expect(Object.values(before.counts).some((n) => n > 0)).toBe(true);

      const r = await runMigrateCli(["down", "--to", "0", "--allow-down"], db.urls.migrator);
      expectCliFail(r, db.urls.migrator);

      // 실행기 사전 확인을 건너뛰고 down 파일을 owner로 직접 실행해도 첫 문장이 P0001로 거부해야 한다.
      const downSql = await readFile(INIT_DOWN, "utf8");
      await withOwner(env, db, async (c) => {
        await expectSqlError(c.query(downSql), "P0001");
      });

      await withOwner(env, db, async (c) => {
        expect(await schemaSnapshot(c)).toEqual(before.snap);
        expect(await userDataCounts(c)).toEqual(before.counts);
        expect(await readMigrationRows(c)).toEqual(before.rows);
      });
    });
  }

  it("on an empty CI DB, up → down → up succeeds and the schema snapshot is identical", async () => {
    const db = await freshDb("mcycle");
    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    const first = await withOwner(env, db, async (c) => {
      const counts = await userDataCounts(c);
      for (const n of Object.values(counts)) expect(n).toBe(0);
      return schemaSnapshot(c);
    });
    expect(first.some((x) => x.startsWith("table|pod.emotion_ledger"))).toBe(true);
    expect(first.some((x) => x.startsWith("trigger|"))).toBe(true);
    expect(first.some((x) => x.startsWith("table_privilege|") && x.includes(CI_ROLES.app))).toBe(true);

    expectCliOk(await runMigrateCli(["down", "--to", "0", "--allow-down"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaExists(c, "pod")).toBe(false);
      expect((await readMigrationRows(c)) ?? []).toEqual([]);
    });

    expectCliOk(await runMigrateCli(["up"], db.urls.migrator), db.urls.migrator);
    await withOwner(env, db, async (c) => {
      expect(await schemaSnapshot(c)).toEqual(first);
      expect((await readMigrationRows(c))?.map((x) => x.version)).toEqual([1, 2, 3, 4]);
    });
  });
});
