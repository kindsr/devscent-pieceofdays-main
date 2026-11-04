// 개발 도메인 /try/ 체험판의 브라우저 저장 모듈(docs/plans/PLAN_dev-local-preview.md). 순수 ES module이다.
// - 전용 키 하나에 버전이 있는 JSON을 저장한다. 서버 전송·외부 라이브러리는 없다.
// - 매 쓰기마다 최신 저장값을 다시 읽고 대상만 바꾼 뒤 setItem이 성공했을 때만 ok를 돌려준다.
// - 손상된 저장값은 덮어쓰거나 지우지 않는다(corrupt_data). 내보내기는 원문을 그대로 돌려준다.

export const STORAGE_KEY = "pieceofdays.dev-preview.v1";

const FONTS = ["gothic", "serif", "hand"];
const MAX_CODE_POINTS = 300;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SEOUL = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function seoulParts(now) {
  const out = {};
  for (const p of SEOUL.formatToParts(now)) out[p.type] = p.value;
  return out;
}

/** 순간의 서울 날짜 YYYY-MM-DD. */
export function seoulDate(now) {
  const p = seoulParts(now);
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}`;
}

function seoulTime(now) {
  const p = seoulParts(now);
  return `${p.hour}:${p.minute}`;
}

/** 실제 달력에 있는 YYYY-MM-DD인지. */
export function isDate(value) {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const codePoints = (s) => Array.from(s).length;

/** 앞뒤 공백을 지운 뒤 min..300 코드포인트면 그 값, 아니면 null. */
function cleanText(value, min) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  const n = codePoints(t);
  return n < min || n > MAX_CODE_POINTS ? null : t;
}

const emptySnapshot = () => ({ v: 1, font: "gothic", days: [] });
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 저장 문서를 검증하고 알려진 필드만 담은 새 객체로 돌려준다. 형식이 틀리면 null. */
function normalize(doc) {
  if (!isObject(doc) || doc.v !== 1 || !FONTS.includes(doc.font) || !Array.isArray(doc.days)) return null;
  const seen = new Set();
  const days = [];
  for (const d of doc.days) {
    if (!isObject(d) || !isDate(d.date) || seen.has(d.date)) return null;
    if (typeof d.summary !== "string" || codePoints(d.summary) > MAX_CODE_POINTS || !Array.isArray(d.moments)) return null;
    seen.add(d.date);
    const moments = [];
    for (const m of d.moments) {
      if (!isObject(m) || typeof m.id !== "string" || m.id === "" || typeof m.time !== "string" || !TIME_RE.test(m.time)) return null;
      if (typeof m.text !== "string" || codePoints(m.text) < 1 || codePoints(m.text) > MAX_CODE_POINTS) return null;
      moments.push({ id: m.id, time: m.time, text: m.text });
    }
    days.push({ date: d.date, summary: d.summary, moments });
  }
  return { v: 1, font: doc.font, days };
}

const fail = (error) => ({ ok: false, error });

function newId(taken) {
  for (;;) {
    const id =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * storage는 getItem/setItem/removeItem을 가진 객체(브라우저의 localStorage 등), now는 현재 시각이다.
 * 반환 객체는 매번 새로 만든 값이라 바꿔도 저장값에 영향이 없다.
 */
export function createPreviewStore(storage, now = () => new Date()) {
  function load() {
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return fail("storage_error");
    }
    if (raw === null || raw === undefined) return { ok: true, value: emptySnapshot() };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail("corrupt_data");
    }
    const snap = normalize(parsed);
    return snap ? { ok: true, value: snap } : fail("corrupt_data");
  }

  function save(snap) {
    const text = JSON.stringify(snap);
    try {
      storage.setItem(STORAGE_KEY, text);
    } catch {
      return fail("storage_error");
    }
    return { ok: true, value: JSON.parse(text) };
  }

  function dayIndex(snap, date) {
    return snap.days.findIndex((d) => d.date === date);
  }

  function insertDay(snap, day) {
    const at = snap.days.findIndex((d) => d.date > day.date);
    if (at === -1) snap.days.push(day);
    else snap.days.splice(at, 0, day);
  }

  function dropIfEmpty(snap, i) {
    const d = snap.days[i];
    if (d && d.moments.length === 0 && d.summary === "") snap.days.splice(i, 1);
  }

  return {
    read() {
      return load();
    },

    addMoment(text) {
      const t = cleanText(text, 1);
      if (t === null) return fail("invalid_input");
      const cur = load();
      if (!cur.ok) return cur;
      const snap = cur.value;
      const at = now();
      const date = seoulDate(at);
      let i = dayIndex(snap, date);
      if (i === -1) {
        insertDay(snap, { date, summary: "", moments: [] });
        i = dayIndex(snap, date);
      }
      const day = snap.days[i];
      day.moments.push({ id: newId(new Set(day.moments.map((m) => m.id))), time: seoulTime(at), text: t });
      return save(snap);
    },

    updateMoment(date, id, text) {
      if (!isDate(date)) return fail("invalid_input");
      const t = cleanText(text, 1);
      if (t === null) return fail("invalid_input");
      const cur = load();
      if (!cur.ok) return cur;
      const snap = cur.value;
      const day = snap.days[dayIndex(snap, date)];
      const m = day?.moments.find((x) => x.id === id);
      if (!m) return fail("not_found");
      m.text = t;
      return save(snap);
    },

    removeMoment(date, id) {
      if (!isDate(date)) return fail("invalid_input");
      const cur = load();
      if (!cur.ok) return cur;
      const snap = cur.value;
      const i = dayIndex(snap, date);
      const day = snap.days[i];
      const at = day ? day.moments.findIndex((x) => x.id === id) : -1;
      if (at === -1) return fail("not_found");
      day.moments.splice(at, 1);
      dropIfEmpty(snap, i);
      return save(snap);
    },

    setSummary(date, text) {
      if (!isDate(date)) return fail("invalid_input");
      const t = cleanText(text, 0);
      if (t === null) return fail("invalid_input");
      const cur = load();
      if (!cur.ok) return cur;
      const snap = cur.value;
      const i = dayIndex(snap, date);
      if (i === -1) {
        if (t !== "") insertDay(snap, { date, summary: t, moments: [] });
      } else {
        snap.days[i].summary = t;
        dropIfEmpty(snap, i);
      }
      return save(snap);
    },

    setFont(font) {
      if (!FONTS.includes(font)) return fail("invalid_input");
      const cur = load();
      if (!cur.ok) return cur;
      cur.value.font = font;
      return save(cur.value);
    },

    clear() {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        return fail("storage_error");
      }
      return { ok: true, value: emptySnapshot() };
    },

    exportJSON() {
      let raw;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch {
        return fail("storage_error");
      }
      if (raw === null || raw === undefined) return { ok: true, value: JSON.stringify(emptySnapshot(), null, 2) };
      const cur = load();
      return { ok: true, value: cur.ok ? JSON.stringify(cur.value, null, 2) : raw };
    },
  };
}
