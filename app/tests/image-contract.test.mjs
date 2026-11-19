// F6a1 RED — 실제 앱 이미지 계약(PLAN_dev-app-deployment §3·§4·§7 app-image 1~6단계).
// 실행(app에서): POD_FULL_CHECK_ISOLATED=1 POD_IMAGE_TEST_IMAGE=<image> ... node --test tests/image-contract.test.mjs
//
// 입력(공개 계약, 모두 필수. 하나라도 없거나 형식이 틀리면 Docker·DB에 손대기 전에 환경 오류로 실패한다 — skip·빈 검사 없음):
//   POD_FULL_CHECK_ISOLATED=1                 격리 Cloud·CI 전용 표시(공유 서버에서 실행하지 않는다)
//   POD_IMAGE_TEST_IMAGE                      시험할 이미지: 로컬 image ID `sha256:<64 hex>` 또는 CI 전용 tag `pod-app-ci:<[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}>`
//   POD_IMAGE_TEST_NETWORK                    CI 서비스 컨테이너 전용 Docker network ID(12~64 hex). 이름(host·bridge·none·edge 등)은 받지 않는다.
//                                             CI는 job.services.postgres.network 값을 `docker network inspect --format {{.Id}}`로 ID로 바꿔 전달한다.
//                                             inspect한 이름이 `github_network_<hex>`(Actions 서비스 network)이고 driver가 bridge여야 한다.
//   POD_IMAGE_TEST_DB_HOST                    그 network 안에서 PG18 서비스의 alias(예: CI services 키 이름). 포트는 서비스 내부 5432 고정.
//   POD_TEST_DB_DISPOSABLE=1, POD_TEST_ADMIN_URL   기존 일회용 PG18 harness 그대로(loopback 관리자 URL guard 유지).
// - Docker CLI는 고정 인자 배열로만 실행한다(shell 해석 없음). 컨테이너·DB·임시 파일은 사례마다 finally에서 정리한다.
// - 관리자·role URL과 비밀번호를 출력하지 않는다(실패 메시지도 가린다). trace·기록 파일을 남기지 않는다.
// - 기동 계약(main 기술 계약): CMD ["node","runtime-startup.mjs"]. wrapper가 원본 src/server/runtime-mode.ts의
//   assertFixtureModeAllowed·assertAuthModeAllowed("phase-production-server", process.env)를 부른 뒤 server.js를 import한다
//   (standalone server.js는 빌드 때 직렬화한 설정을 써 next.config 검사가 기동 때 다시 돌지 않을 수 있다).
//   helper 고정 실행은 entrypoint ["node"] + command ["--env-file=/run/secrets/pod_app_env","runtime-startup.mjs"]다.
// - Vitest의 expect를 쓰지 않는다. DB는 tests/db/helpers.ts의 순수 함수와 제품 migration CLI(이미지 안)만 쓴다.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  assertServerIs18,
  bootstrapRoles,
  cleanupAll,
  closeAllClients,
  createDisposableDatabase,
  readDisposableEnv,
  withAdmin,
} from "./db/helpers.ts";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = path.join(APP_DIR, "..");
const SOURCE_URL = "https://github.com/kindsr/devscent-pieceofdays-main";
const IMAGE_RE = /^(sha256:[0-9a-f]{64}|pod-app-ci:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
const NETWORK_ID_RE = /^[0-9a-f]{12,64}$/;
const DB_HOST_RE = /^[a-z][a-z0-9-]{0,62}$/;
const DB_PORT_IN_NETWORK = "5432";
const CASE_TIMEOUT = 300_000;
const FIXTURE_TEXT = ["창문을 열었더니", "엄마와 20분 통화", "은행나무 길이 반쯤"];

// ---------------------------------------------------------------- 입력 guard(fail closed)

function requireInputs() {
  assert.equal(
    process.env.POD_FULL_CHECK_ISOLATED,
    "1",
    "environment: POD_FULL_CHECK_ISOLATED=1 is required (isolated Cloud / CI only). Nothing was started.",
  );
  const image = process.env.POD_IMAGE_TEST_IMAGE ?? "";
  assert.match(image, IMAGE_RE, "environment: POD_IMAGE_TEST_IMAGE must be sha256:<64 hex> or pod-app-ci:<tag>. Nothing was started.");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(typeof uid === "number" && uid > 0 && typeof gid === "number" && gid > 0, "environment: run as a non-root user (the container uses the same numeric uid:gid)");
  return { image, user: `${uid}:${gid}`, uid, gid };
}

function requireDbInputs() {
  const network = process.env.POD_IMAGE_TEST_NETWORK ?? "";
  assert.match(network, NETWORK_ID_RE, "environment: POD_IMAGE_TEST_NETWORK must be a Docker network ID (12-64 hex), never a name like host/bridge/edge");
  const dbHost = process.env.POD_IMAGE_TEST_DB_HOST ?? "";
  assert.match(dbHost, DB_HOST_RE, "environment: POD_IMAGE_TEST_DB_HOST must be the PG18 service alias on that network");
  return { network, dbHost, env: readDisposableEnv() };
}

// ---------------------------------------------------------------- 실행 도우미

const secrets = new Set();
function redact(text) {
  let out = String(text);
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s) out = out.split(s).join("***");
  return out;
}
function rememberUrl(url) {
  secrets.add(url);
  const u = new URL(url);
  if (u.password) {
    secrets.add(u.password);
    secrets.add(decodeURIComponent(u.password));
  }
}

/** docker CLI를 고정 인자로 실행한다(shell 없음). */
function docker(args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", output: redact(`${stdout ?? ""}\n${stderr ?? ""}`) });
    });
  });
}

async function dockerOk(args, label, timeout) {
  const r = await docker(args, timeout);
  assert.equal(r.code, 0, `${label}: docker ${args[0]} failed\n${r.output.slice(-3000)}`);
  return r;
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

const containers = new Set();
const uniqueName = (label) => `pod-f6a1-${label}-${process.pid}-${randomBytes(4).toString("hex")}`;

async function removeContainers() {
  for (const name of [...containers]) {
    await docker(["rm", "-f", "-v", name], 60_000);
    containers.delete(name);
  }
}

/** 운영 후보와 같은 제한으로 컨테이너를 띄운다(host port·volume·privileged 없음). */
function hardenedArgs(ctx, name, { network = "none", envFile, envPairs = [], extra = [] } = {}) {
  return [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--tmpfs",
    `/app/.next/cache:rw,noexec,nosuid,size=64m,uid=${ctx.uid},gid=${ctx.gid},mode=0700`,
    "--user",
    ctx.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    ...(envFile ? ["--env-file", envFile] : []),
    ...envPairs.flatMap((p) => ["--env", p]),
    ...extra,
    ctx.image,
  ];
}

const HELPER_ENV_PATH = "/run/secrets/pod_app_env";

/** helper 고정 실행 형식: entrypoint node + ["--env-file=/run/secrets/pod_app_env", "runtime-startup.mjs"], env 파일 하나만 읽기 전용 bind. */
function helperArgs(ctx, name, envFile, network = "none") {
  const args = hardenedArgs(ctx, name, {
    network,
    extra: ["--mount", `type=bind,src=${envFile},dst=${HELPER_ENV_PATH},readonly`, "--entrypoint", "node"],
  });
  return [...args, `--env-file=${HELPER_ENV_PATH}`, "runtime-startup.mjs"];
}

/** 컨테이너가 끝나기를 기다려 종료 코드와 (가린) 로그를 돌려준다. */
async function waitExit(name, timeoutMs = 90_000) {
  const r = await docker(["wait", name], timeoutMs);
  const logs = await docker(["logs", name], 30_000);
  return { waited: r.code === 0, code: Number(r.stdout.trim()), logs: logs.output };
}

const PROBE = `const u = process.argv[1];
fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) })
  .then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text(), cc: r.headers.get("cache-control"), ct: r.headers.get("content-type") })))
  .catch((e) => console.log(JSON.stringify({ error: String(e && e.name) })));`;

/** 컨테이너 안에서 127.0.0.1:3000으로 요청한다(network none에서도 동작). */
async function probe(name, pathName) {
  const r = await docker(["exec", name, "node", "-e", PROBE, `http://127.0.0.1:3000${pathName}`], 30_000);
  if (r.code !== 0) return { error: `exec ${r.code}` };
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    return { error: "unparsable probe output" };
  }
}

async function isRunning(name) {
  const r = await docker(["inspect", "--format", "{{.State.Running}}", name], 30_000);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** /healthz가 200이 될 때까지 기다린다. 컨테이너가 끝나면 그 사실을 돌려준다. */
async function waitLive(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) return { exited: true };
    const p = await probe(name, "/healthz");
    if (p.status === 200) return { exited: false };
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = await docker(["logs", "--tail", "60", name], 30_000);
  assert.fail(`${name}: /healthz did not answer 200 within ${timeoutMs}ms\n${logs.output.slice(-3000)}`);
}

function expectPlain(p, status, body, label) {
  assert.equal(p.error, undefined, `${label}: probe failed (${p.error})`);
  assert.equal(p.status, status, `${label}: status`);
  assert.equal(p.body, body, `${label}: fixed body`);
  assert.match(String(p.cc ?? ""), /(^|,|\s)no-store(,|$|\s)/, `${label}: no-store`);
  assert.equal(String(p.ct ?? "").toLowerCase().replace(/\s+/g, ""), "text/plain;charset=utf-8", `${label}: text/plain`);
}

function latestMigration() {
  const nums = readdirSync(path.join(APP_DIR, "migrations"))
    .map((f) => /^(\d{4})_.+\.up\.sql$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(nums.length > 0, "repository has migrations");
  return Math.max(...nums);
}

async function inspectImage(image) {
  const r = await dockerOk(["image", "inspect", image], "image inspect");
  const list = JSON.parse(r.stdout);
  assert.equal(list.length, 1, "exactly one image");
  return list[0];
}

// ================================================================= 1. 메타데이터

test("image metadata: linux/amd64, non-root, PORT 3000, NODE_ENV production, fixed CMD, source/revision/tree/migrations labels, no volumes or secret env", { timeout: CASE_TIMEOUT }, async () => {
  const ctx = requireInputs();
  const img = await inspectImage(ctx.image);
  assert.equal(img.Os, "linux");
  assert.equal(img.Architecture, "amd64");
  const cfg = img.Config ?? {};
  assert.ok(cfg.User && !/^(root|0)(:|$)/.test(cfg.User), `non-root USER (got ${JSON.stringify(cfg.User)})`);
  assert.equal(cfg.WorkingDir, "/app");
  assert.deepEqual(cfg.Cmd, ["node", "runtime-startup.mjs"], "starts through the mode-check wrapper");
  assert.ok(!cfg.Entrypoint || cfg.Entrypoint.length === 0 || JSON.stringify(cfg.Entrypoint) === '["docker-entrypoint.sh"]', "no custom entrypoint");
  assert.deepEqual(Object.keys(cfg.ExposedPorts ?? {}), ["3000/tcp"]);
  const env = Object.fromEntries((cfg.Env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert.equal(env.PORT, "3000");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
  const forbidden = Object.keys(env).filter((k) => k.startsWith("POD_") || /SECRET|PASSWORD|TOKEN|PRIVATE|DATABASE_URL|_KEY$/i.test(k));
  assert.deepEqual(forbidden, [], "no POD_* or secret-like env baked into the image");
  assert.ok(!cfg.Volumes || Object.keys(cfg.Volumes).length === 0, "no VOLUME");
  const labels = cfg.Labels ?? {};
  assert.equal(labels["org.opencontainers.image.source"], SOURCE_URL);
  assert.equal(labels["org.opencontainers.image.revision"], await git(["rev-parse", "HEAD"]), "revision label = checked-out commit");
  assert.equal(labels["pod.tree"], await git(["rev-parse", "HEAD^{tree}"]), "tree label = checked-out tree");
  assert.match(String(labels["pod.migrations.latest"] ?? ""), /^\d+$/);
  assert.equal(Number(labels["pod.migrations.latest"]), latestMigration(), "migrations label = latest migration in the repository");
});

// ================================================================= 2. 파일 구성

const FS_SCRIPT = `const fs = require("node:fs"), path = require("node:path");
const out = { envFiles: [], forbidden: [] };
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (/^\\.env/.test(e.name)) out.envFiles.push(p);
  if (e.isDirectory() && p !== "/app/node_modules") walk(p);
} };
walk("/app");
for (const p of ["/app/tests", "/app/test-results", "/app/playwright-report", "/app/.next/cache/images", "/app/src/app", "/app/Dockerfile", "/app/.dockerignore", "/app/.npmrc"]) if (fs.existsSync(p)) out.forbidden.push(p);
out.server = fs.existsSync("/app/server.js");
out.wrapper = ["/app/runtime-startup.mjs", "/app/src/server/runtime-mode.ts"].map((f) => fs.existsSync(f));
out.staticFiles = fs.existsSync("/app/.next/static") ? fs.readdirSync("/app/.next/static", { recursive: true }).length : 0;
out.public = fs.existsSync("/app/public") ? fs.readdirSync("/app/public").sort() : null;
out.migrate = ["migrate-cli.ts", "migrate.ts", "sql-policy.ts"].map((f) => fs.existsSync("/app/src/server/db/" + f));
out.photoCleanup = ["cleanup-cli.mjs", "cleanup-core.mjs", "config-core.mjs", "blob-store.s3-core.mjs"].map((f) => fs.existsSync("/app/src/server/photos/" + f));
out.storyWorkerCli = fs.existsSync("/app/src/server/stories/worker-cli.mjs");
out.migrations = fs.existsSync("/app/migrations") ? fs.readdirSync("/app/migrations").sort() : null;
try { require.resolve("pg", { paths: ["/app/src/server/db"] }); out.pg = true; } catch { out.pg = false; }
console.log(JSON.stringify(out));`;

// Dependency/native ABI and memory probe only. This does not import or emulate normalizePhoto.
const SHARP_MEMORY_PROBE = `(async () => {
  const fs = require("node:fs"), sharp = require("sharp");
  const started = performance.now(), input = fs.readFileSync(process.argv[1]);
  const original = await sharp(input).metadata();
  const output = await sharp(input, { limitInputPixels: 40000000, sequentialRead: true })
    .autoOrient().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  const decoded = await sharp(output).metadata();
  const number = (name) => Number(fs.readFileSync("/sys/fs/cgroup/" + name, "utf8").trim());
  console.log(JSON.stringify({ inputFormat: original.format, inputWidth: original.width, inputHeight: original.height,
    inputBytes: input.length, outputFormat: decoded.format, width: decoded.width, height: decoded.height, outputBytes: output.length,
    jpegSignature: output[0] === 255 && output[1] === 216 && output[2] === 255 && output.at(-2) === 255 && output.at(-1) === 217,
    memoryMax: number("memory.max"), swapMax: number("memory.swap.max"), cgroupPeakBytes: number("memory.peak"),
    maxRssBytes: process.resourceUsage().maxRSS * 1024, elapsedMs: Math.ceil(performance.now() - started) }));
})().catch(() => { console.error("sharp-dependency-probe: failed"); process.exitCode = 1; });`;

test("image files: standalone assets and migrate/cleanup CLI runtime; Sharp dependency/native 512MiB probe; no .env*, tests or build artifacts", { timeout: CASE_TIMEOUT }, async () => {
  const input = requireInputs();
  assert.equal(process.env.CI, "true", "photo image probes generate synthetic fixtures in CI only");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "photo image probes require Actions");
  const image = await inspectImage(input.image);
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/, "all file/runtime probes use one immutable image ID");
  const ctx = { ...input, image: image.Id };
  const r = await dockerOk(
    ["run", "--rm", "--network", "none", "--read-only", "--user", ctx.user, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "node", ctx.image, "-e", FS_SCRIPT],
    "file listing",
  );
  const fsInfo = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(fsInfo.envFiles, [], "no .env* file outside node_modules");
  assert.deepEqual(fsInfo.forbidden, [], "no tests, test artifacts, sources or build inputs");
  assert.equal(fsInfo.server, true, "standalone server.js");
  assert.deepEqual(fsInfo.wrapper, [true, true], "runtime-startup.mjs and the original src/server/runtime-mode.ts");
  assert.ok(fsInfo.staticFiles > 0, ".next/static copied");
  assert.deepEqual(fsInfo.public, readdirSync(path.join(APP_DIR, "public")).sort(), "public copied as in the repository");
  assert.deepEqual(fsInfo.migrate, [true, true, true], "migrate-cli.ts, migrate.ts, sql-policy.ts at /app/src/server/db");
  assert.deepEqual(fsInfo.photoCleanup, [true, true, true, true], "raw cleanup CLI and its three pure cores are packaged");
  assert.equal(fsInfo.storyWorkerCli, true, "the native story worker CLI is packaged at /app/src/server/stories/worker-cli.mjs (PLAN_ai-story-live-generation §4.8, §7)");
  assert.deepEqual(fsInfo.migrations, readdirSync(path.join(APP_DIR, "migrations")).sort(), "migrations identical to the repository list");
  assert.equal(fsInfo.pg, true, "pg resolvable for the migrate CLI");
  const owner = randomBytes(16).toString("hex");
  const label = `pod.photo-image-owner=${owner}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "pod-photo-image-input-"));
  chmodSync(tmp, 0o700);
  const runNode = async (tag, argv, envPairs = [], extra = []) => {
    const name = uniqueName(tag);
    const args = hardenedArgs(ctx, name, { envPairs, extra: ["--label", label, "--entrypoint", "node", ...extra] });
    const created = await dockerOk(["create", ...args.slice(2), ...argv], `${tag}: create`);
    const id = created.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    await dockerOk(["start", id], `${tag}: start`);
    const waited = await docker(["wait", id], 90_000);
    assert.equal(waited.code, 0, `${tag}: bounded container exit`);
    const info = JSON.parse((await dockerOk(["inspect", id], `${tag}: inspect`)).stdout)[0];
    assert.equal(info.Image, ctx.image, `${tag}: same immutable image`);
    assert.equal(info.Config.Labels["pod.photo-image-owner"], owner, `${tag}: owned container`);
    return { code: Number(waited.stdout.trim()), info, logs: await dockerOk(["logs", id], `${tag}: logs`) };
  };
  try {
    const fakeDsn = "postgres://ci_only_cleanup:ci-only-image-db-password@127.0.0.1:9/ci_only_photos";
    rememberUrl(fakeDsn);
    const complete = [`POD_PHOTO_CLEANUP_DATABASE_URL=${fakeDsn}`, "POD_PHOTOS_S3_ENDPOINT=https://photo-ci-only.invalid",
      "POD_PHOTOS_S3_REGION=us-east-1", "POD_PHOTOS_S3_BUCKET=ci-only-photo-image", "POD_PHOTOS_S3_ACCESS_KEY_ID=ci-only-image-access",
      "POD_PHOTOS_S3_SECRET_ACCESS_KEY=ci-only-image-secret-not-production"];
    for (const pair of complete) secrets.add(pair.slice(pair.indexOf("=") + 1));
    for (const [tag, envPairs] of [["cleanup-empty", []], ["cleanup-configured", complete]]) {
      const result = await runNode(tag, ["src/server/photos/cleanup-cli.mjs", "--limit", "1"], envPairs);
      assert.equal(result.code, 1, `${tag}: fixed failure exit, not an import/loader failure`);
      assert.equal(result.logs.stdout, "", `${tag}: no success stdout`);
      assert.equal(redact(result.logs.stderr), "photo-cleanup: unavailable\n", `${tag}: exactly one fixed stderr line`);
      assert.doesNotMatch(result.logs.output, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError|\n\s+at /, `${tag}: eager CLI/core/SDK imports must work`);
      assert.equal(result.info.State.OOMKilled, false);
    }

    const { default: sharp } = await import("sharp"); // CI fixture generation is outside every measured container.
    for (const format of ["jpeg", "png", "webp"]) {
      const create = { width: 8000, height: 5000, channels: format === "png" ? 4 : 3, background: { r: 92, g: 136, b: 174, alpha: 0.5 } };
      let generator = sharp({ create });
      if (format === "jpeg") generator = generator.withMetadata({ orientation: 6 });
      let bytes = await generator[format]().toBuffer();
      assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, `${format}: synthetic 40MP input fits 8MiB`);
      if (format === "jpeg") { const padded = Buffer.alloc(8 * 1024 * 1024); bytes.copy(padded); bytes = padded; }
      const filename = `input.${format}`;
      writeFileSync(path.join(tmp, filename), bytes, { mode: 0o600, flag: "wx" });
      const result = await runNode(`sharp-${format}`, ["-e", SHARP_MEMORY_PROBE, `/photo-inputs/${filename}`], [],
        ["--memory", "512m", "--memory-swap", "512m", "--mount", `type=bind,src=${tmp},dst=/photo-inputs,readonly`]);
      assert.equal(result.info.HostConfig.Memory, 536870912, `${format}: whole-container memory limit`);
      assert.equal(result.info.HostConfig.MemorySwap, 536870912, `${format}: no additional swap`);
      assert.equal(result.info.State.OOMKilled, false, `${format}: no OOM kill`);
      assert.equal(result.code, 0, `${format}: native probe completed within the limit`);
      assert.equal(result.logs.stderr, "", `${format}: no loader/native errors`);
      const mount = result.info.Mounts.filter((entry) => entry.Destination === "/photo-inputs");
      assert.equal(mount.length, 1);
      assert.equal(mount[0].Source, tmp);
      assert.equal(mount[0].RW, false, "synthetic inputs are read-only");
      const metrics = JSON.parse(result.logs.stdout);
      assert.equal(metrics.memoryMax, 536870912, `${format}: actual cgroup v2 memory.max`);
      assert.equal(metrics.swapMax, 0, `${format}: actual cgroup swap.max`);
      for (const key of ["cgroupPeakBytes", "maxRssBytes", "elapsedMs"]) assert.ok(Number.isSafeInteger(metrics[key]) && metrics[key] > 0, `${format}: numeric ${key}`);
      assert.ok(metrics.cgroupPeakBytes <= 536870912 && metrics.maxRssBytes <= 536870912);
      assert.equal(metrics.inputFormat, format);
      assert.equal(metrics.inputWidth * metrics.inputHeight, 40_000_000);
      assert.equal(metrics.inputBytes, bytes.length);
      assert.equal(metrics.outputFormat, "jpeg");
      assert.deepEqual([metrics.width, metrics.height], format === "jpeg" ? [1600, 2560] : [2560, 1600]);
      assert.ok(metrics.outputBytes > 0 && metrics.outputBytes <= 4 * 1024 * 1024);
      assert.equal(metrics.jpegSignature, true);
      console.log(`Sharp dependency/native memory probe only: ${JSON.stringify({ image: ctx.image, ...metrics })}`);
    }
  } finally {
    const failures = [];
    try {
      const ids = (await dockerOk(["ps", "-aq", "--filter", `label=${label}`], "owned photo probe lookup")).stdout.trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        try {
          assert.match(id, /^[0-9a-f]{12,64}$/);
          const info = JSON.parse((await dockerOk(["inspect", id], "owned photo probe inspect")).stdout)[0];
          assert.equal(info.Config.Labels["pod.photo-image-owner"], owner);
          assert.equal(info.Image, ctx.image);
          await dockerOk(["rm", "-f", "-v", id], "owned photo probe removal", 60_000);
        } catch { failures.push("owned container removal"); }
      }
      assert.equal((await dockerOk(["ps", "-aq", "--filter", `label=${label}`], "owned photo probe remnants")).stdout.trim(), "");
    } catch { failures.push("owned container lookup/remnants"); }
    finally { try { rmSync(tmp, { recursive: true }); } catch { failures.push("owned synthetic inputs"); } }
    assert.deepEqual(failures, [], "photo image probe resources were removed");
  }
});

// ================================================================= 3. 제한 기동(env 없음)

test("hardened start with no env (network none, read-only, tmpfs, numeric uid, cap-drop ALL, no-new-privileges): /healthz 200, /healthz/ready 503", { timeout: CASE_TIMEOUT }, async () => {
  const ctx = requireInputs();
  const name = uniqueName("bare");
  try {
    containers.add(name);
    await dockerOk(hardenedArgs(ctx, name), "start");
    const state = await waitLive(name);
    assert.equal(state.exited, false, "server kept running");
    const ins = JSON.parse((await dockerOk(["inspect", name], "inspect")).stdout)[0];
    assert.equal(ins.HostConfig.ReadonlyRootfs, true);
    assert.equal(ins.HostConfig.NetworkMode, "none");
    assert.deepEqual(ins.HostConfig.CapDrop, ["ALL"]);
    assert.ok((ins.HostConfig.SecurityOpt ?? []).includes("no-new-privileges:true"));
    assert.equal(ins.HostConfig.Privileged, false);
    assert.deepEqual(ins.Mounts ?? [], [], "no volume or bind mount");
    assert.ok(!ins.HostConfig.PortBindings || Object.keys(ins.HostConfig.PortBindings).length === 0, "no host port");
    assert.deepEqual((ins.Config.Env ?? []).filter((e) => e.startsWith("POD_")), [], "no POD_* env");
    const uid = await dockerOk(["exec", name, "node", "-e", "console.log(process.getuid())"], "uid");
    assert.equal(uid.stdout.trim(), String(ctx.uid), "runs as the given non-root uid");
    expectPlain(await probe(name, "/healthz"), 200, "ok", "/healthz");
    expectPlain(await probe(name, "/healthz/ready"), 503, "not ready", "/healthz/ready without POD_DATABASE_URL");
  } finally {
    await removeContainers();
  }
});

// ================================================================= 4. 운영 모드 경계(기동 거부)

test("startup refuses fixture or mock-issuer env in production through runtime-startup.mjs (image CMD and the helper command form): non-zero exit, never serving", { timeout: CASE_TIMEOUT }, async () => {
  const ctx = requireInputs();
  const auth = ["POD_AUTH_PROVIDERS=google", "POD_AUTH_GOOGLE_CLIENT_ID=ci-only-f6a1-client", "POD_AUTH_GOOGLE_CLIENT_SECRET=ci-only-f6a1-secret", `POD_AUTH_SESSION_SECRETS={"1":"${"ci-only-f6a1-session-key-1-".padEnd(40, "x")}"}`, "POD_AUTH_BASE_URL=https://pieceofdays.example"];
  const cases = [
    { label: "fixture", env: ["POD_LOCAL_FIXTURE=1"], message: "POD_LOCAL_FIXTURE=1 is refused in phase-production-server" },
    { label: "fixtureauth", env: ["POD_LOCAL_FIXTURE=1", ...auth], message: "POD_LOCAL_FIXTURE=1 is refused in phase-production-server" },
    { label: "mock", env: ["POD_AUTH_MOCK_OIDC_ISSUER=http://127.0.0.1:9"], message: "POD_AUTH_MOCK_OIDC_ISSUER is refused in phase-production-server" },
    { label: "mockauth", env: [...auth, "POD_AUTH_MOCK_OIDC_ISSUER=http://127.0.0.1:9"], message: "POD_AUTH_MOCK_OIDC_ISSUER is refused in phase-production-server" },
  ];
  const tmp = mkdtempSync(path.join(tmpdir(), "pod-f6a1-mode-"));
  chmodSync(tmp, 0o700);
  try {
    for (const c of cases) {
      const envFile = path.join(tmp, `${c.label}.env`);
      writeFileSync(envFile, `${c.env.join("\n")}\n`, { mode: 0o600 });
      for (const [form, args] of [
        ["image CMD", (name) => hardenedArgs(ctx, name, { envPairs: c.env })],
        ["helper command", (name) => helperArgs(ctx, name, envFile)],
      ]) {
        const name = uniqueName(c.label);
        containers.add(name);
        await dockerOk(args(name), `${c.label} (${form}): create`);
        const r = await waitExit(name);
        assert.equal(r.waited, true, `${c.label} (${form}): the server must exit instead of serving`);
        assert.notEqual(r.code, 0, `${c.label} (${form}): non-zero exit`);
        assert.ok(r.logs.includes(c.message), `${c.label} (${form}): refusal message\n${r.logs.slice(-2000)}`);
        assert.ok(!/Ready in|started server|Listening/i.test(r.logs), `${c.label} (${form}): server.js must not start`);
        for (const t of FIXTURE_TEXT) assert.ok(!r.logs.includes(t), `${c.label} (${form}): no sample data`);
      }
    }
  } finally {
    await removeContainers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the helper command form with an env file of ordinary keys starts the server (no refusal) and answers /healthz 200", { timeout: CASE_TIMEOUT }, async () => {
  const ctx = requireInputs();
  const tmp = mkdtempSync(path.join(tmpdir(), "pod-f6a1-helper-"));
  chmodSync(tmp, 0o700);
  try {
    const envFile = path.join(tmp, "pod_app_env");
    writeFileSync(envFile, "POD_LOCAL_FIXTURE=\n", { mode: 0o600 });
    const name = uniqueName("helper");
    containers.add(name);
    await dockerOk(helperArgs(ctx, name, envFile), "helper start");
    assert.equal((await waitLive(name)).exited, false, "server kept running");
    expectPlain(await probe(name, "/healthz"), 200, "ok", "helper /healthz");
    expectPlain(await probe(name, "/healthz/ready"), 503, "not ready", "helper /healthz/ready without POD_DATABASE_URL");
  } finally {
    await removeContainers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ================================================================= 5·6. 실제 PG18: migration CLI·readiness

test("same image on PG18: the fixed migrate CLI runs status/up with the migrator env file up to the latest migration, then /healthz/ready is 200 with the app role and writes nothing", { timeout: CASE_TIMEOUT }, async () => {
  const ctx = requireInputs();
  const { network, dbHost, env } = requireDbInputs();
  rememberUrl(env.adminUrl);
  const tmp = mkdtempSync(path.join(tmpdir(), "pod-f6a1-"));
  chmodSync(tmp, 0o700);
  try {
    const net = JSON.parse((await dockerOk(["network", "inspect", network], "network inspect")).stdout)[0];
    assert.match(String(net.Name), /^github_network_[0-9a-f]+$/, "only the CI service network is accepted");
    assert.equal(net.Driver, "bridge");

    await withAdmin(env, async (admin) => {
      await assertServerIs18(admin);
      await bootstrapRoles(admin);
    });
    const db = await createDisposableDatabase(env, "f6aimage");
    for (const u of Object.values(db.urls)) rememberUrl(u);
    const inNetwork = (url) => {
      const u = new URL(url);
      u.hostname = dbHost;
      u.port = DB_PORT_IN_NETWORK;
      return u.toString();
    };
    const migratorFile = path.join(tmp, "migrator.env");
    writeFileSync(migratorFile, `POD_MIGRATE_DATABASE_URL=${inNetwork(db.urls.migrator)}\n`, { mode: 0o600 });
    const appFile = path.join(tmp, "pod_app_env");
    writeFileSync(appFile, `POD_DATABASE_URL=${inNetwork(db.urls.app)}\n`, { mode: 0o600 });
    rememberUrl(inNetwork(db.urls.migrator));
    rememberUrl(inNetwork(db.urls.app));

    const migrate = (cmd) =>
      docker(
        [
          "run",
          "--rm",
          "--network",
          network,
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
          "--user",
          ctx.user,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--mount",
          `type=bind,src=${migratorFile},dst=/run/secrets/migrator.env,readonly`,
          "--workdir",
          "/app",
          "--entrypoint",
          "node",
          ctx.image,
          "--env-file=/run/secrets/migrator.env",
          "src/server/db/migrate-cli.ts",
          cmd,
        ],
        180_000,
      );
    const versions = () =>
      withAdmin(env, async (c) => (await c.query("SELECT version FROM pod_meta.schema_migrations ORDER BY version")).rows.map((r) => r.version), db.name);

    const before = await migrate("status");
    assert.equal(before.code, 0, `status before up\n${before.output.slice(-2000)}`);
    const up = await migrate("up");
    assert.equal(up.code, 0, `up\n${up.output.slice(-2000)}`);
    const latest = latestMigration();
    assert.deepEqual(await versions(), Array.from({ length: latest }, (_, i) => i + 1), `applied 1..${latest}`);
    const again = await migrate("up");
    assert.equal(again.code, 0, `second up is a no-op\n${again.output.slice(-2000)}`);
    const after = await migrate("status");
    assert.equal(after.code, 0, `status after up\n${after.output.slice(-2000)}`);
    assert.deepEqual(await versions(), Array.from({ length: latest }, (_, i) => i + 1), "unchanged by the second up");
    for (const r of [before, up, again, after]) {
      for (const s of secrets) if (s.length >= 6) assert.ok(!`${r.stdout}${r.stderr}`.includes(s), "migrate output must not contain URLs or passwords");
    }

    const counts = () =>
      withAdmin(
        env,
        async (c) =>
          (
            await c.query(
              `SELECT (SELECT count(*)::int FROM pod.users) AS users, (SELECT count(*)::int FROM pod.auth_identities) AS identities,
                      (SELECT count(*)::int FROM pod.credit_accounts) AS accounts, (SELECT count(*)::int FROM pod.emotion_ledger) AS ledger,
                      (SELECT count(*)::int FROM pod_meta.schema_migrations) AS migrations`,
            )
          ).rows[0],
        db.name,
      );
    const beforeCounts = await counts();
    const name = uniqueName("ready");
    containers.add(name);
    await dockerOk(helperArgs(ctx, name, appFile, network), "app start (helper command form)");
    assert.equal((await waitLive(name)).exited, false, "app kept running");
    expectPlain(await probe(name, "/healthz"), 200, "ok", "/healthz with DB");
    expectPlain(await probe(name, "/healthz/ready"), 200, "ok", "/healthz/ready with the app role");
    expectPlain(await probe(name, "/healthz/ready"), 200, "ok", "/healthz/ready again");
    assert.deepEqual(await counts(), beforeCounts, "readiness writes nothing");
    const logs = await docker(["logs", name], 30_000);
    for (const s of secrets) if (s.length >= 6) assert.ok(!`${logs.stdout}${logs.stderr}`.includes(s), "app logs must not contain URLs or passwords");
  } finally {
    await removeContainers();
    rmSync(tmp, { recursive: true, force: true });
    await cleanupAll(env).finally(() => closeAllClients());
  }
});
