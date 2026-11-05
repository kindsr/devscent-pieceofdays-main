// F4a RED — auth 모듈의 server-only 빌드 경계 harness(PLAN_mvp-authentication §6, §8 "빌드 경계 harness").
// 실행: POD_FULL_CHECK_ISOLATED=1 node --test app/tests/auth-build-boundary.test.mjs
//
// - 격리된 Cloud 독립 runner·격리 CI에서만 실행한다. POD_FULL_CHECK_ISOLATED=1이 없으면 어떤 build도 시작하기 전에 실패한다.
//   공유 운영 서버에서 실행하지 않는다. 서버 listen·DB 접속은 하지 않는다.
// - 각 시험은 원본 app을 **임시 디렉터리에 복사한 사본**에서만 fixture를 쓰고 `next build`를 순차 실행한다(사본마다 고유 .next).
//   원본 소스·설정은 편집하지 않는다. node_modules는 사본 안에 hardlink(실패 시 복사)해 Turbopack root가 사본이 되게 한다.
// - RED 단계: ① 기준 사본(auth import 없음) build 성공은 환경 양성 제어다.
//   ② 실제 auth 모듈을 쓰는 서버 positive, ③ client 직접 import 거부, ④ shared를 거친 client 전이 import 거부는
//   신규 모듈 app/src/server/auth/session.ts가 없으면 build 없이 각각 명시적으로 실패한다(0개·skip 없음).
// - 거부 사례는 build 실패 **그리고** 출력에 server-only/Client Component 원인이 있어야 통과한다.
//   의존성·Turbopack root·설치 같은 환경 오류로 실패한 build를 거부 성공으로 세지 않는다.
// - fixture는 실제로 auth export를 사용해 tree-shaking으로 import가 사라지지 않게 한다.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const AUTH_REL = path.join("src", "server", "auth", "session.ts");
const AUTH_MODULE = path.join(APP_DIR, AUTH_REL);
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
// 사본에 가져가지 않는 원본 항목(산출물·시험·로컬 상태).
const SKIP_TOP = new Set(["node_modules", ".next", "out", "test-results", "playwright-report", "tsconfig.tsbuildinfo", "tests"]);

function requireIsolated() {
  assert.equal(
    process.env.POD_FULL_CHECK_ISOLATED,
    "1",
    "refused: POD_FULL_CHECK_ISOLATED=1 is required (isolated Cloud runner / isolated CI only). No build was started.",
  );
}

function requireAuthModule() {
  assert.ok(
    existsSync(AUTH_MODULE),
    `F4a product module ${AUTH_REL} is missing (expected before GREEN). No build was started for this case.`,
  );
}

const copies = [];

/** 원본 app을 임시 사본으로 복사한다. 원본은 읽기만 한다. */
function makeCopy(label) {
  const root = mkdtempSync(path.join(tmpdir(), `pod-f4a-build-${label}-`));
  const dir = path.join(root, "app");
  mkdirSync(dir);
  for (const entry of readdirSync(APP_DIR)) {
    if (SKIP_TOP.has(entry)) continue;
    cpSync(path.join(APP_DIR, entry), path.join(dir, entry), { recursive: true, dereference: false });
  }
  const srcModules = path.join(APP_DIR, "node_modules");
  assert.ok(existsSync(srcModules), "environment: app/node_modules is missing (run npm ci in app first)");
  try {
    execFileSync("cp", ["-al", srcModules, path.join(dir, "node_modules")], { stdio: "pipe" });
  } catch {
    rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    cpSync(srcModules, path.join(dir, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  copies.push(root);
  return dir;
}

function writeFixture(dir, rel, body) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

/** 사본에서 `next build`를 실행한다(순차, 사본 고유 .next). 서버를 띄우지 않는다. */
function build(dir) {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.POD_LOCAL_FIXTURE;
  const r = spawnSync(process.execPath, [path.join(dir, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, signal: r.signal, error: r.error, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const tail = (text) => text.split("\n").slice(-60).join("\n");

function expectBuildOk(r, label) {
  assert.equal(r.error, undefined, `${label}: build could not run: ${r.error}`);
  assert.equal(r.status, 0, `${label}: next build failed (status ${r.status}, signal ${r.signal})\n${tail(r.output)}`);
}

/** 거부 사례: build가 실패했고 원인이 server-only의 client 경계 위반이어야 한다. */
function expectServerOnlyRejection(r, label, fixtureFile) {
  assert.equal(r.error, undefined, `${label}: build could not run: ${r.error}`);
  assert.notEqual(r.status, 0, `${label}: next build unexpectedly succeeded — the client graph accepted the auth module`);
  assert.match(r.output, /server-only/, `${label}: build failed for another reason (not server-only):\n${tail(r.output)}`);
  assert.match(
    r.output,
    /Client Component|use client/i,
    `${label}: build failed but not at a client boundary:\n${tail(r.output)}`,
  );
  assert.ok(r.output.includes(fixtureFile), `${label}: failure does not point at ${fixtureFile}:\n${tail(r.output)}`);
}

function cleanup() {
  for (const root of copies.splice(0)) rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- fixture(사본에만 쓴다)

const SERVER_PAGE = `import { loadSessionConfig, sessionCookieOptions } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default function AuthBoundaryServerProbe() {
  const r = loadSessionConfig({}, "production");
  return <p data-probe="server">{r.ok ? sessionCookieOptions(r.value, new Date(0)).name : r.error}</p>;
}
`;

const CLIENT_DIRECT = `"use client";
import { assertSameOrigin } from "@/server/auth/session";

export default function AuthBoundaryClientDirect() {
  return <p data-probe="client-direct">{typeof assertSameOrigin}</p>;
}
`;

const SHARED_BRIDGE = `import { readSession } from "@/server/auth/session";

export const sessionReader = readSession;
`;

const CLIENT_TRANSITIVE = `"use client";
import { sessionReader } from "@/shared/auth-boundary-bridge";

export default function AuthBoundaryClientTransitive() {
  return <p data-probe="client-transitive">{typeof sessionReader}</p>;
}
`;

const pageRendering = (component) => `import Probe from "./${component}";

export default function Page() {
  return <Probe />;
}
`;

// ---------------------------------------------------------------- 시험(순차)

test("① baseline copy without any auth import builds (environment positive control)", () => {
  requireIsolated();
  try {
    const dir = makeCopy("baseline");
    expectBuildOk(build(dir), "baseline");
  } finally {
    cleanup();
  }
});

test("② server page importing and using the real auth module builds (server positive)", () => {
  requireIsolated();
  requireAuthModule();
  try {
    const dir = makeCopy("server");
    writeFixture(dir, "src/app/auth-boundary-server/page.tsx", SERVER_PAGE);
    expectBuildOk(build(dir), "server positive");
  } finally {
    cleanup();
  }
});

test("③ client component importing the auth module directly fails next build because of server-only", () => {
  requireIsolated();
  requireAuthModule();
  try {
    const dir = makeCopy("client");
    writeFixture(dir, "src/app/auth-boundary-client/ClientDirect.tsx", CLIENT_DIRECT);
    writeFixture(dir, "src/app/auth-boundary-client/page.tsx", pageRendering("ClientDirect"));
    expectServerOnlyRejection(build(dir), "client direct", "ClientDirect");
  } finally {
    cleanup();
  }
});

test("④ client component importing the auth module through a shared module fails next build because of server-only", () => {
  requireIsolated();
  requireAuthModule();
  try {
    const dir = makeCopy("transitive");
    writeFixture(dir, "src/shared/auth-boundary-bridge.ts", SHARED_BRIDGE);
    writeFixture(dir, "src/app/auth-boundary-transitive/ClientTransitive.tsx", CLIENT_TRANSITIVE);
    writeFixture(dir, "src/app/auth-boundary-transitive/page.tsx", pageRendering("ClientTransitive"));
    expectServerOnlyRejection(build(dir), "client transitive", "ClientTransitive");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- F4 B4: 처리 함수·요청 context 경계(PLAN_mvp-oidc-integration §9 B1)
// B4 route·page가 쓰는 server/auth/handlers·server/auth/config·server/context를 fixture가 실제로 사용한다.
// 이 모듈들은 B2·B3에서 이미 있으므로 RED 단계에서도 통과할 수 있다(새 위험: route/page 연결 뒤 client 그래프로 새는 것을 막는 회귀).
// CI 시간을 위해 B4 사례는 서버 positive 1개 + client 거부 2개만 추가한다(기존 ①~④와 같은 사본 방식).

const B4_MODULES = [
  path.join("src", "server", "auth", "handlers.ts"),
  path.join("src", "server", "auth", "config.ts"),
  path.join("src", "server", "context.ts"),
];

function requireB4Modules() {
  for (const rel of B4_MODULES) {
    assert.ok(existsSync(path.join(APP_DIR, rel)), `F4 module ${rel} is missing. No build was started for this case.`);
  }
}

const SERVER_PAGE_B4 = `import { loadAuthConfig } from "@/server/auth/config";
import { handleLogout } from "@/server/auth/handlers";
import { getViewer } from "@/server/context";

export const dynamic = "force-dynamic";

export default async function AuthB4ServerProbe() {
  const r = handleLogout(loadAuthConfig({}, "production"), null);
  const v = await getViewer();
  return <p data-probe="server-b4">{r.status}:{v.kind}</p>;
}
`;

const CLIENT_DIRECT_B4 = `"use client";
import { handleLogout } from "@/server/auth/handlers";

export default function AuthB4ClientDirect() {
  return <p data-probe="client-direct-b4">{typeof handleLogout}</p>;
}
`;

const SHARED_BRIDGE_B4 = `import { getViewer } from "@/server/context";

export const viewerReader = getViewer;
`;

const CLIENT_TRANSITIVE_B4 = `"use client";
import { viewerReader } from "@/shared/auth-b4-bridge";

export default function AuthB4ClientTransitive() {
  return <p data-probe="client-transitive-b4">{typeof viewerReader}</p>;
}
`;

test("⑤ server page using the real handlers, auth config and request context builds (B4 server positive)", () => {
  requireIsolated();
  requireB4Modules();
  try {
    const dir = makeCopy("b4server");
    writeFixture(dir, "src/app/auth-b4-server/page.tsx", SERVER_PAGE_B4);
    expectBuildOk(build(dir), "B4 server positive");
  } finally {
    cleanup();
  }
});

test("⑥ client component importing the auth handlers directly fails next build because of server-only", () => {
  requireIsolated();
  requireB4Modules();
  try {
    const dir = makeCopy("b4client");
    writeFixture(dir, "src/app/auth-b4-client/AuthB4ClientDirect.tsx", CLIENT_DIRECT_B4);
    writeFixture(dir, "src/app/auth-b4-client/page.tsx", pageRendering("AuthB4ClientDirect"));
    expectServerOnlyRejection(build(dir), "B4 client direct", "AuthB4ClientDirect");
  } finally {
    cleanup();
  }
});

test("⑦ client component reaching the request context through a shared module fails next build because of server-only", () => {
  requireIsolated();
  requireB4Modules();
  try {
    const dir = makeCopy("b4transitive");
    writeFixture(dir, "src/shared/auth-b4-bridge.ts", SHARED_BRIDGE_B4);
    writeFixture(dir, "src/app/auth-b4-transitive/AuthB4ClientTransitive.tsx", CLIENT_TRANSITIVE_B4);
    writeFixture(dir, "src/app/auth-b4-transitive/page.tsx", pageRendering("AuthB4ClientTransitive"));
    expectServerOnlyRejection(build(dir), "B4 client transitive", "AuthB4ClientTransitive");
  } finally {
    cleanup();
  }
});
