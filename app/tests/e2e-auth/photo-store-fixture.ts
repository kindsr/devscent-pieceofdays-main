// Actions-only real S3 fixture. One owned SeaweedFS container; no host mounts or real data.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { CI_ROLES } from "../db/helpers";

const IMAGE = "chrislusf/seaweedfs:4.53@sha256:972ba30c529dfc72a6a12ed427e94d99c7b6a6e59d97bfa52be0a849f43e2cc9";
const LABEL = "pieceofdays.photo-ci-owner";
const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const status = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const WORKER_ENV = "POD_E2E_PHOTO_FIXTURE";
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

export async function syntheticPhoto() {
  return { name: "ci-only-synthetic.png", mimeType: "image/png", buffer: await sharp({ create: {
    width: 48, height: 32, channels: 4, background: { r: 92, g: 136, b: 174, alpha: 0.5 },
  } }).png().toBuffer() };
}

export type PhotoFixture = { appEnv: Record<string, string>; stop: () => Promise<void> };

// This worker-only envelope is never spread into the normal Next child environment.
export function configurePhotoWorkers(fixture: PhotoFixture, purgeUrl: string, appUrl: string) {
  const url = new URL(purgeUrl);
  assert.equal(url.username, CI_ROLES.purge);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/pod_ci_[a-z0-9]{1,20}_[0-9a-f]{16}$/);
  assert.equal(new URL(appUrl).username, CI_ROLES.app);
  assert.equal(new URL(appUrl).host, url.host);
  assert.equal(new URL(appUrl).pathname, url.pathname);
  process.env[WORKER_ENV] = JSON.stringify({ appEnv: fixture.appEnv, purgeUrl, appUrl });
}

function workerConfig(): { appEnv: Record<string, string>; purgeUrl: string; appUrl: string } {
  assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1");
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.ok(process.env[WORKER_ENV], "photo worker fixture must come from successful globalSetup");
  return JSON.parse(process.env[WORKER_ENV]!) as { appEnv: Record<string, string>; purgeUrl: string; appUrl: string };
}

export async function fixtureObject(key: string): Promise<Buffer | null> {
  assert.match(key, /^photos\/[0-9a-f-]{36}\.jpg$/);
  const { appEnv: values } = workerConfig();
  const client = new S3Client({ endpoint: values.POD_PHOTOS_S3_ENDPOINT!, region: values.POD_PHOTOS_S3_REGION!, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: values.POD_PHOTOS_S3_ACCESS_KEY_ID!, secretAccessKey: values.POD_PHOTOS_S3_SECRET_ACCESS_KEY! } });
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: values.POD_PHOTOS_S3_BUCKET!, Key: key }), { abortSignal: AbortSignal.timeout(5000) });
    assert.ok(result.Body, "real fixture object body required");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    assert.ok(bytes.length <= 4 * 1024 * 1024);
    return bytes;
  } catch (error) {
    if (status(error) === 404) return null;
    throw new Error("photo fixture object read failed (not a successful storage proof)");
  } finally { client.destroy(); }
}

async function cleanupResult(limit: number, asApp = false) {
  const { appEnv, purgeUrl, appUrl } = workerConfig();
  const cli = path.join(APP_DIR, "src/server/photos/cleanup-cli.mjs");
  assert.ok(existsSync(cli), "photos/cleanup-cli.mjs must exist to consume real deletion tombstones");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, "--limit", String(limit)], {
      cwd: APP_DIR, timeout: 30_000, maxBuffer: 64 * 1024,
      env: { NODE_ENV: "development", PATH: process.env.PATH ?? "", POD_FULL_CHECK_ISOLATED: "1", POD_PHOTO_CLEANUP_DATABASE_URL: asApp ? appUrl : purgeUrl, ...appEnv },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr }));
  });
  for (const secret of [purgeUrl, appUrl, decodeURIComponent(new URL(purgeUrl).password), decodeURIComponent(new URL(appUrl).password), ...Object.values(appEnv)]) {
    if (secret.length >= 4) assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false, "cleanup CLI must not print private configuration");
  }
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError/, "cleanup CLI must actually run, not fail to load");
  return result;
}

export async function expectCleanupRefusesApp() {
  const result = await cleanupResult(1, true);
  assert.equal(result.code, 1, "cleanup refuses the ordinary app login");
  assert.equal(result.stdout.trim(), "", "wrong-role cleanup never reports success stats");
  assert.ok(result.stderr.trim(), "fixed wrong-role failure required");
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, "fixed failure only, no stack");
}

export async function runPhotoCleanup(limit = 1): Promise<{ processed: number; deleted: number; failed: number; busy: number }> {
  const result = await cleanupResult(limit);
  assert.equal(result.code, 0, "photo cleanup CLI must complete one real batch successfully");
  assert.equal(result.stderr, "", "successful cleanup has no stderr");
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, "one stats JSON line only");
  const stats = JSON.parse(result.stdout) as { processed: number; deleted: number; failed: number; busy: number };
  assert.deepEqual(Object.keys(stats).sort(), ["busy", "deleted", "failed", "processed"]);
  for (const count of Object.values(stats)) assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(stats.processed <= limit, "bounded CLI batch");
  return stats;
}

export async function startPhotoStore(): Promise<PhotoFixture> {
  assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1", "[photo fixture] isolated runner required");
  assert.equal(process.env.POD_TEST_DB_DISPOSABLE, "1", "[photo fixture] disposable PG guard required");
  assert.equal(process.env.CI, "true", "[photo fixture] CI required");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "[photo fixture] Actions required");
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === "unix:///var/run/docker.sock", "[photo fixture] local Docker daemon only");
  const owner = randomUUID();
  const name = `pod-photo-ci-${owner}`;
  const bucket = `pod-photo-ci-${owner}`;
  const accessKeyId = "ci-only-photo-access";
  const secretAccessKey = "ci-only-photo-secret-not-production";
  let client: S3Client | undefined;
  let creationAttempted = false;
  const docker = async (args: string[]) => (await exec("docker", args, {
    env: { PATH: process.env.PATH ?? "" }, timeout: 120_000, maxBuffer: 1024 * 1024,
  })).stdout.trim();
  const ownedIds = async () => (await docker(["ps", "-aq", "--filter", `label=${LABEL}=${owner}`])).split(/\s+/).filter(Boolean);
  const stop = async () => {
    client?.destroy();
    client = undefined;
    if (!creationAttempted) return;
    const failures: string[] = [];
    for (const id of await ownedIds()) {
      try {
        assert.match(id, /^[0-9a-f]{12,64}$/);
        const info = JSON.parse(await docker(["inspect", id]))[0] as { Name: string; Config: { Labels: Record<string, string> } };
        assert.equal(info.Config.Labels[LABEL], owner, "[photo fixture] ownership label required before deletion");
        assert.equal(info.Name, `/${name}`, "[photo fixture] owned name required before deletion");
        await docker(["rm", "--force", "--volumes", id]);
      } catch { failures.push("owned container removal"); }
    }
    if ((await ownedIds()).length) failures.push("owned container remains");
    if (failures.length) throw new Error(`[photo fixture] cleanup failed: ${failures.join(", ")}`);
  };
  let phase = "Docker availability";
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
    phase = "owned container creation";
    creationAttempted = true;
    const id = await docker(["create", "--platform", "linux/amd64", "--name", name, "--label", `${LABEL}=${owner}`,
      "--publish", "127.0.0.1::8333", "--tmpfs", "/data:rw,nosuid,nodev,size=256m",
      "--env", `AWS_ACCESS_KEY_ID=${accessKeyId}`, "--env", `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      "--env", `S3_BUCKET=${bucket}`, IMAGE, "mini", "-dir=/data"]);
    assert.match(id, /^[0-9a-f]{64}$/);
    await docker(["start", id]);
    const info = JSON.parse(await docker(["inspect", id]))[0] as {
      Config: { Labels: Record<string, string> }; State: { Running: boolean };
      NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
    };
    assert.equal(info.Config.Labels[LABEL], owner);
    assert.equal(info.State.Running, true);
    const mapping = info.NetworkSettings.Ports["8333/tcp"];
    assert.equal(mapping?.length, 1, "[photo fixture] exactly one S3 loopback mapping");
    assert.equal(mapping![0]!.HostIp, "127.0.0.1");
    assert.match(mapping![0]!.HostPort, /^\d+$/);
    assert.ok(Number(mapping![0]!.HostPort) > 0 && Number(mapping![0]!.HostPort) <= 65535);
    for (const [port, hosts] of Object.entries(info.NetworkSettings.Ports)) {
      if (port !== "8333/tcp") assert.ok(!hosts?.length, "[photo fixture] no other ports published");
    }
    const endpoint = `http://127.0.0.1:${mapping![0]!.HostPort}`;
    const config = { endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId, secretAccessKey } };
    client = new S3Client(config);
    phase = "signed HeadBucket readiness";
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) });
        if (response.$metadata.httpStatusCode === 200) { ready = true; break; }
      } catch { /* Startup only; no SDK error values are logged. */ }
      await pause(250);
    }
    assert.ok(ready, "[photo fixture] signed bucket readiness timed out");
    phase = "real signed object roundtrip and authentication denial";
    const key = `photos/${randomUUID()}.jpg`;
    const bytes = Buffer.from("ci-only-synthetic-s3-preflight-no-user-photo");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }), { abortSignal: AbortSignal.timeout(5000) });
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) });
    assert.ok(object.Body);
    const received = await object.Body.transformToByteArray();
    assert.equal(hash(received), hash(bytes), "[photo fixture] real object bytes must roundtrip");
    const anonymous = await fetch(`${endpoint}/${bucket}/${key}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    await anonymous.arrayBuffer();
    assert.ok([401, 403].includes(anonymous.status), "[photo fixture] anonymous object access must be refused");
    const wrong = new S3Client({ ...config, credentials: { accessKeyId, secretAccessKey: "ci-only-wrong-secret" } });
    try {
      let refusal: unknown;
      try { await wrong.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) }); }
      catch (error) { refusal = error; }
      assert.ok([401, 403].includes(status(refusal) ?? 0), "[photo fixture] wrong credentials must be refused");
    } finally { wrong.destroy(); }
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) });
    let missing: unknown;
    try { await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) }); }
    catch (error) { missing = error; }
    assert.equal(status(missing), 404, "[photo fixture] deleted object must really be absent");
    console.log("[photo fixture] pinned SeaweedFS: HeadBucket/Put/Get hash/Delete/Get404; anonymous/wrong-key refused; synthetic bytes only");
    return { appEnv: { POD_PHOTOS_S3_ENDPOINT: endpoint, POD_PHOTOS_S3_REGION: "us-east-1", POD_PHOTOS_S3_BUCKET: bucket,
      POD_PHOTOS_S3_ACCESS_KEY_ID: accessKeyId, POD_PHOTOS_S3_SECRET_ACCESS_KEY: secretAccessKey }, stop };
  } catch {
    try { await stop(); }
    catch { throw new Error(`[photo fixture] preparation failed at ${phase}; owned cleanup also failed (not a product RED)`); }
    throw new Error(`[photo fixture] preparation failed at ${phase} (not a product RED; no SDK/env/raw logs retained)`);
  }
}
