// F5 S3a RED — 기록 Server Actions의 요청 경계(PLAN_dev-diary-actions §1·§2·§3). DB 없음(단위).
//
// 대상: app/src/app/actions/diary.ts(아직 없음). 각 it 안에서 vi.resetModules 뒤 동적 import한다.
// 모듈·export 부재는 명시 단언으로 그 it만 RED가 된다(정상 RED). 정적 import·타입 import는 하지 않는다.
//
// 실제로 쓰는 것: loadAuthConfig·assertSameOrigin(설정·Origin), createPgDiaryStore·setFontKey(F3 검증·SQL·오류 판정).
// 시험 seam(edge만):
//   1) process.env: vi.stubEnv로 넣고 되돌린다.
//   2) next/headers: headers()·cookies()를 시험이 정한 요청 입력으로 바꾼다.
//   3) @/server/context getViewer: 시험이 정한 viewer를 돌려주고 호출 수를 센다(실제 세션·DB 확인은 tests/db/f5-diary-actions.test.ts).
//   4) @/server/db/pool getAppDb: fake Db. 실제 F3 함수가 보내는 SQL·매개변수를 기록하고 시험이 정한 행으로 답한다.
// 액션 호출 하나 = 새 POST 요청 하나로 보고 h.request를 늘린다.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type Viewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };
type QueryReply = { rows: Record<string, unknown>[]; rowCount: number };

const h = vi.hoisted(() => ({
  request: 0,
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
  headersThrow: null as null | Error,
  viewer: { kind: "signed_out" } as unknown,
  viewerThrow: null as null | Error,
  viewerCalls: [] as number[], // getViewer를 부른 요청 번호
  dbCalls: 0,
  dbThrow: null as null | Error,
  queries: [] as { sql: string; params: unknown[] }[],
  reply: null as null | ((sql: string, params: unknown[]) => unknown),
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (h.headersThrow) throw h.headersThrow;
    return new Headers([...h.headers]);
  },
  cookies: async () => ({
    get: (name: string) => {
      const value = h.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => h.cookies.has(name),
    getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
  }),
}));

vi.mock("@/server/context", () => ({
  getViewer: async () => {
    h.viewerCalls.push(h.request);
    if (h.viewerThrow) throw h.viewerThrow;
    return h.viewer;
  },
  getDiaryContext: async () => ({ kind: "unavailable" }),
}));

vi.mock("@/server/db/pool", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    getAppDb: () => {
      h.dbCalls++;
      if (h.dbThrow) throw h.dbThrow;
      return {
        query: async (sql: string, params: unknown[] = []) => {
          h.queries.push({ sql, params });
          return h.reply!(sql, params);
        },
      };
    },
  };
});

const ACTIONS_MODULE = path.join(APP_DIR, "src", "app", "actions", "diary.ts");
// PLAN_reflection-time-settings §2: 공개 action 계약이 5개에서 6개로 확장된다.
const ACTION_NAMES = ["createMomentAction", "updateMomentAction", "deleteMomentAction", "saveSummaryAction", "setFontAction", "setReflectionTimeAction"] as const;

type ActionError =
  | "forbidden"
  | "not_signed_in"
  | "unavailable"
  | "invalid_body"
  | "invalid_version"
  | "invalid_date"
  | "invalid_font"
  | "invalid_reflection_time"
  | "not_found"
  | "conflict";
type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };
type Actions = {
  createMomentAction: (body: unknown) => Promise<ActionResult<{ id: string; version: number }>>;
  updateMomentAction: (id: unknown, expectedVersion: unknown, body: unknown) => Promise<ActionResult<{ id: string; version: number }>>;
  deleteMomentAction: (id: unknown, expectedVersion: unknown) => Promise<ActionResult<null>>;
  saveSummaryAction: (date: unknown, expectedVersion: unknown, body: unknown) => Promise<ActionResult<{ version: number } | null>>;
  setFontAction: (key: unknown) => Promise<ActionResult<"gothic" | "serif" | "hand">>;
  setReflectionTimeAction: (time: unknown) => Promise<ActionResult<string>>;
};

async function freshModule(): Promise<Record<string, unknown>> {
  vi.resetModules();
  try {
    return (await import(/* @vite-ignore */ ACTIONS_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/app/actions/diary.ts could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 6개 액션 export를 단언한다. 모듈이나 export가 없으면 이 it만 실패한다(정상 RED). */
async function loadActions(): Promise<Actions> {
  const mod = await freshModule();
  for (const name of ACTION_NAMES) expect(typeof mod[name], `src/app/actions/diary.ts must export function ${name}`).toBe("function");
  return mod as unknown as Actions;
}

// ---------------------------------------------------------------- 요청·env·DB 조작(시험 전용 가상 값)

const KEY = "ci-only-s3a-session-key-1-".padEnd(40, "x");
const BASE = "https://pieceofdays.example";
const UID_A = "0190f3a2-7c1e-7d4b-9a01-0000000000aa";
const UID_B = "0190f3a2-7c1e-7d4b-9a01-0000000000bb";
const MOMENT_ID = "0190f3a2-7c1e-7d4b-9a01-00000000d001";
const DB_URL_SECRET = "postgres://pod_app:ci-only-s3a-db-password@127.0.0.1:5432/pod_secret_db";
const RAW_MARKER = "ci-only-s3a-raw-internal-detail";
const SESSION_COOKIE_VALUE = "ci-only-s3a-session-cookie-value";

type EnvMap = Record<string, string>;
const AUTH_ENV: EnvMap = {
  POD_LOCAL_FIXTURE: "",
  POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: KEY }),
  POD_AUTH_BASE_URL: BASE,
  POD_AUTH_PROVIDERS: "google",
  POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-google-client",
  POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-google-secret",
  POD_AUTH_KAKAO_CLIENT_ID: "",
  POD_AUTH_KAKAO_CLIENT_SECRET: "",
  POD_AUTH_MOCK_OIDC_ISSUER: "",
  POD_DATABASE_URL: DB_URL_SECRET,
};
const USER_A: Viewer = { kind: "user", userId: UID_A, gen: 1 };

function setEnv(env: EnvMap): void {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

/** 새 POST 요청: 요청 번호 증가, 헤더·쿠키 교체. 기본은 같은 Origin + 세션 쿠키. */
function newRequest(opts: { origin?: string | null; headers?: Record<string, string>; cookies?: Record<string, string> } = {}): void {
  h.request++;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.origin = origin;
  h.headers = new Map(Object.entries(headers));
  h.cookies = new Map(Object.entries(opts.cookies ?? { "__Host-pod_session": SESSION_COOKIE_VALUE }));
}

/** fake Db 응답: 실제 F3 SQL 문장을 보고 성공(ok)·낡은 버전(conflict)·없음(missing) 상태로 답한다. */
type DbMode = "ok" | "conflict" | "missing";
function replyFor(mode: DbMode) {
  return (sql: string, params: unknown[]): QueryReply => {
    const s = sql.replace(/\s+/g, " ");
    if (/INSERT INTO pod\.diary_moments/.test(s)) return { rows: [{ id: MOMENT_ID, version: 1 }], rowCount: 1 };
    if (/UPDATE pod\.diary_moments/.test(s))
      return mode === "ok" ? { rows: [{ id: String(params[0]), version: Number(params[2]) + 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/DELETE FROM pod\.diary_moments/.test(s)) return { rows: [], rowCount: mode === "ok" ? 1 : 0 };
    if (/INSERT INTO pod\.day_summaries/.test(s)) return mode === "ok" ? { rows: [{ version: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/UPDATE pod\.day_summaries/.test(s))
      return mode === "ok" ? { rows: [{ version: Number(params[2]) + 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/DELETE FROM pod\.day_summaries/.test(s)) return { rows: [], rowCount: mode === "ok" ? 1 : 0 };
    if (/INSERT INTO pod\.preferences/.test(s)) return { rows: [{ reflection_time: params[1] }], rowCount: 1 };
    if (/SELECT EXISTS/.test(s)) return { rows: [{ user_exists: true, summary_exists: mode === "conflict" }], rowCount: 1 };
    if (/^\s*SELECT 1 /.test(s)) return mode === "conflict" ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    throw new Error(`unit fake Db: unexpected SQL ${s.slice(0, 60)}`);
  };
}

const MUTATION = /\b(INSERT|UPDATE|DELETE)\b/i;
const mutations = () => h.queries.filter((q) => MUTATION.test(q.sql));

/** Seoul 날짜(시험 기대값 계산용, 제품과 독립). */
function seoulDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  setEnv(AUTH_ENV);
  h.viewer = USER_A;
  h.viewerThrow = null;
  h.headersThrow = null;
  h.dbThrow = null;
  h.viewerCalls = [];
  h.dbCalls = 0;
  h.queries = [];
  h.reply = replyFor("ok");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 액션마다 정상 인자 한 벌(입력 검증을 통과하는 값). */
const VALID_CALLS: [(typeof ACTION_NAMES)[number], unknown[]][] = [
  ["createMomentAction", ["오늘의 조각"]],
  ["updateMomentAction", [MOMENT_ID, 1, "고친 조각"]],
  ["deleteMomentAction", [MOMENT_ID, 1]],
  ["saveSummaryAction", [seoulDate(new Date()), null, "맑은 하루"]],
  ["setFontAction", ["serif"]],
  ["setReflectionTimeAction", ["21:30"]],
];
const call = (a: Actions, name: (typeof ACTION_NAMES)[number], args: unknown[]) =>
  (a[name] as unknown as (...xs: unknown[]) => Promise<unknown>)(...args);

// ================================================================= 모듈 모양

describe("module shape (§1)", () => {
  it("exports exactly the six async actions at runtime", async () => {
    const mod = await freshModule();
    expect(Object.keys(mod).sort(), "runtime exports").toEqual([...ACTION_NAMES].sort());
    for (const name of ACTION_NAMES) expect((mod[name] as { constructor: { name: string } }).constructor.name, name).toBe("AsyncFunction");
  });
});

// ================================================================= 가드 순서: 설정 → Origin → viewer

describe("guard 1: auth config (§1 step 1)", () => {
  it("config not set / invalid / fixture+PROVIDERS conflict → unavailable before reading headers, viewer or DB", async () => {
    const a = await loadActions();
    const cases: [string, EnvMap][] = [
      ["providers blank", { ...AUTH_ENV, POD_AUTH_PROVIDERS: "" }],
      ["session secrets missing", { ...AUTH_ENV, POD_AUTH_SESSION_SECRETS: "" }],
      ["provider credentials missing", { ...AUTH_ENV, POD_AUTH_GOOGLE_CLIENT_SECRET: "" }],
      ["fixture env without auth", { ...AUTH_ENV, POD_AUTH_PROVIDERS: "", POD_LOCAL_FIXTURE: "1" }],
      ["fixture + PROVIDERS (loadAuthConfig throws)", { ...AUTH_ENV, POD_LOCAL_FIXTURE: "1" }],
    ];
    for (const [label, env] of cases) {
      setEnv(env);
      for (const [name, args] of VALID_CALLS) {
        h.viewerCalls = [];
        h.dbCalls = 0;
        newRequest();
        expect(await call(a, name, args), `${label}: ${name}`).toEqual({ ok: false, error: "unavailable" });
        expect(h.viewerCalls, `${label}: ${name} no viewer`).toEqual([]);
        expect(h.dbCalls, `${label}: ${name} no DB`).toBe(0);
      }
    }
    expect(h.queries).toEqual([]);
  });
});

describe("guard 2: same Origin (§1 step 2)", () => {
  it("missing / empty / \"null\" / other origin → forbidden with no viewer, DB or SQL", async () => {
    const a = await loadActions();
    const origins: [string, string | null][] = [
      ["missing", null],
      ["empty", ""],
      ["null string", "null"],
      ["other site", "https://evil.example"],
      ["suffix trick", "https://pieceofdays.example.evil"],
      ["http scheme", "http://pieceofdays.example"],
      ["other port", "https://pieceofdays.example:8443"],
      ["trailing slash", "https://pieceofdays.example/"],
      ["subdomain", "https://dev.pieceofdays.example"],
    ];
    for (const [label, origin] of origins) {
      for (const [name, args] of VALID_CALLS) {
        newRequest({ origin, headers: { referer: `${BASE}/`, host: "pieceofdays.example" } });
        expect(await call(a, name, args), `${label}: ${name}`).toEqual({ ok: false, error: "forbidden" });
      }
    }
    expect(h.viewerCalls, "viewer never checked").toEqual([]);
    expect(h.dbCalls, "DB never taken").toBe(0);
    expect(h.queries).toEqual([]);
  });

  it("headers() throwing → unavailable, no viewer/DB, and the raw error is neither returned nor logged", async () => {
    const a = await loadActions();
    h.headersThrow = new Error(`${RAW_MARKER} ${DB_URL_SECRET}`);
    for (const [name, args] of VALID_CALLS) {
      newRequest();
      const r = await call(a, name, args);
      expect(r, name).toEqual({ ok: false, error: "unavailable" });
    }
    expect(h.viewerCalls).toEqual([]);
    expect(h.dbCalls).toBe(0);
    const out = logs.join("\n");
    expect(out).not.toContain(RAW_MARKER);
    expect(out).not.toContain(DB_URL_SECRET);
  });
});

describe("guard 3: viewer on every call (§1 step 3)", () => {
  it("fixture / signed_out → not_signed_in; unavailable (any reason) → unavailable; no DB or SQL", async () => {
    const a = await loadActions();
    const cases: [Viewer, ActionError][] = [
      [{ kind: "fixture" }, "not_signed_in"],
      [{ kind: "signed_out" }, "not_signed_in"],
      [{ kind: "unavailable", reason: "db_unavailable" }, "unavailable"],
      [{ kind: "unavailable", reason: "auth_not_configured" }, "unavailable"],
      [{ kind: "unavailable", reason: "invalid_config" }, "unavailable"],
    ];
    for (const [viewer, error] of cases) {
      h.viewer = viewer;
      for (const [name, args] of VALID_CALLS) {
        newRequest();
        expect(await call(a, name, args), `${viewer.kind}: ${name}`).toEqual({ ok: false, error });
      }
    }
    expect(h.dbCalls).toBe(0);
    expect(h.queries).toEqual([]);
  });

  it("getViewer throwing → unavailable without the raw message or secrets in the result or logs", async () => {
    const a = await loadActions();
    h.viewerThrow = Object.assign(new Error(`${RAW_MARKER} ${DB_URL_SECRET} ${SESSION_COOKIE_VALUE}`), { code: "ECONNREFUSED" });
    for (const [name, args] of VALID_CALLS) {
      newRequest();
      const r = await call(a, name, args);
      expect(r, name).toEqual({ ok: false, error: "unavailable" });
      expect(JSON.stringify(r)).not.toContain(RAW_MARKER);
    }
    expect(h.dbCalls).toBe(0);
    const out = logs.join("\n");
    for (const secret of [RAW_MARKER, DB_URL_SECRET, SESSION_COOKIE_VALUE, KEY]) expect(out).not.toContain(secret);
  });

  it("re-checks the viewer for each new POST request: a signed-out second request is refused", async () => {
    const a = await loadActions();
    for (const [name, args] of VALID_CALLS) {
      h.viewer = USER_A;
      newRequest();
      const first = h.request;
      expect(await call(a, name, args), `${name} as user`).toMatchObject({ ok: true });
      h.viewer = { kind: "signed_out" };
      h.queries = [];
      newRequest();
      const second = h.request;
      expect(await call(a, name, args), `${name} after sign-out`).toEqual({ ok: false, error: "not_signed_in" });
      expect(h.viewerCalls, `${name}: viewer checked in both requests`).toEqual(expect.arrayContaining([first, second]));
      expect(mutations(), `${name}: no write in the refused request`).toEqual([]);
    }
  });
});

// ================================================================= 검증된 userId만 F3에 전달

describe("guard 4: only the verified viewer's userId reaches F3 (§1 step 4)", () => {
  it("extra arguments, x-user-id style headers and userId cookies never become the owner", async () => {
    const a = await loadActions();
    const spoof = {
      headers: { "x-user-id": UID_B, "x-forwarded-user": UID_B, referer: `${BASE}/?userId=${UID_B}` },
      cookies: { "__Host-pod_session": SESSION_COOKIE_VALUE, userId: UID_B, user_id: UID_B },
    };
    const extra: [(typeof ACTION_NAMES)[number], unknown[]][] = [
      ["createMomentAction", ["오늘의 조각", UID_B, { userId: UID_B }]],
      ["updateMomentAction", [MOMENT_ID, 1, "고친 조각", UID_B]],
      ["deleteMomentAction", [MOMENT_ID, 1, UID_B]],
      ["saveSummaryAction", [seoulDate(new Date()), null, "맑은 하루", UID_B]],
      ["setFontAction", ["hand", UID_B]],
      ["setReflectionTimeAction", ["21:30", UID_B, { userId: UID_B }]],
    ];
    for (const [name, args] of extra) {
      h.queries = [];
      newRequest(spoof);
      expect(await call(a, name, args), name).toMatchObject({ ok: true });
      const writes = mutations();
      expect(writes.length, `${name}: one write`).toBeGreaterThanOrEqual(1);
      for (const q of h.queries) {
        expect(q.params, `${name}: owner is A`).toContain(UID_A);
        expect(q.params, `${name}: B never used`).not.toContain(UID_B);
      }
    }
  });
});

// ================================================================= 입력 검증(§1 step 5) — mutation SQL 0

describe("input validation before any write", () => {
  it("non-string body → invalid_body for create / update / summary with no SQL", async () => {
    const a = await loadActions();
    const today = seoulDate(new Date());
    for (const body of [undefined, null, 1, true, {}, ["조각"], { toString: () => "조각" }]) {
      for (const [name, args] of [
        ["createMomentAction", [body]],
        ["updateMomentAction", [MOMENT_ID, 1, body]],
        ["saveSummaryAction", [today, null, body]],
      ] as const) {
        newRequest();
        expect(await call(a, name, [...args]), `${name}(${JSON.stringify(body)})`).toEqual({ ok: false, error: "invalid_body" });
      }
    }
    expect(h.queries).toEqual([]);
  });

  it("body trim and 300 code points: blank → invalid_body, 300 (emoji counted as one) saves trimmed, 301 → invalid_body", async () => {
    const a = await loadActions();
    const emoji300 = "😀".repeat(300);
    newRequest();
    expect(await a.createMomentAction("   \n\t ")).toEqual({ ok: false, error: "invalid_body" });
    newRequest();
    expect(await a.createMomentAction(`  ${emoji300}  `)).toMatchObject({ ok: true, value: { id: MOMENT_ID, version: 1 } });
    expect(mutations().at(-1)!.params, "trimmed 300 emoji stored").toContain(emoji300);
    h.queries = [];
    for (const [name, args] of [
      ["createMomentAction", ["😀".repeat(301)]],
      ["updateMomentAction", [MOMENT_ID, 1, "가".repeat(301)]],
      ["updateMomentAction", [MOMENT_ID, 1, "   "]],
      ["saveSummaryAction", [seoulDate(new Date()), null, "a".repeat(301)]],
    ] as const) {
      newRequest();
      expect(await call(a, name, [...args]), name).toEqual({ ok: false, error: "invalid_body" });
    }
    expect(h.queries, "no SQL for rejected bodies").toEqual([]);
    newRequest();
    expect(await a.updateMomentAction(MOMENT_ID, 1, "가".repeat(300))).toMatchObject({ ok: true, value: { id: MOMENT_ID, version: 2 } });
  });

  it("non-string or non-UUID moment id → not_found with no SQL", async () => {
    const a = await loadActions();
    for (const id of [undefined, null, 1, {}, [MOMENT_ID], "", "not-a-uuid", `${MOMENT_ID} `]) {
      newRequest();
      expect(await a.updateMomentAction(id, 1, "본문"), `update ${JSON.stringify(id)}`).toEqual({ ok: false, error: "not_found" });
      newRequest();
      expect(await a.deleteMomentAction(id, 1), `delete ${JSON.stringify(id)}`).toEqual({ ok: false, error: "not_found" });
    }
    expect(h.queries).toEqual([]);
  });

  it("expected version must be a positive safe integer: 0 / negative / fraction / NaN / Infinity / string / bigint / unsafe → invalid_version", async () => {
    const a = await loadActions();
    const today = seoulDate(new Date());
    const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", 1n, 2 ** 53, Number.MAX_VALUE, {}, true];
    for (const v of bad) {
      newRequest();
      expect(await a.updateMomentAction(MOMENT_ID, v, "본문"), `update ${String(v)}`).toEqual({ ok: false, error: "invalid_version" });
      newRequest();
      expect(await a.deleteMomentAction(MOMENT_ID, v), `delete ${String(v)}`).toEqual({ ok: false, error: "invalid_version" });
      newRequest();
      expect(await a.saveSummaryAction(today, v, "본문"), `summary ${String(v)}`).toEqual({ ok: false, error: "invalid_version" });
    }
    for (const v of [undefined, null]) {
      newRequest();
      expect(await a.updateMomentAction(MOMENT_ID, v, "본문"), `update ${String(v)}`).toEqual({ ok: false, error: "invalid_version" });
      newRequest();
      expect(await a.deleteMomentAction(MOMENT_ID, v), `delete ${String(v)}`).toEqual({ ok: false, error: "invalid_version" });
    }
    expect(h.queries).toEqual([]);
  });

  it("summary date: non-string / malformed / impossible / after Seoul today → invalid_date; past and today are accepted", async () => {
    const a = await loadActions();
    const later = seoulDate(new Date(Date.now() + 2 * 86_400_000));
    for (const date of [undefined, null, 20261105, {}, "", "2026-1-5", "2026-02-30", "2026-13-01", "2026/11/05", " 2026-11-05", later]) {
      newRequest();
      expect(await a.saveSummaryAction(date, null, "한 줄"), `date ${JSON.stringify(date)}`).toEqual({ ok: false, error: "invalid_date" });
    }
    expect(h.queries).toEqual([]);
    for (const date of ["2024-02-29", seoulDate(new Date(Date.now() - 30 * 86_400_000)), seoulDate(new Date())]) {
      newRequest();
      expect(await a.saveSummaryAction(date, null, "한 줄"), `date ${date}`).toEqual({ ok: true, value: { version: 1 } });
    }
  });

  it("font key: gothic / serif / hand saved as is; other values → invalid_font with no SQL", async () => {
    const a = await loadActions();
    for (const key of [undefined, null, "", "Gothic", "SERIF", " hand", "mono", 1, {}, ["serif"]]) {
      newRequest();
      expect(await a.setFontAction(key), `font ${JSON.stringify(key)}`).toEqual({ ok: false, error: "invalid_font" });
    }
    expect(h.queries).toEqual([]);
    for (const key of ["gothic", "serif", "hand"] as const) {
      newRequest();
      expect(await a.setFontAction(key)).toEqual({ ok: true, value: key });
      expect(mutations().at(-1)!.params).toEqual([UID_A, key]);
    }
  });

  it("reflection time: invalid input returns invalid_reflection_time with SQL 0; valid minute boundaries are saved for the viewer", async () => {
    const a = await loadActions();
    for (const time of [undefined, null, 2000, {}, ["20:00"], { time: "20:00", userId: UID_B }, "", "24:00", "23:60", "0:00", "20:00:00", " 20:00", "20:00\n", "２０:００"]) {
      newRequest();
      expect(await a.setReflectionTimeAction(time)).toEqual({ ok: false, error: "invalid_reflection_time" });
    }
    expect(h.queries, "invalid reflection time never reaches SQL").toEqual([]);
    for (const time of ["00:00", "20:00", "21:30", "23:59"]) {
      newRequest();
      expect(await a.setReflectionTimeAction(time)).toEqual({ ok: true, value: time });
      expect(mutations().at(-1)!.params).toEqual([UID_A, time]);
    }
  });
});

// ================================================================= 결과 매핑(§1 step 6)

describe("success and domain results are returned as F3 gives them", () => {
  it("success values: create {id,version}, update {id,version+1}, delete null, summary create/update/delete, font key", async () => {
    const a = await loadActions();
    const today = seoulDate(new Date());
    newRequest();
    expect(await a.createMomentAction("새 조각")).toEqual({ ok: true, value: { id: MOMENT_ID, version: 1 } });
    newRequest();
    expect(await a.updateMomentAction(MOMENT_ID, 3, "고침")).toEqual({ ok: true, value: { id: MOMENT_ID, version: 4 } });
    newRequest();
    expect(await a.deleteMomentAction(MOMENT_ID, 4)).toEqual({ ok: true, value: null });
    newRequest();
    expect(await a.saveSummaryAction(today, null, "한 줄")).toEqual({ ok: true, value: { version: 1 } });
    newRequest();
    expect(await a.saveSummaryAction(today, 1, "고친 한 줄")).toEqual({ ok: true, value: { version: 2 } });
    newRequest();
    expect(await a.saveSummaryAction(today, 2, "   ")).toEqual({ ok: true, value: null });
    newRequest();
    expect(await a.setFontAction("hand")).toEqual({ ok: true, value: "hand" });
  });

  it("stale versions → conflict and missing rows → not_found, including versions beyond int4", async () => {
    const a = await loadActions();
    const today = seoulDate(new Date());
    for (const v of [1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      h.reply = replyFor("conflict");
      newRequest();
      expect(await a.updateMomentAction(MOMENT_ID, v, "고침"), `update conflict ${v}`).toEqual({ ok: false, error: "conflict" });
      newRequest();
      expect(await a.deleteMomentAction(MOMENT_ID, v), `delete conflict ${v}`).toEqual({ ok: false, error: "conflict" });
      newRequest();
      expect(await a.saveSummaryAction(today, v, "고침"), `summary conflict ${v}`).toEqual({ ok: false, error: "conflict" });
      h.reply = replyFor("missing");
      newRequest();
      expect(await a.updateMomentAction(MOMENT_ID, v, "고침"), `update missing ${v}`).toEqual({ ok: false, error: "not_found" });
      newRequest();
      expect(await a.deleteMomentAction(MOMENT_ID, v), `delete missing ${v}`).toEqual({ ok: false, error: "not_found" });
      newRequest();
      expect(await a.saveSummaryAction(today, v, "고침"), `summary missing ${v}`).toEqual({ ok: false, error: "not_found" });
    }
    const updates = h.queries.filter((q) => /UPDATE pod\.diary_moments/.test(q.sql));
    expect(updates.map((q) => q.params[2]), "expected version passed through unchanged").toEqual(
      expect.arrayContaining([2 ** 31, Number.MAX_SAFE_INTEGER]),
    );
    h.reply = replyFor("conflict");
    newRequest();
    expect(await a.saveSummaryAction(today, null, "이미 있는 날"), "create over an existing summary").toEqual({ ok: false, error: "conflict" });
    newRequest();
    expect(await a.saveSummaryAction(today, null, ""), "null-version delete of an existing summary").toEqual({ ok: false, error: "conflict" });
  });

  it("getAppDb or query failure → unavailable; the DB URL, raw message and stack are neither returned nor logged", async () => {
    const a = await loadActions();
    const failure = Object.assign(new Error(`connect ECONNREFUSED ${DB_URL_SECRET} ${RAW_MARKER}`), { code: "ECONNREFUSED" });
    h.dbThrow = failure;
    for (const [name, args] of VALID_CALLS) {
      newRequest();
      expect(await call(a, name, args), `getAppDb throws: ${name}`).toEqual({ ok: false, error: "unavailable" });
    }
    h.dbThrow = null;
    h.reply = () => {
      throw failure;
    };
    for (const [name, args] of VALID_CALLS) {
      newRequest();
      const r = await call(a, name, args);
      expect(r, `query throws: ${name}`).toEqual({ ok: false, error: "unavailable" });
      expect(JSON.stringify(r)).not.toContain("ECONNREFUSED");
    }
    const out = logs.join("\n");
    for (const secret of [DB_URL_SECRET, RAW_MARKER, "ECONNREFUSED", KEY, SESSION_COOKIE_VALUE]) expect(out, secret).not.toContain(secret);
  });
});
