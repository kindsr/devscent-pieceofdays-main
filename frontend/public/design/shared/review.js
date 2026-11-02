/* 시안 리뷰 도구: 상단 리뷰 바, 화면 라우팅(#today 등), 상태 알림, 날짜·대비 계산.
   저장 기능 없음 — 서버·localStorage 등 어디에도 기록하지 않는다. */
(function () {
  "use strict";
  var VIEWS = [
    ["today", "오늘"], ["write", "작성"], ["days", "다시 보기"], ["empty", "첫날 빈 상태"], ["tokens", "토큰"]
  ];
  var CONCEPTS = [["a-warm", "A 따뜻한 기록장"], ["b-calm", "B 차분한 일기장"], ["c-pieces", "C 조각 모음"], ["d-warm-pieces", "D 따뜻한 조각 모음"]];
  var WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  var embed = /[?&]embed=1\b/.test(location.search);
  if (embed) document.documentElement.classList.add("is-embed");

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parts(iso) {
    var p = iso.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return { y: p[0], m: p[1], d: p[2], w: WEEK[d.getDay()], wd: d.getDay() };
  }
  function nowTime() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function route() {
    var h = location.hash.replace(/^#/, "").split("/");
    var view = VIEWS.some(function (v) { return v[0] === h[0]; }) ? h[0] : "today";
    var date = /^\d{4}-\d{2}-\d{2}$/.test(h[1] || "") ? h[1] : null;
    return { view: view, date: date };
  }
  function onRoute(cb) {
    function run() { cb(route()); markBar(); }
    window.addEventListener("hashchange", run);
    run();
  }
  var liveTimer;
  function announce(msg) {
    var el = document.getElementById("live");
    if (!el) return;
    el.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { el.textContent = msg; }, 30);
  }
  function lum(hex) {
    var c = hex.replace("#", "");
    return [0, 2, 4].map(function (i) {
      var v = parseInt(c.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  /* 토큰 카드 공통 표: rows = [이름, 변수, hex, 대비 기준 hex 또는 null, 용도] */
  function tokenRows(rows) {
    return rows.map(function (r) {
      var ratio = r[3] ? contrast(r[2], r[3]) : null;
      var verdict = ratio === null ? "면 색" : ratio >= 4.5 ? "AA 본문 통과" : ratio >= 3 ? "AA 큰 글자·경계만" : "글자 사용 금지";
      return '<li class="tk-row"><span class="tk-swatch" style="background:' + r[2] + '"></span>' +
        '<span class="tk-name"><b>' + esc(r[0]) + "</b><code>" + esc(r[1]) + " " + r[2] + "</code></span>" +
        '<span class="tk-ratio">' + (ratio === null ? "" : ratio.toFixed(2) + ":1 · ") + verdict +
        "<br><small>" + esc(r[4]) + "</small></span></li>";
    }).join("");
  }

  function markBar() {
    var r = route();
    document.querySelectorAll("[data-view-link]").forEach(function (a) {
      if (a.getAttribute("data-view-link") === r.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  function buildBar() {
    var host = document.getElementById("review-bar");
    if (!host) return;
    var me = host.getAttribute("data-concept");
    host.innerHTML =
      '<div class="rb-row">' +
        '<a class="rb-link" href="../index.html" target="_top">← 시안 비교판</a>' +
        '<p class="rb-note"><strong>시안 미리보기</strong> · 예시 기록이며 저장되지 않습니다</p>' +
      "</div>" +
      '<nav class="rb-row rb-scroll" aria-label="시안 전환">' +
        CONCEPTS.map(function (c) {
          return '<a class="rb-link" target="_top" href="../' + c[0] + '/index.html"' +
            (c[0] === me ? ' aria-current="true"' : "") + ">" + c[1] + "</a>";
        }).join("") +
      "</nav>" +
      '<nav class="rb-row rb-scroll" aria-label="볼 화면">' +
        VIEWS.map(function (v) {
          return '<a class="rb-link" data-view-link="' + v[0] + '" href="#' + v[0] + '">' + v[1] + "</a>";
        }).join("") +
      "</nav>";
  }
  document.addEventListener("DOMContentLoaded", buildBar);

  window.POD = {
    esc: esc, parts: parts, nowTime: nowTime, onRoute: onRoute, announce: announce,
    contrast: contrast, tokenRows: tokenRows, WEEK: WEEK, embed: embed,
    /* 비교판 미리보기에서 사용자가 이 iframe을 조작 중이 아니면 부모 화면의 포커스를 가져가지 않는다 */
    quiet: function () { return embed && !document.hasFocus(); },
    clone: function (o) { return JSON.parse(JSON.stringify(o)); },
    /* 순간을 시간순으로 넣는다 */
    addMoment: function (day, m) {
      day.moments.push(m);
      day.moments.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    },
    NOT_SAVED: "이 화면에만 추가했어요. 저장되지 않아 새로고침하면 사라집니다."
  };
})();
