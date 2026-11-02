/* 시안 B 화면 동작 — 메모리 안에서만 바뀐다. 저장 없음. */
(function () {
  "use strict";
  var P = window.POD, S = window.POD_SAMPLE, esc = P.esc;
  var sample = P.clone(S.days);
  var first = [{ date: S.today, summary: "", moments: [] }];
  var mode = "sample", editing = false, lastNewKey = null, current = S.today;
  var view = document.getElementById("view");
  var index = document.getElementById("index");
  var tocBtn = document.getElementById("toc-btn");

  function days() { return mode === "first" ? first : sample; }
  function find(date) { return days().filter(function (d) { return d.date === date; })[0]; }
  function homeHash() { return mode === "first" ? "#empty" : "#today"; }
  function full(iso) { var p = P.parts(iso); return p.y + "년 " + p.m + "월 " + p.d + "일 " + p.w + "요일"; }
  function short(iso) { var p = P.parts(iso); return p.m + "월 " + p.d + "일"; }
  function link(iso) { return iso === S.today ? homeHash() : "#days/" + iso; }

  function tocHTML(cls) {
    var groups = {}, order = [];
    days().forEach(function (d) {
      var p = P.parts(d.date), k = p.y + "년 " + p.m + "월";
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(d);
    });
    return order.map(function (k) {
      return '<h2 class="toc-month">' + k + '</h2><ol class="toc">' + groups[k].map(function (d) {
        var p = P.parts(d.date);
        var ex = d.summary || (d.moments[0] ? d.moments[0].text : "아직 비어 있는 장");
        return '<li><a href="' + link(d.date) + '"' + (cls && d.date === current ? ' aria-current="page"' : "") + '>' +
          '<span class="d num">' + (cls ? p.d + "일 " + p.w : p.m + "월 " + p.d + "일 " + p.w) + "</span>" +
          '<span class="x">' + (d.date === S.today ? "오늘 · " : "") + esc(ex) + "</span></a></li>";
      }).join("") + "</ol>";
    }).join("");
  }

  function pageHTML(day) {
    var list = days(), i = list.indexOf(day);
    var newer = list[i - 1], older = list[i + 1];
    var isToday = day.date === S.today, n = day.moments.length;
    var sum;
    if (editing && isToday) {
      sum = '<form class="sum-form" id="sum-form"><label class="field-label" for="sum-text">하루 정리</label>' +
        '<textarea id="sum-text" rows="6" maxlength="2000">' + esc(day.summary) + "</textarea>" +
        '<p class="hint">시안이라 이 화면에만 반영되고 저장되지 않아요.</p>' +
        '<div class="actions"><button class="btn-ink" type="submit">정리 반영</button>' +
        '<button class="btn-line" type="button" id="sum-cancel">취소</button></div></form>';
    } else if (day.summary) {
      sum = '<p class="prose">' + esc(day.summary) + "</p>" +
        (isToday ? '<button class="text-btn" type="button" id="sum-edit">정리 고쳐 쓰기</button>' : "");
    } else if (isToday && n) {
      sum = '<p class="prose muted">아직 쓰지 않았어요. 아래 순간들을 다시 읽고 하루를 한 문단으로 정리해 보세요.</p>' +
        '<button class="text-btn" type="button" id="sum-edit">하루 정리 쓰기</button>';
    } else {
      sum = '<p class="prose muted">이 날은 정리 없이 순간만 남았어요.</p>';
    }
    if (!n) {
      return '<article class="page"><p class="page-label">첫 장</p><h1 class="page-title num" tabindex="-1">' + full(day.date) + "</h1>" +
        '<div class="first"><p class="prose">오늘이 이 일기장의 첫 장입니다. 잘 쓰려고 하지 않아도 괜찮아요. 떠오르는 문장 하나로 시작해 보세요.</p>' +
        '<a class="btn-ink" href="#write">첫 문장 쓰기</a></div></article>';
    }
    return '<article class="page">' +
      '<p class="page-label">' + (isToday ? "오늘의 장" : "지난 장") + "</p>" +
      '<h1 class="page-title num" tabindex="-1">' + full(day.date) + "</h1>" +
      '<section class="sec" aria-labelledby="h-sum"><h2 class="sec-h" id="h-sum">하루 정리</h2>' + sum + "</section>" +
      '<section class="sec" aria-labelledby="h-mo"><h2 class="sec-h" id="h-mo">이날의 순간 ' + n + '</h2><ol class="timeline">' +
      day.moments.map(function (m) {
        var img = m.img ? S.images[m.img] : null;
        return "<li" + (m.key && m.key === lastNewKey ? ' class="is-new"' : "") + '><time class="num">' + m.time + "</time><div><p>" + esc(m.text) + "</p>" +
          (img ? '<figure><img src="' + img.src + '" alt="' + esc(img.alt) + '" width="400" height="300"><figcaption>예시 이미지<br>직접 그린 그림</figcaption></figure>' : "") +
          "</div></li>";
      }).join("") + "</ol></section>" +
      '<nav class="pager" aria-label="이전·다음 날">' +
      (older ? '<a href="' + link(older.date) + '"><span>이전 장</span>‹ ' + short(older.date) + "</a>" : "") +
      (newer ? '<a class="next" href="' + link(newer.date) + '"><span>다음 장</span>' + short(newer.date) + " ›</a>" : "") +
      "</nav></article>";
  }

  function contentsHTML() {
    return '<section class="contents"><p class="page-label">다시 보기</p><h1 class="page-title" tabindex="-1">목차</h1>' +
      '<p class="hint" style="margin-top:12px">기록이 있는 날만 최근 순서로 보여요. 날짜를 고르면 그날을 처음부터 읽습니다.</p>' +
      tocHTML(false) + "</section>";
  }

  function writerHTML() {
    var opts = [["", "붙이지 않음"], ["window", "창가"], ["noodle", "국수"], ["ginkgo", "은행나무 길"]];
    return '<section class="writer"><p class="page-label">' + short(S.today) + " " + P.parts(S.today).w + "요일 · 지금 <span class=\"num\">" + P.nowTime() + "</span></p>" +
      '<h1 class="page-title" tabindex="-1">새 순간</h1>' +
      '<form id="write-form" novalidate class="writer">' +
      '<label class="field-label" for="w-text">문장</label>' +
      '<textarea id="w-text" rows="6" maxlength="2000" required aria-describedby="w-err w-hint" placeholder="지금 남기고 싶은 장면이나 생각"></textarea>' +
      '<p class="err" id="w-err" hidden>한 문장이라도 적어야 남길 수 있어요.</p>' +
      "<fieldset><legend>예시 이미지 (선택)</legend>" +
      opts.map(function (o, i) {
        var img = o[0] ? S.images[o[0]] : null;
        return '<label class="opt"><input type="radio" name="img" value="' + o[0] + '"' + (i ? "" : " checked") + ">" +
          (img ? '<img src="' + img.src + '" alt="" width="56" height="42">' : "") + "<span>" + o[1] + "</span></label>";
      }).join("") + "</fieldset>" +
      '<p class="hint" id="w-hint">시안이라 이 화면의 오늘 장에만 추가되고 저장되지 않아요.</p>' +
      '<div class="actions"><button class="btn-ink" type="submit">남기기</button><a class="btn-line" href="' + homeHash() + '">쓰지 않고 돌아가기</a></div>' +
      "</form></section>";
  }

  function tokensHTML() {
    var rows = [
      ["종이", "--paper", "#F3F1E9", null, "화면 바탕"],
      ["지면", "--surface", "#FAF9F4", null, "목차·입력 바탕"],
      ["잉크", "--ink", "#1D2633", "#F3F1E9", "본문 (긴 글)"],
      ["흐린 잉크", "--ink-muted", "#4F5664", "#F3F1E9", "날짜 보조·안내"],
      ["잉크 블루", "--accent", "#1D3A63", "#F3F1E9", "유일한 강조: 동작·현재 날짜·시각"],
      ["잉크 블루 위 글자", "--on-accent", "#FFFFFF", "#1D3A63", "주 버튼 글자"],
      ["괘선", "--rule", "#D3CDBD", null, "구분선·원고지 줄 (장식)"]
    ];
    return '<section class="tokens"><div><p class="page-label">시안 B</p><h1 tabindex="-1">토큰 카드</h1>' +
      '<p class="hint">시안용 임시 값입니다. 대비는 이 화면에서 직접 계산했어요(WCAG 2.x). kami는 중국어·일본어 대상이라 한국어 렌더는 따로 확인해야 합니다.</p></div>' +
      '<section><h2>색 — 강조는 하나만</h2><ul class="tk-list">' + P.tokenRows(rows) + "</ul></section>" +
      '<section><h2>글꼴 — 명조 한 가족</h2>' +
      '<div class="type-sample"><p style="font-size:32px;font-weight:700">2026년 11월 2일 월요일</p><code>장 제목 · 26–32 / 700</code></div>' +
      '<div class="type-sample"><p class="prose">쌀쌀해진 아침으로 시작해 따뜻한 국수와 노란 은행나무 길로 이어진 하루.</p><code>본문 · 19 / 행간 2.0 · 폭 34em</code></div>' +
      '<div class="type-sample"><p style="font-size:15px;color:var(--accent)" class="num">07:40 · 12:15 · 16:30</p><code>여백 시각 · 15 · 고정폭 숫자</code></div></section>' +
      '<section><h2>간격·모서리·구성 요소</h2><p class="hint">간격 6·12·20·32·56, 모서리 2px, 그림자 없음, 괘선 1px.</p>' +
      '<div class="actions" style="margin-top:12px"><a class="btn-ink" href="#write">새 순간 쓰기</a><a class="btn-line" href="#days">목차</a></div></section></section>';
  }

  function setToc(open) {
    index.classList.toggle("is-open", open);
    tocBtn.setAttribute("aria-expanded", String(open));
  }
  tocBtn.addEventListener("click", function () { setToc(!index.classList.contains("is-open")); });

  function renderIndex() { document.getElementById("index-list").innerHTML = tocHTML(true); }

  function render(r) {
    if (r.view === "empty") { if (mode !== "first") first = [{ date: S.today, summary: "", moments: [] }]; mode = "first"; }
    else if (r.view === "today" || r.view === "tokens") mode = "sample";
    editing = false; setToc(false);
    current = r.view === "days" && r.date ? r.date : (r.view === "days" ? "" : S.today);
    if (r.view === "days" && !r.date) view.innerHTML = contentsHTML();
    else if (r.view === "days") view.innerHTML = find(r.date) ? pageHTML(find(r.date)) : contentsHTML();
    else if (r.view === "write") view.innerHTML = writerHTML();
    else if (r.view === "tokens") view.innerHTML = tokensHTML();
    else view.innerHTML = pageHTML(find(S.today));
    renderIndex();
    var h = view.querySelector(r.view === "write" ? "#w-text" : "h1");
    if (h && location.hash && !P.quiet()) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function rerender(sel) {
    view.innerHTML = pageHTML(find(S.today));
    var f = view.querySelector(sel); if (f) f.focus();
  }
  view.addEventListener("click", function (e) {
    if (e.target.id === "sum-edit") { editing = true; rerender("#sum-text"); }
    if (e.target.id === "sum-cancel") { editing = false; rerender("#sum-edit"); }
  });
  view.addEventListener("submit", function (e) {
    e.preventDefault();
    if (e.target.id === "sum-form") {
      find(S.today).summary = document.getElementById("sum-text").value.trim();
      editing = false; rerender("h1"); renderIndex();
      P.announce("하루 정리를 이 화면에만 반영했어요. 저장되지 않습니다.");
      return;
    }
    if (e.target.id === "write-form") {
      var t = document.getElementById("w-text"), v = t.value.trim();
      if (!v) {
        document.getElementById("w-err").hidden = false; t.setAttribute("aria-invalid", "true"); t.focus();
        P.announce("한 문장이라도 적어야 남길 수 있어요.");
        return;
      }
      lastNewKey = "n" + Date.now();
      P.addMoment(find(S.today), { time: P.nowTime(), text: v, img: e.target.querySelector('input[name="img"]:checked').value || null, key: lastNewKey });
      location.hash = homeHash();
      P.announce(P.NOT_SAVED);
    }
  });

  P.onRoute(render);
})();
