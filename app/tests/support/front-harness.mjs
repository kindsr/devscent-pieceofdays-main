// F6a2 Actions-only harness. No service configuration, deployment helper entrypoint or registry publication.
// Reusable entrypoint: node --test --test-reporter=tap tests/front-contract.test.mjs (app cwd).
// Inputs are the F6a1 variables; POD_IMAGE_TEST_IMAGE must be the immutable local image ID.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { assertServerIs18, bootstrapRoles, cleanupAll, closeAllClients, createDisposableDatabase, readDisposableEnv, withAdmin } from "../db/helpers.ts";

export const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const BASE = "https://dev.pieceofdays.com";
export const PROVIDERS = ["google", "kakao"];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FAKE_PASSWORD = "ci-front-only-not-a-secret";
export const BASIC = `Basic ${Buffer.from(`ci:${FAKE_PASSWORD}`).toString("base64")}`;
const SESSION_SECRET = "f6a2-ci-only-session-key-not-a-secret-000000";
const FIXTURES = path.join(APP_DIR, "tests/fixtures/front");
const masks = new Set([FAKE_PASSWORD, BASIC, SESSION_SECRET]);
export const protect = (value) => (masks.add(value), value);
function sanitized(value) {
  let out = String(value);
  for (const mask of [...masks].sort((a, b) => b.length - a.length)) if (mask) out = out.split(mask).join("[redacted]");
  return out;
}
function rememberUrl(value) {
  protect(value);
  protect(new URL(value).password);
  protect(decodeURIComponent(new URL(value).password));
}

export function command(file, args, { timeout = 120_000, env = process.env, cwd = APP_DIR } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
export async function docker(args, timeout) {
  const r = await command("docker", args, { timeout });
  assert.equal(r.code, 0, sanitized(`docker ${args[0]} failed (${r.code}): ${r.stderr.slice(-2500)}`));
  return r;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw HTTP, without redirect-following or duplicate-header folding. Never print request values. */
export function request(port, target, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: target, method, headers: { Host: "dev.pieceofdays.com", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", () => reject(new Error("HTTP response failed")));
    });
    req.setTimeout(12_000, () => req.destroy());
    req.on("error", (err) => reject(new Error(`HTTP request failed (${err.code ?? "timeout"})`)));
    req.end(body);
  });
}
export function values(raw, name) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name.toLowerCase()) out.push(raw[i + 1]);
  return out;
}
export function callbackInput(provider) {
  const code = protect(`ci_code_${randomBytes(12).toString("hex")}`);
  const state = protect(`ci_state_${randomBytes(12).toString("hex")}`);
  const referrer = protect(`https://referrer.invalid/${randomBytes(12).toString("hex")}`);
  const cookie = protect(`__Host-pod_oauth=invalid_${randomBytes(12).toString("hex")}; ci_cookie=kept`);
  const target = `/auth/${provider}/callback?code=${code}%2Bvalue&state=${state}&state=duplicate%20value`;
  return { provider, target, sentinels: [code, state, referrer], headers: { Referer: referrer, Cookie: cookie, Origin: BASE } };
}

export class FrontHarness {
  constructor() {
    // Fail before Docker, DB or temporary files. These inputs may never point to a live server.
    assert.equal(process.env.CI, "true", "CI=true required");
    assert.equal(process.env.GITHUB_ACTIONS, "true", "GITHUB_ACTIONS=true required");
    assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1", "isolated Actions only");
    this.image = process.env.POD_IMAGE_TEST_IMAGE ?? "";
    assert.match(this.image, /^sha256:[0-9a-f]{64}$/, "immutable local image ID required");
    this.serviceNetwork = process.env.POD_IMAGE_TEST_NETWORK ?? "";
    assert.match(this.serviceNetwork, /^[0-9a-f]{12,64}$/, "Actions service network ID required");
    this.dbHost = process.env.POD_IMAGE_TEST_DB_HOST ?? "";
    assert.match(this.dbHost, /^[a-z][a-z0-9-]{0,62}$/, "CI PG alias required");
    this.dbEnv = readDisposableEnv();
    rememberUrl(this.dbEnv.adminUrl);
    this.uid = process.getuid();
    this.gid = process.getgid();
    assert.ok(this.uid > 0 && this.gid > 0, "non-root numeric uid:gid required");
    this.prefix = `pod-f6a2-${process.pid}-${randomBytes(4).toString("hex")}`;
    this.names = Object.fromEntries(["upstream", "front", "outer"].map((k) => [k, `${this.prefix}-${k}`]));
    this.containers = new Set();
    this.images = new Set();
    this.archived = [];
    this.mode = undefined;
  }

  async setup() {
    this.tmp = mkdtempSync(path.join(tmpdir(), "pod-f6a2-"));
    chmodSync(this.tmp, 0o700);
    const service = JSON.parse((await docker(["network", "inspect", this.serviceNetwork])).stdout)[0];
    assert.match(service.Name, /^github_network_[0-9a-f]+$/);
    assert.equal(service.Driver, "bridge");
    const candidates = [];
    for (const id of Object.keys(service.Containers ?? {})) {
      const info = JSON.parse((await docker(["inspect", id])).stdout)[0];
      if (info.NetworkSettings.Networks[service.Name]?.Aliases?.includes(this.dbHost)) candidates.push(id);
    }
    assert.equal(candidates.length, 1, "exactly one PG18 service with the supplied alias");
    this.pgContainer = candidates[0];

    // Read constants from this checkout without calling the helper main/config/deployment functions.
    const readConstants = await command("python3", ["-B", "-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('pod_front_source',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps({'conf':m.DEV_FRONT_NGINX_CONF,'base':m.FRONT_NGINX_BASE}))", path.join(REPO_DIR, "scripts/ops/deploy.py")]);
    assert.equal(readConstants.code, 0, "read helper source constants");
    this.trusted = JSON.parse(readConstants.stdout);
    assert.match(this.trusted.base, /^nginx:stable-alpine@sha256:[0-9a-f]{64}$/);
    const publicDir = path.join(REPO_DIR, "frontend/public");
    this.staticFiles = [];
    const walk = (dir, relative = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        assert.ok(entry.isDirectory() || entry.isFile(), "regular static files only");
        const rel = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else this.staticFiles.push(`/${rel}`);
      }
    };
    for (const name of ["try", "design", "promo", "status"]) walk(path.join(publicDir, name), name);
    for (const kind of ["baseline", "front"]) {
      const context = path.join(this.tmp, kind);
      cpSync(publicDir, path.join(context, "public"), { recursive: true });
      if (kind === "front") writeFileSync(path.join(context, "default.conf"), this.trusted.conf);
      writeFileSync(path.join(context, "Dockerfile"), `FROM ${this.trusted.base}\nCOPY public/ /usr/share/nginx/html/\n${kind === "front" ? "COPY default.conf /etc/nginx/conf.d/default.conf\n" : ""}`);
      const tag = `${this.prefix}-${kind}:ci`;
      this.images.add(tag);
      await docker(["build", "--network=none", "-t", tag, context], 600_000);
      this[`${kind}Image`] = (await docker(["image", "inspect", "--format", "{{.Id}}", tag])).stdout.trim();
      assert.match(this[`${kind}Image`], /^sha256:[0-9a-f]{64}$/);
    }
    this.network = (await docker(["network", "create", "--internal", "--driver", "bridge", `${this.prefix}-net`])).stdout.trim();
    const net = JSON.parse((await docker(["network", "inspect", this.network])).stdout)[0];
    assert.equal(net.Internal, true, "app/observer/front/outer cannot reach real OIDC providers");
    this.subnet = net.IPAM.Config[0].Subnet;
    await docker(["network", "connect", "--alias", "pod-front-postgres", this.network, this.pgContainer]);
    this.pgConnected = true;
    await withAdmin(this.dbEnv, async (admin) => {
      await assertServerIs18(admin);
      await bootstrapRoles(admin);
    });
    this.db = await createDisposableDatabase(this.dbEnv, "f6afront");
    for (const url of Object.values(this.db.urls)) rememberUrl(url);
    const inNetwork = (url) => {
      const u = new URL(url);
      u.hostname = "pod-front-postgres";
      u.port = "5432";
      rememberUrl(u.toString());
      return u.toString();
    };
    const migrator = this.envFile("migrator", { POD_MIGRATE_DATABASE_URL: inNetwork(this.db.urls.migrator) });
    await docker(["run", "--rm", "--network", this.network, ...this.appRestrictions(), "--mount", `type=bind,src=${migrator},dst=/run/secrets/migrator.env,readonly`, "--entrypoint", "node", this.image, "--env-file=/run/secrets/migrator.env", "src/server/db/migrate-cli.ts", "up"], 180_000);
    const appEnv = { POD_DATABASE_URL: inNetwork(this.db.urls.app) };
    this.envOff = this.envFile("off", appEnv);
    this.envOn = this.envFile("on", { ...appEnv, POD_AUTH_BASE_URL: BASE, POD_AUTH_PROVIDERS: "google,kakao", POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: SESSION_SECRET }), POD_AUTH_GOOGLE_CLIENT_ID: "ci-google", POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-google-not-a-secret", POD_AUTH_KAKAO_CLIENT_ID: "ci-kakao", POD_AUTH_KAKAO_CLIENT_SECRET: "ci-kakao-not-a-secret" });
    await this.upstream("off");
    await this.front("front");
    this.makeOuter();
    this.containers.add(this.names.outer);
    await docker(["run", "-d", "--name", this.names.outer, "--network", this.network, "--read-only", "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "-p", "127.0.0.1::80", "--mount", `type=bind,src=${path.join(this.tmp, "outer.conf")},dst=/etc/nginx/conf.d/default.conf,readonly`, "--mount", `type=bind,src=${path.join(this.tmp, "htpasswd")},dst=/etc/nginx/ci.htpasswd,readonly`, this.trusted.base]);
    this.outerPort = await this.port(this.names.outer);
    await this.waitPort(this.outerPort, 401);
  }

  envFile(name, env) {
    const file = path.join(this.tmp, `${name}.env`);
    writeFileSync(file, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
    return file;
  }
  appRestrictions() {
    return ["--read-only", "--user", `${this.uid}:${this.gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777", "--tmpfs", `/app/.next/cache:rw,noexec,nosuid,size=64m,uid=${this.uid},gid=${this.gid},mode=0700`];
  }
  async archive(name) {
    if (this.containers.has(name)) {
      const r = await docker(["logs", name]);
      this.archived.push(r.stdout, r.stderr);
    }
  }
  async remove(name) {
    if (!this.containers.has(name)) return;
    await this.archive(name);
    await docker(["rm", "-f", "-v", name]);
    this.containers.delete(name);
  }
  async address(name) {
    const info = JSON.parse((await docker(["inspect", name])).stdout)[0];
    return Object.values(info.NetworkSettings.Networks)[0].IPAddress;
  }
  async port(name) {
    const info = JSON.parse((await docker(["inspect", name])).stdout)[0];
    const mapping = info.NetworkSettings.Ports["80/tcp"];
    assert.equal(mapping.length, 1);
    assert.equal(mapping[0].HostIp, "127.0.0.1");
    return Number(mapping[0].HostPort);
  }
  async upstream(mode) {
    if (this.mode === mode) return;
    await this.remove(this.names.upstream);
    const args = ["run", "-d", "--name", this.names.upstream, "--network", this.network, "--network-alias", "pieceofdays-app-dev", ...(this.appIP ? ["--ip", this.appIP] : []), ...this.appRestrictions()];
    this.containers.add(this.names.upstream);
    if (mode === "observer") {
      args.push("--mount", `type=bind,src=${path.join(FIXTURES, "observer.mjs")},dst=/observer.mjs,readonly`, "--entrypoint", "node", this.image, "/observer.mjs");
    } else {
      args.push("--mount", `type=bind,src=${mode === "on" ? this.envOn : this.envOff},dst=/run/secrets/pod_app_env,readonly`, "--entrypoint", "node", this.image, "--env-file=/run/secrets/pod_app_env", "runtime-startup.mjs");
    }
    await docker(args);
    this.appIP ??= await this.address(this.names.upstream);
    this.mode = mode;
    for (let n = 0; n < 90; n++) {
      const result = await this.appRequest("/healthz").catch(() => null);
      if (result?.status === 200) return;
      await pause(500);
    }
    assert.fail(`upstream ${mode} did not become healthy`);
  }
  async appRequest(target) {
    const script = "fetch(process.argv[1],{redirect:'manual',signal:AbortSignal.timeout(3000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>process.exitCode=1)";
    const r = await docker(["exec", this.names.upstream, "node", "-e", script, `http://127.0.0.1:3000${target}`]);
    return JSON.parse(r.stdout);
  }
  async front(kind) {
    await this.remove(this.names.front);
    this.containers.add(this.names.front);
    await docker(["run", "-d", "--name", this.names.front, "--network", this.network, ...(this.frontIP ? ["--ip", this.frontIP] : []), "--read-only", "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "-p", `127.0.0.1:${this.frontPort ?? ""}:80`, this[`${kind}Image`]]);
    this.frontIP ??= await this.address(this.names.front);
    this.frontPort = await this.port(this.names.front);
    await this.waitPort(this.frontPort, 200, "/try/");
  }
  async waitPort(port, status, target = "/") {
    for (let n = 0; n < 60; n++) {
      const r = await request(port, target).catch(() => null);
      if (r?.status === status) return;
      await pause(250);
    }
    assert.fail(`loopback fixture did not answer expected status ${status}`);
  }
  makeOuter() {
    const fragment = readFileSync(path.join(FIXTURES, "outer-callback.conf"), "utf8");
    this.fragmentHash = hash(fragment);
    const start = fragment.indexOf("location = /auth/google/callback {");
    assert.ok(start > 0);
    const format = fragment.slice(0, start);
    const locations = fragment.slice(start);
    const security = 'add_header X-Robots-Tag "noindex, nofollow" always; add_header X-Frame-Options "SAMEORIGIN" always; add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "strict-origin-when-cross-origin" always; add_header Strict-Transport-Security "max-age=31536000" always;';
    const background = `set $pieceofdays_dev_web http://${this.frontIP}:80; auth_basic "CI dev fixture"; auth_basic_user_file /etc/nginx/ci.htpasswd; allow ${this.subnet}; deny all; ${security}`;
    writeFileSync(path.join(this.tmp, "outer.conf"), `${format}\nserver { listen 80; server_name dev.pieceofdays.com; ${background}\n${locations}\nlocation / { proxy_pass $pieceofdays_dev_web; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }\n}\n`);
    const sha = createHash("sha1").update(FAKE_PASSWORD).digest("base64");
    writeFileSync(path.join(this.tmp, "htpasswd"), `ci:{SHA}${sha}\n`, { mode: 0o644 });
  }
  frontRequest(target, options) { return request(this.frontPort, target, options); }
  edgeRequest(target, options = {}) { return request(this.outerPort, target, { ...options, headers: { Authorization: BASIC, ...options.headers } }); }
  async logs() {
    const out = [...this.archived];
    for (const name of this.containers) {
      const r = await docker(["logs", name]);
      out.push(r.stdout, r.stderr);
    }
    return out.join("\n");
  }
  async noSentinels(sentinels) {
    const text = await this.logs();
    assert.ok(text.length > 0, "collected actual nginx/Next logs");
    for (const sentinel of sentinels) assert.ok(!text.includes(sentinel) && !text.includes(encodeURIComponent(sentinel)), "callback sentinel must be absent from all nginx/Next logs");
  }
  async safeRows() {
    const r = await docker(["logs", this.names.outer]);
    return r.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  }
  async withBrowser(fn) {
    const browser = await chromium.launch();
    try { return await fn(browser); }
    finally { await browser.close(); }
  }
  async preview() {
    const r = await command(process.execPath, [path.join(APP_DIR, "node_modules/@playwright/test/cli.js"), "test", "-c", "playwright.front-preview.config.ts", "--reporter=json"], { timeout: 240_000, env: { ...process.env, POD_FRONT_PREVIEW_URL: `http://127.0.0.1:${this.frontPort}` } });
    // Include only sanitized output on failure, never browser traces or HTTP log artifacts.
    assert.equal(r.code, 0, sanitized(`preview failed: ${r.stdout.slice(-5000)} ${r.stderr.slice(-1500)}`));
    const result = JSON.parse(r.stdout);
    assert.deepEqual({ expected: result.stats.expected, unexpected: result.stats.unexpected, flaky: result.stats.flaky, skipped: result.stats.skipped }, { expected: 10, unexpected: 0, flaky: 0, skipped: 0 });
    assert.deepEqual(result.errors, []);
    return result.stats;
  }
  async cleanup() {
    const failures = [];
    for (const name of [...this.containers].reverse()) {
      try { await this.remove(name); } catch { failures.push("container cleanup"); }
    }
    if (this.pgConnected) {
      try { await docker(["network", "disconnect", this.network, this.pgContainer]); } catch { failures.push("PG network disconnect"); }
    }
    if (this.network) {
      try { await docker(["network", "rm", this.network]); } catch { failures.push("network cleanup"); }
    }
    try { await cleanupAll(this.dbEnv); } catch { failures.push("disposable DB cleanup"); }
    await closeAllClients();
    for (const image of this.images) {
      try { await docker(["image", "rm", image]); } catch { failures.push("fixture image cleanup"); }
    }
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
    assert.deepEqual(failures, [], "all owned CI resources must be cleaned");
  }
}
