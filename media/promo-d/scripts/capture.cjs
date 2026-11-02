/* pieceofdays 시안 D 실제 화면 캡처 — 영상 자산을 만든다.
   실제 D 프로토타입(docs/design/concepts/d-warm-pieces)을 브라우저에서 마우스로 조작하며
   상태별 전체 페이지 still과 hover/press/타이핑 부분 crop, 좌표 manifest를 남긴다.
   - embed=1로 리뷰 바를 숨긴다(앱 코드는 바꾸지 않는다).
   - 시계는 2026-11-02 22:30(Asia/Seoul)로 고정해 시각 표시를 재현 가능하게 한다.
   - 외부 네트워크 없음: 저장소의 정적 파일만 로컬 HTTP로 띄운다.
   사용: node scripts/capture.cjs   (media/promo-d에서, 한글 폰트가 시스템에 설치돼 있어야 함) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../../../docs/design/concepts");
const OUT = path.resolve(__dirname, "../assets/capture");
const VW = 390, VH = 560, DPR = 3;
const MEMO = "자기 전 보리차 한 잔, 오늘은 여기까지.";
const SUMMARY = "찬 공기로 시작해 따뜻하게 끝난 하루.";
const TYPE_STEP = 1; // 음절 단위로 crop

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, "127.0.0.1", () => res(srv));
  });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = "http://127.0.0.1:" + srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, locale: "ko-KR",
    timezoneId: "Asia/Seoul", reducedMotion: "no-preference", colorScheme: "light"
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date("2026-11-02T22:30:00+09:00"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/d-warm-pieces/index.html?embed=1#today");
  await page.evaluate(() => document.fonts.ready);

  const M = { viewport: { w: VW, h: VH, dpr: DPR }, memo: MEMO, summary: SUMMARY, states: {}, actions: [] };
  const sy = () => page.evaluate(() => Math.round(window.scrollY));
  async function rect(sel) {
    const r = await page.locator(sel).first().evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.width, h: b.height };
    });
    return r;
  }
  function pad(r, p, pageH) {
    const x = Math.max(0, Math.floor(r.x - p)), y = Math.max(0, Math.floor(r.y - p));
    const x2 = Math.min(VW, Math.ceil(r.x + r.w + p)), y2 = Math.min(pageH, Math.ceil(r.y + r.h + p));
    return { x, y, w: x2 - x, h: y2 - y };
  }
  async function pageH() { return page.evaluate(() => document.documentElement.scrollHeight); }
  async function full(name) {
    await page.mouse.move(VW - 1, VH - 1); // 포인터 hover가 still에 남지 않게 구석으로
    const file = name + ".png";
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    M.states[name] = { file, h: await pageH(), scrollY: await sy() };
    return M.states[name];
  }
  async function crop(name, r) {
    const file = name + ".png";
    await page.screenshot({ path: path.join(OUT, file), fullPage: true, clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
    return { file, x: r.x, y: r.y, w: r.w, h: r.h };
  }
  /* 실제 마우스 클릭: 대상이 보이게 스크롤 → hover crop → 누른 상태 crop → 놓기 */
  async function click(id, sel, padPx) {
    const loc = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded();
    const scrollY = await sy();
    const r = await rect(sel);
    const ph = await pageH();
    const area = pad(r, padPx == null ? 10 : padPx, ph);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await page.mouse.move(cx, cy - scrollY);
    const hover = await crop(id + "_hover", area);
    await page.mouse.down();
    const press = await crop(id + "_press", area);
    await page.mouse.up();
    await page.waitForTimeout(120);
    const a = { id, sel, scrollY, target: r, tip: { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 }, hover, press };
    M.actions.push(a);
    return a;
  }
  async function type(id, sel, text) {
    const r = await rect(sel);
    const area = pad(r, 4, await pageH());
    const frames = [];
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += TYPE_STEP) {
      await page.keyboard.insertText(chars.slice(i, i + TYPE_STEP).join(""));
      const n = Math.min(i + TYPE_STEP, chars.length);
      frames.push(await crop(id + "_" + String(n).padStart(2, "0"), area));
    }
    M.actions.push({ id, sel, typed: text, area, scrollY: await sy(), frames });
  }

  // 준비(화면 밖): 오늘 한 줄을 실제 UI로 비워 하루를 아직 정리하지 않은 상태로 만든다.
  await page.click("#sum-edit");
  await page.fill("#sum-text", "");
  await page.click("#sum-form .btn-main");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // 1) 오늘 보드 → 조각 추가 타일 클릭
  const s0 = await full("s0_board");
  s0.addTile = await rect(".add-tile");
  s0.oneline = await rect(".oneline");
  await click("c1_addtile", ".add-tile");
  await page.waitForSelector("#compose[open]");
  await page.waitForTimeout(150);
  // 2) 작성 팝업 → 메모 입력 → 붙이기
  const s1 = await full("s1_compose");
  s1.dialog = await rect("#compose");
  s1.text = await rect("#compose-text");
  s1.focusScrollY = s1.scrollY;
  await type("t1_memo", "#compose-text", MEMO);
  M.states.s1_compose.afterTypeScrollY = await sy();
  await click("c2_submit", "#compose-form .btn-main");
  await page.waitForTimeout(150);
  // 3) 새 조각이 붙은 보드
  const s2 = await full("s2_added");
  s2.newPiece = await rect(".piece.is-new");
  s2.oneline = await rect(".oneline");
  // 4) 한 줄 쓰기 → 입력 → 반영
  await click("c3_sumedit", "#sum-edit");
  await page.waitForTimeout(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  const s3 = await full("s3_editing");
  s3.text = await rect("#sum-text");
  s3.oneline = await rect(".oneline");
  await page.locator("#sum-text").focus();
  await type("t2_summary", "#sum-text", SUMMARY);
  await click("c4_apply", "#sum-form .btn-main");
  await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const s4 = await full("s4_summary");
  s4.oneline = await rect(".oneline");
  // 5) 모아보기 탭 → 달력 → 11월 1일 다시 보기
  await page.evaluate(() => window.scrollTo(0, 0));
  await click("c5_days", '[data-tab="days"]');
  await page.waitForTimeout(150);
  const s5 = await full("s5_days");
  s5.nov = await rect(".cal");
  await click("c6_nov1", 'a.cell[href="#days/2026-11-01"]');
  await page.waitForTimeout(200);
  const s6 = await full("s6_picked");
  s6.picked = await rect(".picked");
  s6.appScrollY = s6.scrollY; // 앱이 scrollIntoView로 옮긴 실제 위치

  M.errors = errors;
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(M, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "manifest.js"), "/* capture.cjs가 생성 — 직접 고치지 않는다 */\nwindow.POD_CAPTURE = " + JSON.stringify(M) + ";\n");
  await browser.close();
  srv.close();
  console.log("states", Object.keys(M.states).length, "actions", M.actions.length, "errors", errors.length);
})().catch((e) => { console.error(e); process.exit(1); });
