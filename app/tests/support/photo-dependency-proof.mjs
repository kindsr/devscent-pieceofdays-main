// CI-only dependency spike: copy package files, install in scratch, perform no S3 I/O.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["package-lock.json", "package.json"];
const PINS = { sharp: "0.35.5", "@aws-sdk/client-s3": "3.1165.0" };
const REGISTRY = "https://registry.npmjs.org/";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1", "isolated runner required");
assert.equal(process.env.CI, "true", "CI required");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Actions runner required");
assert.ok(process.env.RUNNER_TEMP, "runner temporary directory required");
assert.equal(process.platform, "linux", "Linux runner required");
assert.equal(process.arch, "x64", "x64 runner required");
const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
assert.ok(path.isAbsolute(runnerTemp) && runnerTemp !== path.parse(runnerTemp).root, "safe runner temporary directory required");
assert.ok(!/[\r\n]/.test(runnerTemp), "single-line runner path required");
const checkout = realpathSync(path.join(APP, ".."));
assert.ok(!runnerTemp.startsWith(`${checkout}${path.sep}`) && runnerTemp !== checkout, "scratch must be outside checkout");
const output = path.join(runnerTemp, "pod-photo-dependency-lock");

function readJson(filename) {
  const stat = lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "regular JSON file required");
  return JSON.parse(readFileSync(filename, "utf8"));
}

function ownedDirectory(directory) {
  assert.equal(path.dirname(directory), runnerTemp, "owned directory must be directly under runner temp");
  const stat = lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "owned regular directory required");
  assert.equal(realpathSync(directory), directory, "directory symlinks refused");
}

function validateRegistryPackages(lock) {
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    assert.ok(location.startsWith("node_modules/") && !location.split("/").includes("..") && !entry.link, "registry packages only");
    const url = new URL(entry.resolved);
    assert.ok(url.origin === REGISTRY.slice(0, -1) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith(".tgz"), "official registry tarballs only");
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, "SHA-512 package integrity required");
  }
}

function validatePair(directory, expected) {
  const pkg = readJson(path.join(directory, "package.json"));
  const lock = readJson(path.join(directory, "package-lock.json"));
  assert.deepEqual(pkg, expected, "only the two exact dependencies may change the manifest");
  assert.equal(lock.lockfileVersion, 3, "lock version 3 required");
  assert.equal(lock.name, pkg.name, "lock package name must match");
  assert.equal(lock.version, pkg.version, "lock package version must match");
  assert.ok(lock.packages?.[""], "lock root required");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines"]) {
    assert.deepEqual(lock.packages[""][field] ?? {}, pkg[field] ?? {}, "lock root must match the manifest");
  }
  for (const [name, version] of Object.entries(PINS)) {
    assert.equal(pkg.dependencies[name], version, "exact manifest version required");
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, "exact locked version required");
  }
  validateRegistryPackages(lock);
  return lock;
}

async function registryMetadata(name, version) {
  const response = await fetch(`${REGISTRY}${encodeURIComponent(name)}/${version}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "exact official registry metadata required");
  const metadata = await response.json();
  assert.equal(metadata.name, name, "registry package name mismatch");
  assert.equal(metadata.version, version, "registry package version mismatch");
  assert.equal(metadata.license, "Apache-2.0", "expected package license mismatch");
  return metadata;
}

async function probeSharp(requireFromScratch) {
  const sharp = requireFromScratch("sharp");
  assert.equal(sharp.versions.sharp, PINS.sharp, "loaded Sharp version mismatch");
  sharp.cache(false);
  sharp.concurrency(1);
  // Synthetic RGB only. Orientation metadata makes default stripping observable.
  const input = await sharp({ create: { width: 3200, height: 1600, channels: 3, background: "#5078a0" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await sharp(input).metadata()).orientation, 6, "synthetic orientation fixture required");
  const normalize = (bytes) => sharp(bytes, { limitInputPixels: 40_000_000 })
    .autoOrient().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).timeout({ seconds: 5 }).toBuffer();
  const result = await normalize(input);
  assert.ok(result.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && result.subarray(-2).equals(Buffer.from([0xff, 0xd9])), "JPEG signature required");
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, "jpeg", "decoded JPEG required");
  assert.equal(metadata.width, 1280, "orientation and inside resize width");
  assert.equal(metadata.height, 2560, "orientation and inside resize height");
  assert.ok(result.length <= 4 * 1024 * 1024, "synthetic output byte limit");
  for (const field of ["orientation", "exif", "icc", "iptc", "xmp"]) assert.equal(metadata[field], undefined, "metadata stripped by default");
  const decoded = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.channels, 3, "decoded RGB required");
  assert.equal(decoded.data.length, 1280 * 2560 * 3, "full JPEG decode required");
  const small = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#5078a0" } }).jpeg().toBuffer();
  const smallMetadata = await sharp(await normalize(small)).metadata();
  assert.equal(smallMetadata.width, 32, "withoutEnlargement width");
  assert.equal(smallMetadata.height, 16, "withoutEnlargement height");
  await assert.rejects(sharp(input, { limitInputPixels: 1 }).metadata(), /pixel limit/i);
  console.log(`Sharp ${PINS.sharp}: synthetic RGB/JPEG, orientation, resize, metadata stripping, pixel-limit and timeout API; libvips ${sharp.versions.vips}`);
  console.log("API compatibility only; real 40MP inputs, 512MB capacity, adversarial photos and timeout expiry are unproven.");
}

async function probeS3(requireFromScratch) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = requireFromScratch("@aws-sdk/client-s3");
  let requests = 0;
  let destroyed = 0;
  const client = new S3Client({
    region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: "ci-only-access-key", secretAccessKey: "ci-only-secret-key" },
    requestHandler: { handle() { requests++; throw new Error("S3 I/O prohibited"); }, destroy() { destroyed++; } },
  });
  try {
    assert.equal(await client.config.region(), "us-east-1", "explicit CI region required");
    const credentials = await client.config.credentials();
    assert.equal(credentials.accessKeyId, "ci-only-access-key", "static fake credentials required");
    assert.equal(credentials.secretAccessKey, "ci-only-secret-key", "static fake credentials required");
    assert.equal(client.config.forcePathStyle, true);
    const object = { Bucket: "ci-only-no-bucket", Key: "ci-only/synthetic.jpg" };
    const put = { ...object, Body: Buffer.from([0]), ContentType: "image/jpeg" };
    for (const [Command, input] of [[PutObjectCommand, put], [GetObjectCommand, object], [DeleteObjectCommand, object]]) {
      const command = new Command(input);
      assert.deepEqual(command.input, input, "S3 command shape");
      assert.equal(typeof command.resolveMiddleware, "function", "SDK command constructor required");
    }
  } finally { client.destroy(); }
  assert.equal(requests, 0, "S3 requests forbidden");
  assert.equal(destroyed, 1, "client destroy must reach the owned handler");
  console.log(`S3 SDK ${PINS["@aws-sdk/client-s3"]}: constructor/config/put-get-delete shapes/destroy; send calls 0; no storage support claim.`);
}

async function prove() {
  assert.ok(process.env.GITHUB_OUTPUT, "Actions output file required");
  let phase = "source allowlist", temporary, outputCreated = false, complete = false;
  const hashes = new Map();
  try {
    const originals = new Map(FILES.map((name) => {
      readJson(path.join(APP, name));
      const bytes = readFileSync(path.join(APP, name));
      hashes.set(name, digest(bytes));
      return [name, bytes];
    }));
    const original = JSON.parse(originals.get("package.json").toString("utf8"));
    const originalLock = JSON.parse(originals.get("package-lock.json").toString("utf8"));
    assert.deepEqual(originalLock.packages[""].dependencies, original.dependencies, "source dependency roots must agree");
    assert.deepEqual(originalLock.packages[""].devDependencies, original.devDependencies, "source dev dependency roots must agree");
    validateRegistryPackages(originalLock);
    assert.equal(originalLock.packages["node_modules/sharp"].version, PINS.sharp, "Sharp must match the existing Next optional lock");
    const expected = { ...original, dependencies: { ...original.dependencies, ...PINS } };
    temporary = mkdtempSync(path.join(runnerTemp, "pod-photo-dependency-scratch-"));
    for (const [name, bytes] of originals) writeFileSync(path.join(temporary, name), bytes, { flag: "wx" });
    writeFileSync(path.join(temporary, "package.json"), `${JSON.stringify(expected, null, 2)}\n`);
    // Empty private npm config/cache; only the temporary package pair is copied from the app.
    const npmrc = path.join(temporary, "empty-npmrc");
    const globalNpmrc = path.join(temporary, "empty-global-npmrc");
    for (const filename of [npmrc, globalNpmrc]) writeFileSync(filename, "", { flag: "wx" });
    const tmp = path.join(temporary, "tmp");
    mkdirSync(tmp);
    const npmEnv = { PATH: process.env.PATH, CI: "true", TMPDIR: tmp,
      npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc,
      npm_config_cache: path.join(temporary, "npm-cache"), npm_config_registry: REGISTRY,
      npm_config_engine_strict: "true", npm_config_update_notifier: "false", SHARP_IGNORE_GLOBAL_LIBVIPS: "1" };
    const npm = (args) => execFileSync("npm", args, { cwd: temporary, env: npmEnv, stdio: "inherit", timeout: 300_000 });
    phase = "exact registry metadata";
    const registry = new Map();
    for (const [name, version] of Object.entries(PINS)) registry.set(name, await registryMetadata(name, version));
    const sdkMetadata = registry.get("@aws-sdk/client-s3");
    assert.match(sdkMetadata.engines?.node, /^>=20(?:\.0(?:\.0)?)?$/, "SDK Node >=20 metadata required");
    assert.equal(Object.keys(sdkMetadata.dependencies).length, 11, "expected SDK direct dependency count changed");
    phase = "temporary lock generation";
    npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const lock = validatePair(temporary, expected);
    phase = "temporary clean install and dependency tree";
    npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    npm(["ls", "--all"]);
    assert.deepEqual(validatePair(temporary, expected), lock, "clean install must preserve the generated lock");
    phase = "installed metadata and licenses";
    for (const [name, version] of Object.entries(PINS)) {
      const installed = readJson(path.join(temporary, "node_modules", name, "package.json"));
      const metadata = registry.get(name);
      const entry = lock.packages[`node_modules/${name}`];
      assert.equal(installed.name, name);
      assert.equal(installed.version, version);
      assert.equal(installed.license, "Apache-2.0");
      assert.deepEqual(installed.engines, metadata.engines, "installed engines must match official metadata");
      assert.deepEqual(installed.dependencies, metadata.dependencies, "installed direct dependencies must match official metadata");
      assert.deepEqual(entry.dependencies, metadata.dependencies, "locked direct dependencies must match official metadata");
      assert.equal(entry.resolved, metadata.dist.tarball, "locked tarball must match official metadata");
      assert.equal(entry.integrity, metadata.dist.integrity, "locked integrity must match official metadata");
      assert.equal(entry.license, metadata.license, "locked license must match official metadata");
    }
    console.log("Exact official metadata, installed manifests and locks agree; SDK Node >=20, direct dependencies 11.");
    const licenses = new Map();
    const unknown = [];
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location) continue;
      if (typeof entry.license !== "string" || !entry.license.trim() || /^(?:UNKNOWN|UNLICENSED|SEE LICENSE)/i.test(entry.license)) unknown.push(`${location}@${entry.version}`);
      else licenses.set(entry.license, (licenses.get(entry.license) ?? 0) + 1);
    }
    const libvips = readJson(path.join(temporary, "node_modules/@img/sharp-libvips-linux-x64/package.json"));
    assert.equal(libvips.license, "LGPL-3.0-or-later", "bundled libvips license required");
    assert.equal(libvips.version, lock.packages["node_modules/@img/sharp-libvips-linux-x64"].version);
    assert.equal(libvips.license, lock.packages["node_modules/@img/sharp-libvips-linux-x64"].license, "bundled libvips lock license must agree");
    console.log("All locked dependency license metadata (including optional platforms):", JSON.stringify([...licenses].sort((a, b) => b[1] - a[1])));
    console.log("Unknown/unresolved dependency license metadata:", JSON.stringify(unknown));
    console.log(`Sharp itself: Apache-2.0; bundled libvips package ${libvips.version}: LGPL-3.0-or-later. Metadata inventory is not a full license audit.`);
    const requireFromScratch = createRequire(path.join(temporary, "package.json"));
    phase = "synthetic Sharp API probe";
    await probeSharp(requireFromScratch);
    phase = "offline S3 API probe";
    await probeS3(requireFromScratch);
    phase = "artifact allowlist";
    mkdirSync(output, { mode: 0o700 }); // EEXIST fails without taking ownership or deleting it.
    outputCreated = true;
    for (const name of FILES) {
      const bytes = readFileSync(path.join(temporary, name));
      writeFileSync(path.join(output, name), bytes, { flag: "wx" });
      assert.equal(digest(readFileSync(path.join(output, name))), digest(bytes), "artifact bytes must match the approved pair");
    }
    ownedDirectory(output);
    assert.deepEqual(readdirSync(output).sort(), FILES, "exactly two artifact files required");
    assert.deepEqual(validatePair(output, expected), lock, "artifact pair must equal the approved pair");
    complete = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 240) : "non-Error failure";
    console.error(`photo dependency proof failed at ${phase}: ${reason}; no package artifact approved`);
    process.exitCode = 1;
  } finally {
    const failures = [];
    try { for (const [name, hash] of hashes) { readJson(path.join(APP, name)); assert.equal(digest(readFileSync(path.join(APP, name))), hash, "original package bytes changed"); } }
    catch { failures.push("original package hashes"); }
    try { if (temporary) { ownedDirectory(temporary); assert.ok(path.basename(temporary).startsWith("pod-photo-dependency-scratch-")); rmSync(temporary, { recursive: true }); } }
    catch { failures.push("owned scratch cleanup"); }
    if (complete && !failures.length) {
      try { appendFileSync(process.env.GITHUB_OUTPUT, `artifact_dir=${output}\n`); }
      catch { failures.push("Actions output publication"); }
    }
    if (outputCreated && (!complete || failures.length)) {
      try { ownedDirectory(output); rmSync(output, { recursive: true }); }
      catch { failures.push("owned artifact cleanup"); }
    }
    if (failures.length) { console.error(`photo dependency proof cleanup failed: ${failures.join(", ")}`); process.exitCode = 1; }
    if (complete && !failures.length) {
      console.log("Original package SHA-256 unchanged:", JSON.stringify(Object.fromEntries(hashes)));
      console.log("Approved package files 2; temporary install removed. Photo feature and real S3 remain unproven.");
    }
  }
}

if (process.argv[2] === "--cleanup-output") {
  assert.equal(process.argv.length, 3, "cleanup takes no path arguments");
  if (process.env.POD_PHOTO_ARTIFACT_DIR) {
    assert.equal(process.env.POD_PHOTO_ARTIFACT_DIR, output, "only this proof's emitted artifact path may be removed");
    ownedDirectory(output);
    assert.deepEqual(readdirSync(output).sort(), FILES, "cleanup artifact allowlist");
    for (const name of FILES) readJson(path.join(output, name));
    rmSync(output, { recursive: true });
  }
} else {
  assert.equal(process.argv.length, 2, "proof takes no arguments");
  await prove();
}
