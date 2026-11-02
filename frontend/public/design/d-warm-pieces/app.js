/* 시안 D(선택안) 화면 동작 — 시안 C 동작 + 개별 조각 수정 + 기록 글꼴 설정. 메모리 안에서만 바뀐다. 저장 없음. */
(function () {
  "use strict";
  var P = window.POD, S = window.POD_SAMPLE, esc = P.esc;
  var sample = P.clone(S.days);
  var first = [{ date: S.today, summary: "", moments: [] }];
  var mode = "sample", editing = false, lastNewKey = null, cur = { view: "today", date: null };
  var editTarget = null, addDraft = null; // 수정 중인 조각 {date, idx}, 수정 전 추가 초안
  var FONTS = [["gothic", "고딕", "기본 · D 화면과 같은 글꼴"], ["serif", "명조", "책처럼 차분하게"], ["hand", "손글씨", "손글씨 글꼴이 없는 기기는 고딕으로 보여요"]];
  var recordFont = "gothic"; // 이 페이지 메모리에만 있다. 새로고침하면 고딕.
  var view = document.getElementById("view");
  var dlg = document.getElementById("compose");
  var form = document.getElementById("compose-form");
  var text = document.getElementById("compose-text");
  var err = document.getElementById("compose-err");
  var titleEl = document.getElementById("compose-title"), submitEl = document.getElementById("compose-submit");
  var timeEl = document.getElementById("compose-time"), hintEl = document.getElementById("compose-hint");
  var ADD_HINT = hintEl.textContent;
  var NOTE = ["y", "m", "p"];
  /* 메모 색은 조각마다 메모리 상태에 고정한다. 처음 값은 기존 D와 같은 순서(메모 조각끼리 y→m→p).
     사진 조각도 미리 색을 받아 두어, 메모로 바뀌어도 다른 조각 색이 밀리지 않는다. */
  sample.forEach(function (d) {
    var k = 0;
    d.moments.forEach(function (m, i) { m.note = m.img ? NOTE[i % 3] : NOTE[k++ % 3]; });
  });
  var STAR = '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><path d="M28 6 L33 22 L50 22 L36 32 L41 49 L28 39 L15 49 L20 32 L6 22 L23 22 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>';

  function days() { return mode === "first" ? first : sample; }
  function find(date) { return days().filter(function (d) { return d.date === date; })[0]; }
  function homeHash() { return mode === "first" ? "#empty" : "#today"; }
  function label(iso) { var p = P.parts(iso); return p.m + "월 " + p.d + "일 " + p.w + "요일"; }

  function piecesHTML(day, isToday) {
    var items = day.moments.map(function (m, i) {
      var img = m.img ? S.images[m.img] : null;
      var nw = m.key && m.key === lastNewKey ? " is-new" : "";
      var meta = '<div class="piece-meta"><time>' + m.time + '</time><button class="piece-edit" type="button" data-edit="' + day.date + "|" + i +
        '" aria-label="' + label(day.date) + " " + m.time + ' 조각 수정">수정</button></div>';
      if (img) {
        return '<li class="piece photo' + nw + '"><img src="' + img.src + '" alt="' + esc(img.alt) + '" width="400" height="300">' +
          '<p class="tag">예시 이미지 · 직접 그린 그림</p>' + meta + "<p>" + esc(m.text) + "</p></li>";
      }
      return '<li class="piece note ' + (m.note || NOTE[0]) + nw + '">' + meta + "<p>" + esc(m.text) + "</p></li>";
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

  function boardHTML(day, isToday, sub, withSettings) {
    var n = day.moments.length;
    var head = '<header class="board-head"><h1 tabindex="-1">' + label(day.date) + '의 조각<span class="count">' + n + '<span class="sr-only">개</span></span></h1>' +
      (sub ? '<p class="sub">' + sub + "</p>" : "") +
      (withSettings ? '<a class="text-btn set-link" href="#settings">기록 글꼴 설정</a>' : "") + "</header>";
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
      ["바탕", "--bg", "#F5EFE4", null, "화면 바탕 (A --paper)"],
      ["종이", "--surface", "#FFFBF4", null, "사진 틀·팝업 (A --surface)"],
      ["잉크", "--ink", "#2A211C", "#F5EFE4", "글자·2px 손그림 테두리 (A --ink)"],
      ["흐린 잉크", "--muted", "#5F5248", "#F5EFE4", "보조 글 (A --ink-muted)"],
      ["테라코타", "--accent", "#9E4527", "#F5EFE4", "주 동작·선택 (A --accent)"],
      ["테라코타 위 글자", "--on-accent", "#FFFFFF", "#9E4527", "주 버튼 글자 (A --on-accent)"],
      ["메모 1 살구", "--note-yellow", "#F1DED2", null, "메모 조각·작성 칸·달력 칸 (A --accent-weak)"],
      ["메모 2 종이", "--note-mint", "#F5EFE4", null, "메모 조각, 바탕과 같은 색이라 테두리로 구분 (A --paper)"],
      ["메모 3 흰 종이", "--note-pink", "#FFFBF4", null, "메모 조각 (A --surface)"],
      ["잉크 on 살구", "(조합)", "#2A211C", "#F1DED2", "메모 위 본문 대비 확인"],
      ["흐린 잉크 on 살구", "(조합)", "#5F5248", "#F1DED2", "가장 어두운 메모 위 보조 글 대비 확인"],
      ["테이프", "--tape", "#DDCFBC", null, "한 줄 칸 테이프 (A --line)"],
      ["마커", "--marker", "#9E4527", null, "장식 선·빈 상태 별 (A --accent와 같은 값)"],
      ["포커스 초록", "--focus", "#2D5A4C", "#F5EFE4", "키보드 포커스 테두리 (A --focus)"],
      ["오류", "(오류 글자)", "#8E2A12", "#FFFBF4", "작성 팝업 오류 글자·테두리 (A 오류 색)"]
    ];
    return '<section class="tokens"><div><h1 tabindex="-1">토큰 카드 · 시안 D</h1>' +
      '<p class="hint">시안용 임시 값입니다. 대비는 이 화면에서 직접 계산했어요(WCAG 2.x). 시안 C의 화면 구성은 그대로 두고 색만 시안 A 팔레트의 값으로 바꿨어요(새 색 없음). 변수 이름은 C와 비교하기 쉽게 그대로 뒀어요.</p></div>' +
      '<section><h2>색</h2><ul class="tk-list">' + P.tokenRows(rows) + "</ul></section>" +
      '<section><h2>글꼴</h2>' +
      '<div class="type-sample"><p style="font-size:30px;font-weight:800">11월 2일 월요일의 조각</p><code>제목 · 고딕 24–30 / 800 · --font-ui</code></div>' +
      '<div class="type-sample"><p style="font-size:15px">공원 은행나무 길이 반쯤 노랗다.</p><code>조각 글 · 15 / 행간 1.55</code></div>' +
      '<div class="type-sample"><p class="hand" style="font-size:22px">12:15 · 오늘을 한 줄로</p><code>손글씨는 시각·작은 이름표만 · --font-hand (나눔손글씨 펜이 없으면 고딕으로 대체)</code></div>' +
      '<div class="type-sample"><p class="rec-text" style="font-size:15px">동네 국숫집 줄이 생각보다 짧았다.</p><code>기록 글꼴 · --font-record (조각 글·하루 한 줄·쓰는 칸만, 설정에서 고딕 기본/명조/손글씨)</code></div></section>' +
      '<section><h2>간격·모서리·구성 요소</h2><p class="hint">간격 8·12·20·32·48, 모서리 4(조각)·10(버튼), 테두리 2px, 조각 기울기 ±1° 이하(움직이지 않음).</p>' +
      '<div class="row" style="margin-top:12px"><a class="btn-main" href="#write">조각 추가</a><a class="btn-ghost" href="#days">모아보기</a></div></section></section>';
  }

  function settingsHTML() {
    var opts = FONTS.map(function (f) {
      return '<label class="font-opt"><input type="radio" name="record-font" value="' + f[0] + '"' + (f[0] === recordFont ? " checked" : "") + ">" +
        '<span class="font-name">' + f[1] + '</span><span class="font-desc">' + f[2] + '</span><span class="font-eg" data-f="' + f[0] + '" aria-hidden="true">가나다 하루의 조각</span></label>';
    }).join("");
    return '<header class="board-head"><h1 tabindex="-1">설정</h1><p class="sub">나에게 맞게</p></header>' +
      '<section class="settings" aria-labelledby="font-h"><h2 id="font-h">기록 글꼴</h2>' +
      '<p class="hint">조각 글·하루 한 줄·쓰는 칸에만 적용돼요. 메뉴·버튼·제목 글꼴과 화면 배치는 그대로예요.</p>' +
      '<fieldset class="font-pick"><legend class="sr-only">기록 글꼴 고르기</legend>' + opts + "</fieldset>" +
      '<div class="font-preview"><p class="lbl">미리보기</p><div class="note y sample"><time class="hand">12:15</time>' +
      "<p>동네 국숫집 줄이 생각보다 짧았다. 멸치 국물 한 그릇에 몸이 풀렸다.</p></div></div>" +
      '<div class="row"><button class="btn-ghost" type="button" id="font-reset">기본값(고딕)으로 되돌리기</button><a class="text-btn" href="#today">오늘로 돌아가기</a></div>' +
      '<p class="hint">시안이라 이 화면 메모리에만 유지돼요. 새로고침하면 고딕으로 돌아가고 기기·계정에 저장되지 않아요.</p></section>';
  }
  function fontName(v) { return FONTS.filter(function (f) { return f[0] === v; })[0][1]; }
  function setFont(v) {
    recordFont = v;
    if (v === "gothic") document.documentElement.removeAttribute("data-record-font");
    else document.documentElement.setAttribute("data-record-font", v);
  }

  function paint(r) {
    if (r.view === "days") view.innerHTML = daysHTML(r.date);
    else if (r.view === "tokens") view.innerHTML = tokensHTML();
    else if (r.view === "settings") view.innerHTML = settingsHTML();
    else view.innerHTML = boardHTML(find(S.today), true, "오늘", true);
  }
  function render(r) {
    if (r.view === "empty") { if (mode !== "first") first = [{ date: S.today, summary: "", moments: [] }]; mode = "first"; }
    else if (r.view === "today" || r.view === "tokens") mode = "sample";
    editing = false; cur = r;
    paint(r);
    document.querySelectorAll("[data-tab]").forEach(function (t) {
      var on = (t.getAttribute("data-tab") === "days") === (r.view === "days");
      if (on && r.view !== "tokens" && r.view !== "settings") t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (r.view === "write") openCompose();
    else {
      if (dlg.open) dlg.close();
      endEdit();
      var target = r.view === "days" && r.date ? document.getElementById("picked-h") : null;
      if (target) target.scrollIntoView({ block: "start" });
    }
  }

  function rerenderToday(sel) {
    paint(cur);
    var f = view.querySelector(sel); if (f) f.focus();
  }
  view.addEventListener("click", function (e) {
    if (e.target.id === "sum-edit") { editing = true; rerenderToday("#sum-text"); }
    if (e.target.id === "sum-cancel") { editing = false; rerenderToday("#sum-edit"); }
    var ed = e.target.closest("[data-edit]");
    if (ed) { var k = ed.getAttribute("data-edit").split("|"); openEdit(k[0], Number(k[1])); }
    if (e.target.id === "font-reset") {
      setFont("gothic");
      view.querySelector('input[name="record-font"][value="gothic"]').checked = true;
      P.announce("기록 글꼴을 기본값 고딕으로 되돌렸어요.");
    }
  });
  view.addEventListener("change", function (e) {
    if (e.target.name !== "record-font") return;
    setFont(e.target.value);
    P.announce("기록 글꼴을 " + fontName(e.target.value) + "(으)로 바꿨어요. 이 화면 메모리에만 유지되고 새로고침하면 고딕으로 돌아갑니다.");
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

  function imgVal() { return form.querySelector('input[name="img"]:checked').value || null; }
  function setImg(v) { form.querySelectorAll('input[name="img"]').forEach(function (i) { i.checked = i.value === (v || ""); }); }
  function showDialog() {
    if (P.embed) { if (!dlg.open) dlg.setAttribute("open", ""); if (!P.quiet()) text.focus(); return; }
    if (!dlg.open) dlg.showModal();
    text.focus();
  }
  /* 수정 상태: 같은 대화상자를 쓰되 제목·버튼·시각을 바꾸고, 추가 중이던 초안은 따로 보관한다 */
  function openEdit(date, idx) {
    var day = find(date), m = day && day.moments[idx];
    if (!m) return;
    if (!editTarget) addDraft = { text: text.value, img: imgVal() };
    editTarget = { date: date, idx: idx };
    titleEl.textContent = "조각 고치기"; submitEl.textContent = "고치기";
    timeEl.textContent = m.time;
    hintEl.textContent = "시안이라 이 화면에만 고쳐지고 저장되지 않아요. 기록 시각은 그대로예요.";
    text.value = m.text; setImg(m.img);
    err.hidden = true; text.removeAttribute("aria-invalid");
    showDialog();
  }
  function endEdit() {
    if (!editTarget) return;
    editTarget = null;
    titleEl.textContent = "조각 붙이기"; submitEl.textContent = "붙이기"; hintEl.textContent = ADD_HINT;
    text.value = addDraft ? addDraft.text : ""; setImg(addDraft ? addDraft.img : null); addDraft = null;
    err.hidden = true; text.removeAttribute("aria-invalid");
  }
  function leaveEdit(msg, repaint) {
    var key = editTarget.date + "|" + editTarget.idx;
    if (dlg.open) dlg.close();
    endEdit();
    if (repaint) {
      var sum = document.getElementById("sum-text"), keep = sum ? sum.value : null;
      paint(cur);
      if (keep !== null && document.getElementById("sum-text")) document.getElementById("sum-text").value = keep;
    }
    P.announce(msg);
    // 비교판 미리보기에서는 #write 팝업 뒤 조각도 누를 수 있다. 경로가 #write면 추가 팝업(보관한 초안)으로 돌아가
    // 주소와 팝업 상태를 맞춘다. 단독 화면은 모달이라 이 경우가 생기지 않는다.
    if (cur.view === "write") { openCompose(); return; }
    var b = view.querySelector('[data-edit="' + key + '"]');
    if (b && !P.quiet()) b.focus();
  }
  function cancelCompose() {
    if (editTarget) leaveEdit("고치기를 취소했어요. 조각은 그대로예요.", false);
    else closeTo(homeHash());
  }

  function openCompose() {
    endEdit();
    timeEl.textContent = P.nowTime();
    err.hidden = true; text.removeAttribute("aria-invalid");
    // 비교판 미리보기(embed): showModal은 포커스를 옮기고, 닫을 때 연 사람의 포커스로 복원해 부모 조작을 끊는다.
    // 그래서 open 속성으로만 겹쳐 보이고, 사용자가 이 미리보기를 직접 조작 중일 때만 입력칸에 포커스를 준다.
    showDialog();
  }
  function closeTo(hash) { if (dlg.open) dlg.close(); if (location.hash !== hash) location.hash = hash; }
  document.getElementById("compose-close").addEventListener("click", cancelCompose);
  dlg.addEventListener("cancel", function (e) { e.preventDefault(); cancelCompose(); });
  // 비교판 미리보기는 open 속성으로만 열어 cancel 이벤트가 없다. Esc를 직접 받는다.
  dlg.addEventListener("keydown", function (e) { if (P.embed && e.key === "Escape") { e.preventDefault(); cancelCompose(); } });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = text.value.trim();
    if (!v) {
      err.hidden = false; text.setAttribute("aria-invalid", "true"); text.focus();
      P.announce("메모를 한 줄 적어 주세요.");
      return;
    }
    if (editTarget) {
      var m = find(editTarget.date).moments[editTarget.idx];
      m.text = v; m.img = imgVal(); // 시각·순서·개수는 그대로
      leaveEdit("조각을 고쳤어요. 이 화면에만 반영되고 저장되지 않아 새로고침하면 사라집니다.", true);
      return;
    }
    lastNewKey = "n" + Date.now();
    var today = find(S.today);
    P.addMoment(today, { time: P.nowTime(), text: v, img: form.querySelector('input[name="img"]:checked').value || null, key: lastNewKey, note: NOTE[today.moments.length % 3] });
    form.reset();
    closeTo(homeHash());
    P.announce(P.NOT_SAVED);
  });

  P.addView("settings", "설정");
  P.onRoute(render);
})();
