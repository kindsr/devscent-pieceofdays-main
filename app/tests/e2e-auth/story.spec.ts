// PLAN_ai-daily-story-view §1·§3 S2 RED(E2E). 기존 auth E2E harness(mock OIDC·일회용 PG18·next dev)만 쓴다.
// - 메모는 실제 화면·Server Action으로 만들고, 날짜는 그 DB 행의 localDate로 고정한다(서버 현재일 추측 없음).
// - 이야기 행만 관리자 연결이 선언된 revision 공식으로 합성해 넣는다(시험 fixture). 생성 mock·실제 API·사진 0.
// - 선행 조건: S1 0005(pod.story_versions). 없으면 'S1 precondition' 단언에서 멈추며 S2 UI RED가 아니다.
// - 이 파일 전용 도우미만 둔다(공통 support·diary-support·issuer·global setup·config는 읽기만 재사용).
// - chromium project에서 PC(Desktop Chrome)와 별도 WebKit 휴대폰(iPhone 13) context를 열고 finally에서 닫는다.
import { createHash } from "node:crypto";
import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type pg from "pg";
import { CI_ROLES, quoteIdent, readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV, TEXT, WIDTHS, expectLayoutOk } from "./support";
import { DIARY_TEXT, dateLabel, escapeRe, momentsOf, serverSeoulToday, signIn, statusWith, topAdd, type Account } from "./diary-support";

const STORY = "AI 하루 이야기";
const OUTDATED = /이 이야기를 만든 뒤 조각이 바뀌었어요/;
const KEPT = /남아 있어요/;
const UNAVAILABLE = /AI 하루 이야기는 아직 준비 중이에요/;
const READ_FAILED = /불러오지 못했/;

const dialog = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => dialog(page).getByRole("textbox", { name: "메모" });
const piece = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const story = (page: Page) => page.getByRole("region", { name: STORY, exact: true });
const reflectionTime = (page: Page) => page.getByLabel("매일 회고할 시간", { exact: true });
/** The story region's reflection-time label only (not the story's creation time). */
const reflectionShown = (page: Page) => story(page).getByText(/^회고 시간 \d{2}:\d{2}/);

// ---------------------------------------------------------------- 이 파일 전용 DB fixture(관리자, 일회용 DB)

function dbName(): string {
  const v = process.env[E2E_ENV.db];
  if (!v) throw new Error("[e2e-story] POD_E2E_AUTH_DB is missing — run through playwright.auth.config.ts (globalSetup)");
  return v;
}
const admin = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => withAdmin(readDisposableEnv(), fn, dbName());

/** S1 선행 조건(제품 S1 GREEN 이전에는 여기서 멈춘다 — S2 UI RED가 아니다). */
async function expectS1Storage(): Promise<void> {
  const ok = await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT to_regclass('pod.story_versions') IS NOT NULL AS ok")).rows[0]!.ok);
  expect(ok, "S1 precondition (not an S2 RED): pod.story_versions from 0005_daily_stories must exist").toBe(true);
}

/** PLAN_ai-daily-story-storage §2 revision 공식(시험 쪽 독립 계산). */
function revisionOf(date: string, refs: { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return createHash("sha256").update(`v1\n${date}\n${lines.join("")}`, "utf8").digest("hex");
}

/** 지금 그 날짜의 실제 조각으로 계산한 revision으로 합성 이야기 1행을 넣는다(current 상태). */
async function insertStory(userId: string, date: string, body: string): Promise<void> {
  const refs = (await momentsOf(userId)).filter((m) => m.localDate === date).map((m) => ({ id: m.id, version: m.version }));
  await admin(async (c) => {
    const r = await c.query(
      "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1::uuid, $2::date, 1, $3, $4)",
      [userId, date, revisionOf(date, refs), body],
    );
    expect(r.rowCount, "story fixture inserted one row").toBe(1);
  });
}

async function storiesOf(userId: string): Promise<{ date: string; version: number; body: string }[]> {
  return admin(async (c) => (await c.query<{ date: string; version: number; body: string }>(
    "SELECT local_date::text AS date, version, body FROM pod.story_versions WHERE user_id = $1::uuid ORDER BY local_date, version", [userId],
  )).rows);
}

/** 읽기 실패 재현: app role의 story_versions SELECT만 잠시 회수하고 finally에서 정확히 되돌린다. */
async function withoutStorySelect<T>(fn: () => Promise<T>): Promise<T> {
  const can = () => admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'pod.story_versions', 'SELECT') AS ok", [CI_ROLES.app])).rows[0]!.ok);
  expect(await can(), "app role can read stories before the fixture").toBe(true);
  await admin((c) => c.query(`REVOKE SELECT ON pod.story_versions FROM ${quoteIdent(CI_ROLES.app)}`));
  try {
    return await fn();
  } finally {
    await admin((c) => c.query(`GRANT SELECT ON pod.story_versions TO ${quoteIdent(CI_ROLES.app)}`));
    expect(await can(), "app role SELECT restored").toBe(true);
  }
}

// ---------------------------------------------------------------- 화면 조작(공개 문구·역할만)

/** 오늘 화면에서 메모 하나를 저장하고, action 응답 반영(목록·DB 행)을 확인한 뒤 그 행의 날짜를 돌려준다. */
async function createMemo(page: Page, account: Account, text: string): Promise<string> {
  const before = (await momentsOf(account.userId)).length;
  await topAdd(page).click();
  await expect(memo(page)).toBeVisible();
  await memo(page).fill(text);
  await dialog(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.created)).toBeVisible();
  await expect(piece(page, text)).toHaveCount(1);
  await expect.poll(async () => (await momentsOf(account.userId)).length, { message: "the action committed one row" }).toBe(before + 1);
  const rows = (await momentsOf(account.userId)).filter((m) => m.body === text);
  expect(rows, "exactly one stored row has this memo body").toHaveLength(1);
  return rows[0]!.localDate;
}

async function editMemo(page: Page, from: string, to: string): Promise<void> {
  await piece(page, from).getByRole("button", { name: /조각 수정$/ }).click();
  await expect(memo(page)).toHaveValue(from);
  await memo(page).fill(to);
  await dialog(page).getByRole("button", { name: "고치기", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.edited)).toBeVisible();
  await expect(piece(page, to)).toHaveCount(1);
}

async function deleteMemo(page: Page, text: string): Promise<void> {
  await piece(page, text).getByRole("button", { name: /조각 삭제/ }).click();
  const confirm = page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "지우기" }).click();
  await expect(page.getByText(DIARY_TEXT.deleted, { exact: true })).toBeAttached();
  await expect(piece(page, text)).toHaveCount(0);
}

/** 이야기 영역이 정확한 본문(줄바꿈 포함)을 text로 담고 있고, 수정·생성 버튼이 없음을 확인한다. */
async function expectStoryBody(page: Page, body: string, headingLevel: 2 | 3, label: string): Promise<void> {
  const region = story(page);
  await expect(region, `${label}: story region`).toBeVisible();
  await expect(region.getByRole("heading", { level: headingLevel, name: STORY, exact: true }), `${label}: h${headingLevel}`).toBeVisible();
  await expect.poll(() => region.evaluate((el, text) => [...el.querySelectorAll("*")].some((n) => n.textContent === text), body), { message: `${label}: exact body text` }).toBe(true);
  await expect(region.getByRole("button"), `${label}: no edit/delete/generate button`).toHaveCount(0);
}

async function saveReflection(page: Page, value: string): Promise<void> {
  await page.goto("/settings");
  await reflectionTime(page).fill(value);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("회고 시간을 저장했어요.", { exact: true })).toBeVisible();
  await expect(reflectionTime(page)).toBeEnabled();
}

async function phoneContext(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL: AUTH_BASE });
  return { browser, context, page: await context.newPage() };
}

// ---------------------------------------------------------------- 사례

test("PC Chromium and phone WebKit read one stored story on the memo's real date; a phone edit keeps the same body as outdated; the reflection time is reread", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName, "story journey runs in the chromium project and launches its own WebKit phone").toBe("chromium");
  await expectS1Storage();
  const contexts: BrowserContext[] = [];
  let phoneBrowser: Browser | undefined;
  try {
    const pcContext = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: AUTH_BASE });
    contexts.push(pcContext);
    const pc = await pcContext.newPage();
    const account = await signIn(pc);
    const first = "아침에 귤 하나를 먹었다";
    const date = await createMemo(pc, account, first);
    const body = "아침 버스에서 귤 하나로 하루를 열었다.\n\n오후에는 비가 그쳤다.";
    await insertStory(account.userId, date, body);
    const path = `/days/${date}`;

    const extraStories: { date: string; version: number; body: string }[] = [];
    if ((await serverSeoulToday()) === date) {
      await pc.goto("/");
      await expectStoryBody(pc, body, 2, "PC today");
    } else {
      // Seoul midnight passed after the first memo: keep that memo's date fixed for the rest of the case and verify
      // the today view (h2) with a second, unique memo created through the UI and that row's real localDate.
      await pc.goto("/");
      const todayText = "자정 뒤 오늘 화면 확인용 메모";
      const todayDate = await createMemo(pc, account, todayText);
      expect(todayDate, "the second memo is on a later day than the first").not.toBe(date);
      const todayBody = "자정을 넘긴 뒤 오늘 화면에서 읽는 합성 이야기.";
      await insertStory(account.userId, todayDate, todayBody);
      extraStories.push({ date: todayDate, version: 1, body: todayBody });
      await pc.goto("/");
      await expectStoryBody(pc, todayBody, 2, "PC today (after midnight)");
    }
    await pc.goto(path);
    await expectStoryBody(pc, body, 3, "PC selected day");
    await expect(story(pc)).not.toContainText(OUTDATED);
    await expect(reflectionShown(pc), "one reflection-time label").toHaveCount(1);
    await expect(reflectionShown(pc), "default reflection time is shown").toHaveText(/^회고 시간 20:00(?!\d)/);
    await expect(story(pc).locator('a[href="/settings"]'), "settings link").toHaveCount(1);
    await expect(piece(pc, first), "original memo stays below the story").toHaveCount(1);
    for (const width of WIDTHS) {
      await pc.setViewportSize({ width, height: 900 });
      await expectStoryBody(pc, body, 3, `PC ${width}px`);
      await expectLayoutOk(pc, `story ${width}px`);
    }

    const phone = await phoneContext();
    phoneBrowser = phone.browser;
    contexts.push(phone.context);
    expect(await signIn(phone.page, account.provider, account.subject), "phone logs into the same account").toEqual(account);
    await phone.page.goto(path);
    await expectStoryBody(phone.page, body, 3, "phone selected day");
    await expectLayoutOk(phone.page, "phone story");

    const edited = "아침에 귤 두 개를 먹었다";
    await editMemo(phone.page, first, edited);
    await phone.page.reload();
    await expect(story(phone.page), "phone: outdated after the memo edit").toContainText(OUTDATED);
    await expectStoryBody(phone.page, body, 3, "phone outdated");
    await pc.reload();
    await expect(story(pc), "PC: outdated after the phone edit").toContainText(OUTDATED);
    await expectStoryBody(pc, body, 3, "PC outdated");
    await expect(piece(pc, edited)).toHaveCount(1);
    expect(await storiesOf(account.userId), "reading and editing never rewrote or regenerated the story").toEqual([{ date, version: 1, body }, ...extraStories]);

    await saveReflection(pc, "21:15");
    await phone.page.goto(path);
    await expect(reflectionShown(phone.page), "one reflection-time label").toHaveCount(1);
    await expect(reflectionShown(phone.page), "phone rereads the account's reflection time").toHaveText(/^회고 시간 21:15(?!\d)/);
    await expect(reflectionShown(phone.page), "the old reflection time is gone from the label").not.toContainText("20:00");
    await expectStoryBody(phone.page, body, 3, "phone after settings change");
  } finally {
    try { await Promise.all(contexts.map((c) => c.close())); } finally { await phoneBrowser?.close(); }
  }
});

test("after every memo of the day is deleted, the calendar keeps a story-only link and a re-logged-in phone reopens the kept story by calendar and direct URL", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  await expectS1Storage();
  const contexts: BrowserContext[] = [];
  let phoneBrowser: Browser | undefined;
  try {
    const pcContext = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: AUTH_BASE });
    contexts.push(pcContext);
    const pc = await pcContext.newPage();
    const account = await signIn(pc);
    const text = "지울 원본 메모";
    const date = await createMemo(pc, account, text);
    const body = "원본을 지워도 남는 합성 이야기.";
    await insertStory(account.userId, date, body);
    const path = `/days/${date}`;
    await pc.goto(path);
    await deleteMemo(pc, text);
    expect((await momentsOf(account.userId)).filter((m) => m.localDate === date), "no memo left for the day").toEqual([]);
    await pc.reload();
    await expectStoryBody(pc, body, 3, "PC after deleting all memos");
    await expect(story(pc), "explains that the earlier story is kept").toContainText(KEPT);

    const calendarLink = (page: Page) => page.getByRole("link", { name: new RegExp(`^${escapeRe(dateLabel(date))}.*${escapeRe(STORY)}`) });
    await pc.goto("/days");
    await expect(calendarLink(pc), "story-only day is still selectable").toHaveCount(1);
    await calendarLink(pc).click();
    await expect(pc).toHaveURL(`${AUTH_BASE}${path}`);
    await expect(calendarLink(pc)).toHaveAttribute("aria-current", "date");
    await expectStoryBody(pc, body, 3, "PC calendar selection");

    const phone = await phoneContext();
    phoneBrowser = phone.browser;
    contexts.push(phone.context);
    expect(await signIn(phone.page, account.provider, account.subject)).toEqual(account);
    await phone.page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(phone.page).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    expect(await signIn(phone.page, account.provider, account.subject), "phone logs in again").toEqual(account);
    await phone.page.goto("/days");
    await expect(calendarLink(phone.page)).toHaveCount(1);
    await calendarLink(phone.page).click();
    await expect(phone.page).toHaveURL(`${AUTH_BASE}${path}`);
    await expectStoryBody(phone.page, body, 3, "phone calendar selection");
    await phone.page.goto(path);
    await phone.page.reload();
    await expectStoryBody(phone.page, body, 3, "phone direct URL");
    await expect(story(phone.page)).toContainText(KEPT);
    await expectLayoutOk(phone.page, "phone story-only day");
    expect(await storiesOf(account.userId)).toEqual([{ date, version: 1, body }]);
  } finally {
    try { await Promise.all(contexts.map((c) => c.close())); } finally { await phoneBrowser?.close(); }
  }
});

test("shows the closed not-ready state with no button, renders an HTML-like body as text, isolates other accounts and signed-out viewers, and keeps originals when the story read fails", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  await expectS1Storage();
  const contexts: BrowserContext[] = [];
  try {
    const aContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(aContext);
    const pa = await aContext.newPage();
    const account = await signIn(pa);
    const text = "HTML 시험용 원본 메모";
    const date = await createMemo(pa, account, text);
    const path = `/days/${date}`;

    await pa.goto(path);
    await expect(story(pa), "input without a story shows the real not-ready state").toContainText(UNAVAILABLE);
    await expect(story(pa).getByRole("button"), "no generate button while generation is unavailable").toHaveCount(0);

    const marker = "ci-only-story-escape-marker";
    const body = `${marker} <b>굵게</b> <img src=x onerror="window.__podStoryXss=1"> <script>window.__podStoryXss=2</script>`;
    await insertStory(account.userId, date, body);
    await pa.goto(path);
    await expectStoryBody(pa, body, 3, "escaped body");
    await expect(story(pa).locator("b, img, script"), "no element was created from the story text").toHaveCount(0);
    expect(await pa.evaluate(() => (window as unknown as { __podStoryXss?: number }).__podStoryXss), "no script ran").toBeUndefined();
    await expect(story(pa)).not.toContainText(UNAVAILABLE);

    const bContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(bContext);
    const pb = await bContext.newPage();
    const other = await signIn(pb);
    expect(other.userId).not.toBe(account.userId);
    await pb.goto(path);
    await expect(pb.locator("body"), "another account never sees the story").not.toContainText(marker);
    await expect(story(pb).filter({ hasText: marker })).toHaveCount(0);
    await pb.goto("/days");
    await expect(pb.getByRole("link", { name: new RegExp(`^${escapeRe(dateLabel(date))}.*${escapeRe(STORY)}`) }), "no story link for another account").toHaveCount(0);

    await withoutStorySelect(async () => {
      await pa.goto(path);
      await expect(pa.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(piece(pa, text), "originals stay visible when the story read fails").toHaveCount(1);
      await expect(story(pa), "fixed story read-failure notice").toContainText(READ_FAILED);
      await expect(pa.locator("body")).not.toContainText(marker);
      const html = await pa.content();
      for (const raw of ["permission denied", "42501", "story_versions", account.userId]) expect(html.includes(raw), `no raw error/identifier: ${raw}`).toBe(false);
      await pa.goto("/days");
      await expect(pa.getByRole("link", { name: `${dateLabel(date)}, 조각 1개`, exact: true }), "calendar keeps original days when story dates fail").toHaveCount(1);
      await expect(pa.locator("main"), "story date failure is a separate warning").toContainText(READ_FAILED);
    });

    await pa.goto(path);
    await expectStoryBody(pa, body, 3, "after read recovery");
    await pa.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(pa).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    await expect(pa.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
    await pa.goto(path);
    const login = new URL(pa.url());
    expect([login.pathname, login.searchParams.get("returnTo")]).toEqual(["/login", path]);
    await expect(pa.locator("body"), "signed-out viewer never sees the story").not.toContainText(marker);
    expect(await storiesOf(account.userId)).toEqual([{ date, version: 1, body }]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
