/* 시안 A 화면 동작 — 메모리 안에서만 바뀐다. 저장 없음. */
(function () {
  "use strict";
  var P = window.POD, S = window.POD_SAMPLE, esc = P.esc;
  var sample = P.clone(S.days);
  var first = [{ date: S.today, summary: "", moments: [] }];
  var mode = "sample";            // "sample" | "first"(첫날 빈 상태)
  var editing = false;
  var view = document.getElementById("view");
  var dlg = document.getElementById("compose");
  var form = document.getElementById("compose-form");
  var text = document.getElementById("compose-text");
  var err = document.getElementById("compose-err");
  var lastNewKey = null;

  function days() { return mode === "first" ? first : sample; }
  function find(date) { return days().filter(function (d) { return d.date === date; })[0]; }
  function homeHash() { return mode === "first" ? "#empty" : "#today"; }
  function dateLabel(iso) { var p = P.parts(iso); return p.m + "월 " + p.d + "일"; }

  function momentHTML(m) {
    var img = m.img ? S.images[m.img] : null;
    var cls = "moment" + (img ? " has-img" : " text-only") + (m.key && m.key === lastNewKey ? " is-new" : "");
    return '<li class="' + cls + '">' +
      (img ? '<figure><img src="' + img.src + '" alt="' + esc(img.alt) + '" width="400" height="300"><figcaption>예시 이미지 · 직접 그린 그림</figcaption></figure>' : "") +
      '<div><p class="moment-time"><time>' + m.time + "</time></p>" +
      '<p class="moment-text">' + esc(m.text) + "</p></div></li>";
  }

  function summaryHTML(day, isToday) {
    if (editing && isToday) {
      return '<section class="summary" aria-labelledby="sum-h"><h2 id="sum-h">하루 정리</h2>' +
        '<form id="sum-form"><label class="field-label" for="sum-text">오늘을 한 문단으로</label>' +
        '<textarea id="sum-text" rows="5" maxlength="1000">' + esc(day.summary) + "</textarea>" +
        '<p class="hint">시안이라 이 화면에만 반영되고 저장되지 않아요.</p>' +
        '<div class="row"><button class="btn btn-primary" type="submit">정리 반영</button>' +
        '<button class="btn btn-quiet" type="button" id="sum-cancel">취소</button></div></form></section>';
    }
    if (!day.summary) {
      if (!isToday) return '<section class="summary"><h2>하루 정리</h2><p class="empty-note">이 날은 하루 정리 없이 순간만 남았어요.</p></section>';
      if (!day.moments.length) return "";
      return '<section class="summary" aria-labelledby="sum-h"><h2 id="sum-h">하루 정리</h2>' +
        '<p class="empty-note">순간들을 보며 밤에 한 문단으로 묶어 보세요.</p>' +
        '<button class="link-btn" type="button" id="sum-edit">하루 정리 쓰기</button></section>';
    }
    return '<section class="summary" aria-labelledby="sum-h"><h2 id="sum-h">하루 정리</h2>' +
      "<blockquote><p>" + esc(day.summary) + "</p></blockquote>" +
      (isToday ? '<button class="link-btn" type="button" id="sum-edit">고쳐 쓰기</button>' : "") + "</section>";
  }

  function dayHTML(day, isToday, fromList) {
    var p = P.parts(day.date);
    var n = day.moments.length;
    var side = '<div class="day-side">' +
      (fromList ? '<a class="back" href="#days">← 날짜 목록</a>' : "") +
      '<header class="day-head"><p class="kicker">' + (isToday ? "오늘 · " : "") + p.y + "년</p>" +
      '<h1 class="day-title" tabindex="-1">' + p.m + "월 " + p.d + '일<span class="wd">' + p.w + "요일</span></h1>" +
      '<p class="day-meta">' + (n ? "순간 " + n + "개" : "아직 남긴 순간 없음") + "</p></header>" +
      summaryHTML(day, isToday) + "</div>";
    var body = n ? '<ol class="moments" aria-label="' + dateLabel(day.date) + '의 순간">' + day.moments.map(momentHTML).join("") + "</ol>"
      : '<section class="empty" aria-labelledby="empty-h"><span class="rule" aria-hidden="true"></span>' +
        '<h2 id="empty-h">오늘이 첫 페이지예요</h2>' +
        "<p>잘 쓰려고 하지 않아도 괜찮아요. 지금 떠오르는 한 줄이나 예시 이미지 하나로 시작해 보세요.</p>" +
        '<a class="btn btn-primary" href="#write">첫 순간 남기기</a></section>';
    return '<article class="day">' + side + "<div>" + body + "</div></article>";
  }

  function listHTML() {
    var groups = {};
    days().forEach(function (d) {
      var p = P.parts(d.date), k = p.y + "년 " + p.m + "월";
      (groups[k] = groups[k] || []).push(d);
    });
    var html = '<section class="list-head"><h1 tabindex="-1">다시 보기</h1><p>기록이 있는 날만 날짜순으로 모았어요. 빈 날은 표시하지 않아요.</p></section>';
    Object.keys(groups).forEach(function (k) {
      html += '<section class="month" aria-label="' + k + '"><h2>' + k + '</h2><ul class="cards">' +
        groups[k].map(function (d) {
          var p = P.parts(d.date);
          var cover = d.moments.filter(function (m) { return m.img; })[0];
          var img = cover ? S.images[cover.img] : null;
          return '<li><a class="card" href="#days/' + d.date + '">' +
            (img ? '<img src="' + img.src + '" alt="" width="400" height="300">' : '<span class="cover-text" aria-hidden="true">' + p.d + "</span>") +
            '<span><span class="card-date">' + p.m + "월 " + p.d + "일 " + p.w + "요일" + (d.date === S.today ? " · 오늘" : "") + "</span><br>" +
            '<span class="card-sum">' + esc(d.summary || (d.moments[0] ? d.moments[0].text : "")) + "</span>" +
            '<span class="card-count">순간 ' + d.moments.length + "개" + (d.summary ? "" : " · 하루 정리 없음") + "</span></span></a></li>";
        }).join("") + "</ul></section>";
    });
    return html;
  }

  function tokensHTML() {
    var rows = [
      ["종이 바탕", "--paper", "#F5EFE4", null, "화면 바탕"],
      ["지면", "--surface", "#FFFBF4", null, "시트·카드 바탕"],
      ["잉크", "--ink", "#2A211C", "#F5EFE4", "본문·제목"],
      ["흐린 잉크", "--ink-muted", "#5F5248", "#F5EFE4", "날짜 보조·설명"],
      ["테라코타", "--accent", "#9E4527", "#F5EFE4", "주 동작·시각·정리 강조 (절제)"],
      ["테라코타 위 글자", "--on-accent", "#FFFFFF", "#9E4527", "주 버튼 글자"],
      ["포커스", "--focus", "#2D5A4C", "#F5EFE4", "키보드 포커스 테두리"],
      ["선", "--line", "#DDCFBC", null, "구분선 (장식, 정보 전달 안 함)"]
    ];
    return '<section class="tokens"><div><h1 tabindex="-1">토큰 카드 · 시안 A</h1>' +
      '<p class="lead">시안용 임시 값입니다. 대비는 이 화면에서 직접 계산했어요(WCAG 2.x). 선택 뒤 확정합니다.</p></div>' +
      '<section><h2>색</h2><ul class="tk-list">' + P.tokenRows(rows) + "</ul></section>" +
      '<section><h2>글꼴 (시스템 글꼴, 동봉 안 함)</h2>' +
      '<div class="type-sample"><p style="font-family:var(--font-head);font-size:36px;font-weight:700">11월 2일 월요일</p><code>제목 · 명조 36–48 / 700 · --font-head</code></div>' +
      '<div class="type-sample"><p style="font-family:var(--font-head);font-size:20px">겨울 준비를 시작한 날로 기억하고 싶다.</p><code>하루 정리 · 명조 20 / 행간 1.8</code></div>' +
      '<div class="type-sample"><p style="font-size:18px">공원 은행나무 길이 반쯤 노랗다.</p><code>순간 본문 · 고딕 18 / 행간 1.75 · --font-body</code></div>' +
      "</section>" +
      '<section><h2>간격·모서리·구성 요소</h2><p class="lead">간격 8·16·24·40·64, 모서리 8(버튼)·14(사진). 그림자 없음, 선 1px.</p>' +
      '<div class="row" style="margin-top:16px"><a class="btn btn-primary" href="#write">순간 남기기</a><a class="btn btn-quiet" href="#days">다시 보기</a></div></section></section>';
  }

  function render(r) {
    // #empty는 첫날 기록장으로, #today·#tokens는 샘플로 돌아간다. #days·#write는 현재 기록장을 유지한다.
    if (r.view === "empty") { if (mode !== "first") first = [{ date: S.today, summary: "", moments: [] }]; mode = "first"; }
    else if (r.view === "today" || r.view === "tokens") mode = "sample";
    editing = false;
    var html;
    if (r.view === "days") html = r.date && find(r.date) ? dayHTML(find(r.date), r.date === S.today, true) : listHTML();
    else if (r.view === "tokens") html = tokensHTML();
    else html = dayHTML(find(S.today), true, false);
    view.innerHTML = html;
    document.querySelectorAll("[data-tab]").forEach(function (t) {
      var on = (t.getAttribute("data-tab") === "days") === (r.view === "days");
      if (on && r.view !== "tokens") t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (r.view === "write") openCompose(); else if (dlg.open) dlg.close();
  }

  function rerenderToday(focusSel) {
    view.innerHTML = dayHTML(find(S.today), true, false);
    var f = focusSel && view.querySelector(focusSel);
    if (f) f.focus();
  }

  view.addEventListener("click", function (e) {
    if (e.target.id === "sum-edit") { editing = true; rerenderToday("#sum-text"); }
    if (e.target.id === "sum-cancel") { editing = false; rerenderToday("#sum-edit"); }
  });
  view.addEventListener("submit", function (e) {
    if (e.target.id !== "sum-form") return;
    e.preventDefault();
    find(S.today).summary = document.getElementById("sum-text").value.trim();
    editing = false;
    rerenderToday(".day-title");
    P.announce("하루 정리를 이 화면에만 반영했어요. 저장되지 않습니다.");
  });

  /* 작성 시트 */
  var pick = document.getElementById("compose-pick");
  pick.innerHTML = [["", "없음"], ["window", "창가"], ["noodle", "국수"], ["ginkgo", "은행나무"]].map(function (o, i) {
    var img = o[0] ? S.images[o[0]] : null;
    return '<label class="pick-item"><input type="radio" name="img" value="' + o[0] + '"' + (i === 0 ? " checked" : "") + ">" +
      (img ? '<img class="pick-thumb" src="' + img.src + '" alt="">' : '<span class="pick-thumb" aria-hidden="true">—</span>') +
      "<span>" + o[1] + "</span></label>";
  }).join("");

  function openCompose() {
    document.getElementById("compose-time").textContent = P.nowTime();
    err.hidden = true; text.removeAttribute("aria-invalid");
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
      P.announce("한 줄이라도 적어야 남길 수 있어요.");
      return;
    }
    var chosen = form.querySelector('input[name="img"]:checked').value || null;
    lastNewKey = "n" + Date.now();
    P.addMoment(find(S.today), { time: P.nowTime(), text: v, img: chosen, key: lastNewKey });
    form.reset();
    closeTo(homeHash());
    P.announce(P.NOT_SAVED);
  });

  P.onRoute(render);
})();
