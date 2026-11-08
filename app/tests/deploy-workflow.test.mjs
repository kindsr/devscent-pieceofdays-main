// F6c1 RED — R4 §7.0/7.1/7.3 and the main-fixed verify-image CLI contract.
// Actions only, app cwd: node --test --test-reporter=tap tests/deploy-workflow.test.mjs
// This file never executes a workflow, Docker, login, publication, SSH or deployment.
// Existing js-yaml 4.3.2 from the app lock only; no optional import or skipped tests.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "../node_modules/js-yaml/dist/js-yaml.mjs";

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.resolve(APP, "..");
const CLI = path.join(ROOT, "scripts/ci/verify-image-archive.py");
const SOURCE = "https://github.com/kindsr/devscent-pieceofdays-main";
const REPOSITORY = "ghcr.io/kindsr/devscent-pieceofdays-main-app";
const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const MIGRATIONS = "1"; // CLI/config/GitHub outputs use a canonical string, not a converted number.
const CHECKOUT4 = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const CHECKOUT6 = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const ACTIONS = new Set([CHECKOUT4, CHECKOUT6, NODE]);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const workflowText = (name) => readFileSync(path.join(ROOT, ".github/workflows", name), "utf8");
const DEPLOY_TEXT = workflowText("deploy.yml");
const DEPLOY = load(DEPLOY_TEXT);
const APP_WORKFLOW = load(workflowText("app-validation.yml"));
const IMAGE_WORKFLOW = load(workflowText("app-image-validation.yml"));
const sorted = (values) => [...values].sort();
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const expression = (value) => String(value ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
const steps = (job) => job.steps ?? [];
const runOf = (step) => String(step.run ?? "").replace(/\\\r?\n\s*/g, " ").replace(/^\s*#.*$/gm, "");
const scriptOf = (job) => steps(job).map(runOf).join("\n");
const job = (name) => {
  assert.ok(DEPLOY.jobs?.[name], `F6c1 GREEN missing required job: ${name}`);
  return DEPLOY.jobs[name];
};
const uniqueStep = (j, re, label) => {
  const matches = steps(j).filter((step) => re.test(runOf(step)));
  assert.equal(matches.length, 1, `one required ${label} step`);
  return matches[0];
};
const position = (script, re, label) => {
  const index = script.search(re);
  assert.ok(index >= 0, `missing required publisher operation: ${label}`);
  return index;
};
function ordered(script, patterns) {
  let previous = -1;
  for (const [label, re] of patterns) {
    const next = position(script, re, label);
    assert.ok(next > previous, `${label} must follow the preceding verified operation`);
    previous = next;
  }
}
function immutableVariable(script) {
  const match = script.match(/\b([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(docker image inspect --format ['"]\{\{\s*\.Id\s*\}\}['"][^\n)]*\)/);
  assert.ok(match, "derive an opaque image ID from docker image inspect; never equate ID and config digest");
  return match[1];
}
const variablePattern = (name) => `\\$\\{?${name}\\}?`;
function frozenJobText(name) {
  const header = `  ${name}:\n`;
  const start = DEPLOY_TEXT.indexOf(`\n${header}`);
  assert.ok(start >= 0);
  const tail = DEPLOY_TEXT.slice(start + 1);
  const next = tail.slice(header.length).search(/^  [A-Za-z_][A-Za-z0-9_-]*:\s*$/m);
  return (next < 0 ? tail : tail.slice(0, header.length + next)).trimEnd() + "\n";
}
function verifierStep(j, mode) {
  return uniqueStep(j, new RegExp(`python3(?: -B)? [^\\n]*scripts/ci/verify-image-archive\\.py ${mode}\\b`), `${mode} verifier`);
}

before(() => {
  assert.equal(process.env.CI, "true", "Actions-only test: CI=true required before any fixture/process");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Actions-only test: no shared-server execution");
});

// -------------------------------------------------------- C1 workflow structure (no C2 activation)

test("C1 preserves dev/main push+PR triggers and workflow read-only permissions, without new event or concurrency", () => {
  assert.deepEqual(sorted(Object.keys(DEPLOY.on)), ["pull_request", "push"]);
  for (const trigger of Object.values(DEPLOY.on)) assert.deepEqual(trigger, { branches: ["dev", "main"] });
  assert.deepEqual(DEPLOY.permissions, { contents: "read" });
  assert.equal(DEPLOY.concurrency, undefined);
  assert.equal(DEPLOY.environment, undefined);
  assert.ok(!/github\.token|secrets\.|GITHUB_TOKEN/.test(JSON.stringify(DEPLOY.env ?? {})));
});

test("C1 preserves the COMPLETE existing static dev/production deploy job, including SSH body and needs validate", () => {
  const current = job("deploy");
  assert.equal(expression(current.if), "github.event_name == 'push' && (github.ref == 'refs/heads/dev' || github.ref == 'refs/heads/main')");
  assert.deepEqual(list(current.needs), ["validate"]);
  assert.deepEqual(current.concurrency, { group: "pieceofdays-deployment", "cancel-in-progress": false });
  assert.equal(digest(frozenJobText("deploy")), "sha256:3d9fe51f5f55007d9e3705c1e762b91485cf893b7035b0624716bbbf36aab3a0", "frozen62f5d31 static job bytes; no C2 change in C1");
});

test("C1 preserves the existing root validate job and its complete contract/Compose commands", () => {
  assert.equal(digest(frozenJobText("validate")), "sha256:1c1178d4a7a7e8f6a4de6489b337a1f4ebb1b11b1e26b7a6c0a472319062ca57");
});

test("C1 leaves app-validation PR/dev/main triggers and all existing app jobs unconditional; no workflow_call yet", () => {
  assert.deepEqual(sorted(Object.keys(APP_WORKFLOW.on)), ["pull_request", "push"]);
  assert.deepEqual(APP_WORKFLOW.on.push.branches, ["dev", "main"]);
  assert.deepEqual(APP_WORKFLOW.on.pull_request, { paths: ["app/**", ".github/workflows/app-validation.yml"] });
  assert.deepEqual(APP_WORKFLOW.permissions, { contents: "read" });
  assert.deepEqual(sorted(Object.keys(APP_WORKFLOW.jobs)), ["app", "auth-e2e", "db"]);
  for (const appJob of Object.values(APP_WORKFLOW.jobs)) {
    assert.equal(appJob.if, undefined, "no conditional app checks in C1");
    assert.equal(appJob.environment, undefined);
    assert.ok(!/secrets\.|packages.*write/.test(JSON.stringify(appJob)));
  }
  assert.equal(DEPLOY.jobs["app-checks"], undefined, "C2 has not started");
  assert.equal(DEPLOY.jobs["deploy-dev-app"], undefined, "C2 has not started");
});

test("all deploy actions use the three approved immutable commits; new jobs use credential-free v6 checkout and Node26", () => {
  for (const current of Object.values(DEPLOY.jobs)) {
    for (const step of steps(current)) if (step.uses) assert.ok(ACTIONS.has(step.uses), `unapproved action: ${step.uses}`);
  }
  for (const name of ["workflow-contracts", "build-dev-app"]) {
    const current = job(name);
    const checkout = steps(current).filter((step) => step.uses === CHECKOUT6);
    const setup = steps(current).filter((step) => step.uses === NODE);
    assert.equal(checkout.length, 1);
    assert.equal(checkout[0].with?.["persist-credentials"], false);
    assert.equal(setup.length, 1);
    assert.equal(String(setup[0].with?.["node-version"]), "26.13.0");
  }
});

test("workflow-contracts runs on push and PR with read-only scope, no secrets/environment, lock-only install and a nonempty TAP gate", () => {
  const current = job("workflow-contracts");
  assert.equal(current.if, undefined);
  assert.equal(current.environment, undefined);
  assert.deepEqual(current.permissions ?? DEPLOY.permissions, { contents: "read" });
  assert.ok(!/secrets\.|github\.token|GITHUB_TOKEN|ssh\b|docker\b/.test(JSON.stringify(current)));
  const script = scriptOf(current);
  assert.match(script, /npm(?: --prefix app)? ci --ignore-scripts\b/);
  assert.match(script, /node --test(?: --test-reporter=tap)? (?:app\/)?tests\/deploy-workflow\.test\.mjs/);
  assert.ok(script.includes("# tests [1-9]") || /# tests [1-9][0-9]*\b/.test(script) || /tests[^\n]*(?:-gt 0|> 0|>= 1)/.test(script), "explicitly reject zero tests");
  assert.match(script, /(?:# skipped 0|skipped[^\n]*0)/);
  assert.match(script, /(?:# fail 0|fail[^\n]*0)/);
  assert.ok(!steps(current).some((step) => step.if !== undefined || step["continue-on-error"]));
});

test("publisher is dev-push ONLY, needs validate and workflow-contracts, and owns the only packages-write permission", () => {
  const publisher = job("build-dev-app");
  assert.equal(expression(publisher.if), "github.event_name == 'push' && github.ref == 'refs/heads/dev'");
  assert.deepEqual(sorted(list(publisher.needs)), ["validate", "workflow-contracts"]);
  assert.deepEqual(publisher.permissions, { contents: "read", packages: "write" });
  assert.equal(publisher.environment, undefined);
  assert.ok(!publisher["continue-on-error"]);
  for (const [name, current] of Object.entries(DEPLOY.jobs)) {
    if (name !== "build-dev-app") assert.ok(!JSON.stringify(current.permissions ?? {}).includes("write"), "PR jobs cannot write packages");
    if (name !== "deploy") assert.ok(!/secrets\.(?:DEPLOY|SSH)|\bssh\s/.test(JSON.stringify(current)), "only existing static deploy owns SSH credentials");
  }
});

test("publisher token is explicit only in the isolated login-step env; no token/secret in job env, run, outputs or other jobs", () => {
  const publisher = job("build-dev-app");
  const login = uniqueStep(publisher, /docker login ghcr\.io\b/, "registry login");
  assert.match(runOf(login), /--password-stdin/);
  assert.equal(Object.keys(login.env ?? {}).length, 1, "only the login token in login env");
  const [tokenName, tokenValue] = Object.entries(login.env)[0];
  assert.ok(["github.token", "secrets.GITHUB_TOKEN"].includes(expression(tokenValue)));
  assert.match(runOf(login), new RegExp(variablePattern(tokenName)));
  assert.ok(!/npm\b|node\b|docker (?:build|image|push|tag)/.test(runOf(login)), "token-bearing step only logs in");
  const withoutLoginEnv = structuredClone(DEPLOY);
  const cloneLogin = steps(withoutLoginEnv.jobs["build-dev-app"]).find((step) => /docker login ghcr\.io\b/.test(runOf(step)));
  delete cloneLogin.env;
  // Existing deploy SSH secrets are authorized; no token reference is authorized elsewhere.
  assert.ok(!/github\.token|secrets\.GITHUB_TOKEN|\$\{\{[^}]*token/i.test(JSON.stringify(withoutLoginEnv)));
  assert.ok(!/secrets\./.test(JSON.stringify({ ...publisher, steps: steps(publisher).map((step) => step === login ? { ...step, env: undefined } : step) })));
});

test("publisher builds linux/amd64 locally, records Docker storage metadata, and validates checkout SHA before any image operation", () => {
  const script = scriptOf(job("build-dev-app"));
  assert.match(script, /git rev-parse HEAD/);
  assert.match(script, /github\.sha/);
  assert.match(script, /(?:test\s|\[\[)[^\n]*(?:==|=)[^\n]*/);
  assert.match(script, /docker version/);
  assert.match(script, /docker info/);
  assert.match(script, /npm(?: --prefix app)? ci --ignore-scripts/);
  const build = uniqueStep(job("build-dev-app"), /docker buildx build\b/, "buildx build");
  for (const flag of ["--platform linux/amd64", "--provenance=false", "--sbom=false", "--load", "--metadata-file"]) assert.ok(runOf(build).includes(flag), flag);
  for (const label of ["POD_SHA", "POD_TREE", "POD_MIGRATIONS_LATEST"]) assert.ok(runOf(build).includes(label));
  assert.ok(!/--push\b|--cache-from\b|--cache-to\b|docker pull\b/.test(script), "fresh local build, no alternate registry artifact");
  ordered(script, [["checkout SHA", /git rev-parse HEAD/], ["local build", /docker buildx build\b/], ["immutable inspect", /docker image inspect --format ['"]\{\{\s*\.Id\s*\}\}['"]/]]);
});

test("opaque image ID drives save, test env, post-test inspection and tagging; never compare engine ID to config digest", () => {
  const script = scriptOf(job("build-dev-app"));
  const id = immutableVariable(script);
  const ref = variablePattern(id);
  assert.match(script, new RegExp(`docker image save ["']?${ref}["']?\\s`));
  assert.match(script, new RegExp(`POD_IMAGE_TEST_IMAGE=["']?${ref}`));
  assert.match(script, new RegExp(`docker tag ["']?${ref}["']?\\s`));
  assert.match(script, new RegExp(`docker image inspect --format ['"]\\{\\{\\s*\\.Id\\s*\\}\\}['"] ["']?${ref}`));
  assert.ok(!new RegExp(`${ref}[^\\n]*(?:==| = )[^\\n]*\\$\\{?(?:config_digest|config|metadata_digest|C|M)\\}?`).test(script), "ID is opaque and must not be assumed equal to C/M");
});

test("exported immutable ID is proven C=M by the fixed archive CLI BEFORE tests, registry login and push", () => {
  const publisher = job("build-dev-app");
  const archive = verifierStep(publisher, "archive");
  assert.equal(archive.if, undefined);
  for (const arg of ["--metadata", "--archive", "--sha", "--tree", "--migrations-latest"]) assert.ok(runOf(archive).includes(arg), arg);
  const script = scriptOf(publisher);
  ordered(script, [["save tested ID", /docker image save\b/], ["archive C=M proof", /verify-image-archive\.py archive\b/], ["image six", /tests\/image-contract\.test\.mjs/], ["front fourteen", /tests\/front-contract\.test\.mjs/], ["login", /docker login ghcr\.io/], ["push", /docker push\b/]]);
  assert.ok(!steps(publisher).some((step) => step["continue-on-error"]));
});

test("publisher unconditionally executes original image6 and front14+original-preview10 on the same immutable ID before login", () => {
  const publisher = job("build-dev-app");
  for (const file of ["image-contract", "front-contract"]) {
    const current = uniqueStep(publisher, new RegExp(`node --test --test-reporter=tap tests/${file}\\.test\\.mjs`), file);
    assert.equal(current.if, undefined);
    assert.ok(!current["continue-on-error"]);
    const count = file === "image-contract" ? 6 : 14;
    for (const line of [`# tests ${count}`, `# pass ${count}`, "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"]) assert.ok(runOf(current).includes(line), `${file} requires exact ${line}`);
  }
  const script = scriptOf(publisher);
  assert.ok(script.includes("original preview: pass 10, fail 0, flaky 0, skip 0"));
  assert.match(script, /(?:npx playwright|node [^\n]*playwright[^\n]*) install --with-deps chromium/);
  assert.equal(publisher.env?.POD_FULL_CHECK_ISOLATED, "1");
  assert.equal(publisher.env?.POD_TEST_DB_DISPOSABLE, "1");
  assert.ok(publisher.services?.postgres, "dedicated PG18 service is not optional");
  assert.match(String(publisher.services.postgres.image), /^postgres:18\.6@sha256:[0-9a-f]{64}$/);
  assert.ok(!/secrets\./.test(JSON.stringify(publisher.services)));
});

test("post-push verification binds fixed-repo single RepoDigest D, raw manifest SHA D, and config C=M before outputs", () => {
  const publisher = job("build-dev-app");
  const manifest = verifierStep(publisher, "manifest");
  assert.equal(manifest.if, undefined);
  for (const arg of ["--manifest", "--manifest-digest", "--config-digest"]) assert.ok(runOf(manifest).includes(arg), arg);
  const script = scriptOf(publisher);
  assert.ok(script.includes(REPOSITORY));
  assert.match(script, /RepoDigests/);
  assert.match(script, /(?:len\([^\n]*\)\s*==\s*1|length[^\n]*==?[^\n]*1|\$\{#[^}]+\}[^\n]*-eq\s+1|test[^\n]*-eq\s+1)/, "select exactly one digest for the fixed repository");
  ordered(script, [["push", /docker push\b/], ["RepoDigest selection", /RepoDigests/], ["raw manifest", /docker buildx imagetools inspect --raw\b/], ["D and C proof", /verify-image-archive\.py manifest\b/], ["final outputs", />>\s*["']?\$GITHUB_OUTPUT/]]);
});

test("publisher emits only the five validated outputs in the LAST step, then exposes that exact step's outputs", () => {
  const publisher = job("build-dev-app");
  const names = ["sha", "tree", "manifest_digest", "config_digest", "migrations_latest"];
  assert.deepEqual(sorted(Object.keys(publisher.outputs ?? {})), sorted(names));
  const outputSteps = steps(publisher).filter((step) => /\$GITHUB_OUTPUT/.test(runOf(step)));
  assert.equal(outputSteps.length, 1);
  assert.equal(outputSteps[0], steps(publisher).at(-1), "outputs appear only after all proof and cleanup");
  const final = outputSteps[0];
  assert.equal(final.if, undefined);
  assert.ok(final.id);
  for (const name of names) {
    assert.equal(expression(publisher.outputs[name]), `steps.${final.id}.outputs.${name}`);
    assert.match(runOf(final), new RegExp(`\\b${name}=`));
  }
  for (const pattern of ["[0-9a-f]{40}", "sha256:", "[0-9a-f]{64}", "[1-9][0-9]*"]) assert.ok(runOf(final).includes(pattern), `validate output format ${pattern}`);
  const script = scriptOf(publisher);
  assert.match(script, /docker logout ghcr\.io/);
  assert.match(script, /(?:rm|unlink)[^\n]*(?:\.docker|DOCKER_CONFIG)[^\n]*config\.json/);
  assert.ok(script.includes("$GITHUB_STEP_SUMMARY"));
  for (const field of ["metadata_keys", "media_type", "migrations_latest", "config_digest", "manifest_digest"]) assert.ok(script.includes(field), `retain verified summary field ${field}`);
});

test("C1 image local-proof PR/dev triggers cover exactly all six approved app/workflow/verifier/helper/front path patterns", () => {
  const paths = ["app/**", ".github/workflows/app-image-validation.yml", ".github/workflows/deploy.yml", "scripts/ci/verify-image-archive.py", "scripts/ops/deploy.py", "frontend/public/**"];
  assert.deepEqual(sorted(Object.keys(IMAGE_WORKFLOW.on)), ["pull_request", "push"]);
  assert.deepEqual(sorted(IMAGE_WORKFLOW.on.pull_request.paths), sorted(paths), "verifier/deploy-only PRs must run local image proof too");
  assert.deepEqual(IMAGE_WORKFLOW.on.push.branches, ["dev"], "retain dev image validation in C1");
  assert.deepEqual(sorted(IMAGE_WORKFLOW.on.push.paths), sorted(paths));
});

test("the ENTIRE image PR-trial workflow stays contents-read-or-less, with no token, secret, environment, registry publication or extra action", () => {
  const readOnly = (permissions) => {
    assert.ok(permissions && typeof permissions === "object" && !Array.isArray(permissions), "explicitly bounded effective permissions");
    for (const [name, value] of Object.entries(permissions)) assert.ok(value === "none" || (name === "contents" && value === "read"), "PR trial cannot gain packages-write or other token scopes");
  };
  readOnly(IMAGE_WORKFLOW.permissions);
  assert.equal(IMAGE_WORKFLOW.environment, undefined);
  assert.ok(!/secrets(?:\.|\[)|github\.token|GITHUB_TOKEN/i.test(JSON.stringify(IMAGE_WORKFLOW)), "no explicit credential/token references anywhere in PR trial");
  for (const current of Object.values(IMAGE_WORKFLOW.jobs)) {
    readOnly(current.permissions ?? IMAGE_WORKFLOW.permissions);
    assert.equal(current.environment, undefined);
    assert.ok(!/\bdocker\b[^\n]*(?:\blogin\b|\bpush\b|--push\b)/.test(scriptOf(current)), "PR trial cannot log in or publish an image");
    for (const step of steps(current)) if (step.uses) assert.ok(ACTIONS.has(step.uses), `unapproved PR-trial action: ${step.uses}`);
  }
});

// -------------------------------------------------------- stdlib CLI fixtures (no Docker required)

const TAR_WRITER = `import base64,io,json,sys,tarfile
spec=json.load(sys.stdin)
with tarfile.open(sys.argv[1],"w",format=tarfile.USTAR_FORMAT) as out:
 for entry in spec:
  info=tarfile.TarInfo(entry["name"])
  info.mode=0o644
  kind=entry.get("type","file")
  if kind=="file":
   data=base64.b64decode(entry.get("data","")); info.size=len(data); out.addfile(info,io.BytesIO(data))
  else:
   info.type={"symlink":tarfile.SYMTYPE,"hardlink":tarfile.LNKTYPE,"directory":tarfile.DIRTYPE,"fifo":tarfile.FIFOTYPE}[kind]
   info.linkname=entry.get("linkname",""); out.addfile(info)
`;
function configDocument() {
  return { os: "linux", architecture: "amd64", config: { Labels: { "org.opencontainers.image.source": SOURCE, "org.opencontainers.image.revision": SHA, "pod.tree": TREE, "pod.migrations.latest": MIGRATIONS } } };
}
const member = (name, bytes) => ({ name, data: Buffer.from(bytes).toString("base64") });
function archiveFixture(options = {}) {
  const config = options.config ?? configDocument();
  const rawConfig = options.rawConfig ?? JSON.stringify(config, null, 2) + "\n";
  const C = digest(rawConfig);
  const configName = options.configName ?? "config.json";
  const metadata = options.metadata ?? { z_ci: "not-a-secret", "containerimage.config.digest": C, a_ci: true };
  const manifest = options.archiveManifest ?? [{ Config: configName, RepoTags: ["ci-only:image"], Layers: ["layer.tar"] }];
  const entries = [member("manifest.json", options.rawArchiveManifest ?? JSON.stringify(manifest)), member(configName, rawConfig), member("layer.tar", Buffer.alloc(1024))];
  options.mutateEntries?.(entries);
  return { C, rawConfig, metadata: options.rawMetadata ?? JSON.stringify(metadata), metadataKeys: sorted(Object.keys(metadata)), entries };
}
function withArchive(options, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pod-ci-archive-"));
  try {
    const fixture = archiveFixture(options);
    const archive = path.join(dir, "ci-input-sensitive-marker.tar");
    const metadata = path.join(dir, "ci-input-sensitive-marker.json");
    writeFileSync(metadata, fixture.metadata);
    execFileSync("python3", ["-B", "-c", TAR_WRITER, archive], { input: JSON.stringify(fixture.entries), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const args = ["archive", "--metadata", metadata, "--archive", archive, "--sha", SHA, "--tree", TREE, "--migrations-latest", MIGRATIONS];
    const result = fn({ ...fixture, dir, archive, metadataFile: metadata, args });
    assert.deepEqual(sorted(readdirSync(dir)), ["ci-input-sensitive-marker.json", "ci-input-sensitive-marker.tar"], "no archive extraction on success OR rejection");
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function invoke(args) {
  // A missing script is RED, NEVER an accepted negative result or a skipped case.
  assert.ok(existsSync(CLI), "F6c1 GREEN missing required product CLI: scripts/ci/verify-image-archive.py");
  const r = spawnSync("python3", ["-B", CLI, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.equal(r.error, undefined, "verifier subprocess must actually execute");
  assert.equal(r.signal, null, "no timeout/crash counts as a domain rejection");
  return r;
}
function success(r, expected) {
  assert.equal(r.status, 0, `valid fixture must succeed, stderr=${r.stderr}`);
  assert.equal(r.stderr, "", "successful CLI emits only metadata JSON");
  assert.deepEqual(JSON.parse(r.stdout), expected);
}
function rejection(r, forbidden = []) {
  assert.equal(r.status, 1, "intentional validation rejection has exit1, never argparse/crash/missing-module");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^verify-image: [^\r\n]+\n?$/, "fixed failure prefix, no traceback/usage/raw exception");
  for (const value of [CLI, "ci-input-sensitive-marker", "Traceback", "TypeError", ...forbidden]) assert.ok(!r.stderr.includes(value), "failure must not echo a path, raw input or exception");
}

for (const [name, options] of [["pretty config raw bytes", {}], ["nested Docker-save blob path", { configName: "blobs/sha256/config-bytes" }]]) {
  test(`archive accepts ${name}, hashes ORIGINAL bytes C=M and returns canonical string migration plus sorted keys`, () => {
    withArchive(options, (f) => success(invoke(f.args), { config_digest: f.C, migrations_latest: MIGRATIONS, metadata_keys: f.metadataKeys }));
  });
}

const archiveInvalid = [
  ["config hash C differs from metadata M", () => ({ metadata: { "containerimage.config.digest": `sha256:${"0".repeat(64)}` } })],
  ["metadata digest key absent", () => ({ metadata: { "containerimage.digest": `sha256:${"0".repeat(64)}` } })],
  ["metadata digest malformed", () => ({ metadata: { "containerimage.config.digest": "ci-input-sensitive-marker" } })],
  ["metadata root is not an object", () => ({ metadata: [] })],
  ["metadata duplicate JSON key (otherwise valid)", () => { const C = digest(JSON.stringify(configDocument(), null, 2) + "\n"); return { rawMetadata: `{"containerimage.config.digest":"${C}","containerimage.config.digest":"${C}"}` }; }],
  ["archive manifest has zero images", () => ({ archiveManifest: [] })],
  ["archive manifest has multiple images", () => ({ archiveManifest: [{ Config: "config.json" }, { Config: "config.json" }] })],
  ["unknown archive layout without manifest.json", () => ({ mutateEntries: (entries) => { entries[0].name = "index.json"; } })],
  ["manifest missing Config", () => ({ archiveManifest: [{ Layers: ["layer.tar"] }] })],
  ["referenced config absent", () => ({ mutateEntries: (entries) => { entries.splice(1, 1); } })],
  ["duplicate manifest.json members", () => ({ mutateEntries: (entries) => { entries.push(entries[0]); } })],
  ["duplicate config members", () => ({ mutateEntries: (entries) => { entries.push(entries[1]); } })],
  ["absolute member even outside selected config", () => ({ mutateEntries: (entries) => { entries.push(member("/ci-input-sensitive-marker", "x")); } })],
  ["parent traversal member even outside selected config", () => ({ mutateEntries: (entries) => { entries.push(member("../ci-input-sensitive-marker", "x")); } })],
  ["internal parent traversal in Config reference", () => ({ configName: "safe/../config.json" })],
  ["config symlink", () => ({ mutateEntries: (entries) => { entries[1] = { name: "config.json", type: "symlink", linkname: "layer.tar" }; } })],
  ["config hardlink", () => ({ mutateEntries: (entries) => { entries[1] = { name: "config.json", type: "hardlink", linkname: "layer.tar" }; } })],
  ["unrelated symlink", () => ({ mutateEntries: (entries) => { entries.push({ name: "unsafe-link", type: "symlink", linkname: "/ci-input-sensitive-marker" }); } })],
  ["referenced config is a directory", () => ({ mutateEntries: (entries) => { entries[1] = { name: "config.json", type: "directory" }; } })],
  ["config JSON malformed", () => ({ rawConfig: '{"ci-input-sensitive-marker":' })],
  ["config duplicate platform JSON key (otherwise valid)", () => ({ rawConfig: (JSON.stringify(configDocument(), null, 2) + "\n").replace('"os": "linux"', '"os": "linux", "os": "linux"') })],
  ["config nested duplicate label JSON key (otherwise valid)", () => ({ rawConfig: (JSON.stringify(configDocument(), null, 2) + "\n").replace(`"pod.tree": "${TREE}"`, `"pod.tree": "${TREE}", "pod.tree": "${TREE}"`) })],
  ["archive manifest duplicate Config JSON key (otherwise valid)", () => ({ rawArchiveManifest: '[{"Config":"config.json","Config":"config.json","RepoTags":["ci-only:image"],"Layers":["layer.tar"]}]' })],
  ["config root is not an object", () => ({ config: [] })],
  ["config missing Labels", () => ({ config: { os: "linux", architecture: "amd64", config: {} } })],
];
for (const [field, value] of [["os", "windows"], ["architecture", "arm64"], ["os", undefined], ["architecture", undefined], ["architecture", ["amd64"]]]) {
  archiveInvalid.push([`platform ${field}=${JSON.stringify(value)}`, () => { const config = configDocument(); if (value === undefined) delete config[field]; else config[field] = value; return { config }; }]);
}
for (const [key, value] of [["org.opencontainers.image.source", "https://example.invalid/other"], ["org.opencontainers.image.revision", "c".repeat(40)], ["pod.tree", "d".repeat(40)], ["pod.migrations.latest", "2"], ["pod.migrations.latest", "01"], ["pod.migrations.latest", 1], ["pod.tree", undefined]]) {
  archiveInvalid.push([`image label ${key} mismatch ${JSON.stringify(value)}`, () => { const config = configDocument(); if (value === undefined) delete config.config.Labels[key]; else config.config.Labels[key] = value; return { config }; }]);
}
for (const [name, options] of archiveInvalid) {
  test(`archive rejects ${name} with explicit safe validation failure`, () => {
    withArchive(options(), (f) => {
      rejection(invoke(f.args), [f.dir]);
    });
  });
}
for (const value of ["0", "01", "-1", "1e2", " 1", "1 "]) {
  test(`archive rejects noncanonical migration argument ${JSON.stringify(value)}`, () => {
    const config = configDocument();
    config.config.Labels["pod.migrations.latest"] = value;
    withArchive({ config }, (f) => rejection(invoke(f.args.slice(0, -1).concat(value)), [f.dir]));
  });
}
test("archive preserves a multi-digit canonical migration label as a JSON string without numeric conversion", () => {
  const config = configDocument();
  config.config.Labels["pod.migrations.latest"] = "12";
  withArchive({ config }, (f) => success(invoke(f.args.slice(0, -1).concat("12")), { config_digest: f.C, migrations_latest: "12", metadata_keys: f.metadataKeys }));
});

const OCI = "application/vnd.oci.image.manifest.v1+json";
const DOCKER = "application/vnd.docker.distribution.manifest.v2+json";
function manifestDocument(type = OCI) {
  return { schemaVersion: 2, mediaType: type, config: { mediaType: type === OCI ? "application/vnd.oci.image.config.v1+json" : "application/vnd.docker.container.image.v1+json", size: 123, digest: `sha256:${"c".repeat(64)}` }, layers: [{ mediaType: type === OCI ? "application/vnd.oci.image.layer.v1.tar+gzip" : "application/vnd.docker.image.rootfs.diff.tar.gzip", size: 456, digest: `sha256:${"d".repeat(64)}` }] };
}
function withManifest(options, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "pod-ci-manifest-"));
  try {
    const doc = options.document ?? manifestDocument();
    const raw = options.raw ?? JSON.stringify(doc, null, 2) + "\n";
    const D = options.D ?? digest(raw);
    const C = options.C ?? doc.config?.digest ?? `sha256:${"c".repeat(64)}`;
    const file = path.join(dir, "ci-input-sensitive-marker.json");
    writeFileSync(file, raw);
    return fn({ doc, D, C, dir, args: ["manifest", "--manifest", file, "--manifest-digest", D, "--config-digest", C] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const type of [OCI, DOCKER]) {
  test(`manifest accepts raw schema2 single ${type} and returns ONLY verified D/C/media_type`, () => {
    withManifest({ document: manifestDocument(type) }, (f) => success(invoke(f.args), { manifest_digest: f.D, config_digest: f.C, media_type: type }));
  });
}
test("manifest layer mediaType follows the existing helper string contract rather than an invented enum", () => {
  const document = manifestDocument();
  document.layers[0].mediaType = "ci/custom-layer";
  withManifest({ document }, (f) => success(invoke(f.args), { manifest_digest: f.D, config_digest: f.C, media_type: OCI }));
});
const manifestInvalid = [
  ["raw hash differs from D", () => ({ D: `sha256:${"0".repeat(64)}` })],
  ["config digest differs from C", () => ({ C: `sha256:${"0".repeat(64)}` })],
  ["malformed D", () => ({ D: "ci-input-sensitive-marker" })],
  ["malformed C", () => ({ C: "ci-input-sensitive-marker" })],
  ["malformed JSON", () => ({ raw: '{"ci-input-sensitive-marker":' })],
  ["duplicate JSON key (otherwise valid)", () => ({ raw: (JSON.stringify(manifestDocument(), null, 2) + "\n").replace('"schemaVersion": 2', '"schemaVersion": 2, "schemaVersion": 2') })],
  ["index or manifest list", () => ({ document: { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] } })],
];
for (const [field, value] of [["schemaVersion", 1], ["schemaVersion", "2"], ["mediaType", "unknown"], ["config", null], ["layers", []], ["layers", null], ["manifests", []]]) {
  manifestInvalid.push([`${field} invalid ${JSON.stringify(value)}`, () => { const document = manifestDocument(); document[field] = value; return { document }; }]);
}
for (const [field, value] of [["mediaType", "application/vnd.docker.container.image.v1+json"], ["size", 0], ["size", -1], ["size", true], ["size", 1.5], ["digest", "sha256:bad"]]) {
  manifestInvalid.push([`config ${field} invalid ${JSON.stringify(value)}`, () => { const document = manifestDocument(); document.config[field] = value; return { document, C: `sha256:${"c".repeat(64)}` }; }]);
}
for (const [field, value] of [["mediaType", null], ["size", 0], ["size", -1], ["size", true], ["size", 1.5], ["digest", "sha256:bad"]]) {
  manifestInvalid.push([`layer ${field} invalid ${JSON.stringify(value)}`, () => { const document = manifestDocument(); document.layers[0][field] = value; return { document }; }]);
}
manifestInvalid.push(["invalid second layer must also be checked", () => { const document = manifestDocument(); document.layers.push(null); return { document }; }]);
for (const [name, options] of manifestInvalid) {
  test(`manifest rejects ${name} with explicit safe validation failure`, () => {
    withManifest(options(), (f) => rejection(invoke(f.args), [f.dir]));
  });
}
