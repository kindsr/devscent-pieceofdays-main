// CI-only story visual evidence (PLAN_ai-daily-story-view §2·§3): the real DailyStory/AccountDayBoard/CSS rendered
// from a temporary Next copy with synthetic StoryDay DTOs only. No DB, auth, provider, API, cookie or write.
// The temporary RootLayout/page below replace the product's account/font reads; they never enter the product tree.
// Missing product pieces fail as explicit assertions before Next starts (not as import or build errors).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const WIDTHS = [375, 768, 1440];
const SCENES = ["current", "outdated", "deleted", "unavailable", "read-failed"];
const NAMES = SCENES.flatMap((scene) => WIDTHS.map((width) => `story-${scene}-${width}.png`));
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OUTPUT_NAME = "pod-story-visual-png";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(process.env.CI, "true", "CI required");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Actions runner required");
assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1", "isolated runner required");
assert.ok(process.env.RUNNER_TEMP, "runner temporary directory required");
const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
const output = path.join(runnerTemp, OUTPUT_NAME);
assert.equal(path.dirname(output), runnerTemp, "output stays directly under RUNNER_TEMP");

// ---------------------------------------------------------------- synthetic story DTOs (S1 StoryDay shape)

const DATE = "2026-11-02";
const REVISION = "a".repeat(64);
const CREATED_AT = "2026-11-02T11:03:00.000Z";
const NORMAL_BODY = "아침 출근길 버스에서 귤 하나를 먹으며 하루를 시작했다.\n\n점심에는 동료들과 칼국수를 먹었다. 오후 네 시쯤 비가 그친 뒤 하늘이 맑아졌다.\n\n저녁에는 산책하며 노래 한 곡을 들었다.";
function maxBody() {
  const unit = `${NORMAL_BODY}\n\n`;
  let out = "";
  while (Array.from(out + unit).length <= 2000) out += unit;
  return out + Array.from(unit).slice(0, 2000 - Array.from(out).length).join("").replace(/\s$/u, "다");
}
const MAX_BODY = maxBody();
assert.equal(Array.from(MAX_BODY).length, 2000, "synthetic outdated body is exactly 2000 codepoints");
const ref = (body) => ({ id: "0190f0a0-0000-7000-8000-00000000a201", version: 1, body, createdAt: CREATED_AT });
const STORY_PROPS = {
  current: { data: { date: DATE, inputRevision: REVISION, story: ref(NORMAL_BODY), state: "current", generation: "unavailable" }, hasMoments: true },
  outdated: { data: { date: DATE, inputRevision: "b".repeat(64), story: ref(MAX_BODY), state: "outdated", generation: "unavailable" }, hasMoments: true },
  deleted: { data: { date: DATE, inputRevision: null, story: ref(NORMAL_BODY), state: "outdated", generation: "unavailable" }, hasMoments: false },
  unavailable: { data: { date: DATE, inputRevision: REVISION, story: null, state: "none", generation: "unavailable" }, hasMoments: true },
  "read-failed": { data: null, hasMoments: true },
};
const EXPECT = {
  current: { body: NORMAL_BODY, text: null, absent: /조각이 바뀌었어요/ },
  outdated: { body: MAX_BODY, text: /이 이야기를 만든 뒤 조각이 바뀌었어요/, absent: null },
  deleted: { body: NORMAL_BODY, text: /남아 있어요/, absent: null },
  unavailable: { body: null, text: /AI 하루 이야기는 아직 준비 중이에요/, absent: null },
  "read-failed": { body: null, text: /불러오지 못했/, absent: null },
};
const MOMENTS = [
  { id: "visual-story-piece-01", time: "08:40", text: "출근길 버스에서 귤 하나.", image: null, version: 1 },
  { id: "visual-story-piece-02", time: "12:30", text: "점심은 동료들과 칼국수.", image: null, version: 1 },
  { id: "visual-story-piece-03", time: "16:10", text: "비 그친 뒤 하늘이 맑았다.", image: null, version: 1 },
  { id: "visual-story-piece-04", time: "19:20", text: "산책하며 노래 한 곡 들었다.", image: null, version: 1 },
];

// ---------------------------------------------------------------- product presence (explicit RED before any build)

function importSpecifiers(source) {
  const specs = [];
  for (const m of source.matchAll(/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

function assertProductPieces() {
  const story = path.join(APP, "src/ui/d/DailyStory.tsx");
  assert.ok(existsSync(story), "src/ui/d/DailyStory.tsx must exist (PLAN_ai-daily-story-view §2)");
  const source = readFileSync(story, "utf8");
  assert.match(source, /\bexport\s+(?:async\s+)?(?:function|const)\s+DailyStory\b/, "DailyStory.tsx must export DailyStory");
  assert.deepEqual(importSpecifiers(source).filter((s) => /(?:^|\/)server(?:\/|$)|server-only/.test(s)), [], "DailyStory must not import server modules or user context");
  for (const relative of ["src/ui/d/AccountDayBoard.tsx", "src/app/globals.css"]) assert.ok(existsSync(path.join(APP, relative)), `${relative} must exist`);
}

// ---------------------------------------------------------------- temporary copy (byte-identical product sources)

function copySources(destination) {
  const hashes = new Map();
  const copy = (relative) => {
    const source = path.join(APP, relative);
    const stat = lstatSync(source);
    assert.ok(!stat.isSymbolicLink(), "source symlinks refused");
    if (stat.isDirectory()) {
      for (const name of readdirSync(source)) copy(path.posix.join(relative, name));
      return;
    }
    assert.ok(stat.isFile() && /\.(?:ts|tsx|css|json|mjs|d\.mts)$/.test(relative), "source copy allowlist");
    assert.ok(!relative.split("/").some((name) => name.startsWith(".")), "hidden source refused");
    const bytes = readFileSync(source);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    hashes.set(relative, digest(bytes));
  };
  for (const relative of ["src/ui", "src/shared", "src/server", "src/app/actions", "src/app/globals.css", "package.json", "package-lock.json", "tsconfig.json", "next.config.ts"]) copy(relative);
  return hashes;
}

function verifySources(destination, hashes) {
  for (const [relative, hash] of hashes) {
    assert.equal(digest(readFileSync(path.join(APP, relative))), hash, "original source changed");
    assert.equal(digest(readFileSync(path.join(destination, relative))), hash, "copied product source changed");
  }
}

// Temporary RootLayout: real TopBar/CSS, no account, font or reflection reads (differs from the product layout).
const LAYOUT = `import { TopBar } from "@/ui/d/TopBar";
import "./globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body>
    <TopBar viewer="account" canWrite /><main id="view" tabIndex={-1}>{children}</main>
  </body></html>;
}
`;
const PAGE = `import { AccountDayBoard } from "@/ui/d/AccountDayBoard";
import { DailyStory } from "@/ui/d/DailyStory";
import type { DiaryDay } from "@/shared/diary";
export const dynamic = "force-dynamic";
const STORY_PROPS = ${JSON.stringify(STORY_PROPS)} as const;
const MOMENTS = ${JSON.stringify(MOMENTS)};
export default async function Page({ searchParams }: { searchParams: Promise<{ scene?: string }> }) {
  const scene = (await searchParams).scene as keyof typeof STORY_PROPS;
  const props = STORY_PROPS[scene];
  if (!props) return <p>unknown synthetic scene</p>;
  const day: DiaryDay = { date: ${JSON.stringify(DATE)}, summary: props.hasMoments ? "비 온 뒤라 괜히 오래 걸었다." : "", summaryVersion: props.hasMoments ? 1 : null, moments: props.hasMoments ? MOMENTS : [] };
  // PLAN §2 fixed props; the story slot is rendered by the real AccountDayBoard after its date header.
  const story = <DailyStory date={day.date} data={props.data as never} reflectionTime="20:00" hasMoments={props.hasMoments} headingLevel={2} />;
  return <AccountDayBoard day={day} isToday sub="오늘" showSettingsLink photosEnabled={false} story={story} />;
}
`;

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function probe(origin) {
  return new Promise((resolve) => {
    const req = http.get(`${origin}/?scene=current`, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode === 200)); });
    req.setTimeout(3000, () => req.destroy());
    req.once("error", () => resolve(false));
  });
}

async function stop(child, closed) {
  if (!child?.pid) return;
  const signal = (name) => {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  const ended = await Promise.race([closed.then(() => true), pause(8000).then(() => false)]);
  if (!ended) {
    signal("SIGKILL");
    assert.ok(await Promise.race([closed.then(() => true), pause(5000).then(() => false)]), "owned Next process cleanup failed");
  }
}

async function layoutOk(page) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const small = [...document.querySelectorAll("a, button")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" && (rect.width < 44 || rect.height < 44);
    });
    return { overflow: root.scrollWidth > root.clientWidth, headings: document.querySelectorAll("main h1").length, small: small.length };
  });
  assert.deepEqual(result, { overflow: false, headings: 1, small: 0 }, "layout/44px contract");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** The real story region: correct state text, exact body (or none), no buttons, after the date header and before the pieces. */
async function storyOk(page, expect, scene) {
  const region = page.getByRole("region", { name: "AI 하루 이야기", exact: true });
  await expect(region).toBeVisible();
  await expect(region.getByRole("heading", { level: 2, name: "AI 하루 이야기", exact: true })).toBeVisible();
  assert.equal(await region.getByRole("button").count(), 0, "no story buttons before the S3 contract");
  const want = EXPECT[scene];
  if (want.text) await expect(region).toContainText(want.text);
  if (want.absent) await expect(region).not.toContainText(want.absent);
  const bodyShown = await region.evaluate((element, body) => [...element.querySelectorAll("*")].some((node) => node.textContent === body), want.body ?? NORMAL_BODY);
  assert.equal(bodyShown, want.body !== null, "exact story body shown only when a story exists");
  if (want.body !== null) {
    const whiteSpace = await region.evaluate((element, body) => {
      const node = [...element.querySelectorAll("*")].find((n) => n.textContent === body);
      return node ? getComputedStyle(node).whiteSpace : null;
    }, want.body);
    assert.ok(["pre-wrap", "pre-line", "break-spaces"].includes(whiteSpace), "story line breaks are preserved");
  }
  const order = await region.evaluate((element) => {
    const head = document.querySelector("main header.board-head");
    const after = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const firstPiece = document.querySelector("main li");
    return { afterHeader: after(head, element), beforePieces: firstPiece ? after(element, firstPiece) : true };
  });
  assert.deepEqual(order, { afterHeader: true, beforePieces: true }, "story slot sits after the date header and before the pieces");
}

function validatePngs() {
  assert.deepEqual(readdirSync(output).sort(), [...NAMES].sort(), "exact PNG15 allowlist");
  for (const name of NAMES) {
    const stat = lstatSync(path.join(output, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "regular PNG files only");
    const bytes = readFileSync(path.join(output, name));
    assert.ok(bytes.subarray(0, 8).equals(SIGNATURE), "PNG signature");
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR", "PNG dimensions header");
    const width = Number(/-(\d+)\.png$/.exec(name)[1]);
    assert.equal(bytes.readUInt32BE(16), width, "expected PNG width");
    assert.ok(bytes.readUInt32BE(20) >= 1000, "full-page PNG height");
  }
}

async function capture() {
  let phase = "product presence";
  let child, closed, browser, temporary, hashes;
  let complete = false;
  let outputCreated = false;
  const violations = { actionPosts: 0, externalRequests: 0, pageErrors: 0 };
  try {
    assertProductPieces();
    phase = "prepare";
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: APP, encoding: "utf8" }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    mkdirSync(output, { mode: 0o700 });
    outputCreated = true;
    temporary = mkdtempSync(path.join(runnerTemp, "pod-story-visual-app-"));
    hashes = copySources(temporary);
    // Reuse this exact lock's installed dependencies; no second install, env or build output copy.
    const modules = path.join(APP, "node_modules");
    assert.ok(lstatSync(modules).isDirectory() && !lstatSync(modules).isSymbolicLink());
    try { execFileSync("cp", ["-al", modules, path.join(temporary, "node_modules")], { stdio: "pipe" }); }
    catch {
      rmSync(path.join(temporary, "node_modules"), { recursive: true, force: true });
      cpSync(modules, path.join(temporary, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    writeFileSync(path.join(temporary, "src/app/layout.tsx"), LAYOUT);
    writeFileSync(path.join(temporary, "src/app/page.tsx"), PAGE);
    verifySources(temporary, hashes);
    const env = { NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", CI: "true" };
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    phase = "Next readiness";
    child = spawn(process.execPath, [path.join(temporary, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: temporary, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // Drain without recording HTML, request values or server logs in files/artifacts.
    child.stdout.resume();
    child.stderr.resume();
    let spawnError = false;
    closed = new Promise((resolve) => { child.once("close", resolve); child.once("error", () => { spawnError = true; resolve(); }); });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      assert.ok(!spawnError && child.exitCode === null, "temporary Next stopped before ready");
      if (await probe(origin)) { ready = true; break; }
      await pause(250);
    }
    assert.ok(ready, "temporary Next readiness timeout");
    const { chromium, expect } = await import("@playwright/test");
    browser = await chromium.launch();
    let count = 0;
    for (const width of WIDTHS) {
      for (const scene of SCENES) {
        phase = `${scene}/${width}`;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: "block", reducedMotion: "reduce" });
        try {
          await context.route("**/*", async (route) => {
            const request = route.request();
            if (new URL(request.url()).origin !== origin) { violations.externalRequests++; return route.abort(); }
            if (!["GET", "HEAD"].includes(request.method()) || await request.headerValue("next-action") !== null) { violations.actionPosts++; return route.abort(); }
            return route.continue();
          });
          await context.routeWebSocket("**/*", (route) => {
            if (new URL(route.url()).origin !== origin.replace("http:", "ws:")) { violations.externalRequests++; return route.close(); }
            route.connectToServer();
          });
          const page = await context.newPage();
          page.on("pageerror", () => violations.pageErrors++);
          await page.goto(`${origin}/?scene=${scene}`, { waitUntil: "networkidle" });
          await storyOk(page, expect, scene);
          if (STORY_PROPS[scene].hasMoments) await expect(page.getByText(MOMENTS[0].text, { exact: true })).toBeVisible();
          else await expect(page.getByText("메모 한 줄로 첫 조각을 붙여 보세요.", { exact: true })).toBeVisible();
          assert.deepEqual(await context.cookies(), [], "no cookies in the synthetic context");
          await layoutOk(page);
          assert.deepEqual(violations, { actionPosts: 0, externalRequests: 0, pageErrors: 0 }, "no actions, external requests or rendering errors");
          await page.screenshot({ path: path.join(output, `story-${scene}-${width}.png`), fullPage: true, animations: "disabled", caret: "hide" });
          count++;
        } finally { await context.close(); }
      }
    }
    phase = "final validation";
    assert.equal(count, 15);
    validatePngs();
    verifySources(temporary, hashes);
    assert.deepEqual(violations, { actionPosts: 0, externalRequests: 0, pageErrors: 0 });
    console.log(`story visual: PNG15; states current/outdated(2000cp)/deleted/unavailable/read-failed; widths375/768/1440; real DailyStory/AccountDayBoard/CSS; temporary layout without account reads; actionPOST0; external0; cookie0; DB/auth/API0; source/CSS byte-identical; checkout ${sha}`);
    complete = true;
  } catch (error) {
    // Assertion messages are fixed strings over synthetic data; other errors stay unprinted (no HTML/logs/values).
    const detail = error?.code === "ERR_ASSERTION" ? `: ${String(error.message).split("\n")[0]}` : "";
    console.error(`story visual capture failed at ${phase}${detail}; no logs/HTML/trace artifacts were produced`);
    process.exitCode = 1;
  } finally {
    const failures = [];
    try { if (browser) await browser.close(); } catch { failures.push("browser"); }
    try { await stop(child, closed); } catch { failures.push("Next"); }
    try { if (temporary && hashes) verifySources(temporary, hashes); } catch { failures.push("source bytes"); }
    try { if (temporary) rmSync(temporary, { recursive: true }); } catch { failures.push("temporary copy"); }
    if (outputCreated && (!complete || failures.length)) rmSync(output, { recursive: true, force: true });
    if (failures.length) {
      console.error(`story visual cleanup failed: ${failures.join(", ")}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[2] === "--cleanup-output") {
  assert.equal(process.argv.length, 3, "--cleanup-output takes no other argument");
  if (readdirSync(runnerTemp).includes(OUTPUT_NAME)) {
    const stat = lstatSync(output);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "owned real output directory only");
    rmSync(output, { recursive: true });
  }
} else {
  assert.equal(process.argv.length, 2, "no capture arguments");
  await capture();
}
