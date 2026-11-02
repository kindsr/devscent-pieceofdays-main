import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, MigrationError } from "@/server/db/migrate";

// F2 경계 시험(PLAN_mvp-database §3·§9): CLI 종료 코드는 성공 0·실패 1뿐이고, migration 파일은 BOM 없는 UTF-8이어야 한다.
// DB·네트워크에 접속하지 않는다.
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLI_PATH = path.join(APP_DIR, "src", "server", "db", "migrate-cli.ts");

describe("migrate CLI: malformed database URL", () => {
  // 호스트 자리가 "[" 로 끝나 URL 문법상 틀린 값이다. 접속을 의도하지 않는다. 암호는 가짜 값이다.
  const BOGUS_SECRET = "ci-only-bogus-secret";
  const MALFORMED_URL = `postgres://pod_ci_migrator:${BOGUS_SECRET}@[/postgres`;

  /** URL을 파싱하지 않고 문자열 그대로 가린다(형식이 틀린 URL에 new URL을 쓰지 않는다). */
  function hide(text: string): string {
    return text.split(MALFORMED_URL).join("***").split(BOGUS_SECRET).join("***");
  }

  function runStatus(): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI_PATH, "status"],
        {
          cwd: APP_DIR,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            POD_MIGRATE_DATABASE_URL: MALFORMED_URL,
          },
          timeout: 30_000,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          let code: number | null = 0;
          if (err) {
            const c = (err as { code?: unknown }).code;
            code = typeof c === "number" ? c : null;
          }
          resolve({ code, output: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("exits with the failure code 1 (not 2) and never prints the URL or password", async () => {
    const r = await runStatus();
    const shown = hide(r.output);
    expect(shown).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/);
    expect(r.output.includes(MALFORMED_URL), "output must not contain the database URL").toBe(false);
    expect(r.output.includes(BOGUS_SECRET), "output must not contain the password").toBe(false);
    expect(r.code, `exit code (output with secrets hidden): ${shown}`).toBe(1);
  }, 40_000);
});

describe("loadMigrations: UTF-8 BOM is rejected", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const UP = "0001_probe.up.sql";
  const DOWN = "0001_probe.down.sql";
  const SQL = "SELECT 1;\n";
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function probeDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pod-f2-bom-"));
    dirs.push(dir);
    await writeFile(path.join(dir, UP), SQL, "utf8");
    await writeFile(path.join(dir, DOWN), SQL, "utf8");
    return dir;
  }

  for (const file of [UP, DOWN]) {
    it(`rejects ${file} that starts with the BOM bytes EF BB BF (a clean pair loads)`, async () => {
      const dir = await probeDir();
      const clean = await loadMigrations(dir);
      expect(clean.map((m) => [m.version, m.name])).toEqual([[1, "probe"]]);

      await writeFile(path.join(dir, file), Buffer.concat([BOM, Buffer.from(SQL, "utf8")]));
      let caught: unknown;
      try {
        await loadMigrations(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught, `${file} with a BOM must be rejected`).toBeInstanceOf(MigrationError);
      expect((caught as Error).message).toMatch(/BOM/);
      expect((caught as Error).message).toContain(file);
    });
  }
});
