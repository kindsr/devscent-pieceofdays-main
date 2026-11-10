// CI-only visual evidence: real account components/CSS, synthetic DTOs, no auth or writes.
// The temporary shell replaces RootLayout's account/font reads; it is never a product route.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const WIDTHS = [375, 768, 1440];
const SCENES = ["read", "empty", "compose", "delete", "settings"];
const NAMES = SCENES.flatMap((scene) => WIDTHS.map((width) => `account-${scene}-${width}.png`));
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(process.env.CI, "true", "CI required");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Actions runner required");
assert.equal(process.env.POD_FULL_CHECK_ISOLATED, "1", "isolated runner required");
assert.ok(process.env.RUNNER_TEMP, "runner temporary directory required");
const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
const output = path.join(runnerTemp, "pod-account-visual-png");

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

const LAYOUT = `"use client";
import { usePathname } from "next/navigation";
import { TopBar } from "@/ui/d/TopBar";
import "./globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  const settings = usePathname() === "/settings";
  return <html lang="ko" data-record-font={settings ? "serif" : undefined}><body>
    <TopBar viewer="account" canWrite /><main id="view" tabIndex={-1}>{children}</main>
  </body></html>;
}
`;
const PAGE = `import { AccountDayBoard } from "@/ui/d/AccountDayBoard";
import type { DiaryDay } from "@/shared/diary";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ scene?: string }> }) {
  const empty = (await searchParams).scene === "empty";
  const day: DiaryDay = { date: "2026-11-02", summary: empty ? "" : "천천히 걸으며 모은 작은 하루.", summaryVersion: empty ? null : 1, moments: empty ? [] : [
    { id: "visual-piece-01", time: "09:40", text: "창가에 앉아 따뜻한 차를 마셨다.\\n아직 식지 않은 잔을 두 손으로 감쌌다.", image: null, version: 1 },
    { id: "visual-piece-02", time: "12:15", text: "점심을 먹고 동네를 한 바퀴 걸었다. 바람에 잎이 흔들리고 멀리서 자전거 종소리가 들렸다. 기억하고 싶은 장면을 한 줄씩 모아 두었다.", image: null, version: 1 },
    { id: "visual-piece-03", time: "18:20", text: "집으로 돌아오는 길의 하늘이 연한 분홍빛이었다.", image: null, version: 1 },
    { id: "visual-piece-04", time: "21:05", text: "오늘 읽던 책을 덮고 내일의 빈칸을 남겼다.", image: null, version: 1 }
  ] };
  return <AccountDayBoard day={day} isToday sub="오늘" showSettingsLink />;
}
`;
const SETTINGS = `import { AccountFontSettings } from "@/ui/d/AccountFontSettings";
export default function Settings() {
  return <><header className="board-head"><h1 tabIndex={-1}>설정</h1><p className="sub">나에게 맞게</p></header>
    <AccountFontSettings initialFont="serif" /></>;
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
    const req = http.get(`${origin}/?scene=read`, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode === 200)); });
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
    const small = [...document.querySelectorAll("a, button, label.font-opt")].filter((element) => {
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
  let phase = "prepare";
  let child, closed, browser, temporary, hashes;
  let complete = false;
  let outputCreated = false;
  const violations = { actionPosts: 0, externalRequests: 0, pageErrors: 0 };
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: APP, encoding: "utf8" }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    mkdirSync(output, { mode: 0o700 });
    outputCreated = true;
    temporary = mkdtempSync(path.join(runnerTemp, "pod-account-visual-app-"));
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
    mkdirSync(path.join(temporary, "src/app/settings"));
    writeFileSync(path.join(temporary, "src/app/settings/page.tsx"), SETTINGS);
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
          await page.goto(scene === "settings" ? `${origin}/settings` : `${origin}/?scene=${scene}`, { waitUntil: "networkidle" });
          if (scene === "compose") {
            await page.locator("main").getByRole("link", { name: "조각 추가", exact: true }).click();
            const memo = page.getByRole("dialog").getByRole("textbox", { name: "메모" });
            await expect(memo).toBeFocused();
            await memo.fill("잠깐 멈춰 오늘의 한 장면을 적어 두었다.");
          } else if (scene === "delete") {
            await page.getByRole("button", { name: /조각 삭제/ }).first().click();
            await expect(page.getByRole("dialog", { name: "조각 지우기" })).toBeVisible();
          } else if (scene === "empty") {
            await expect(page.getByText("메모 한 줄로 첫 조각을 붙여 보세요.", { exact: true })).toBeVisible();
          } else if (scene === "settings") {
            await expect(page.getByRole("radio", { name: /^명조/ })).toBeChecked();
            await expect(page.locator("html")).toHaveAttribute("data-record-font", "serif");
          } else {
            await expect(page.getByText("천천히 걸으며 모은 작은 하루.", { exact: true })).toBeVisible();
          }
          assert.deepEqual(await context.cookies(), [], "no cookies in the synthetic context");
          await layoutOk(page);
          assert.deepEqual(violations, { actionPosts: 0, externalRequests: 0, pageErrors: 0 }, "no actions, external requests or rendering errors");
          await page.screenshot({ path: path.join(output, `account-${scene}-${width}.png`), fullPage: true, animations: "disabled", caret: "hide" });
          count++;
        } finally { await context.close(); }
      }
    }
    phase = "final validation";
    assert.equal(count, 15);
    validatePngs();
    verifySources(temporary, hashes);
    assert.deepEqual(violations, { actionPosts: 0, externalRequests: 0, pageErrors: 0 });
    console.log(`account visual: PNG15; scenes5; widths375/768/1440; actionPOST0; external0; cookie0; source/CSS byte-identical; checkout ${sha}`);
    complete = true;
  } catch {
    console.error(`account visual capture failed at ${phase}; no logs/HTML/trace artifacts were produced`);
    process.exitCode = 1;
  } finally {
    const failures = [];
    try { if (browser) await browser.close(); } catch { failures.push("browser"); }
    try { await stop(child, closed); } catch { failures.push("Next"); }
    try { if (temporary && hashes) verifySources(temporary, hashes); } catch { failures.push("source bytes"); }
    try { if (temporary) rmSync(temporary, { recursive: true }); } catch { failures.push("temporary copy"); }
    if (outputCreated && (!complete || failures.length)) rmSync(output, { recursive: true, force: true });
    if (failures.length) {
      console.error(`account visual cleanup failed: ${failures.join(", ")}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[2] === "--cleanup-output") {
  assert.equal(process.argv.length, 3);
  if (readdirSync(runnerTemp).includes(path.basename(output))) {
    const stat = lstatSync(output);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid());
    rmSync(output, { recursive: true });
  }
} else {
  assert.equal(process.argv.length, 2, "no capture arguments");
  await capture();
}
