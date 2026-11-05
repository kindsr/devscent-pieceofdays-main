/* 시안 D 인증 상태 아트보드(B4-d) — 정적 화면만 바꾼다. 네트워크 요청·저장·실제 로그인 없음.
   상태: #login 등 hash, Google 버튼 변형: ?g=image(기본)|html. 문구는 PLAN_mvp-oidc-integration §8. */
(function () {
  "use strict";
  var view = document.getElementById("view");
  var stateSel = document.getElementById("tool-state");
  var googleSel = document.getElementById("tool-google");

  var STATES = ["login", "login-google-only", "login-loading", "unavailable", "cancelled", "failed", "expired", "purge_due",
    "signed_out", "withdrawn", "withdraw", "restore", "recovery_expired", "signed_in", "settings"];
  // 로그인 화면 위에 보이는 결과 안내(§8)
  var NOTICES = {
    cancelled: { text: "로그인을 취소했어요. 다시 시도할 수 있어요." },
    failed: { text: "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.", error: true },
    expired: { text: "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요." },
    purge_due: { text: "복구 기간이 지나 이 계정을 되돌릴 수 없어요." },
    signed_out: { text: "로그아웃했어요" },
    withdrawn: { text: "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요." },
    recovery_expired: { text: "확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요." },
  };

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.append(c);
    }
    return el;
  }
  function head(title) {
    return h("header", { class: "board-head" }, h("h1", { tabindex: "-1", text: title }));
  }
  function googleVariant() {
    return new URLSearchParams(location.search).get("g") === "html" ? "html" : "image";
  }

  // ------------------------------------------------------------ 공급자 버튼(공식 에셋 그대로)

  function googleButton(onPick) {
    if (googleVariant() === "html") {
      // 후보: 한국어 레이블. Google Sans에는 한글이 없어 한글은 시스템 글꼴로 보인다(SOURCES.md).
      return h("button", { type: "button", class: "auth-pbtn auth-google-html", "data-provider": "google", onclick: onPick },
        h("span", { class: "auth-g", "aria-hidden": "true" },
          h("img", { src: "auth-assets/google/signin-light-rect-icon@4x.png", alt: "", width: "40", height: "40" })),
        h("span", { text: "Google 계정으로 계속" }));
    }
    // 기본: 공식 승인(pre-approved) 이미지 버튼. 보이는 글자를 이름에 포함하고 한국어 설명을 덧붙인다.
    return h("button", { type: "button", class: "auth-pbtn auth-google-img", "data-provider": "google", onclick: onPick },
      h("img", { src: "auth-assets/google/signin-light-rect-text@4x.png", alt: "Sign in with Google", lang: "en", width: "207", height: "46" }),
      h("span", { class: "sr-only", text: " (Google 계정으로 로그인)" }));
  }
  function kakaoButton(onPick) {
    return h("button", { type: "button", class: "auth-pbtn auth-kakao", "data-provider": "kakao", onclick: onPick },
      h("img", { src: "auth-assets/kakao/kakao_login_kr_medium.svg", alt: "카카오 로그인", width: "224", height: "46" }));
  }

  function loginView(state) {
    var status = h("p", { class: "auth-status", role: "status", "aria-live": "polite" });
    var providers = h("div", { class: "auth-providers", role: "group", "aria-label": "로그인 방법" });
    // 이동 중: 공급자 레이블·로고·색은 바꾸지 않고 aria-disabled와 버튼 밖 상태 문구로만 알린다.
    function setLoading() {
      providers.querySelectorAll(".auth-pbtn").forEach(function (b) { b.setAttribute("aria-disabled", "true"); });
      status.textContent = "이동 중…";
    }
    function onPick(e) {
      e.preventDefault();
      if (e.currentTarget.getAttribute("aria-disabled") === "true") return;
      setLoading(); // 아트보드: 실제 이동·요청 없음
    }
    providers.append(googleButton(onPick));
    if (state !== "login-google-only") providers.append(kakaoButton(onPick));
    if (state === "login-loading") setLoading();

    var body = h("div", { class: "auth-body" });
    var n = NOTICES[state];
    if (n) body.append(h("section", { class: "notice" + (n.error ? " is-error" : ""), role: "status", "aria-live": "polite" },
      h("p", { class: "auth-msg", text: n.text })));
    body.append(providers, status);
    return [head("pieceofdays에 로그인"), body];
  }

  function unavailableView() {
    return [head("pieceofdays에 로그인"),
      h("section", { class: "notice", "aria-labelledby": "nc-h" }, h("h2", { id: "nc-h", text: "로그인을 준비하고 있어요" }))];
  }

  function signedInView() {
    return [head("오늘"),
      h("section", { class: "notice", "aria-labelledby": "si-h" },
        h("h2", { id: "si-h", text: "로그인됐어요" }),
        h("p", { text: "기록 쓰기·불러오기는 다음 단계에서 연결돼요." }))];
  }

  function settingsView() {
    return [
      h("header", { class: "board-head" }, h("h1", { tabindex: "-1", text: "설정" }), h("p", { class: "sub", text: "나에게 맞게" })),
      h("section", { class: "settings", "aria-labelledby": "acct-h" },
        h("h2", { id: "acct-h", text: "계정" }),
        h("p", { class: "hint", text: "로그인되어 있어요." }),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn-ghost", onclick: function () { go("signed_out"); } }, "로그아웃"),
          h("a", { class: "text-btn", href: "#withdraw" }, "계정 탈퇴"))),
    ];
  }

  function withdrawView() {
    var submit = h("button", { type: "button", class: "btn-ghost auth-danger", disabled: true, onclick: function () { go("withdrawn"); } }, "계정 탈퇴");
    var check = h("input", { type: "checkbox", id: "wd-ok", "aria-describedby": "wd-warn",
      onchange: function (e) { submit.disabled = !e.currentTarget.checked; } });
    return [head("계정 탈퇴"),
      h("section", { class: "settings", "aria-labelledby": "wd-h" },
        h("h2", { id: "wd-h", text: "탈퇴하기 전에 확인해 주세요" }),
        h("p", { id: "wd-warn", class: "auth-warn", text: "탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요" }),
        h("label", { class: "auth-check", for: "wd-ok" }, check, "위 내용을 확인했어요"),
        h("div", { class: "row" }, submit, h("a", { class: "text-btn", href: "#settings" }, "취소")))];
  }

  function restoreView() {
    return [head("계정 복구"),
      h("section", { class: "notice", "aria-labelledby": "rs-h" },
        h("h2", { id: "rs-h", text: "탈퇴를 요청한 계정이에요. 복구할까요?" }),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn-main", onclick: function () { go("signed_in"); } }, "복구하기"),
          h("button", { type: "button", class: "text-btn", onclick: function () { go("login"); } }, "복구하지 않기")))];
  }

  // ------------------------------------------------------------ 상태 전환

  function current() {
    var s = location.hash.slice(1);
    return STATES.indexOf(s) >= 0 ? s : "login";
  }
  function go(state) { location.hash = state; }

  function render(focus) {
    var s = current();
    var nodes;
    if (s === "unavailable") nodes = unavailableView();
    else if (s === "signed_in") nodes = signedInView();
    else if (s === "settings") nodes = settingsView();
    else if (s === "withdraw") nodes = withdrawView();
    else if (s === "restore") nodes = restoreView();
    else nodes = loginView(s);
    view.replaceChildren.apply(view, nodes);
    stateSel.value = s;
    googleSel.value = googleVariant();
    if (focus) view.querySelector("h1").focus();
  }

  stateSel.addEventListener("change", function () { go(stateSel.value); });
  googleSel.addEventListener("change", function () {
    var q = googleSel.value === "html" ? "?g=html" : location.pathname.split("/").pop();
    history.replaceState(null, "", q + location.hash);
    render(false);
  });
  window.addEventListener("hashchange", function () { render(true); });
  render(false);
})();
