/* index.html(HyperFrames composition) 생성기.
   입력: timeline.cjs(시간), assets/capture/manifest.json(실제 D 화면 좌표·파일).
   출력: index.html — 1080x1920, 30fps, root data-duration=20, paused GSAP timeline을 window.__timelines.root에 등록.
   사용: node scripts/build.cjs   (BGM 파일이 assets/audio/bgm.*에 있으면 자동으로 넣는다) */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const T = require(path.join(ROOT, "timeline.cjs"));
const M = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/capture/manifest.json"), "utf8"));

if (T.copyLines.join(" ") !== T.copy) throw new Error("copyLines가 확정 카피와 다르다(줄바꿈 외 변경 금지)");

const W = 1080, H = 1920;
const K = 920 / M.viewport.w;           // 페이지 CSS px → 영상 px
const SCREEN = { x: 80, y: 484, w: 920, h: Math.round(M.viewport.h * K) };
const BORDER = 5;
const r2 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const action = (id) => { const a = M.actions.find((x) => x.id === id); if (!a) throw new Error("no action " + id); return a; };

// 상태 구간
const states = T.states.map((s, i) => ({ ...s, end: i + 1 < T.states.length ? T.states[i + 1].start : T.duration }));
const stateAt = (t) => states.filter((s) => s.start <= t).pop();

// 스크롤 값(시각 t에 확정된 값; 클릭은 스크롤이 멈춘 뒤에만 일어나게 timeline.cjs에서 배치)
function scrollAt(t) {
  let v = 0;
  for (const s of T.scroll) if (s.t1 <= t + 1e-6) v = s.to; else if (s.t0 < t) throw new Error("클릭이 스크롤 중이다 @" + t);
  return v;
}
const tipRoot = (px, py, scroll) => [r2(SCREEN.x + px * K), r2(SCREEN.y + (py - scroll) * K)];

let clips = [];   // 스크롤러 안 타임드 이미지
let uid = 0;
function img(file, x, y, w, h, start, end, cls) {
  const id = cls + "-" + (++uid);
  clips.push(`<img id="${id}" class="clip ${cls}" data-start="${r2(start)}" data-duration="${r2(end - start)}" src="assets/capture/${file}" alt="" ` +
    `style="left:${r2(x * K)}px;top:${r2(y * K)}px;width:${r2(w * K)}px;height:${r2(h * K)}px">`);
}
for (const s of states) {
  const st = M.states[s.id];
  img(st.file, 0, 0, M.viewport.w, st.h, s.start, s.end, "st");
}
const clickTimes = [];
const cursorKeys = [];  // {t0,t1,x,y,ease}
for (const c of T.clicks) {
  const a = action(c.id);
  const sc = scrollAt(c.arrive);
  const [x, y] = tipRoot(a.tip.x, a.tip.y, sc);
  const release = c.press + T.pressDur;
  img(a.hover.file, a.hover.x, a.hover.y, a.hover.w, a.hover.h, c.arrive, c.press, "ov");
  img(a.press.file, a.press.x, a.press.y, a.press.w, a.press.h, c.press, release, "ov");
  cursorKeys.push({ t0: c.moveFrom, t1: c.arrive, x, y, ease: c.ease || "power2.inOut" });
  clickTimes.push({ id: c.id, press: c.press, release, x, y });
}
for (const m of T.cursorMoves) cursorKeys.push({ t0: m.t0, t1: m.t1, x: m.to[0], y: m.to[1], ease: m.ease || "power2.inOut" });
cursorKeys.sort((a, b) => a.t0 - b.t0);
for (const ty of T.typing) {
  const a = action(ty.id);
  const n = a.frames.length;
  for (let j = 0; j < n; j++) {
    const f = a.frames[j];
    const start = ty.start + j * ty.step;
    const end = j + 1 < n ? ty.start + (j + 1) * ty.step : stateAt(start).end;
    img(f.file, f.x, f.y, f.w, f.h, start, end, "ov");
  }
}

// 자막(의미 단위) 클립
const caps = T.captions.map((c, i) =>
  `<div id="cap-${i}" class="clip cap" data-start="${c.start}" data-duration="${r2(c.end - c.start)}"><p class="cap-in" id="cap-in-${i}">${esc(T.copyLines[c.line])}</p></div>`).join("\n      ");

// 끝 카피: 화면 글자 = 확정 카피(블록 줄바꿈만). 마지막 줄의 pieceofdays에 D 브랜드 밑줄.
const O = T.outro;
const lines = T.copyLines.map((l, i) => {
  if (i === T.copyLines.length - 1) {
    const cut = l.lastIndexOf("pieceofdays");
    return `<span class="ln" id="ln-${i}">${esc(l.slice(0, cut))}<span class="brand">pieceofdays<svg class="squiggle" viewBox="0 0 120 10" aria-hidden="true"><path id="squiggle-path" d="M2 6 C 14 1, 22 9, 34 5 S 56 1, 68 6 S 92 9, 118 3" fill="none" stroke="#9E4527" stroke-width="2.5" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg></span></span>`;
  }
  return `<span class="ln" id="ln-${i}">${esc(l)}</span>`;
}).join(" ");

const audio = [];
audio.push(`<audio id="sfx-clicks" class="clip" data-start="0" data-duration="${T.duration}" data-volume="1" src="assets/audio/clicks.m4a"></audio>`);
const bgm = fs.readdirSync(path.join(ROOT, "assets/audio")).find((f) => /^bgm\.(mp3|wav|m4a|aac|ogg)$/.test(f));
if (bgm) audio.push(`<!-- BGM: 메인 서버의 Sunra MCP(model elevenlabs-music, task 4ae0454e-28fd-4209-8d1a-43409a2234c0)로 생성한 20초 연주곡. 화면은 생성형이 아닌 실제 D 화면 캡처다. 출처·해시는 ASSETS.md -->`);
if (bgm) audio.push(`<audio id="bgm" class="clip" data-start="0" data-duration="${T.duration}" data-volume="0.32" data-fade-in="0.6" data-fade-out="1.6" src="assets/audio/${bgm}"></audio>`);

const data = { K, SCREEN, cursorKeys, clickTimes, scroll: T.scroll.map((s) => ({ t0: s.t0, t1: s.t1, y: r2(-s.to * K) })),
  captions: T.captions.map((c, i) => ({ i, start: c.start, end: c.end })), outro: O, nLines: T.copyLines.length,
  pressDur: T.pressDur, releaseDur: T.releaseDur };

const html = `<!doctype html>
<!-- 생성 파일: node scripts/build.cjs 로 다시 만든다(직접 고치면 덮어써진다). 정본은 timeline.cjs·scripts/build.cjs·assets/capture. -->
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>pieceofdays D 세로 홍보영상</title>
    <script src="assets/vendor/gsap-3.13.0.min.js"></script>
    <style>
      @font-face {
        font-family: "PodSans";
        src: url("assets/fonts/NotoSansKR-ExtraBold-promo-subset.woff2") format("woff2");
        font-weight: 800;
        font-style: normal;
        font-display: block;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #F5EFE4; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #F5EFE4;
        font-family: "PodSans", sans-serif; color: #2A211C; word-break: keep-all; }
      /* 실제 D 화면 카드: D의 2px 잉크 테두리·단단한 그림자를 영상 배율로 */
      #card { position: absolute; left: ${SCREEN.x - BORDER}px; top: ${SCREEN.y - BORDER}px; width: ${SCREEN.w + BORDER * 2}px; height: ${SCREEN.h + BORDER * 2}px;
        border: ${BORDER}px solid #2A211C; border-radius: 24px; background: #F5EFE4; box-shadow: 12px 12px 0 #2A211C; }
      #screen { position: absolute; inset: 0; overflow: hidden; border-radius: 19px; }
      #scroller { position: absolute; left: 0; top: 0; width: ${SCREEN.w}px; height: 4000px; }
      #scroller img { position: absolute; display: block; }
      #scroller img.ov { z-index: 2; }
      .cap { position: absolute; left: 108px; top: 250px; width: 864px; height: 160px; }
      .cap-in { position: absolute; left: 0; right: 0; top: 0; text-align: center; font-weight: 800; font-size: 68px; line-height: 160px; letter-spacing: -0.01em; }
      #outro { position: absolute; left: 108px; top: 250px; width: 864px; height: 700px; }
      #copy { position: absolute; left: 0; right: 0; top: 40px; text-align: center; font-weight: 800; font-size: 62px; line-height: 1.42; letter-spacing: -0.01em; }
      #copy .ln { display: block; }
      #copy .brand { position: relative; display: inline-block; }
      #copy .squiggle { position: absolute; left: 2%; bottom: -14px; width: 96%; height: 20px; overflow: visible; }
      #cursor { position: absolute; left: 0; top: 0; width: 100px; height: 100px; z-index: 50; filter: drop-shadow(0 6px 9px rgba(0,0,0,0.28)); }
      #cursor svg { display: block; width: 100%; height: 100%; fill: #FFFFFF; stroke: #141414; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
      #ring { position: absolute; left: 0; top: 0; width: 72px; height: 72px; border-radius: 50%; border: 4px solid #9E4527; z-index: 49; opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="root" data-start="0" data-duration="${T.duration}" data-width="${W}" data-height="${H}">
      ${caps}
      <div id="outro" class="clip" data-start="${r2(O.linesStart - 0.05)}" data-duration="${r2(T.duration - O.linesStart + 0.05)}">
        <p id="copy" data-copy="${esc(T.copy)}">${lines}</p>
      </div>
      <div id="card">
        <div id="screen">
          <div id="scroller" data-layout-allow-overflow>
            ${clips.join("\n            ")}
          </div>
        </div>
      </div>
      <div id="ring" aria-hidden="true"></div>
      <div id="cursor" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 3 L5 19 L9 15 L12 22 L15 20.5 L11.5 14 L18 14 Z" /></svg></div>
      ${audio.join("\n      ")}
    </div>
    <script>
      (function () {
        "use strict";
        var D = ${JSON.stringify(data)};
        var TIP = { x: 20.83, y: 12.5 }; // 포인터 끝(24 단위 중 5,3)
        var tl = gsap.timeline({ paused: true });
        var cursor = document.getElementById("cursor");
        var ring = document.getElementById("ring");
        var scroller = document.getElementById("scroller");
        var card = document.getElementById("card");
        function cx(x) { return x - TIP.x; }
        function cy(y) { return y - TIP.y; }

        // 페이지 스크롤(사용자 스크롤과 앱의 scrollIntoView)
        tl.set(scroller, { y: 0 }, 0);
        D.scroll.forEach(function (s) { tl.to(scroller, { y: s.y, duration: s.t1 - s.t0, ease: "power2.inOut" }, s.t0); });

        // 커서: 아래 화면 밖에서 진입, 실제 클릭 대상에 끝을 맞춘다
        gsap.set(cursor, { transformOrigin: TIP.x + "% " + TIP.y + "%" });
        D.cursorKeys.forEach(function (k) {
          if (k.t1 <= k.t0) tl.set(cursor, { x: cx(k.x), y: cy(k.y), scale: 1 }, k.t0);
          else tl.to(cursor, { x: cx(k.x), y: cy(k.y), duration: k.t1 - k.t0, ease: k.ease }, k.t0);
        });
        // 클릭: 0.1s 압축 → 0.2s 해제, 같은 프레임에 원형 효과와 실제 버튼 press crop
        D.clickTimes.forEach(function (c) {
          tl.to(cursor, { scale: 0.86, duration: D.pressDur, ease: "power2.in" }, c.press);
          tl.to(cursor, { scale: 1, duration: D.releaseDur, ease: "power2.out" }, c.release);
          tl.set(ring, { x: c.x - 36, y: c.y - 36, scale: 0.35, opacity: 0.8 }, c.press);
          tl.to(ring, { scale: 1.1, opacity: 0, duration: 0.45, ease: "power2.out" }, c.press);
        });

        // 의미 단위 자막: 아래에서 위로(전 구간 같은 방향)
        D.captions.forEach(function (c) {
          var el = document.getElementById("cap-in-" + c.i);
          tl.fromTo(el, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.55, ease: "power2.out" }, c.start);
          tl.to(el, { opacity: 0, y: -22, duration: 0.35, ease: "power2.in" }, c.end - 0.35);
        });

        // 끝: 화면 카드가 아래로 물러나며 작아지고 전체 카피가 위에서 줄 단위로 놓인다
        var O = D.outro;
        tl.to(card, { scale: O.cardScale, transformOrigin: "50% 100%", duration: O.cardDur, ease: "power2.inOut" }, O.cardStart);
        for (var i = 0; i < D.nLines; i++) {
          tl.fromTo("#ln-" + i, { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: O.lineDur, ease: "power2.out" }, O.linesStart + i * O.lineStagger);
        }
        tl.to("#squiggle-path", { attr: { "stroke-dashoffset": 0 }, duration: O.squiggleDur, ease: "power1.inOut" }, O.squiggleStart);

        tl.seek(0);
        window.__timelines = window.__timelines || {};
        window.__timelines["root"] = tl;
      })();
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "index.html"), html);
console.log("index.html: clips", clips.length, "clicks", clickTimes.length, "bgm", bgm || "(없음)");
fs.writeFileSync(path.join(ROOT, "assets/audio/click-times.json"), JSON.stringify(clickTimes.map((c) => ({ id: c.id, press: c.press, release: c.release })), null, 2) + "\n");
