// F6a2: actual standalone image + exact trusted helper nginx + the unabridged public outer fragment.
// Run only in Secrets-free Actions: node --test --test-reporter=tap tests/front-contract.test.mjs
// Required env: CI=true GITHUB_ACTIONS=true POD_FULL_CHECK_ISOLATED=1 POD_TEST_DB_DISPOSABLE=1
// POD_TEST_ADMIN_URL (loopback disposable PG18), POD_IMAGE_TEST_IMAGE (immutable sha256 ID),
// POD_IMAGE_TEST_NETWORK (Actions service network ID), POD_IMAGE_TEST_DB_HOST (PG18 alias).
// Fourteen real contracts, no skip. #14 also runs the ORIGINAL ten preview cases, no retry/skip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { expect } from "@playwright/test";
import { APP_DIR, BASE, BASIC, PROVIDERS, FrontHarness, callbackInput, command, docker, hash, request, values } from "./support/front-harness.mjs";

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
});

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
  for (const target of ["/healthz", "/healthz/ready", "/healthz/anything", "/dev/konva-smoke", "/index.html", "/favicon.ico", "/sample/", "/settings/extra", "/private"]) {
    assert.equal((await h.frontRequest(target)).status, 404, `front ${target}`);
    assert.equal((await h.edgeRequest(target)).status, 404, `outer ${target}`);
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
