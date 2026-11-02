/* 시안 C 화면 동작 — 메모리 안에서만 바뀐다. 저장 없음. */
(function () {
  "use strict";
  var P = window.POD, S = window.POD_SAMPLE, esc = P.esc;
  var sample = P.clone(S.days);
  var first = [{ date: S.today, summary: "", moments: [] }];
  var mode = "sample", editing = false, lastNewKey = null;
  var view = document.getElementById("view");
  var dlg = document.getElementById("compose");
  var form = document.getElementById("compose-form");
  var text = document.getElementById("compose-text");
  var err = document.getElementById("compose-err");
  var NOTE = ["y", "m", "p"];
  var STAR = '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><path d="M28 6 L33 22 L50 22 L36 32 L41 49 L28 39 L15 49 L20 32 L6 22 L23 22 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>';

  function days() { return mode === "first" ? first : sample; }
  function find(date) { return days().filter(function (d) { return d.date === date; })[0]; }
  function homeHash() { return mode === "first" ? "#empty" : "#today"; }
  function label(iso) { var p = P.parts(iso); return p.m + "월 " + p.d + "일 " + p.w + "요일"; }

  function piecesHTML(day, isToday) {
    var noteIdx = 0;
    var items = day.moments.map(function (m) {
      var img = m.img ? S.images[m.img] : null;
      var nw = m.key && m.key === lastNewKey ? " is-new" : "";
      if (img) {
        return '<li class="piece photo' + nw + '"><img src="' + img.src + '" alt="' + esc(img.alt) + '" width="400" height="300">' +
          '<p class="tag">예시 이미지 · 직접 그린 그림</p><time>' + m.time + "</time><p>" + esc(m.text) + "</p></li>";
      }
      return '<li class="piece note ' + NOTE[noteIdx++ % 3] + nw + '"><time>' + m.time + "</time><p>" + esc(m.text) + "</p></li>";
    }).join("");
    if (isToday) items += '<li class="piece"><a class="add-tile" href="#write"><span class="plus" aria-hidden="true">+</span>조각 추가</a></li>';
    return '<ul class="pieces" aria-label="' + label(day.date) + '의 조각">' + items + "</ul>";
  }

  function onelineHTML(day, isToday) {
    if (editing && isToday) {
      return '<section class="oneline"><form id="sum-form"><label class="hand" style="font-size:22px;color:var(--muted)" for="sum-text">오늘을 한 줄로</label>' +
        '<textarea id="sum-text" rows="3" maxlength="300">' + esc(day.summary) + "</textarea>" +
        '<p class="hint">시안이라 이 화면에만 반영되고 저장되지 않아요.</p>' +
        '<div class="row"><button class="btn-main" type="submit">반영</button><button class="btn-ghost" type="button" id="sum-cancel">취소</button></div></form></section>';
    }
    if (!day.summary && !(isToday && day.moments.length)) return "";
    return '<section class="oneline" aria-labelledby="ol-h"><h2 id="ol-h">' + (isToday ? "오늘을 한 줄로" : "그날 한 줄") + "</h2>" +
      (day.summary ? "<p>" + esc(day.summary) + "</p>" : '<p style="color:var(--muted)">조각을 다 모았다면 하루를 한 줄로 묶어 보세요.</p>') +
      (isToday ? '<button class="text-btn" type="button" id="sum-edit">' + (day.summary ? "고쳐 쓰기" : "한 줄 쓰기") + "</button>" : "") + "</section>";
  }

  function boardHTML(day, isToday, sub) {
    var n = day.moments.length;
    var head = '<header class="board-head"><h1 tabindex="-1">' + label(day.date) + '의 조각<span class="count">' + n + '<span class="sr-only">개</span></span></h1>' +
      (sub ? '<p class="sub">' + sub + "</p>" : "") + "</header>";
    if (!n) {
      return head + '<section class="first" aria-labelledby="f-h">' + STAR +
        '<h2 id="f-h">첫 조각을 붙여 보세요</h2><p>사진 한 장이나 메모 한 줄이면 충분해요. 매일 채우지 않아도 괜찮아요.</p>' +
        '<a class="btn-main" href="#write">첫 조각 붙이기</a></section>';
    }
    return head + '<div class="with-side">' + onelineHTML(day, isToday) + piecesHTML(day, isToday) + "</div>";
  }

  function monthHTML(y, m, picked) {
    var start = new Date(y, m - 1, 1).getDay(), count = new Date(y, m, 0).getDate();
    var cells = P.WEEK.map(function (w) { return '<li class="wk" aria-hidden="true">' + w + "</li>"; }).join("");
    for (var i = 0; i < start; i++) cells += '<li aria-hidden="true"></li>';
    for (var d = 1; d <= count; d++) {
      var iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      var day = find(iso);
      if (day && day.moments.length) {
        var cover = day.moments.filter(function (x) { return x.img; })[0];
        cells += '<li><a class="cell" href="#days/' + iso + '"' + (picked === iso ? ' aria-current="date"' : "") +
          ' aria-label="' + label(iso) + ", 조각 " + day.moments.length + '개"><span class="n" aria-hidden="true">' + d + "</span>" +
          (cover ? '<img src="' + S.images[cover.img].src + '" alt="">' : "") + "</a></li>";
      } else {
        cells += '<li><span class="cell ' + (iso > S.today ? "future" : "none") + '"><span class="n">' + d + "</span></span></li>";
      }
    }
    return '<section class="cal" aria-label="' + y + "년 " + m + '월"><h2>' + y + "년 " + m + '월</h2><ul class="cal-grid">' + cells + "</ul></section>";
  }

  function daysHTML(picked) {
    var html = '<header class="board-head"><h1 tabindex="-1">모아보기</h1><p class="sub">조각이 있는 날에 그날의 첫 조각이 보여요</p></header>' +
      '<div class="cal-wrap two">' + monthHTML(2026, 11, picked) + monthHTML(2026, 10, picked) + "</div>";
    var day = picked && find(picked);
    html += '<section class="picked" style="margin-top:32px">' +
      (day ? boardHTML(day, picked === S.today, picked === S.today ? "오늘" : "지난 날").replace("<h1 tabindex=\"-1\">", '<h1 tabindex="-1" id="picked-h">').replace(/<(\/?)h1/g, "<$1h2")
           : '<p class="cal-hint">날짜를 누르면 그날의 조각이 여기에 펼쳐져요. 빈 날은 그냥 비워 둬요.</p>') + "</section>";
    return html;
  }

  function tokensHTML() {
    var rows = [
      ["바탕", "--bg", "#FBFAF6", null, "화면 바탕"],
      ["종이", "--surface", "#FFFFFF", null, "사진 틀·팝업"],
      ["잉크", "--ink", "#22252B", "#FBFAF6", "글자·2px 손그림 테두리"],
      ["흐린 잉크", "--muted", "#555B66", "#FBFAF6", "보조 글"],
      ["파랑", "--accent", "#1F5CAB", "#FBFAF6", "주 동작·선택"],
      ["파랑 위 글자", "--on-accent", "#FFFFFF", "#1F5CAB", "주 버튼 글자"],
      ["메모 노랑", "--note-yellow", "#FFF0B3", null, "메모 조각 (잉크 대비 아래)"],
      ["메모 민트", "--note-mint", "#D5F0E3", null, "메모 조각"],
      ["메모 분홍", "--note-pink", "#FBDDD8", null, "메모 조각"],
      ["잉크 on 분홍", "(조합)", "#22252B", "#FBDDD8", "메모 위 본문 대비 확인"],
      ["마커 주황", "--marker", "#E2672E", null, "장식 선만 (글자 사용 금지)"]
    ];
    return '<section class="tokens"><div><h1 tabindex="-1">토큰 카드 · 시안 C</h1>' +
      '<p class="hint">시안용 임시 값입니다. 대비는 이 화면에서 직접 계산했어요(WCAG 2.x). Doodle 원문의 하늘색·주황은 글자 대비가 낮아 글자에 쓰지 않았어요.</p></div>' +
      '<section><h2>색</h2><ul class="tk-list">' + P.tokenRows(rows) + "</ul></section>" +
      '<section><h2>글꼴</h2>' +
      '<div class="type-sample"><p style="font-size:30px;font-weight:800">11월 2일 월요일의 조각</p><code>제목 · 고딕 24–30 / 800 · --font-ui</code></div>' +
      '<div class="type-sample"><p style="font-size:15px">공원 은행나무 길이 반쯤 노랗다.</p><code>조각 글 · 15 / 행간 1.55</code></div>' +
      '<div class="type-sample"><p class="hand" style="font-size:22px">12:15 · 오늘을 한 줄로</p><code>손글씨는 시각·작은 이름표만 · --font-hand (나눔손글씨 펜이 없으면 고딕으로 대체)</code></div></section>' +
      '<section><h2>간격·모서리·구성 요소</h2><p class="hint">간격 8·12·20·32·48, 모서리 4(조각)·10(버튼), 테두리 2px, 조각 기울기 ±1° 이하(움직이지 않음).</p>' +
      '<div class="row" style="margin-top:12px"><a class="btn-main" href="#write">조각 추가</a><a class="btn-ghost" href="#days">모아보기</a></div></section></section>';
  }

  function render(r) {
    if (r.view === "empty") { if (mode !== "first") first = [{ date: S.today, summary: "", moments: [] }]; mode = "first"; }
    else if (r.view === "today" || r.view === "tokens") mode = "sample";
    editing = false;
    if (r.view === "days") view.innerHTML = daysHTML(r.date);
    else if (r.view === "tokens") view.innerHTML = tokensHTML();
    else view.innerHTML = boardHTML(find(S.today), true, "오늘");
    document.querySelectorAll("[data-tab]").forEach(function (t) {
      var on = (t.getAttribute("data-tab") === "days") === (r.view === "days");
      if (on && r.view !== "tokens") t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (r.view === "write") openCompose();
    else {
      if (dlg.open) dlg.close();
      var target = r.view === "days" && r.date ? document.getElementById("picked-h") : null;
      if (target) target.scrollIntoView({ block: "start" });
    }
  }

  function rerenderToday(sel) {
    view.innerHTML = boardHTML(find(S.today), true, "오늘");
    var f = view.querySelector(sel); if (f) f.focus();
  }
  view.addEventListener("click", function (e) {
    if (e.target.id === "sum-edit") { editing = true; rerenderToday("#sum-text"); }
    if (e.target.id === "sum-cancel") { editing = false; rerenderToday("#sum-edit"); }
  });
  view.addEventListener("submit", function (e) {
    if (e.target.id !== "sum-form") return;
    e.preventDefault();
    find(S.today).summary = document.getElementById("sum-text").value.trim();
    editing = false; rerenderToday("h1");
    P.announce("한 줄을 이 화면에만 반영했어요. 저장되지 않습니다.");
  });

  document.getElementById("compose-pick").innerHTML = [["", "없음"], ["window", "창가"], ["noodle", "국수"], ["ginkgo", "은행나무"]].map(function (o, i) {
    var img = o[0] ? S.images[o[0]] : null;
    return '<label class="pola"><input type="radio" name="img" value="' + o[0] + '"' + (i ? "" : " checked") + ">" +
      (img ? '<img src="' + img.src + '" alt="">' : '<span class="blank" aria-hidden="true">메모만</span>') + "<span>" + o[1] + "</span></label>";
  }).join("");

  function openCompose() {
    document.getElementById("compose-time").textContent = P.nowTime();
    err.hidden = true; text.removeAttribute("aria-invalid");
    // 비교판 미리보기(embed): showModal은 포커스를 옮기고, 닫을 때 연 사람의 포커스로 복원해 부모 조작을 끊는다.
    // 그래서 open 속성으로만 겹쳐 보이고, 사용자가 이 미리보기를 직접 조작 중일 때만 입력칸에 포커스를 준다.
    if (P.embed) { if (!dlg.open) dlg.setAttribute("open", ""); if (!P.quiet()) text.focus(); return; }
    if (!dlg.open) dlg.showModal();
    text.focus();
  }
  function closeTo(hash) { if (dlg.open) dlg.close(); if (location.hash !== hash) location.hash = hash; }
  document.getElementById("compose-close").addEventListener("click", function () { closeTo(homeHash()); });
  dlg.addEventListener("cancel", function (e) { e.preventDefault(); closeTo(homeHash()); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = text.value.trim();
    if (!v) {
      err.hidden = false; text.setAttribute("aria-invalid", "true"); text.focus();
      P.announce("메모를 한 줄 적어 주세요.");
      return;
    }
    lastNewKey = "n" + Date.now();
    P.addMoment(find(S.today), { time: P.nowTime(), text: v, img: form.querySelector('input[name="img"]:checked').value || null, key: lastNewKey });
    form.reset();
    closeTo(homeHash());
    P.announce(P.NOT_SAVED);
  });

  P.onRoute(render);
})();
