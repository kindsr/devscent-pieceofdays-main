/* pieceofdays 기록장 체험판 화면 — D 화면 구성 그대로, 기록은 이 브라우저의 전용 저장 키 하나에만 둔다.
   서버 전송·분석 수집·외부 라이브러리 없음. 사용자 글은 textContent로만 화면에 넣는다. */
import { STORAGE_KEY, createPreviewStore, isDate, seoulDate } from "./store.js";

// 브라우저 저장소를 호출할 때마다 꺼낸다(사생활 보호 모드 등에서 접근 자체가 실패해도 store가 storage_error로 받는다).
const store = createPreviewStore({
  getItem: (k) => window.localStorage.getItem(k),
  setItem: (k, v) => window.localStorage.setItem(k, v),
  removeItem: (k) => window.localStorage.removeItem(k),
});

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const NOTE = ["y", "m", "p"];
const FONTS = [
  ["gothic", "고딕", "기본 · 화면과 같은 글꼴"],
  ["serif", "명조", "책처럼 차분하게"],
  ["hand", "손글씨", "손글씨 글꼴이 없는 기기는 고딕으로 보여요"],
];
const ERRORS = {
  invalid_input: "1~300자로 적어 주세요.",
  not_found: "이 조각을 찾지 못했어요. 다른 탭에서 바뀌었을 수 있어요. 다시 읽은 뒤 시도해 주세요.",
  storage_error: "이 브라우저에 저장하지 못했어요. 적은 글은 그대로 있어요. 저장 공간이나 브라우저 설정을 확인한 뒤 다시 눌러 주세요.",
  corrupt_data: "저장된 기록을 읽지 못해 아무것도 바꾸지 않았어요. 설정에서 원본을 내려받을 수 있어요.",
};

const $ = (id) => document.getElementById(id);
const view = $("view");
const addBtn = $("add");
const statusEl = $("status");
const stale = $("stale");
const compose = $("compose");
const composeForm = $("compose-form");
const composeText = $("compose-text");
const composeErr = $("compose-err");
const confirmDlg = $("confirm");
const confirmErr = $("confirm-err");
const confirmYes = $("confirm-yes");

let monthCursor = null; // "YYYY-MM", 모아보기 달력에 보이는 달
let summaryOpenFor = null; // 하루 한 줄 칸을 연 날짜
let summaryDraft = "";
let editing = null; // { date, id } 수정 중인 조각
let returnFocus = null; // 팝업을 닫은 뒤 돌려줄 포커스
let confirmAction = null;
let statusTimer = 0;

// ---------------------------------------------------------------- 도우미

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function star() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 56 56");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M28 6 L33 22 L50 22 L36 32 L41 49 L28 39 L15 49 L20 32 L6 22 L23 22 Z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.5");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function parts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d, w: WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}
const label = (iso) => {
  const p = parts(iso);
  return `${p.m}월 ${p.d}일 ${p.w}요일`;
};
const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => seoulDate(new Date());
function nowTime() {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

function announce(msg) {
  clearTimeout(statusTimer);
  statusEl.textContent = msg;
  statusTimer = setTimeout(() => { statusEl.textContent = ""; }, 6000);
}

function applyFont(font) {
  if (font === "serif" || font === "hand") document.documentElement.setAttribute("data-record-font", font);
  else document.documentElement.removeAttribute("data-record-font");
}

const anyDialogOpen = () => compose.open || confirmDlg.open;

// ---------------------------------------------------------------- 경로

function route() {
  const hash = location.hash.slice(1);
  if (hash === "days") return { view: "days" };
  if (hash.startsWith("days/")) {
    const d = hash.slice(5);
    return isDate(d) ? { view: "day", date: d } : { view: "days" };
  }
  if (hash === "settings") return { view: "settings" };
  return { view: "today" };
}

// ---------------------------------------------------------------- 화면

function render(opts = {}) {
  const sum = $("sum-text");
  if (sum) summaryDraft = sum.value;
  const r = route();
  const res = store.read();
  const today = todayIso();
  if (res.ok) applyFont(res.value.font);
  addBtn.disabled = !res.ok;

  for (const t of document.querySelectorAll("[data-tab]")) {
    const tab = t.getAttribute("data-tab");
    const on = tab === r.view || (tab === "days" && r.view === "day");
    if (on) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  }

  let nodes;
  if (r.view === "settings") nodes = settingsView(res);
  else if (!res.ok) nodes = problemView(res.error);
  else if (r.view === "days") nodes = daysView(res.value, today);
  else if (r.view === "day") nodes = boardView(res.value, r.date, today, false);
  else nodes = boardView(res.value, today, today, true);
  view.replaceChildren(...nodes);

  if (summaryOpenFor && $("sum-text")) $("sum-text").value = summaryDraft;
  if (opts.focus) {
    const target = opts.focus === "h1" ? view.querySelector("h1") : view.querySelector(opts.focus);
    if (target) target.focus();
  }
}

function boardView(snap, date, today, isHome) {
  const day = snap.days.find((d) => d.date === date) || { date, summary: "", moments: [] };
  const n = day.moments.length;
  const future = date > today;
  const out = [];
  if (!isHome) out.push(h("a", { class: "back", href: "#days" }, h("span", { "aria-hidden": "true" }, "← "), "모아보기로 돌아가기"));
  out.push(h("header", { class: "board-head" },
    h("h1", { tabindex: "-1" }, `${label(date)}의 조각`,
      h("span", { class: "count" }, String(n), h("span", { class: "sr-only" }, "개"))),
    h("p", { class: "sub", text: date === today ? "오늘" : future ? "아직 오지 않은 날" : "지난 날" })));

  if (future) {
    out.push(h("p", { class: "cal-hint", text: "아직 오지 않은 날이에요. 그날이 되면 조각을 붙일 수 있어요." }));
    return out;
  }
  if (!n) {
    out.push(h("section", { class: "first", "aria-labelledby": "f-h" }, star(),
      h("h2", { id: "f-h", text: date === today ? "첫 조각을 붙여 보세요" : "이 날은 조각이 없어요" }),
      h("p", { text: date === today ? "메모 한 줄이면 충분해요. 매일 채우지 않아도 괜찮아요." : "빈 날은 그냥 비워 둬도 괜찮아요." }),
      date === today ? h("button", { class: "btn-main", type: "button", onclick: (e) => openAdd(e.currentTarget) }, "첫 조각 붙이기") : null));
    out.push(onelineView(day, date, today));
    return out;
  }
  out.push(h("div", { class: "with-side" }, onelineView(day, date, today), piecesView(day, date === today)));
  return out;
}

function piecesView(day, isToday) {
  const items = day.moments.map((m, i) => {
    const name = `${m.time} 조각`;
    return h("li", { class: `piece note ${NOTE[i % 3]}` },
      h("div", { class: "piece-meta" },
        h("time", { class: "hand", text: m.time }),
        h("span", { class: "piece-acts" },
          h("button", { class: "piece-edit", type: "button", "data-edit": m.id, "aria-label": `${name} 수정`,
            onclick: (e) => openEdit(day.date, m, e.currentTarget) }, "수정"),
          h("button", { class: "piece-edit", type: "button", "data-del": m.id, "aria-label": `${name} 삭제`,
            onclick: (e) => askDelete(day.date, m, e.currentTarget) }, "삭제"))),
      h("p", { text: m.text }));
  });
  if (isToday) {
    items.push(h("li", { class: "piece" },
      h("button", { class: "add-tile", type: "button", onclick: (e) => openAdd(e.currentTarget) },
        h("span", { class: "plus", "aria-hidden": "true" }, "+"), "조각 추가")));
  }
  return h("ul", { class: "pieces", "aria-label": `${label(day.date)}의 조각 목록` }, items);
}

function onelineView(day, date, today) {
  const sec = h("section", { class: "oneline", "aria-labelledby": "ol-h" },
    h("h2", { id: "ol-h", text: date === today ? "오늘을 한 줄로" : "그날 한 줄" }));
  if (summaryOpenFor === date) {
    const err = h("p", { id: "sum-err", class: "err", role: "alert", hidden: true });
    sec.append(h("form", { id: "sum-form", novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSummary(date); } },
      h("label", { class: "lbl", for: "sum-text" }, "하루 한 줄"),
      h("textarea", { id: "sum-text", rows: "3", "aria-describedby": "sum-err sum-hint" }),
      err,
      h("p", { id: "sum-hint", class: "hint", text: "300자 이내 · 비우고 저장하면 한 줄을 지워요." }),
      h("div", { class: "row" },
        h("button", { class: "btn-main", type: "submit" }, "저장"),
        h("button", { class: "btn-ghost", type: "button", onclick: () => { summaryOpenFor = null; render({ focus: "#sum-edit" }); } }, "취소"))));
    return sec;
  }
  sec.append(day.summary
    ? h("p", { text: day.summary })
    : h("p", { class: "try-muted", text: "조각을 다 모았다면 하루를 한 줄로 묶어 보세요." }));
  sec.append(h("button", { class: "text-btn", type: "button", id: "sum-edit",
    onclick: () => { summaryOpenFor = date; summaryDraft = day.summary; render({ focus: "#sum-text" }); } },
  day.summary ? "고쳐 쓰기" : "한 줄 쓰기"));
  return sec;
}

function saveSummary(date) {
  const ta = $("sum-text");
  const err = $("sum-err");
  const res = store.setSummary(date, ta.value);
  if (!res.ok) {
    err.textContent = res.error === "invalid_input" ? "300자 이내로 적어 주세요." : ERRORS[res.error];
    err.hidden = false;
    ta.setAttribute("aria-invalid", "true");
    ta.focus();
    return;
  }
  summaryOpenFor = null;
  summaryDraft = "";
  const day = res.value.days.find((d) => d.date === date);
  render({ focus: "#sum-edit" });
  announce(day && day.summary ? "하루 한 줄을 적었어요." : "하루 한 줄을 지웠어요.");
}

function daysView(snap, today) {
  const thisMonth = today.slice(0, 7);
  if (!monthCursor || monthCursor > thisMonth) monthCursor = thisMonth;
  const [y, m] = monthCursor.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(snap.days.map((d) => [d.date, d]));
  const cells = WEEK.map((w) => h("li", { class: "wk", "aria-hidden": "true" }, w));
  for (let i = 0; i < start; i++) cells.push(h("li", { "aria-hidden": "true" }));
  for (let d = 1; d <= count; d++) {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    const day = byDate.get(iso);
    if (day && (day.moments.length || day.summary)) {
      const n = day.moments.length;
      cells.push(h("li", null, h("a", { class: "cell", href: `#days/${iso}`, "aria-current": iso === today ? "date" : null,
        "aria-label": `${label(iso)}, 조각 ${n}개${day.summary ? ", 한 줄 있음" : ""}` },
      h("span", { class: "n", "aria-hidden": "true" }, String(d)),
      n ? h("span", { class: "try-dots", "aria-hidden": "true" }, String(n)) : null)));
    } else {
      cells.push(h("li", null, h("span", { class: `cell ${iso > today ? "future" : "none"}` }, h("span", { class: "n" }, String(d)))));
    }
  }
  const go = (delta, id) => { monthCursor = shiftMonth(monthCursor, delta); render({ focus: `#${id}` }); };
  return [
    h("header", { class: "board-head" }, h("h1", { tabindex: "-1" }, "모아보기"), h("p", { class: "sub", text: "조각이 있는 날을 눌러 다시 보세요" })),
    h("section", { class: "cal", "aria-labelledby": "cal-h" },
      h("div", { class: "try-calnav" },
        h("button", { class: "btn-ghost", type: "button", id: "cal-prev", "aria-label": "이전 달", onclick: () => go(-1, "cal-prev") }, h("span", { "aria-hidden": "true" }, "←")),
        h("h2", { id: "cal-h", "aria-live": "polite", text: `${y}년 ${m}월` }),
        h("button", { class: "btn-ghost", type: "button", id: "cal-next", "aria-label": "다음 달", disabled: monthCursor >= thisMonth,
          onclick: () => go(1, "cal-next") }, h("span", { "aria-hidden": "true" }, "→"))),
      h("ul", { class: "cal-grid" }, cells)),
    h("p", { class: "cal-hint", text: "빈 날은 그냥 비워 둬요. 날짜를 누르면 그날의 조각과 한 줄이 펼쳐져요." }),
  ];
}

function storageActions() {
  return h("div", { class: "row" },
    h("button", { class: "btn-ghost", type: "button", onclick: download }, "기록 내려받기"),
    h("button", { class: "btn-ghost try-danger", type: "button", onclick: (e) => askClear(e.currentTarget) }, "체험 기록 지우기"));
}

function problemView(error) {
  const corrupt = error === "corrupt_data";
  return [
    h("header", { class: "board-head" }, h("h1", { tabindex: "-1" }, "기록을 열 수 없어요")),
    h("section", { class: "try-problem" },
      h("p", { text: corrupt
        ? "이 브라우저에 있는 체험 기록을 읽지 못했어요. 원본은 지우거나 덮어쓰지 않고 그대로 두었어요."
        : "이 브라우저 저장소를 쓸 수 없어요. 사생활 보호 모드나 사이트 데이터 설정을 확인해 주세요." }),
      corrupt ? h("p", { text: "기록 내려받기로 원본을 보관한 뒤, 새로 시작하려면 체험 기록 지우기를 눌러 주세요." }) : null,
      storageActions()),
  ];
}

function settingsView(res) {
  const current = res.ok ? res.value.font : null;
  const opts = FONTS.map(([v, name, desc]) => h("label", { class: "font-opt" },
    h("input", { type: "radio", name: "record-font", value: v, checked: v === current, disabled: !res.ok, onchange: () => changeFont(v) }),
    h("span", { class: "font-name", text: name }),
    h("span", { class: "font-desc", text: desc }),
    h("span", { class: "font-eg", "data-f": v, "aria-hidden": "true", text: "가나다 하루의 조각" })));
  return [
    h("header", { class: "board-head" }, h("h1", { tabindex: "-1" }, "설정"), h("p", { class: "sub", text: "나에게 맞게" })),
    h("div", { class: "settings" },
      h("section", { class: "settings", "aria-labelledby": "font-h" },
        h("h2", { id: "font-h", text: "기록 글꼴" }),
        h("p", { class: "hint", text: "조각 글·하루 한 줄·쓰는 칸에만 적용돼요. 메뉴·버튼·제목 글꼴과 화면 배치는 그대로예요." }),
        h("fieldset", { class: "font-pick" }, h("legend", { class: "sr-only", text: "기록 글꼴 고르기" }), opts),
        h("p", { id: "font-err", class: "err", role: "alert", hidden: true }),
        h("div", { class: "font-preview" }, h("p", { class: "lbl", text: "미리보기" }),
          h("div", { class: "note y sample" }, h("time", { class: "hand", text: "12:15" }),
            h("p", { text: "동네 국숫집 줄이 생각보다 짧았다. 멸치 국물 한 그릇에 몸이 풀렸다." })))),
      h("section", { class: "settings try-keep", "aria-labelledby": "keep-h" },
        h("h2", { id: "keep-h", text: "기록 보관" }),
        h("p", { text: "기록은 이 브라우저에만 남아요. 다른 기기와 동기화되지 않고, 브라우저 데이터를 지우면 함께 사라져요." }),
        h("p", { class: "hint", text: "필요하면 기록 내려받기로 파일을 보관해 두세요. 체험 기록 지우기는 이 체험판 기록만 지워요." }),
        storageActions())),
  ];
}

// ---------------------------------------------------------------- 글꼴·내려받기

function changeFont(v) {
  const err = $("font-err");
  const res = store.setFont(v);
  if (!res.ok) {
    err.textContent = ERRORS[res.error];
    err.hidden = false;
    const back = store.read();
    const prev = back.ok ? back.value.font : null;
    for (const r of view.querySelectorAll('input[name="record-font"]')) r.checked = r.value === prev;
    return;
  }
  err.hidden = true;
  applyFont(res.value.font);
  announce(`기록 글꼴을 ${FONTS.find((f) => f[0] === v)[1]}(으)로 바꿨어요.`);
}

function download() {
  const res = store.exportJSON();
  if (!res.ok) {
    announce(ERRORS[res.error]);
    return;
  }
  const url = URL.createObjectURL(new Blob([res.value], { type: "application/json" }));
  const a = h("a", { href: url, download: `pieceofdays-try-${todayIso()}.json`, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("기록 파일을 내려받았어요.");
}

// ---------------------------------------------------------------- 작성·수정 팝업

function setComposeError(msg) {
  if (msg) {
    composeErr.textContent = msg;
    composeErr.hidden = false;
    composeText.setAttribute("aria-invalid", "true");
  } else {
    composeErr.textContent = "";
    composeErr.hidden = true;
    composeText.removeAttribute("aria-invalid");
  }
}

function openAdd(opener) {
  if (anyDialogOpen() || addBtn.disabled) return;
  editing = null;
  $("compose-title").textContent = "조각 붙이기";
  $("compose-time").textContent = nowTime();
  composeText.value = "";
  setComposeError(null);
  returnFocus = opener || addBtn;
  compose.showModal();
  composeText.focus();
}

function openEdit(date, m, opener) {
  if (anyDialogOpen()) return;
  editing = { date, id: m.id };
  $("compose-title").textContent = "조각 고치기";
  $("compose-time").textContent = m.time;
  composeText.value = m.text;
  setComposeError(null);
  returnFocus = opener;
  compose.showModal();
  composeText.focus();
}

composeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const res = editing ? store.updateMoment(editing.date, editing.id, composeText.value) : store.addMoment(composeText.value);
  if (!res.ok) {
    setComposeError(res.error === "invalid_input" ? "메모를 1~300자로 적어 주세요." : ERRORS[res.error]);
    composeText.focus();
    return;
  }
  const wasEdit = editing;
  editing = null;
  setComposeError(null);
  returnFocus = null;
  compose.close();
  const r = route();
  if (!wasEdit && !(r.view === "today" || (r.view === "day" && r.date === todayIso()))) {
    location.hash = "#today"; // hashchange가 다시 그린다
  } else {
    render();
  }
  const target = wasEdit ? view.querySelector(`[data-edit="${CSS.escape(wasEdit.id)}"]`) : null;
  (target || addBtn).focus();
  announce(wasEdit ? "조각을 고쳤어요." : "조각을 붙였어요.");
});

$("compose-cancel").addEventListener("click", () => compose.close());
compose.addEventListener("close", () => {
  editing = null;
  if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  returnFocus = null;
});

// ---------------------------------------------------------------- 확인 팝업

function ask({ title, body, action, onYes, opener }) {
  if (anyDialogOpen()) return;
  $("confirm-h").textContent = title;
  $("confirm-body").textContent = body;
  confirmYes.textContent = action;
  confirmErr.hidden = true;
  confirmErr.textContent = "";
  confirmAction = onYes;
  returnFocus = opener;
  confirmDlg.showModal();
  $("confirm-cancel").focus();
}

function askDelete(date, m, opener) {
  ask({
    title: "이 조각을 지울까요?",
    body: `${label(date)} ${m.time} 조각을 지우면 되돌릴 수 없어요.`,
    action: "삭제",
    opener,
    onYes: () => {
      const res = store.removeMoment(date, m.id);
      if (!res.ok) return ERRORS[res.error];
      render();
      announce("조각을 지웠어요.");
      return null;
    },
  });
}

function askClear(opener) {
  ask({
    title: "체험 기록을 모두 지울까요?",
    body: "이 브라우저에 있는 체험판 기록 전체를 지워요. 되돌릴 수 없으니 필요하면 먼저 기록 내려받기로 보관해 주세요.",
    action: "지우기",
    opener,
    onYes: () => {
      const res = store.clear();
      if (!res.ok) return ERRORS[res.error];
      summaryOpenFor = null;
      render();
      announce("체험 기록을 지웠어요.");
      return null;
    },
  });
}

$("confirm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = confirmAction ? confirmAction() : null;
  if (msg) {
    confirmErr.textContent = msg;
    confirmErr.hidden = false;
    return;
  }
  confirmAction = null;
  returnFocus = null;
  confirmDlg.close();
  const h1 = view.querySelector("h1");
  if (h1) h1.focus();
});
$("confirm-cancel").addEventListener("click", () => confirmDlg.close());
confirmDlg.addEventListener("close", () => {
  confirmAction = null;
  if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  returnFocus = null;
});

// ---------------------------------------------------------------- 시작

addBtn.addEventListener("click", () => openAdd(addBtn));
$("stale-reload").addEventListener("click", () => {
  stale.hidden = true;
  render({ focus: "h1" });
});
// 다른 탭의 변경: 화면을 몰래 바꾸지 않고 알린다. 쓰기는 매번 저장소를 다시 읽은 뒤 한다(다중 탭 원자성은 보장하지 않는다).
window.addEventListener("storage", (e) => {
  if (e.key !== null && e.key !== STORAGE_KEY) return;
  stale.hidden = false;
});
window.addEventListener("hashchange", () => {
  if (compose.open) compose.close();
  if (confirmDlg.open) confirmDlg.close();
  summaryOpenFor = null;
  render({ focus: "h1" });
});

render();
