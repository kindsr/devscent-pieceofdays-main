// F6a2: actual standalone image + exact trusted helper nginx + the unabridged public outer fragment.
// Run only in Secrets-free Actions: node --test --test-reporter=tap tests/front-contract.test.mjs
// Required env: CI=true GITHUB_ACTIONS=true POD_FULL_CHECK_ISOLATED=1 POD_TEST_DB_DISPOSABLE=1
// POD_TEST_ADMIN_URL (loopback disposable PG18), POD_IMAGE_TEST_IMAGE (immutable sha256 ID),
// POD_IMAGE_TEST_NETWORK (Actions service network ID), POD_IMAGE_TEST_DB_HOST (PG18 alias).
// Fourteen real contracts, no skip. #14 also runs the ORIGINAL ten preview cases, no retry/skip.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { expect } from "@playwright/test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ANCESTOR_HIDDEN_HEADERS, APP_DIR, BASE, BASIC, PROVIDERS, RELAY_BUCKET, STORAGE_ACCESS, FrontHarness, callbackInput, command, docker, hash, protect, request, values } from "./support/front-harness.mjs";

const h = new FrontHarness();
const OPTIONS = { timeout: 300_000 };
before(async () => { await h.setup(); }, { timeout: 900_000 });
after(async () => { await h.cleanup(); }, { timeout: 180_000 });

function noStore(r) { assert.match(r.headers["cache-control"] ?? "", /\bno-store\b/, "private response is no-store"); }
function noClear(r) { assert.equal(r.headers["clear-site-data"], undefined, "browser diary must be preserved"); }
function policy(r) {
  assert.deepEqual(values(r.rawHeaders, "Referrer-Policy"), ["no-referrer"], "one callback policy, including error responses");
}
function security(r, referrer = "no-referrer") {
  assert.deepEqual(values(r.rawHeaders, "Referrer-Policy"), [referrer]);
  assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["strict-transport-security"], "max-age=31536000");
}
// Outer photo responses: exactly one existing safe value per security header (raw, unfolded)
// and no upstream banner. Duplicates or observer values mean the ancestor hide list was lost.
function photoEdgeHeaders(r) {
  for (const [name, expected] of [["X-Robots-Tag", ["noindex, nofollow"]], ["X-Frame-Options", ["SAMEORIGIN"]],
    ["X-Content-Type-Options", ["nosniff"]], ["Referrer-Policy", ["strict-origin-when-cross-origin"]],
    ["Strict-Transport-Security", ["max-age=31536000"]], ["X-Powered-By", []]]) {
    assert.deepEqual(values(r.rawHeaders, name), expected, `outer photo ${name}: exactly the inherited safe value, no upstream value`);
  }
}
function expired(r) {
  assert.equal(r.status, 303, "real B4 missing/invalid-flow callback");
  assert.equal(r.headers.location, `${BASE}/login?error=expired`);
  policy(r);
  noStore(r);
  const cookies = r.headers["set-cookie"] ?? [];
  assert.equal(cookies.length, 1, "only the flow cookie is deleted");
  assert.match(cookies[0], /^__Host-pod_oauth=;.*Max-Age=0;.*Path=\/;.*HttpOnly;.*SameSite=Lax;.*Secure/i);
  assert.ok(!cookies[0].includes("Domain="));
}
function safeRow(row, provider, status) {
  assert.ok(row, "a real safe access-log row was collected");
  assert.equal(row.request_uri, `/auth/${provider}/callback`);
  assert.equal(row.uri, row.request_uri);
  assert.equal(row.args, "");
  assert.equal(row.http_referer, "");
  assert.equal(row.status, status);
  for (const key of ["time", "remote_addr", "x_forwarded_for", "host", "server_name", "request_method", "body_bytes_sent", "http_user_agent", "request_time", "upstream_response_time", "scheme"]) assert.ok(Object.hasOwn(row, key), `safe JSON retains ${key}`);
}
function photoInput(kind = "get") {
  const id = protect(randomUUID());
  const marker = protect(`ci_photo_${randomUUID()}`);
  const referer = protect(`https://photo-referrer.invalid/${randomUUID()}`);
  const targetPath = kind === "upload" ? "/photos/upload" : `/photos/${id}`;
  return { id, marker, target: `${targetPath}?probe=${marker}%2Bvalue&probe=duplicate%20value`,
    sentinels: [targetPath, ...(kind === "upload" ? [] : [id]), marker, referer],
    headers: { Origin: BASE, Referer: referer, Cookie: protect(`ci_photo_cookie=${randomUUID()}`) } };
}
async function noPhotoSentinels(sentinels) {
  // Only the inner front has photo locations in this slice. The unmodified
  // outer fixture still has its ordinary logging/1m policy for these paths.
  const records = (await h.logs()).filter((record) => record.role === "front");
  assert.ok(records.length > 0, "identified inner-front sinks with both positive controls are required");
  for (const record of records) for (const stream of ["stdout", "stderr"]) for (const sentinel of sentinels) {
    assert.ok(!record[stream].includes(sentinel) && !record[stream].includes(encodeURIComponent(sentinel)), `${record.sink}/${stream}: photo sentinel absent`);
  }
}
function privatePhoto(r) {
  noStore(r);
  assert.match(r.headers["cache-control"] ?? "", /\bprivate\b/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  noClear(r);
}
function receivedPhoto(r, input, body, method) {
  assert.equal(r.status, 200, "CI receiving-byte observer, not a storage success");
  const received = JSON.parse(r.body);
  assert.equal(received.method, method);
  assert.ok(received.target === input.target, "photo query encoding, order and duplicates are preserved");
  for (const [name, value] of [["Host", "dev.pieceofdays.com"], ["X-Forwarded-Host", "dev.pieceofdays.com"], ["X-Forwarded-Proto", "https"], ["Origin", input.headers.Origin], ["Cookie", input.headers.Cookie], ["Referer", input.headers.Referer]]) {
    assert.ok(values(received.rawHeaders, name).length === 1 && values(received.rawHeaders, name)[0] === value, `${name} reaches the photo observer unchanged/fixed as contracted`);
  }
  assert.equal(received.bodyLength, body.length, "actual bytes received through nginx");
  assert.equal(received.bodySha256, hash(body), "actual receiving-byte SHA256, not Content-Length alone");
}
function gatewayPhotoInput(kind = "get") {
  const input = photoInput(kind);
  return { ...input, sentinels: [...input.sentinels, input.headers.Cookie, input.headers.Cookie.slice(input.headers.Cookie.indexOf("=") + 1)] };
}

test("01 exact helper configuration and the complete outer fragment pass real nginx syntax checks; immutable image identity", OPTIONS, async (t) => {
  for (const name of [h.names.front, h.names.outer]) await docker(["exec", name, "nginx", "-t"]);
  const conf = (await docker(["exec", h.names.front, "cat", "/etc/nginx/conf.d/default.conf"])).stdout;
  assert.equal(conf, h.trusted.conf, "not a handwritten approximation of the helper policy");
  const outer = (await docker(["exec", h.names.outer, "cat", "/etc/nginx/conf.d/default.conf"])).stdout;
  const fragment = readFileSync(path.join(APP_DIR, "tests/fixtures/front/outer-callback.conf"), "utf8");
  assert.equal(h.fragmentHash, "6b8a1ea6acd659d462129e23d2dfeceb21a9da9bdef2dd47d4e97336ca0252c9", "main-supplied fragment bytes");
  const cut = fragment.indexOf("location = /auth/google/callback {");
  assert.ok(outer.startsWith(fragment.slice(0, cut)) && outer.includes(fragment.slice(cut)), "all original fragment directives are used verbatim");
  const image = JSON.parse((await docker(["image", "inspect", h.image])).stdout)[0];
  assert.equal(image.Id, h.image);
  assert.equal(image.Config.Labels["org.opencontainers.image.revision"], (await command("git", ["rev-parse", "HEAD"])).stdout.trim());
  assert.equal(image.Config.Labels["pod.tree"], (await command("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim());
  t.diagnostic(`immutable app image ${h.image}; public fragment sha256 ${h.fragmentHash}`);
  for (const record of await h.logs()) t.diagnostic(`${record.sink}: stdout and stderr positive collection controls observed`);
  assert.equal(typeof h.photoFragmentHash, "string", "the actual outer fixture must expose the public photo fragment hash (not implemented yet)");
  assert.match(h.photoFragmentHash, /^[0-9a-f]{64}$/, "photo fragment hash is a raw SHA256");
  const photoFragmentPath = path.join(APP_DIR, "..", "deploy/nginx/snippets/dev-private-photos.conf");
  assert.ok(existsSync(photoFragmentPath), "the reviewed public photo snippet must exist before reading it");
  const photoFragment = readFileSync(photoFragmentPath, "utf8");
  assert.ok(photoFragment.trim().length > 0, "photo proposal is not an empty placeholder");
  assert.equal(hash(photoFragment), h.photoFragmentHash, "real outer fixture and public snippet use the same bytes");
  assert.ok(outer.includes(photoFragment), "the complete public photo fragment is included verbatim in actual nginx config");
  const photoLocations = [...photoFragment.matchAll(/location\s+(=|\^~)\s+(\S+)\s*\{([^{}]*)\}/g)];
  assert.deepEqual(photoLocations.map((m) => [m[1], m[2]]).sort(), [["=", "/photos/upload"], ["^~", "/photos/"]].sort(), "exactly the two reviewed photo locations");
  assert.equal([...photoFragment.matchAll(/\blocation\s/g)].length, 2, "no additional outer routes");
  const httpLevel = outer.slice(0, outer.indexOf("\nserver {"));
  assert.deepEqual([...httpLevel.matchAll(/\bproxy_hide_header\s+([^;]+);/g)].map((m) => m[1].trim()), ANCESTOR_HIDDEN_HEADERS, "the actual outer fixture models the five ancestor (http-level) hidden upstream headers");
  for (const location of photoLocations) {
    const body = location[3];
    assert.deepEqual([...body.matchAll(/client_max_body_size\s+([^;]+);/g)].map((m) => m[1]), [location[1] === "=" ? "9m" : "1m"]);
    assert.match(body, /\baccess_log\s+off\s*;/);
    assert.match(body, /\berror_log\s+\/dev\/null\s+crit\s*;/);
    assert.deepEqual([...body.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]), ["$pieceofdays_dev_web"]);
    assert.deepEqual([...body.matchAll(/\bproxy_hide_header\s+([^;]+);/g)].map((m) => m[1].trim()), [], "no local proxy_hide_header: a local list would replace the five inherited ancestor hides");
    assert.doesNotMatch(body, /\b(add_header|auth_basic|auth_basic_user_file|allow|deny|satisfy|return|rewrite)\s/, "photo proposal inherits server security and does not bypass Basic/IP");
  }
  await relayContract(t);
});

// PLAN_dev-minio-story-runtime §1.1~1.3 inside the existing #01 (fourteen cases are kept).
// A relay HTML 403 is not S3 XML; the SDK may then expose only the raw response status.
const sdkStatus = (error) => error?.$metadata?.httpStatusCode ?? error?.$response?.statusCode;
const relayKey = () => `photos/${protect(randomUUID())}.jpg`;
/** nginx's own refusal (HTML body), as opposed to a storage S3 error (XML body) that proves the request was forwarded. */
function relayRefused(r, label, status = 403) {
  assert.equal(r.status, status, `${label}: relay refuses with ${status}`);
  const body = r.body.toString("utf8");
  assert.doesNotMatch(body, /<\?xml|<Error>/, `${label}: refused by the relay itself, never forwarded to storage`);
  assert.match(body, /<html/i, `${label}: nginx-generated refusal`);
}
function storageRefusedAnonymous(r, label) {
  assert.ok([401, 403].includes(r.status), `${label}: unsigned request is refused by storage (${r.status})`);
  assert.match(r.body.toString("utf8"), /<Error>|<\?xml/, `${label}: refusal comes from storage after the relay forwarded the exact request`);
}
async function relayContract(t) {
  assert.equal(typeof h.trusted.relay, "string", "scripts/ops/deploy.py must define DEV_FRONT_RELAY_NGINX_CONF (separate internal 8081 relay; not implemented yet)");
  assert.equal(h.trusted.conf, h.trusted.public80 + h.trusted.relay, "front default.conf is the unchanged public80 constant followed by the relay constant");
  assert.match(h.trusted.relay, /\blisten\s+8081\s*;/);

  // The front already started without any `minio` on the network: public80 is never blocked by the relay.
  const early = relayKey();
  const missing = await h.relayRequest(`/${RELAY_BUCKET}/${early}?x-id=GetObject`);
  assert.equal(missing.status, 502, "storage absent: relay answers 502 while public80 keeps serving");
  assert.equal((await h.frontRequest("/try/")).status, 200, "public80 /try/ unaffected by an absent MinIO");

  await h.storage();
  const client = h.relayClient();
  try {
    let ready = false;
    for (let n = 0; n < 240 && !ready; n++) {
      try { await client.send(new GetObjectCommand({ Bucket: RELAY_BUCKET, Key: relayKey() }), { abortSignal: AbortSignal.timeout(2000) }); }
      catch (error) { ready = sdkStatus(error) === 404; }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "signed GET of a missing key through the relay reaches storage (NoSuchKey) once storage is up");

    // Real SigV4 roundtrip: Host/URI/body must reach storage unchanged or the signature fails.
    const key = relayKey();
    const bytes = randomBytes(4 * 1024 * 1024);
    await client.send(new PutObjectCommand({ Bucket: RELAY_BUCKET, Key: key, Body: bytes, ContentLength: bytes.length, ContentType: "image/jpeg" }), { abortSignal: AbortSignal.timeout(20_000) });
    const got = await client.send(new GetObjectCommand({ Bucket: RELAY_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(20_000) });
    assert.equal(hash(Buffer.from(await got.Body.transformToByteArray())), hash(bytes), "4MiB object bytes roundtrip through the relay");
    await client.send(new DeleteObjectCommand({ Bucket: RELAY_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
    let deleted;
    try { await client.send(new GetObjectCommand({ Bucket: RELAY_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(10_000) }); }
    catch (error) { deleted = error; }
    assert.equal(sdkStatus(deleted), 404, "a deleted key is NoSuchKey (cleanup completion signal), not forbidden");

    let otherBucket;
    try { await client.send(new GetObjectCommand({ Bucket: "pieceofdays-photos", Key: relayKey() }), { abortSignal: AbortSignal.timeout(10_000) }); }
    catch (error) { otherBucket = error; }
    assert.equal(sdkStatus(otherBucket), 403, "a signed request for another bucket is refused at the relay");
    const wrong = h.relayClient("ci-only-wrong-secret");
    try {
      let refusal;
      try { await wrong.send(new GetObjectCommand({ Bucket: RELAY_BUCKET, Key: relayKey() }), { abortSignal: AbortSignal.timeout(10_000) }); }
      catch (error) { refusal = error; }
      assert.ok([401, 403].includes(sdkStatus(refusal)), "a wrong signature is refused by storage (the relay adds no authority)");
    } finally { wrong.destroy(); }
  } finally { client.destroy(); }

  const id = protect(randomUUID());
  const object = `/${RELAY_BUCKET}/photos/${id}.jpg`;
  // Allowed shapes are forwarded verbatim (unsigned → storage refusal, never a relay page).
  for (const [method, target] of [["GET", `${object}?x-id=GetObject`], ["GET", object], ["PUT", `${object}?x-id=PutObject`], ["DELETE", `${object}?x-id=DeleteObject`], ["DELETE", object]]) {
    storageRefusedAnonymous(await h.relayRequest(target, { method, ...(method === "PUT" ? { body: Buffer.from("ci-only-unsigned"), headers: { "Content-Type": "image/jpeg" } } : {}) }), `${method} ${target.replace(id, "<id>")}`);
  }
  // Everything else is the relay's own 403: method/x-id mismatch, duplicate/extra query, other bucket/prefix/name,
  // and raw $request_uri bypasses (percent-encoded dot/slash/uuid, double slash, dot segments).
  const upper = id.toUpperCase();
  for (const [method, target] of [
    ["GET", `${object}?x-id=PutObject`], ["GET", `${object}?x-id=DeleteObject`], ["PUT", `${object}?x-id=GetObject`], ["DELETE", `${object}?x-id=GetObject`],
    ["POST", object], ["POST", `${object}?x-id=PutObject`], ["PATCH", `${object}?x-id=PutObject`], ["OPTIONS", object],
    ["GET", `${object}?x-id=GetObject&x-id=GetObject`], ["GET", `${object}?x-id=GetObject&ci-only=1`], ["GET", `${object}?ci-only=1&x-id=GetObject`],
    ["GET", `${object}?acl`], ["GET", `${object}?x-id=ListObjectsV2`], ["GET", `${object}?x-id=getobject`], ["GET", `${object}?X-Id=GetObject`], ["GET", `${object}?`],
    ["GET", `/pieceofdays-photos/photos/${id}.jpg?x-id=GetObject`], ["GET", `/pieceofdays-photos-dev2/photos/${id}.jpg`], ["GET", `/${RELAY_BUCKET}/other/${id}.jpg`],
    ["GET", `/${RELAY_BUCKET}/photos/${upper}.jpg`], ["GET", `/${RELAY_BUCKET}/photos/${id}.png`], ["GET", `/${RELAY_BUCKET}/photos/${id}.jpg/`],
    ["GET", `/${RELAY_BUCKET}/photos/${id}.jpgx`], ["GET", `/${RELAY_BUCKET}/photos/x${id}.jpg`], ["GET", `/${RELAY_BUCKET}/photos/${id.replaceAll("-", "")}.jpg`],
    ["GET", `/${object}`], ["GET", `/${RELAY_BUCKET}//photos/${id}.jpg`], ["GET", `/${RELAY_BUCKET}/./photos/${id}.jpg`], ["GET", `/${RELAY_BUCKET}/x/../photos/${id}.jpg`],
    ["GET", `/${RELAY_BUCKET}/photos/%2e%2e/photos/${id}.jpg`], ["GET", `/${RELAY_BUCKET}%2Fphotos%2F${id}.jpg`], ["GET", `/${RELAY_BUCKET}/photos%2F${id}.jpg`],
    ["GET", `/${RELAY_BUCKET}/photos/${id}%2Ejpg`], ["GET", `/${RELAY_BUCKET}/photos/${encodeURIComponent(id).replace("-", "%2D")}.jpg`], ["GET", `/%70ieceofdays-photos-dev/photos/${id}.jpg`],
    ["GET", `/${RELAY_BUCKET}?list-type=2`], ["GET", `/${RELAY_BUCKET}/`], ["GET", `/${RELAY_BUCKET}/photos/`], ["GET", "/"], ["GET", "/try/"], ["GET", "/minio/health/live"],
  ]) relayRefused(await h.relayRequest(target, { method }), `${method} ${target.replace(id, "<id>").replace(upper, "<ID>")}`);
  relayRefused(await h.relayRequest(`${object}?x-id=PutObject`, { method: "PUT", body: Buffer.alloc(5 * 1024 * 1024 + 1), headers: { "Content-Type": "image/jpeg" } }), "PUT above 5m", 413);

  // access_log off / error_log crit: no object key, credential id or query value in any front log stream.
  const sentinels = [early, id, STORAGE_ACCESS, "x-id=", RELAY_BUCKET];
  const records = (await h.logs()).filter((record) => record.role === "front");
  assert.ok(records.length > 0, "identified inner-front sinks with both positive controls are required");
  for (const record of records) for (const stream of ["stdout", "stderr"]) for (const sentinel of sentinels) {
    assert.ok(!record[stream].includes(sentinel), `${record.sink}/${stream}: relay sentinel absent`);
  }
  assert.equal((await h.frontRequest("/try/")).status, 200, "public80 still serves after relay traffic");
  t.diagnostic("relay: absent-storage 502, SDK Put/Get/Delete/NoSuchKey, other-bucket/method/query/encoding 403, unsigned forwarded, logs clean");
}

test("02 actual Next with no providers: login preparation and configuration-before-Origin 503", OPTIONS, async () => {
  await h.upstream("off");
  const r = await h.frontRequest("/login");
  assert.equal(r.status, 200);
  assert.ok(r.body.toString().includes("로그인을 준비하고 있어요"));
  noStore(r);
  for (const origin of [undefined, BASE, "https://wrong.invalid"]) {
    const post = await h.frontRequest("/auth/logout", { method: "POST", headers: origin ? { Origin: origin } : {} });
    assert.equal(post.status, 503, "auth configuration precedes Origin");
    noStore(post);
    assert.equal(post.headers.location, undefined);
    assert.equal(post.headers["set-cookie"], undefined);
  }
  const input = photoInput("upload");
  const photo = await h.frontRequest(input.target, { method: "POST", headers: { ...input.headers, Origin: "https://wrong.invalid" } });
  assert.equal(photo.status, 503, "actual photo route also checks auth configuration before Origin/body");
  assert.deepEqual(JSON.parse(photo.body), { ok: false, error: "unavailable" });
  privatePhoto(photo);
  await noPhotoSentinels(input.sentinels);
});

test("03 every static file and directory redirect in try/design/promo/status matches the existing static nginx", OPTIONS, async (t) => {
  const paths = [...new Set(["/try", "/try/", "/design", "/design/", "/design/d-warm-pieces/", "/promo", "/promo/", "/status", "/status/", ...h.staticFiles])];
  const baseline = new Map();
  await h.front("baseline");
  await docker(["exec", h.names.front, "nginx", "-t"]);
  for (const target of paths) {
    const r = await h.frontRequest(target);
    baseline.set(target, { status: r.status, type: r.headers["content-type"], location: r.headers.location, digest: hash(r.body) });
  }
  await h.front("front");
  for (const target of paths) {
    const r = await h.frontRequest(target);
    assert.deepEqual({ status: r.status, type: r.headers["content-type"], location: r.headers.location, digest: hash(r.body) }, baseline.get(target), target);
    noClear(r);
  }
  assert.ok(h.staticFiles.length > 0);
  t.diagnostic(`static parity: ${paths.length} HTTP paths including ${h.staticFiles.length} files`);
});

test("04 health and dev/private paths remain outside the public proxy allowlist", OPTIONS, async () => {
  assert.equal((await h.appRequest("/healthz")).status, 200);
  assert.equal((await h.appRequest("/healthz/ready")).status, 200, "same actual app on disposable PG18");
  for (const target of ["/healthz", "/healthz/ready", "/healthz/anything", "/dev/konva-smoke", "/index.html", "/favicon.ico", "/sample/", "/settings/extra", "/private", "/photos-extra/upload"]) {
    assert.equal((await h.frontRequest(target)).status, 404, `front ${target}`);
    assert.equal((await h.edgeRequest(target)).status, 404, `outer ${target}`);
  }
  // PLAN_ai-story-live-generation §4.8·§8: the internal story worker route is never reachable through the front or outer proxy,
  // even with a well-formed bearer token (regression guard: the fixed allowlist already returns 404).
  const bearer = { Authorization: `Bearer ${"0123456789abcdef".repeat(4)}` };
  for (const method of ["POST", "GET"]) {
    for (const target of ["/internal/story-worker", "/internal/story-worker/", "/internal/"]) {
      assert.equal((await h.frontRequest(target, { method, headers: bearer })).status, 404, `front ${method} ${target}`);
      assert.equal((await h.edgeRequest(target, { method, headers: { "X-Story-Probe": "1" } })).status, 404, `outer ${method} ${target}`);
    }
  }
});

test("05 receiving-byte observer proves query, Origin, Cookie and fixed Host through direct front and BOTH proxies", OPTIONS, async () => {
  await h.upstream("observer");
  try {
    for (const provider of PROVIDERS) {
      for (const via of ["front", "outer"]) {
        const input = callbackInput(provider);
        for (const origin of [BASE, "https://origin.invalid", "null"]) {
          const headers = { ...input.headers, Host: "forged.invalid", Origin: origin, "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http" };
          const r = via === "front" ? await h.frontRequest(input.target, { headers }) : await h.edgeRequest(input.target, { headers });
          assert.equal(r.status, 200, "observer control, not a Next callback outcome");
          const received = JSON.parse(r.body);
          assert.ok(received.target === input.target, "raw query/encoding/order/duplicate parameters survive both proxies byte for byte");
          assert.deepEqual(values(received.rawHeaders, "Host"), ["dev.pieceofdays.com"]);
          assert.deepEqual(values(received.rawHeaders, "X-Forwarded-Host"), ["dev.pieceofdays.com"]);
          assert.deepEqual(values(received.rawHeaders, "X-Forwarded-Proto"), ["https"]);
          assert.ok(values(received.rawHeaders, "Origin").join() === origin, "Origin is forwarded unchanged");
          assert.ok(values(received.rawHeaders, "Cookie").join() === input.headers.Cookie, "Cookie bytes are forwarded unchanged");
          assert.ok(values(received.rawHeaders, "Referer").join() === input.headers.Referer, "Referer reaches upstream but is excluded from callback logs");
          await h.noSentinels(input.sentinels);
        }
      }
    }
    const get = photoInput();
    receivedPhoto(await h.frontRequest(get.target, { headers: { ...get.headers, Host: "forged.invalid", "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http" } }), get, Buffer.alloc(0), "GET");
    await noPhotoSentinels(get.sentinels);
    const max = 9 * 1024 * 1024;
    const boundary = Buffer.alloc(max + 1, 0x70); // printable synthetic bytes; never an actual user photo
    for (const chunked of [false, true]) {
      const body = boundary.subarray(0, max);
      const input = photoInput("upload");
      const headers = { ...input.headers, Host: "forged.invalid", Origin: chunked ? "https://origin.invalid" : BASE,
        "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http", "Content-Type": "application/octet-stream",
        ...(chunked ? {} : { "Content-Length": String(body.length) }) };
      receivedPhoto(await h.frontRequest(input.target, { method: "POST", headers, body, chunked }), { ...input, headers }, body, "POST");
      await noPhotoSentinels(input.sentinels);
      const over = photoInput("upload");
      const denied = await h.frontRequest(over.target, { method: "POST", headers: { ...over.headers, ...(chunked ? {} : { "Content-Length": String(boundary.length) }) }, body: boundary, chunked });
      assert.equal(denied.status, 413, "exact upload is limited to 9MiB including actual chunked bytes");
      await noPhotoSentinels(over.sentinels);
      for (const target of [`/photos/${randomUUID()}`, "/photos/upload/", "/photos/upload/extra", "/login"]) {
        const input = photoInput();
        const limitedTarget = `${target}?probe=${input.marker}%2Bvalue`;
        const body = boundary.subarray(0, 1024 * 1024 + 1);
        const denied = await h.frontRequest(limitedTarget, { method: "POST", headers: { ...input.headers, ...(chunked ? {} : { "Content-Length": String(body.length) }) }, body, chunked });
        assert.equal(denied.status, 413, "all other paths retain the 1MiB body limit");
        if (target.startsWith("/photos/")) await noPhotoSentinels([target, ...input.sentinels.slice(1)]);
      }
    }
    const outerGet = gatewayPhotoInput();
    const outerResponse = await h.edgeRequest(outerGet.target, { headers: { ...outerGet.headers, Host: "forged.invalid", "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http" } });
    receivedPhoto(outerResponse, outerGet, Buffer.alloc(0), "GET");
    photoEdgeHeaders(outerResponse);
    security(outerResponse, "strict-origin-when-cross-origin");
    await h.noSentinels(outerGet.sentinels);
    for (const chunked of [false, true]) {
      const input = gatewayPhotoInput("upload");
      const body = boundary.subarray(0, max);
      const headers = { ...input.headers, Host: "forged.invalid", Origin: chunked ? "https://origin.invalid" : BASE,
        "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http", "Content-Type": "application/octet-stream",
        ...(chunked ? {} : { "Content-Length": String(body.length) }) };
      const r = await h.edgeRequest(input.target, { method: "POST", headers, body, chunked });
      receivedPhoto(r, { ...input, headers }, body, "POST");
      photoEdgeHeaders(r);
      security(r, "strict-origin-when-cross-origin");
      await h.noSentinels(input.sentinels);
      const over = gatewayPhotoInput("upload");
      const rejected = await h.edgeRequest(over.target, { method: "POST", headers: { ...over.headers, ...(chunked ? {} : { "Content-Length": String(boundary.length) }) }, body: boundary, chunked });
      assert.equal(rejected.status, 413, "outer→front exact upload rejects 9MiB+1 including chunked input");
      photoEdgeHeaders(rejected);
      security(rejected, "strict-origin-when-cross-origin");
      await h.noSentinels(over.sentinels);
      for (const target of [`/photos/${randomUUID()}`, "/photos/upload/", "/login"]) {
        const input = gatewayPhotoInput();
        const body = boundary.subarray(0, 1024 * 1024 + 1);
        const r = await h.edgeRequest(`${target}?probe=${input.marker}%2Bvalue`, { method: "POST", headers: { ...input.headers, ...(chunked ? {} : { "Content-Length": String(body.length) }) }, body, chunked });
        assert.equal(r.status, 413, "outer photo prefix and ordinary paths retain the 1MiB limit");
        if (target.startsWith("/photos/")) photoEdgeHeaders(r);
        security(r, "strict-origin-when-cross-origin");
        if (target.startsWith("/photos/")) await h.noSentinels([target, ...input.sentinels.slice(1)]);
      }
    }
  } finally { await h.upstream("off"); }
});

test("06 the same browser/origin preserves a real try record across static→actual front replacement and app visits", OPTIONS, async () => {
  await h.front("baseline");
  const origin = `http://127.0.0.1:${h.frontPort}`;
  await h.withBrowser(async (browser) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/try/`);
      await page.getByRole("button", { name: /조각 추가/ }).or(page.getByRole("link", { name: /조각 추가/ })).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "메모" }).fill("F6a2 전환 전 브라우저 기록");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      await expect(dialog).toBeHidden();
      const read = () => page.evaluate(() => localStorage.getItem("pieceofdays.dev-preview.v1"));
      const before = await read();
      assert.ok(before?.includes("F6a2 전환 전 브라우저 기록"));
      await h.front("front");
      assert.equal(`http://127.0.0.1:${h.frontPort}`, origin, "same scheme/host/port after replacement");
      for (const target of ["/", "/login", "/try/"]) {
        const r = await page.goto(`${origin}${target}`);
        assert.equal(r.status(), 200);
        assert.equal(r.headers()["clear-site-data"], undefined);
        assert.ok(await read() === before, "original localStorage bytes retained after each app visit");
      }
      await expect(page.getByRole("listitem").filter({ hasText: "F6a2 전환 전 브라우저 기록" })).toBeVisible();
    } finally { await context.close(); }
  });
});

test("07 fake HTTPS provider configuration: real login/assets/links, no-store and signed-out redirects", OPTIONS, async () => {
  await h.upstream("on");
  const login = await h.frontRequest("/login");
  assert.equal(login.status, 200);
  const text = login.body.toString();
  for (const value of ["/auth/google/start", "/auth/kakao/start", 'href="/try/"', 'href="/status/"']) assert.ok(text.includes(value), value);
  for (const sample of ["창문을 열었더니", "엄마와 20분 통화", "은행나무 길이 반쯤", "ci-google-not-a-secret", "ci-kakao-not-a-secret"]) assert.ok(!text.includes(sample));
  noStore(login);
  noClear(login);
  const assets = [...new Set([...text.matchAll(/(?:src|href)="([^" ]+)"/g)].map((m) => m[1]).filter((src) => src.startsWith("/_next/") || src.startsWith("/auth/")))];
  assert.ok(assets.length > 0, "actual Next/public provider assets");
  for (const src of assets) assert.equal((await h.frontRequest(src.replaceAll("&amp;", "&"))).status, 200, src);
  const pages = [
    ["/", 307, "/login?returnTo=%2F"],
    ["/days", 307, "/login?returnTo=%2Fdays"],
    ["/days/2026-11-02", 307, "/login?returnTo=%2Fdays%2F2026-11-02"],
    ["/settings", 200, undefined],
    ["/account/withdraw", 307, "/settings?notice=withdrawal_unavailable"],
    ["/account/restore", 200, undefined],
  ];
  for (const [target, status, location] of pages) {
    const r = await h.frontRequest(target, { headers: { Host: "forged.invalid", "X-Forwarded-Host": "also-forged.invalid" } });
    assert.equal(r.status, status, `signed-out page ${target}`);
    noStore(r);
    noClear(r);
    assert.equal(r.headers.location, location, `server-chosen return path for ${target}`);
    if (r.headers.location) assert.equal(new URL(r.headers.location, BASE).origin, BASE);
  }
  const input = photoInput();
  const get = await h.frontRequest(input.target, { headers: input.headers });
  assert.equal(get.status, 401, "actual photo GET requires the signed-in owner before any storage lookup");
  privatePhoto(get);
  assert.equal(get.headers.location, undefined);
  assert.equal(get.headers["set-cookie"], undefined);
  assert.ok(!get.body.toString().includes(input.id), "fixed private error does not echo the photo id");
  await noPhotoSentinels(input.sentinels);
  for (const origin of [undefined, "https://wrong.invalid", BASE]) {
    const input = photoInput("upload");
    const headers = { ...input.headers, "Content-Type": "application/octet-stream" };
    if (origin === undefined) delete headers.Origin;
    else headers.Origin = origin;
    const r = await h.frontRequest(input.target, { method: "POST", headers, body: Buffer.from("ci-only-not-multipart") });
    assert.equal(r.status, origin === BASE ? 401 : 403, "real auth/Origin guards precede multipart parsing and unset storage");
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: origin === BASE ? "not_signed_in" : "forbidden" });
    privatePhoto(r);
    assert.equal(r.headers.location, undefined);
    assert.equal(r.headers["set-cookie"], undefined);
    await noPhotoSentinels(input.sentinels);
  }
  const outerInput = gatewayPhotoInput();
  const outerGet = await h.edgeRequest(outerInput.target, { headers: outerInput.headers });
  assert.equal(outerGet.status, 401, "outer Basic permits the request but actual Next still requires a signed-in photo owner");
  privatePhoto(outerGet);
  photoEdgeHeaders(outerGet);
  security(outerGet, "strict-origin-when-cross-origin");
  assert.equal(outerGet.headers.location, undefined);
  assert.equal(outerGet.headers["set-cookie"], undefined);
  assert.ok(!outerGet.body.toString().includes(outerInput.id), "whole-chain private error does not echo the photo id");
  await h.noSentinels(outerInput.sentinels);
  for (const origin of [undefined, "null", "https://wrong.invalid", BASE]) {
    const input = gatewayPhotoInput("upload");
    const headers = { ...input.headers, "Content-Type": "application/octet-stream", Host: "forged.invalid", "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http" };
    if (origin === undefined) delete headers.Origin;
    else headers.Origin = origin;
    const r = await h.edgeRequest(input.target, { method: "POST", headers, body: Buffer.from("ci-only-not-multipart") });
    assert.equal(r.status, origin === BASE ? 401 : 403, "both proxies preserve the actual Next Origin/viewer-before-body guard");
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: origin === BASE ? "not_signed_in" : "forbidden" });
    privatePhoto(r);
    photoEdgeHeaders(r);
    security(r, "strict-origin-when-cross-origin");
    assert.equal(r.headers.location, undefined);
    assert.equal(r.headers["set-cookie"], undefined);
    await h.noSentinels(input.sentinels);
  }
});

test("08 actual logout POST preserves Origin decisions and never uses forged Host for Location", OPTIONS, async () => {
  for (const via of ["front", "outer"]) {
    for (const origin of [undefined, "null", "https://wrong.invalid", "http://dev.pieceofdays.com", `${BASE}:443`, BASE]) {
      const headers = { Host: "forged.invalid", "X-Forwarded-Host": "forwarded.invalid", "X-Forwarded-Proto": "http", ...(origin === undefined ? {} : { Origin: origin }) };
      const r = via === "front" ? await h.frontRequest("/auth/logout", { method: "POST", headers }) : await h.edgeRequest("/auth/logout", { method: "POST", headers });
      assert.equal(r.status, origin === BASE ? 303 : 403, `${via} Origin decision`);
      noStore(r);
      noClear(r);
      assert.equal(r.headers.location, origin === BASE ? `${BASE}/login?notice=signed_out` : undefined);
      if (origin === BASE) {
        assert.equal(r.headers["set-cookie"].length, 2);
        for (const cookie of r.headers["set-cookie"]) assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
      }
    }
  }
});

test("09 direct front callbacks reach actual Next: expired redirect, flow-cookie deletion, one policy and zero log sentinels", OPTIONS, async () => {
  for (const provider of PROVIDERS) {
    const input = callbackInput(provider);
    expired(await h.frontRequest(input.target, { headers: input.headers }));
    await h.noSentinels(input.sentinels);
  }
});

test("10 app-down callbacks leave no query/referrer in front access/error logs, with positive log controls", OPTIONS, async () => {
  const accessControl = "pod_front_access_positive_control";
  await h.frontRequest(`/try/?probe=${accessControl}`);
  assert.ok((await h.currentLog("front")).stdout.includes(accessControl), "front ordinary access stdout is actually collected");
  await h.unavailable("upstream", async () => {
    const errorControl = "pod_front_error_positive_control";
    assert.equal((await h.frontRequest(`/login?probe=${errorControl}`)).status, 502);
    const frontLogs = await h.currentLog("front");
    assert.ok(frontLogs.stderr.includes(errorControl), "ordinary upstream errors are actually collected");
    for (const provider of PROVIDERS) {
      const input = callbackInput(provider);
      assert.equal((await h.frontRequest(input.target, { headers: input.headers })).status, 502);
      await h.noSentinels(input.sentinels);
    }
    for (const kind of ["get", "upload"]) {
      const input = photoInput(kind);
      const r = await h.frontRequest(input.target, { method: kind === "upload" ? "POST" : "GET", headers: input.headers });
      assert.equal(r.status, 502, "both exact upload and photo prefix reach the unavailable upstream");
      await noPhotoSentinels(input.sentinels);
    }
  });
  await h.waitPort(h.frontPort, 200, "/login");
});

test("11 outer server Basic/IP restrictions and default security headers are inherited without callback exceptions", OPTIONS, async () => {
  for (const target of ["/try/", "/login", ...PROVIDERS.map((p) => `/auth/${p}/callback`)]) {
    for (const authorization of [undefined, "Basic d3Jvbmc6d3Jvbmc="]) {
      const r = await request(h.outerPort, target, { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(r.status, 401, "existing authentication is not bypassed by exact callbacks");
      security(r, target.includes("/callback") ? "no-referrer" : "strict-origin-when-cross-origin");
    }
  }
  const ordinary = await h.edgeRequest("/try/");
  assert.equal(ordinary.status, 200);
  security(ordinary, "strict-origin-when-cross-origin");
  assert.equal((await h.edgeRequest("/login")).status, 200);
  // Host-published requests originate inside the CI bridge allowlist. Container loopback is excluded.
  for (const target of ["/try/", ...PROVIDERS.map((p) => `/auth/${p}/callback`)]) {
    const r = await command("docker", ["exec", h.names.outer, "wget", "-q", "-O", "-", "--header", `Authorization: ${BASIC}`, `http://127.0.0.1${target}`]);
    assert.notEqual(r.code, 0, "correct Basic cannot bypass server IP deny");
    assert.ok(r.stderr.includes("403"), "IP deny is a real 403");
  }
  for (const provider of PROVIDERS) {
    const input = callbackInput(provider);
    const r = await request(h.outerPort, input.target, { headers: input.headers });
    assert.equal(r.status, 401);
    security(r);
    await h.noSentinels(input.sentinels);
    const rows = await h.safeRows();
    safeRow(rows.filter((row) => row.uri === `/auth/${provider}/callback`).at(-1), provider, 401);
  }
  for (const kind of ["get", "upload"]) {
    for (const authorization of [undefined, "Basic d3Jvbmc6d3Jvbmc="]) {
      const input = gatewayPhotoInput(kind);
      const r = await request(h.outerPort, input.target, { method: kind === "upload" ? "POST" : "GET", headers: { ...input.headers, ...(authorization ? { Authorization: authorization } : {}) } });
      assert.equal(r.status, 401, "photo locations inherit server Basic authentication");
      photoEdgeHeaders(r);
      security(r, "strict-origin-when-cross-origin");
      await h.noSentinels(input.sentinels);
    }
    const input = gatewayPhotoInput(kind);
    const denied = await command("docker", ["exec", h.names.outer, "wget", "-q", "-O", "-", "--header", `Authorization: ${BASIC}`, "--header", `Referer: ${input.headers.Referer}`, "--header", `Cookie: ${input.headers.Cookie}`, "--header", `Origin: ${BASE}`, `http://127.0.0.1${input.target}`]);
    assert.notEqual(denied.code, 0, "correct Basic cannot bypass the photo location's inherited server IP restriction");
    assert.ok(denied.stderr.includes("403"), "photo IP deny is an actual 403, not a connection error");
    await h.noSentinels(input.sentinels);
  }
});

test("12 BOTH proxies to actual Next retain one no-referrer/security/no-store and emit safe callback JSON only", OPTIONS, async () => {
  for (const provider of PROVIDERS) {
    const input = callbackInput(provider);
    const r = await h.edgeRequest(input.target, { headers: input.headers });
    expired(r);
    security(r);
    const rows = await h.safeRows();
    safeRow(rows.filter((row) => row.uri === `/auth/${provider}/callback`).at(-1), provider, 303);
    await h.noSentinels(input.sentinels);
  }
  assert.ok(/Next\.js|Ready in/.test((await h.currentLog("upstream")).stdout), "actual Next stdout startup logs were collected too");
});

test("13 BOTH proxies with app-down and front-down preserve safe 502 access records and log no callback sentinels", OPTIONS, async () => {
  const control = "pod_outer_log_positive_control";
  await h.edgeRequest(`/try/?probe=${control}`);
  const outerLog = await h.currentLog("outer");
  assert.ok(outerLog.stdout.includes(control), "outer general-path access logging is actually collected");
  for (const role of ["upstream", "front"]) {
    await h.unavailable(role, async () => {
      if (role === "front") {
        const errorControl = "pod_outer_error_positive_control";
        assert.equal((await h.edgeRequest(`/login?probe=${errorControl}`)).status, 502);
        assert.ok((await h.currentLog("outer")).stderr.includes(errorControl), "outer ordinary upstream-error stderr is actually collected");
      }
      for (const provider of PROVIDERS) {
        const input = callbackInput(provider);
        const r = await h.edgeRequest(input.target, { headers: input.headers });
        assert.equal(r.status, 502);
        security(r);
        const rows = await h.safeRows();
        safeRow(rows.filter((row) => row.uri === `/auth/${provider}/callback`).at(-1), provider, 502);
        await h.noSentinels(input.sentinels);
      }
      for (const kind of ["get", "upload"]) {
        const input = gatewayPhotoInput(kind);
        const r = await h.edgeRequest(input.target, { method: kind === "upload" ? "POST" : "GET", headers: input.headers });
        assert.equal(r.status, 502, "whole-chain photo request gets a real 502 for the selected app/front outage");
        photoEdgeHeaders(r);
        security(r, "strict-origin-when-cross-origin");
        await h.noSentinels(input.sentinels);
      }
    });
    await h.waitPort(h.frontPort, 200, "/login");
  }
});

test("14 ORIGINAL preview suite: exactly ten Chromium passes through real helper nginx, no retry/skip", OPTIONS, async (t) => {
  await h.upstream("off");
  const stats = await h.preview();
  t.diagnostic(`original preview: pass ${stats.expected}, fail ${stats.unexpected}, flaky ${stats.flaky}, skip ${stats.skipped}`);
  for (const record of await h.logs()) t.diagnostic(`${record.sink}: both identified streams collected with positive controls`);
  assert.equal((await docker(["image", "inspect", "--format", "{{.Id}}", h.image])).stdout.trim(), h.image, "the same immutable app ID survived every test");
});
