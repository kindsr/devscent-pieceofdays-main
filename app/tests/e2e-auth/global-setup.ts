// F4 B4 인증 E2E globalSetup(시험 전용 harness). 제품 DI·가짜 로그인·세션 직접 발급을 하지 않는다.
//
// 순서(어느 단계든 실패하면 그때까지 연 것을 finally로 정리하고 다시 던진다):
//  1. guard: POD_FULL_CHECK_ISOLATED=1, 일회용 PG18 harness(POD_TEST_DB_DISPOSABLE=1·loopback POD_TEST_ADMIN_URL) — 연결 전에 fail closed.
//  2. PG 18 확인·CI role 준비(기존 tests/db/helpers) → 무작위 pod_ci_ DB → 제품 migration CLI `up`(migrator URL).
//  3. 기존 mock OIDC issuer(tests/support/mock-oidc-issuer)를 127.0.0.1 임의 포트에 띄운다.
//     redirect_uri는 http://127.0.0.1:3300/auth/{google,kakao}/callback.
//  4. 시험 제어용 loopback HTTP 한 개: 브라우저가 가려던 authorize URL로 mock.authorize(url, opts)를 대신 실행해
//     callback URL만 돌려준다(subject 고정·취소 등 사례 선택). code·state는 응답 본문으로만 주고 로그하지 않는다.
//  5. 127.0.0.1:3300이 비어 있는지 확인(재사용 금지) → next dev를 app role URL·mock issuer·가짜 자격으로 띄운다.
//     next 출력은 저장하지 않는다(요청 로그에 code·state가 찍힌다). 시작 실패 때만 비밀값을 가린 stderr 끝을 보인다.
// worker는 아래 env로 제어 주소·DB 이름·mock origin을 받는다. 관리자 URL은 원래 env 그대로다(새로 출력하지 않는다).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertServerIs18,
  bootstrapRoles,
  cleanupAll,
  closeAllClients,
  createDisposableDatabase,
  readDisposableEnv,
  withAdmin,
  type HarnessEnv,
} from "../db/helpers";
import { startMockIssuer, type AuthorizeOptions, type MockIssuer } from "../support/mock-oidc-issuer";
import { AUTH_BASE, AUTH_PORT, CI_CLIENTS, CI_SESSION_KEY, E2E_ENV } from "./support";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATE_CLI = path.join(APP_DIR, "src", "server", "db", "migrate-cli.ts");
const NEXT_BIN = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
const START_TIMEOUT_MS = 180_000;

function requireIsolated(): void {
  if (process.env.POD_FULL_CHECK_ISOLATED !== "1") {
    throw new Error("[e2e-auth] refused: POD_FULL_CHECK_ISOLATED=1 is required (isolated Cloud / CI only). Nothing was started.");
  }
}

function redactor(secrets: string[]): (text: string) => string {
  const list = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => list.reduce((t, s) => t.split(s).join("***"), text);
}

function migrateUp(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [MIGRATE_CLI, "up"],
      { cwd: APP_DIR, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POD_MIGRATE_DATABASE_URL: url }, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`[e2e-auth] migration CLI up failed: ${redactor([url, decodeURIComponent(new URL(url).password)])(stderr).slice(-2000)}`));
        else resolve();
      },
    );
  });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });
}

function startControl(mock: MockIssuer): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          if (req.method !== "POST" || req.url !== "/authorize") throw new Error("not found");
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown; opts?: AuthorizeOptions };
          if (typeof body.url !== "string" || !body.url.startsWith(`${mock.origin}/`)) throw new Error("bad authorize url");
          const r = await mock.authorize(body.url, body.opts ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ callback: r.callback.href, subject: r.subject }));
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("e2e-auth control: request refused");
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitReady(child: ChildProcess, tail: () => string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`[e2e-auth] next dev exited early:\n${tail()}`);
    try {
      const res = await fetch(`${AUTH_BASE}/settings`, { redirect: "manual" });
      await res.arrayBuffer();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`[e2e-auth] next dev did not answer on ${AUTH_BASE} within ${START_TIMEOUT_MS}ms:\n${tail()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 10_000);
  await exited;
  clearTimeout(timer);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  requireIsolated();
  const env: HarnessEnv = readDisposableEnv();
  let mock: MockIssuer | undefined;
  let control: Server | undefined;
  let child: ChildProcess | undefined;

  const teardown = async () => {
    await stopChild(child);
    if (control) await new Promise<void>((r) => control!.close(() => r()));
    if (mock) await mock.close();
    await cleanupAll(env).finally(() => closeAllClients());
  };

  try {
    await withAdmin(env, async (admin) => {
      const version = await assertServerIs18(admin);
      await bootstrapRoles(admin);
      console.log(`[e2e-auth] server_version_num=${version}`);
    });
    const db = await createDisposableDatabase(env, "b4auth");
    await migrateUp(db.urls.migrator);

    mock = await startMockIssuer({
      clients: (["google", "kakao"] as const).map((p) => ({
        provider: p,
        clientId: CI_CLIENTS[p].id,
        clientSecret: CI_CLIENTS[p].secret,
        redirectUri: `${AUTH_BASE}/auth/${p}/callback`,
      })),
    });
    control = await startControl(mock);

    if (await portInUse(AUTH_PORT)) {
      throw new Error(`[e2e-auth] 127.0.0.1:${AUTH_PORT} is already in use; an existing server is never reused`);
    }
    const redact = redactor([...mock.secrets(), db.urls.app, decodeURIComponent(new URL(db.urls.app).password), CI_SESSION_KEY]);
    const lines: string[] = [];
    const next = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(AUTH_PORT), "-H", "127.0.0.1"], {
      cwd: APP_DIR,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        NODE_ENV: "development",
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NEXT_TELEMETRY_DISABLED: "1",
        POD_LOCAL_FIXTURE: "",
        POD_AUTH_PROVIDERS: "google,kakao",
        POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: CI_SESSION_KEY }),
        POD_AUTH_BASE_URL: AUTH_BASE,
        POD_AUTH_GOOGLE_CLIENT_ID: CI_CLIENTS.google.id,
        POD_AUTH_GOOGLE_CLIENT_SECRET: CI_CLIENTS.google.secret,
        POD_AUTH_KAKAO_CLIENT_ID: CI_CLIENTS.kakao.id,
        POD_AUTH_KAKAO_CLIENT_SECRET: CI_CLIENTS.kakao.secret,
        POD_AUTH_MOCK_OIDC_ISSUER: mock.origin,
        POD_DATABASE_URL: db.urls.app,
        POD_WITHDRAWAL_ENABLED: "1",
      },
    });
    child = next;
    next.stderr?.on("data", (d: Buffer) => {
      lines.push(...redact(d.toString("utf8")).split("\n"));
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    });
    await waitReady(next, () => lines.slice(-60).join("\n"));

    const addr = control.address();
    if (addr === null || typeof addr === "string") throw new Error("[e2e-auth] control server has no port");
    process.env[E2E_ENV.control] = `http://127.0.0.1:${addr.port}`;
    process.env[E2E_ENV.db] = db.name;
    process.env[E2E_ENV.mockOrigin] = mock.origin;
    return teardown;
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }
}
