// F5 S3b 기록 화면 E2E 보조(시험 전용). PLAN_dev-diary-actions §4. auth E2E harness(globalSetup·support)를 그대로 쓴다.
// - 성공 경로는 실제 mock OIDC 로그인(support.login)과 실제 화면·Server Action으로만 만든다. 세션·계정·지급을 직접 만들지 않는다.
// - DB는 관리자 연결로 읽는다. 쓰기는 아래 두 가지 고정 조작뿐이다(모두 공개 이름으로 밝힌다):
//   1) moveMomentToPreviousDay: 실제 UI로 만든 조각을 하루 전으로 옮기는 날짜 fixture(제품 쓰기 증거가 아니다).
//   2) withRevokedSelect: app role의 SELECT 권한을 잠시 회수하고 finally에서 원래 상태로 되돌린다(읽기 실패 재현).
// - Server Action 요청은 page.route로 관찰·보류·중단한다. Next 내부 action ID를 코드에 적지 않고 실제 요청에서 붙잡는다.
// - 쿠키·code·state·URL·비밀번호를 출력하지 않는다.
import { expect, type Page, type Request, type Route } from "@playwright/test";
import type pg from "pg";
import { CI_ROLES, quoteIdent, readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV, accountOf, login, newSubject, type Provider } from "./support";

/** PLAN_dev-diary-actions §4 화면 문구(계획 고정값). */
export const DIARY_TEXT = {
  empty: "메모 한 줄로 첫 조각을 붙여 보세요.",
  blank: "메모를 한 줄 적어 주세요.",
  tooLong: "300자 이하로 적어 주세요.",
  saving: "저장 중…",
  created: "조각을 저장했어요.",
  edited: "조각을 고쳤어요.",
  summarySaved: "한 줄을 저장했어요.",
  summaryDeleted: "한 줄을 지웠어요.",
  deleted: "조각을 지웠어요.",
  deleteTitle: "조각 지우기",
  deleteBody: "이 조각을 지울까요? 지운 뒤에는 되돌릴 수 없어요.",
  conflict: "다른 곳에서 기록이 바뀌었어요. 쓰던 글은 그대로 두었어요.",
  serverLatest: "서버의 최신 글",
  notFound: "기록을 찾을 수 없어요. 다시 불러와 주세요.",
  unavailable: "저장을 확인하지 못했어요. 쓰던 글은 그대로 두었어요. 다시 불러와 확인해 주세요.",
  notSignedIn: "다시 로그인해 주세요. 쓰던 글은 그대로 두었어요.",
  reload: "다시 불러오기",
  readFailed: "기록을 불러오지 못했어요",
  readFailedBody: "잠시 뒤 다시 열어 주세요.",
  fontReadFailed: "기록 글꼴을 불러오지 못했어요",
  fontSaved: "기록 글꼴을 저장했어요.",
  fontHint: "계정에 저장돼 다른 기기에서도 같은 글꼴로 보여요.",
  fontReset: "기본값(고딕)으로 되돌리기",
} as const;

/** D 예시 기록 본문 일부(실제 계정 화면에 나오면 안 된다). */
export const FIXTURE_TEXT = ["창문을 열었더니", "동네 국숫집 줄", "공원 은행나무", "엄마와 20분 통화", "알람 없이 일어"] as const;

// ---------------------------------------------------------------- 날짜(서울, 제품과 독립 계산)

const WEEK = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 서울 날짜 YYYY-MM-DD. */
export function seoulDate(instant: Date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** 날짜 문자열에서 n일 더한 날짜(달력 계산, UTC 정오 기준). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d, 12) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** D 날짜 표기 `M월 D일 W요일`. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${m}월 ${d}일 ${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}요일`;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- 실제 로그인

export type Account = { provider: Provider; subject: string; userId: string };

/** 실제 mock OIDC 로그인 뒤 계정 id(관리자 읽기)를 돌려준다. subject를 주면 같은 사람으로 다시 로그인한다. */
export async function signIn(page: Page, provider: Provider = "google", subject = newSubject(provider)): Promise<Account> {
  expect(await login(page, provider, subject), "lands on today after login").toBe(`${AUTH_BASE}/`);
  const row = await accountOf(provider, subject);
  expect(row?.status, "active account after login").toBe("active");
  return { provider, subject, userId: row!.userId };
}

// ---------------------------------------------------------------- DB(관리자)

function dbName(): string {
  const v = process.env[E2E_ENV.db];
  if (!v) throw new Error(`[e2e-diary] ${E2E_ENV.db} is missing — run through playwright.auth.config.ts (globalSetup)`);
  return v;
}

const admin = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => withAdmin(readDisposableEnv(), fn, dbName());

export type MomentRow = { id: string; body: string; version: number; localDate: string; time: string; occurredAt: string };
export type SummaryRow = { localDate: string; body: string; version: number };

export async function momentsOf(userId: string): Promise<MomentRow[]> {
  return admin(async (c) => {
    const r = await c.query<MomentRow>(
      `SELECT id::text AS id, body, version, local_date::text AS "localDate",
              to_char(occurred_at AT TIME ZONE time_zone, 'HH24:MI') AS time,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
         FROM pod.diary_moments WHERE user_id = $1::uuid ORDER BY occurred_at, id`,
      [userId],
    );
    return r.rows;
  });
}

export async function summariesOf(userId: string): Promise<SummaryRow[]> {
  return admin(async (c) => {
    const r = await c.query<SummaryRow>(
      `SELECT local_date::text AS "localDate", body, version FROM pod.day_summaries WHERE user_id = $1::uuid ORDER BY local_date`,
      [userId],
    );
    return r.rows;
  });
}

/** 저장된 글꼴 키(행이 없으면 null). */
export async function fontOf(userId: string): Promise<string | null> {
  return admin(async (c) => {
    const r = await c.query<{ font_key: string }>("SELECT font_key FROM pod.preferences WHERE user_id = $1::uuid", [userId]);
    return r.rows[0]?.font_key ?? null;
  });
}

/** DB 서버 기준 서울 오늘(제품 서버와 같은 기계의 시계). */
export async function serverSeoulToday(): Promise<string> {
  return admin(async (c) => (await c.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text AS d")).rows[0]!.d);
}

/**
 * 날짜 fixture: 실제 UI로 만든 조각 하나를 날짜·시각 모두 하루 전으로 옮긴다(같은 서울 시각 유지).
 * 과거 날 화면·수정 시험의 준비 조작이며 제품 쓰기의 증거가 아니다.
 */
export async function moveMomentToPreviousDay(momentId: string): Promise<void> {
  await admin(async (c) => {
    const r = await c.query(
      `UPDATE pod.diary_moments SET local_date = local_date - 1, occurred_at = occurred_at - interval '1 day' WHERE id = $1::uuid`,
      [momentId],
    );
    expect(r.rowCount, "date fixture moved exactly one moment").toBe(1);
  });
}

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

async function privileges(tables: readonly string[]): Promise<Record<string, boolean[]>> {
  return admin(async (c) => {
    const out: Record<string, boolean[]> = {};
    for (const t of tables) {
      const r = await c.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, $2, p) AS ok FROM unnest($3::text[]) WITH ORDINALITY AS x(p, i) ORDER BY i`,
        [CI_ROLES.app, t, PRIVS],
      );
      out[t] = r.rows.map((x) => x.ok);
    }
    return out;
  });
}

/**
 * 읽기 실패 재현: 일회용 DB에서 app role의 SELECT를 잠시 회수한다. fn이 끝나면(실패해도) 다시 부여하고
 * 권한이 시작 전과 정확히 같은지 확인한다. 공유·운영 DB에는 쓰지 않는다(globalSetup의 일회용 DB만).
 */
export async function withRevokedSelect<T>(tables: readonly string[], fn: () => Promise<T>): Promise<T> {
  for (const t of tables) expect(t, "only pod.* diary/preference tables").toMatch(/^pod\.(diary_moments|day_summaries|preferences)$/);
  const before = await privileges(tables);
  for (const t of tables) expect(before[t]![0], `${t}: app role can SELECT before the fixture`).toBe(true);
  const list = tables.map((t) => t.split(".").map(quoteIdent).join(".")).join(", ");
  await admin((c) => c.query(`REVOKE SELECT ON ${list} FROM ${quoteIdent(CI_ROLES.app)}`));
  try {
    return await fn();
  } finally {
    await admin((c) => c.query(`GRANT SELECT ON ${list} TO ${quoteIdent(CI_ROLES.app)}`));
    expect(await privileges(tables), "app role privileges restored exactly").toEqual(before);
  }
}

// ---------------------------------------------------------------- Server Action 관찰·보류

export type ActionCall = { url: string; headers: Record<string, string>; body: string };
type Behavior = "pass" | "hold" | "abort-before" | "lose-response";
const REACHED_TIMEOUT_MS = 15_000;
type Pending = { behavior: Behavior; gate?: Promise<void>; release?: () => void; reached: () => void; reachedP: Promise<void> };

export type ActionTap = {
  /** 지금까지 브라우저가 보낸 Server Action POST(요청 수 = 재시도 여부 확인). */
  calls: ActionCall[];
  /** 다음 action 요청 하나의 처리 방식을 정한다. hold는 release 전까지 서버에 보내지 않는다. */
  next(behavior: Exclude<Behavior, "pass">): { reached: Promise<void>; release: () => void };
  dispose(): Promise<void>;
};

async function isAction(req: Request): Promise<boolean> {
  return req.method() === "POST" && new URL(req.url()).origin === AUTH_BASE && (await req.headerValue("next-action")) !== null;
}

/**
 * 이 page의 Server Action POST를 모두 기록한다. Server Action은 fetch라 native navigation이 아니므로
 * 보류 중에도 locator로 화면을 볼 수 있다. 기본은 그대로 서버에 보낸다(route.continue).
 */
export async function tapActions(page: Page): Promise<ActionTap> {
  const calls: ActionCall[] = [];
  const queue: Pending[] = [];
  const handler = async (route: Route) => {
    const req = route.request();
    if (!(await isAction(req))) return route.fallback();
    calls.push({ url: req.url(), headers: await req.allHeaders(), body: req.postData() ?? "" });
    const p = queue.shift();
    if (!p) return route.continue();
    p.reached();
    if (p.behavior === "abort-before") return route.abort("connectionreset");
    if (p.behavior === "lose-response") {
      const res = await route.fetch(); // 서버가 처리(커밋)한 뒤
      await res.body();
      return route.abort("connectionreset"); // 응답만 잃는다
    }
    await p.gate;
    return route.continue();
  };
  const matcher = (u: URL) => u.origin === AUTH_BASE;
  await page.route(matcher, handler);
  return {
    calls,
    next(behavior) {
      // reached는 15초 상한이 있다: 화면이 action을 보내지 않으면 고정 진단으로 실패한다(무기한 대기 없음).
      let reached!: () => void;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reachedP = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`[e2e-diary] action POST not observed within ${REACHED_TIMEOUT_MS / 1000}s`)), REACHED_TIMEOUT_MS);
        timer.unref?.();
        reached = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      // 시험이 다른 단언에서 먼저 실패해 reached를 기다리지 않은 경우의 미처리 거부를 막는다(기다린 쪽에는 그대로 거부된다).
      reachedP.catch(() => undefined);
      let release: () => void = () => undefined;
      const gate = behavior === "hold" ? new Promise<void>((r) => (release = r)) : undefined;
      queue.push({ behavior, gate, release, reached, reachedP });
      return { reached: reachedP, release: () => release() };
    },
    // 닫힌 page에서는 정리 오류로 원래 실패를 가리지 않는다.
    dispose: async () => {
      if (page.isClosed()) return;
      try {
        await page.unroute(matcher, handler);
      } catch (err) {
        if (!page.isClosed()) throw err;
      }
    },
  };
}

/** 붙잡은 action 요청을 같은 브라우저 문맥(쿠키)으로 다시 보낸다. origin: undefined면 Origin 헤더 없이 보낸다. */
export async function replayAction(page: Page, call: ActionCall, body: string, origin: string | undefined | "keep" = "keep") {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.headers)) {
    if (["cookie", "host", "content-length", "origin", "connection"].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  if (origin === "keep") headers.origin = AUTH_BASE;
  else if (origin !== undefined) headers.origin = origin;
  return page.request.post(call.url, { headers, data: body, maxRedirects: 0 });
}

// ---------------------------------------------------------------- 응답 본문 수집(식별자 비직렬화)

/** 이 page가 받은 같은 origin 응답 본문(문서 HTML·RSC·action 응답)을 모은다. */
export function collectBodies(page: Page): { bodies: () => Promise<{ url: string; type: string; text: string }[]> } {
  const pending: Promise<{ url: string; type: string; text: string } | null>[] = [];
  page.on("response", (res) => {
    if (new URL(res.url()).origin !== AUTH_BASE) return;
    const type = res.headers()["content-type"] ?? "";
    if (!/text\/html|text\/x-component|application\/json|text\/plain/.test(type)) return;
    pending.push(
      res.text().then(
        (text) => ({ url: new URL(res.url()).pathname, type, text }),
        // 중단된 요청(시험이 abort한 경우 등)은 본문이 없다. 수집 대상에서만 빠진다.
        () => null,
      ),
    );
  });
  return { bodies: async () => (await Promise.all(pending)).filter((x): x is { url: string; type: string; text: string } => x !== null) };
}

/** 같은 화면에서 붙은 status 영역 중 문구가 있는 것. */
export const statusWith = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

/** 상단(banner)의 조각 추가 진입점. */
export const topAdd = (page: Page) => page.getByRole("banner").getByRole("link", { name: "조각 추가" });
