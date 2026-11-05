// F6b RED — 앱 env 파일 부분집합의 Python 검사기 ↔ 실제 Node --env-file 동일성(PLAN_dev-app-deployment R2 §6.3).
//
// node:test 스크립트다. Node 26.13.0과 Python 표준 라이브러리만 쓴다(npm·서버·DB·Docker·Secrets 없음).
// - Python: scripts/ops/deploy.py의 validate_app_env(text, settings)를 `python3 -I`로 불러 stdin의 가짜 env를 검사한다.
//   함수가 없으면 각 test 안에서 명시 실패한다(정상 RED). Python이 없으면 실패한다(skip/통과로 세지 않음).
// - Node: 같은 파일을 실제 `process.execPath --env-file=<임시 파일>`로 읽어 키·값을 비교한다.
// - 자식 프로세스는 고정 argument 배열과 빈 env만 쓴다(쉘 문자열 평가 없음, 실제 HOME 등 시스템 env를 넘기거나 바꾸지 않는다).
// 실행: Node 26.13.0에서 `node --test app/tests/deploy-env-parity.test.mjs`(GREEN의 deploy-app-validation workflow가 고정).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_PY = path.join(REPO, "scripts", "ops", "deploy.py");
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3"].find((p) => existsSync(p));
const WORK = mkdtempSync(path.join(tmpdir(), "pod-env-parity-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

// 시험용 가짜 값만(ci-only-*). settings는 PLAN §6.2의 URL 기대값 키.
const SETTINGS = {
  app_mode_enabled: true,
  app_env_file: "/nonexistent/app.env",
  db_network: "ci-only-db-network",
  app_health_url: "https://dev.pieceofdays.com/try/",
  app_role: "pod_app_dev",
  db_host: "ci-only-pg18",
  dev_db: "pod_dev",
  server_arch: "amd64",
};
const SESSION = JSON.stringify({ 1: "ci-only-parity-session-key-1-".padEnd(40, "x") });
const BASE_ENTRIES = [
  ["POD_AUTH_SESSION_SECRETS", SESSION],
  ["POD_AUTH_BASE_URL", "https://dev.pieceofdays.com"],
  ["POD_AUTH_PROVIDERS", "google"],
  ["POD_AUTH_GOOGLE_CLIENT_ID", "ci-only-parity-google-client"],
  ["POD_AUTH_GOOGLE_CLIENT_SECRET", "ci-only-parity-google-secret"],
  ["POD_DATABASE_URL", "postgres://pod_app_dev:ci-only-parity-pass@ci-only-pg18/pod_dev"],
];
const lines = (entries) => entries.map(([k, v]) => `${k}=${v}\n`).join("");
const replace = (entries, key, value) => entries.map(([k, v]) => [k, k === key ? value : v]);

// Python 쪽: 고정 스크립트(인자 배열로 전달), 텍스트는 stdin, settings는 argv JSON.
const PY_SCRIPT = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('pod_deploy_env_parity', sys.argv[1])",
  "mod = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "if not hasattr(mod, 'validate_app_env'):",
  "    print(json.dumps({'missing': 'validate_app_env'})); sys.exit(3)",
  "text = sys.stdin.buffer.read().decode('utf-8')",
  "try:",
  "    result = mod.validate_app_env(text, json.loads(sys.argv[2]))",
  "except ValueError as error:",
  "    print(json.dumps({'error': type(error).__name__, 'message': str(error)})); sys.exit(2)",
  "print(json.dumps({'ok': result}))",
].join("\n");

function python(text) {
  assert.ok(PYTHON, "python3 (stdlib) is required; a missing interpreter is a failure, not a skip");
  const r = spawnSync(PYTHON, ["-I", "-B", "-c", PY_SCRIPT, DEPLOY_PY, JSON.stringify(SETTINGS)], {
    input: Buffer.from(text, "utf8"),
    env: {},
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = (() => {
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop() || "null");
    } catch {
      return null;
    }
  })();
  assert.notEqual(r.status, 3, "scripts/ops/deploy.py must define validate_app_env (PLAN_dev-app-deployment §6.3)");
  assert.ok(out && (r.status === 0 || r.status === 2), `python validator crashed (status ${r.status}): ${r.stderr.slice(-400)}`);
  return out;
}

let seq = 0;
function nodeEnvFile(text, keys) {
  const file = path.join(WORK, `case-${++seq}.env`);
  writeFileSync(file, text, { mode: 0o600 });
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter((k) => Object.hasOwn(process.env, k)).map((k) => [k, process.env[k]]))))`;
  const r = spawnSync(process.execPath, [`--env-file=${file}`, "-e", script], { env: {}, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, `node --env-file failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout);
}

/** 모든 줄의 키(주석·빈 줄 제외)를 원문 그대로 모은다. */
const keysOf = (text) =>
  text
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(0, l.indexOf("=")));

test("runs on the pinned Node 26.13.0 with a real --env-file parser", () => {
  assert.equal(process.versions.node, "26.13.0", "parity is claimed only for the pinned Node 26.13.0");
  assert.ok(path.isAbsolute(process.execPath));
});

const VALID = {
  "base google": lines(BASE_ENTRIES),
  "google+kakao, withdrawal, two session keys, postgresql scheme": lines([
    ["POD_AUTH_SESSION_SECRETS", JSON.stringify({ 1: "a".repeat(32), 2: "ci-only-parity-session-key-2-".padEnd(48, "z") })],
    ["POD_AUTH_BASE_URL", "https://dev.pieceofdays.com"],
    ["POD_AUTH_PROVIDERS", "google,kakao"],
    ["POD_AUTH_GOOGLE_CLIENT_ID", "ci-only-parity-google-client"],
    ["POD_AUTH_GOOGLE_CLIENT_SECRET", "ci-only-parity-google-secret"],
    ["POD_AUTH_KAKAO_CLIENT_ID", "ci-only-parity-kakao-client"],
    ["POD_AUTH_KAKAO_CLIENT_SECRET", "ci-only-parity-kakao-secret"],
    ["POD_WITHDRAWAL_ENABLED", "1"],
    ["POD_DATABASE_URL", "postgresql://pod_app_dev:ci-only-parity-pass@ci-only-pg18/pod_dev"],
  ]),
  "comments and blank lines": `# ci-only comment\n\n${lines(BASE_ENTRIES)}\n# trailing comment\n`,
  "= and inner spaces kept in values": lines(
    replace(replace(BASE_ENTRIES, "POD_AUTH_GOOGLE_CLIENT_SECRET", "ci-only=parity==secret"), "POD_AUTH_GOOGLE_CLIENT_ID", "ci-only parity client"),
  ),
  "percent-encoded password": lines(replace(BASE_ENTRIES, "POD_DATABASE_URL", "postgres://pod_app_dev:ci%2Donly%40pass@ci-only-pg18/pod_dev")),
  "no trailing newline": lines(BASE_ENTRIES).slice(0, -1),
};

for (const [label, text] of Object.entries(VALID)) {
  test(`accepted file is read identically by Python and Node --env-file: ${label}`, () => {
    const py = python(text);
    assert.ok(py.ok, `python rejected a valid file: ${py.message ?? ""}`);
    const keys = keysOf(text);
    const node = nodeEnvFile(text, keys);
    assert.deepEqual(Object.keys(py.ok).sort(), [...keys].sort(), "python returns exactly the file keys");
    assert.deepEqual(node, py.ok, "Node --env-file values equal the Python values");
  });
}

const base = lines(BASE_ENTRIES);
const SECRET = "ci-only-parity-google-secret";
const REJECTED = {
  "UTF-8 BOM": `﻿${base}`,
  CRLF: base.replaceAll("\n", "\r\n"),
  "bare CR": base.replace("\n", "\r"),
  NUL: `${base}POD_X\u0000=1\n`,
  "other control char": base.replace(SECRET, `ci-only\u0007secret`),
  "tab in value": base.replace(SECRET, `ci-only\tsecret`),
  "export prefix": base.replace("POD_AUTH_PROVIDERS=", "export POD_AUTH_PROVIDERS="),
  "duplicate key": `${base}POD_AUTH_PROVIDERS=google\n`,
  "space before key": base.replace("POD_AUTH_PROVIDERS=", " POD_AUTH_PROVIDERS="),
  "space before =": base.replace("POD_AUTH_PROVIDERS=", "POD_AUTH_PROVIDERS ="),
  "leading space in value": base.replace(`=${SECRET}`, `= ${SECRET}`),
  "trailing space in value": base.replace(`${SECRET}\n`, `${SECRET} \n`),
  "# inside value": base.replace(SECRET, `${SECRET}#x`),
  "inline comment": base.replace(SECRET, `${SECRET} # note`),
  "double quote": base.replace(`=${SECRET}`, `="${SECRET}"`),
  "single quote": base.replace(`=${SECRET}`, `='${SECRET}'`),
  backtick: base.replace(`=${SECRET}`, `=\`${SECRET}\``),
  "empty value": base.replace("=ci-only-parity-google-client", "="),
  "multi-line quoted value": base.replace(`=${SECRET}`, `="ci-only\nparity"`),
  "forbidden NODE_OPTIONS": `${base}NODE_OPTIONS=--require=/tmp/x.js\n`,
  "forbidden fixture": `${base}POD_LOCAL_FIXTURE=1\n`,
};

for (const [label, text] of Object.entries(REJECTED)) {
  test(`Python rejects text outside the Node-identical subset without echoing values: ${label}`, () => {
    const py = python(text);
    assert.equal(py.error, "ValueError", `expected ValueError, got ${JSON.stringify(py).slice(0, 120)}`);
    for (const secret of [SECRET, "ci-only-parity-pass", "ci-only-parity-session-key-1-"]) {
      assert.ok(!py.message.includes(secret), "error message must not contain values");
    }
  });
}

test("why the subset matters: Node itself changes these raw values (so Python must reject them)", () => {
  const cases = [
    ["inline comment", `K=abc # note\n`, "abc # note"],
    ["double quotes", `K="abc"\n`, '"abc"'],
    ["surrounding spaces", `K=  abc  \n`, "  abc  "],
  ];
  for (const [label, text, raw] of cases) {
    const node = nodeEnvFile(text, ["K"]);
    assert.notEqual(node.K, raw, `${label}: Node does not keep the raw text`);
  }
});
