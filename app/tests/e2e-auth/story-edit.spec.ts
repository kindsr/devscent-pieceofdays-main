// PLAN_story-edit-regenerate §3·§4 RED(E2E). 기존 auth E2E harness(mock OIDC·일회용 PG18·next dev·가짜 키)만 쓴다.
// - 메모·동의·수정·재생성 요청은 실제 화면과 Server Action으로 만든다. AI v1 이야기와 재생성 결과만 관리자 fixture로 둔다
//   (worker·실제 API 실행 0 → story_usage 0. 실제 API 경로라고 주장하지 않는다).
// - 날짜는 실제 메모 행의 localDate로 고정한다(서버 현재일 추측 없음).
// - PNG12: story-edit-{read,edit,conflict,confirm}-{375,768,1440}.png를 실제 제품 흐름 안의 상태에서만 찍는다(HTML/trace 저장 0).
// - 이 파일 전용 도우미만 둔다(공통 support·diary-support·issuer·global setup·config는 읽기만 재사용).
import { createHash } from "node:crypto";
import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type pg from "pg";
import { readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV, TEXT, WIDTHS, expectLayoutOk } from "./support";
import { DIARY_TEXT, momentsOf, replayAction, signIn, statusWith, tapActions, topAdd, type Account } from "./diary-support";

const STORY = "AI 하루 이야기";
const EDIT = "이야기 수정";
const CONTENT = "이야기 내용";
const EDITED_SOURCE = "직접 다듬은 글이에요";
const REGEN = "다시 만들기";
const REGEN_CONFIRM = "AI로 다시 만들기";
const MAKING = /만드는 중이에요/;
const MANUAL = "직접 만들기 허용";
const AUTO = /^회고 시간\(현재 \d{2}:\d{2}\)에 자동으로 만들기$/;
const V1 = "ci-only 아침에는 공원을 걸었다.\n저녁에는 국수를 먹었다.";

const dialog = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => dialog(page).getByRole("textbox", { name: "메모" });
const piece = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const story = (page: Page) => page.getByRole("region", { name: STORY, exact: true });
const editButton = (page: Page) => story(page).getByRole("button", { name: EDIT, exact: true });
const content = (page: Page) => story(page).getByRole("textbox", { name: CONTENT, exact: true });
const saveButton = (page: Page) => story(page).getByRole("button", { name: "저장", exact: true });
const cancelButton = (page: Page) => story(page).getByRole("button", { name: "취소", exact: true });
const regenButton = (page: Page) => story(page).getByRole("button", { name: REGEN, exact: true });
const regenConfirm = (page: Page) => story(page).getByRole("button", { name: REGEN_CONFIRM, exact: true });
const makeButton = (page: Page) => story(page).getByRole("button", { name: "AI 이야기 만들기", exact: true });

// ---------------------------------------------------------------- 이 파일 전용 DB fixture(관리자, 일회용 DB)

function dbName(): string {
  const v = process.env[E2E_ENV.db];
  if (!v) throw new Error("[e2e-story-edit] POD_E2E_AUTH_DB is missing — run through playwright.auth.config.ts (globalSetup)");
  return v;
}
const admin = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => withAdmin(readDisposableEnv(), fn, dbName());

/** 0007 선행 조건(제품 GREEN 이전에는 여기서 명시 단언으로 멈춘다). */
async function expectEditSchema(): Promise<void> {
  const cols = await admin(async (c) => (await c.query<{ col: string }>(
    "SELECT table_name || '.' || column_name AS col FROM information_schema.columns WHERE table_schema = 'pod' AND column_name IN ('origin', 'base_version') ORDER BY 1")).rows.map((r) => r.col));
  expect(cols, "0007_story_edits columns must exist (PLAN_story-edit-regenerate §1)").toEqual([
    "story_jobs.base_version", "story_versions.base_version", "story_versions.origin",
  ]);
}

function revisionV1(date: string, refs: { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return createHash("sha256").update(`v1\n${date}\n${lines.join("")}`, "utf8").digest("hex");
}
async function currentRevision(userId: string, date: string): Promise<string> {
  return revisionV1(date, (await momentsOf(userId)).filter((m) => m.localDate === date).map((m) => ({ id: m.id, version: m.version })));
}

/** AI 최초 생성 v1(origin 기본 ai, base NULL)을 지금 조각의 revision으로 넣는다(current). */
async function insertAiStory(account: Account, date: string, body: string): Promise<void> {
  const rev = await currentRevision(account.userId, date);
  await admin(async (c) => {
    const r = await c.query("INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1::uuid, $2::date, 1, $3, $4)", [account.userId, date, rev, body]);
    expect(r.rowCount, "v1 fixture inserted").toBe(1);
  });
}

type StoryRow = { version: number; origin: string; base: number | null; rev: string; body: string };
async function storiesOf(userId: string): Promise<StoryRow[]> {
  return admin(async (c) => (await c.query<StoryRow>(
    "SELECT version, origin, base_version AS base, source_revision AS rev, body FROM pod.story_versions WHERE user_id = $1::uuid ORDER BY local_date, version", [userId])).rows);
}
type JobRow = { id: string; date: string; kind: string; state: string; base: number | null };
async function jobsOf(userId: string): Promise<JobRow[]> {
  return admin(async (c) => (await c.query<JobRow>(
    "SELECT id::text, local_date::text AS date, kind, state, base_version AS base FROM pod.story_jobs WHERE user_id = $1::uuid ORDER BY created_at, id", [userId])).rows);
}
async function usageCount(): Promise<number> {
  return admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.story_usage")).rows[0]!.n);
}
async function settingsOf(userId: string): Promise<{ manual: boolean; auto: boolean; cr: string }[]> {
  return admin(async (c) => (await c.query<{ manual: boolean; auto: boolean; cr: string }>(
    "SELECT manual_enabled AS manual, auto_enabled AS auto, consent_revision::text AS cr FROM pod.story_ai_settings WHERE user_id = $1::uuid", [userId])).rows);
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** worker가 재생성에 성공한 것과 같은 종단 상태: base 다음 version의 ai 행 + 그 job succeeded(관리자 fixture). */
async function finishRegeneration(account: Account, job: JobRow, body: string): Promise<void> {
  await admin(async (c) => {
    const latest = (await c.query<{ v: number; rev: string }>(
      "SELECT version AS v, source_revision AS rev FROM pod.story_versions WHERE user_id = $1::uuid AND local_date = $2::date ORDER BY version DESC LIMIT 1", [account.userId, job.date])).rows[0]!;
    expect(latest.v, "the fixture finishes on the job's base").toBe(job.base);
    const story = await c.query<{ id: string }>(
      "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body, origin, base_version) VALUES ($1::uuid, $2::date, $3, $4, $5, 'ai', $6) RETURNING id::text",
      [account.userId, job.date, latest.v + 1, latest.rev, body, latest.v]);
    const r = await c.query("UPDATE pod.story_jobs SET state = 'succeeded', story_id = $2::uuid, updated_at = now() WHERE id = $1::uuid AND state = 'queued'", [job.id, story.rows[0]!.id]);
    expect(r.rowCount, "the queued regeneration was finished by the fixture").toBe(1);
  });
}

// ---------------------------------------------------------------- 화면 조작

async function createMemo(page: Page, account: Account, text: string): Promise<string> {
  const before = (await momentsOf(account.userId)).length;
  await topAdd(page).click();
  await expect(memo(page)).toBeVisible();
  await memo(page).fill(text);
  await dialog(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.created)).toBeVisible();
  await expect(piece(page, text)).toHaveCount(1);
  await expect.poll(async () => (await momentsOf(account.userId)).length).toBe(before + 1);
  const rows = (await momentsOf(account.userId)).filter((m) => m.body === text);
  expect(rows).toHaveLength(1);
  return rows[0]!.localDate;
}

async function saveConsent(page: Page, account: Account, manual: boolean): Promise<void> {
  await page.goto("/settings");
  const section = page.locator("#story-ai");
  await expect(section).toBeVisible();
  await section.getByRole("checkbox", { name: MANUAL, exact: true }).setChecked(manual);
  await section.getByRole("checkbox", { name: AUTO }).setChecked(false);
  const before = (await settingsOf(account.userId))[0]?.cr ?? "0";
  await section.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(async () => settingsOf(account.userId)).toEqual([{ manual, auto: false, cr: String(Number(before) + 1) }]);
}

/** 이야기 본문이 정확한 text로 보인다(HTML 해석 없음). */
async function expectBody(page: Page, body: string, label: string): Promise<void> {
  await expect.poll(() => story(page).evaluate((el, text) => [...el.querySelectorAll("*")].some((n) => n.textContent === text), body), { message: `${label}: exact body text` }).toBe(true);
}

async function capture(page: Page, state: "read" | "edit" | "conflict" | "confirm"): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectLayoutOk(page, `${state} ${width}px`);
    await page.screenshot({ path: test.info().outputPath(`story-edit-${state}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function phoneContext(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL: AUTH_BASE });
  return { browser, context, page: await context.newPage() };
}

// ---------------------------------------------------------------- 사례

test("a signed-in account partially edits the AI story in place (cancel, save, no-op), keeps v1 and the pieces, and a stale phone/PC save is a kept-draft conflict", async ({ browser, browserName }) => {
  test.setTimeout(240_000);
  expect(browserName).toBe("chromium");
  await expectEditSchema();
  const contexts: BrowserContext[] = [];
  let phoneBrowser: Browser | undefined;
  try {
    const context = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(context);
    const pc = await context.newPage();
    const account = await signIn(pc);
    const date = await createMemo(pc, account, "ci-only 공원 산책");
    const path = `/days/${date}`;
    await insertAiStory(account, date, V1);
    const moments = await momentsOf(account.userId);
    const rev = await currentRevision(account.userId, date);

    // 읽기: AI 글 + 수정 진입 1(동의 없음: 생성·재생성 0), 출처 표시는 아직 없다.
    await pc.goto(path);
    await expectBody(pc, V1, "read");
    await expect(editButton(pc)).toHaveCount(1);
    await expect(makeButton(pc)).toHaveCount(0);
    await expect(regenButton(pc), "no regenerate without consent").toHaveCount(0);
    await expect(story(pc)).not.toContainText(EDITED_SOURCE);
    await expect(content(pc), "no editor before opening it").toHaveCount(0);
    await capture(pc, "read");

    // 열기 → 전체 현재 본문이 든 '이야기 내용' textarea, 저장/취소. 취소는 아무것도 쓰지 않는다.
    await editButton(pc).click();
    await expect(content(pc)).toBeVisible();
    await expect(content(pc)).toHaveValue(V1);
    await expect(saveButton(pc)).toBeVisible();
    await expect(cancelButton(pc)).toBeVisible();
    await content(pc).fill(V1.replace("국수", "냉면"));
    await capture(pc, "edit");
    await cancelButton(pc).click();
    await expect(content(pc)).toHaveCount(0);
    await expectBody(pc, V1, "after cancel");
    expect((await storiesOf(account.userId)).length, "cancel writes nothing").toBe(1);

    // 부분 수정 저장(저장 중 중복 방지) → 새 user_edit version, 출처 표시, v1·조각 그대로.
    const tap = await tapActions(pc);
    const partial = V1.replace("국수", "냉면");
    await editButton(pc).click();
    await content(pc).fill(partial);
    const held = tap.next("hold");
    await saveButton(pc).click();
    await held.reached;
    await expect(saveButton(pc), "no double save while pending").toBeDisabled();
    held.release();
    await expect(content(pc)).toHaveCount(0);
    await expectBody(pc, partial, "saved");
    await expect(story(pc)).toContainText(EDITED_SOURCE);
    expect(tap.calls.length, "one save request").toBe(1);
    const saveCall = tap.calls[0]!;
    expect(await storiesOf(account.userId)).toEqual([
      { version: 1, origin: "ai", base: null, rev, body: V1 },
      { version: 2, origin: "user_edit", base: 1, rev, body: partial },
    ]);
    expect(await momentsOf(account.userId), "pieces untouched").toEqual(moments);
    await pc.reload();
    await expectBody(pc, partial, "reloaded");
    await expect(story(pc)).toContainText(EDITED_SOURCE);
    await expect(story(pc), "still current for the same pieces").not.toContainText(/조각이 바뀌었어요/);

    // 같은 내용 저장 → 새 버전 0, 닫힘.
    await editButton(pc).click();
    await content(pc).fill(`  ${partial}  `);
    await saveButton(pc).click();
    await expect(content(pc)).toHaveCount(0);
    expect((await storiesOf(account.userId)).length, "no-op save stores nothing").toBe(2);

    // HTML 모양 본문은 text로만 보인다.
    const html = `${partial}\n<b>굵게</b> <img src=x onerror="window.__podEditXss=1">`;
    await editButton(pc).click();
    await content(pc).fill(html);
    await saveButton(pc).click();
    await expect(content(pc)).toHaveCount(0);
    await expectBody(pc, html, "html text");
    await expect(story(pc).locator("b, img, script")).toHaveCount(0);
    expect(await pc.evaluate(() => (window as unknown as { __podEditXss?: number }).__podEditXss)).toBeUndefined();

    // 폰(WebKit)·PC 충돌: 둘 다 v3에서 열고 폰이 먼저 저장 → PC 저장은 고정 안내, 초안 유지, 자동 새로고침 0.
    const phone = await phoneContext();
    phoneBrowser = phone.browser;
    contexts.push(phone.context);
    expect(await signIn(phone.page, account.provider, account.subject)).toEqual(account);
    await pc.reload();
    await editButton(pc).click();
    const pcDraft = `${partial}\nci-only PC에서 덧붙임`;
    await content(pc).fill(pcDraft);
    await phone.page.goto(path);
    await editButton(phone.page).click();
    const phoneText = `${partial}\nci-only 폰에서 덧붙임`;
    await content(phone.page).fill(phoneText);
    await saveButton(phone.page).click();
    await expect(content(phone.page)).toHaveCount(0);
    await expectBody(phone.page, phoneText, "phone saved");
    await expectLayoutOk(phone.page, "phone after edit");
    await saveButton(pc).click();
    await expect(story(pc).getByRole("alert"), "fixed conflict notice").toBeVisible();
    await expect(story(pc).getByRole("alert")).not.toHaveText("");
    await expect(content(pc), "draft kept on conflict").toHaveValue(pcDraft);
    await capture(pc, "conflict");
    await expect(content(pc), "no automatic refresh or draft discard").toHaveValue(pcDraft);
    expect((await storiesOf(account.userId)).map((r) => [r.version, r.origin, r.base, r.body])).toEqual([
      [1, "ai", null, V1], [2, "user_edit", 1, partial], [3, "user_edit", 2, html], [4, "user_edit", 3, phoneText],
    ]);

    // 로그아웃 뒤 붙잡은 저장 요청을 다시 보내도 쓰기 0.
    const before = await storiesOf(account.userId);
    await pc.goto("/settings");
    await pc.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(pc).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    await expect(pc.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
    const replay = await replayAction(pc, saveCall, saveCall.body);
    expect(replay.status(), "replayed action answered").toBeLessThan(500);
    expect(await storiesOf(account.userId), "signed-out replay writes nothing").toEqual(before);
    await pc.goto(path);
    expect(new URL(pc.url()).pathname, "signed-out viewer is sent to login").toBe("/login");
    await expect(pc.getByRole("button", { name: EDIT })).toHaveCount(0);
    expect(await momentsOf(account.userId), "pieces untouched to the end").toEqual(moments);
    expect(sha((await storiesOf(account.userId))[0]!.body), "v1 bytes kept").toBe(sha(V1));
    expect(await usageCount(), "no AI request in an edit journey").toBe(0);
    await tap.dispose();
  } finally {
    try { await Promise.all(contexts.map((c) => c.close())); } finally { await phoneBrowser?.close(); }
  }
});

test("another account cannot see, edit or replay an edit of someone else's story", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  await expectEditSchema();
  const contexts: BrowserContext[] = [];
  try {
    const aContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(aContext);
    const pa = await aContext.newPage();
    const a = await signIn(pa);
    const date = await createMemo(pa, a, "ci-only A의 조각");
    await insertAiStory(a, date, V1);
    const tap = await tapActions(pa);
    await pa.goto(`/days/${date}`);
    await editButton(pa).click();
    await content(pa).fill(`${V1}\nci-only A 수정`);
    await saveButton(pa).click();
    await expect(content(pa)).toHaveCount(0);
    expect(tap.calls).toHaveLength(1);
    const aRows = await storiesOf(a.userId);
    expect(aRows).toHaveLength(2);

    const bContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(bContext);
    const pb = await bContext.newPage();
    const b = await signIn(pb);
    expect(b.userId).not.toBe(a.userId);
    await pb.goto(`/days/${date}`);
    await expect(pb.locator("body")).not.toContainText("ci-only A 수정");
    await expect(editButton(pb), "no story, no edit entry").toHaveCount(0);
    // B 세션으로 A가 보낸 저장 요청을 그대로 다시 보낸다 → A·B 모두 쓰기 0.
    const replay = await replayAction(pb, tap.calls[0]!, tap.calls[0]!.body.replace("ci-only A 수정", "ci-only B가 바꿈"));
    expect(replay.status()).toBeLessThan(500);
    expect(await storiesOf(a.userId)).toEqual(aRows);
    expect(await storiesOf(b.userId)).toEqual([]);
    // 다른 Origin이면 A 자신의 세션이어도 쓰기 0.
    for (const origin of ["https://evil.example", "null", undefined]) {
      await replayAction(pa, tap.calls[0]!, tap.calls[0]!.body.replace("ci-only A 수정", `ci-only origin ${String(origin)}`), origin);
    }
    expect(await storiesOf(a.userId), "no write without the same Origin").toEqual(aRows);
    await tap.dispose();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("a current story offers regeneration only after a confirmation that explains resending and history; confirming queues one base job, editing waits, and the result reloads as the latest", async ({ browser, browserName }) => {
  test.setTimeout(240_000);
  expect(browserName).toBe("chromium");
  await expectEditSchema();
  const contexts: BrowserContext[] = [];
  try {
    const context = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(context);
    const page = await context.newPage();
    const account = await signIn(page);
    const date = await createMemo(page, account, "ci-only 비 온 뒤 산책");
    const path = `/days/${date}`;
    await insertAiStory(account, date, V1);
    const rev = await currentRevision(account.userId, date);
    await saveConsent(page, account, true);

    // current + 조각 + 수동 가능 → '다시 만들기' 1, 일반 만들기 0. 누르기 전에는 요청 0.
    await page.goto(path);
    await expect(regenButton(page)).toHaveCount(1);
    await expect(makeButton(page), "no plain make button for a current story").toHaveCount(0);
    expect(await jobsOf(account.userId)).toEqual([]);

    // 확인 단계: 다시 보냄·이력 보존 설명, 'AI로 다시 만들기'/취소. 취소는 요청 0.
    await regenButton(page).click();
    await expect(regenConfirm(page)).toBeVisible();
    await expect(story(page)).toContainText(/다시 보내/);
    await expect(story(page)).toContainText(/이력/);
    await expect(cancelButton(page)).toBeVisible();
    await capture(page, "confirm");
    expect(await jobsOf(account.userId), "showing the confirmation sends nothing").toEqual([]);
    await cancelButton(page).click();
    await expect(regenConfirm(page)).toHaveCount(0);
    expect(await jobsOf(account.userId), "cancel sends nothing").toEqual([]);

    // 확인 → 실제 action이 base_version 1의 manual job 1건.
    await regenButton(page).click();
    await regenConfirm(page).click();
    await expect.poll(async () => (await jobsOf(account.userId)).length, { message: "the action enqueued exactly one job" }).toBe(1);
    const [job] = await jobsOf(account.userId);
    expect(job).toEqual({ id: job!.id, date, kind: "manual", state: "queued", base: 1 });
    await page.reload();
    await expect(story(page)).toContainText(MAKING);
    await expectBody(page, V1, "the current story stays while regenerating");
    if (await editButton(page).count()) await expect(editButton(page), "editing waits while a job is queued").toBeDisabled();
    await expect(regenButton(page), "no second regeneration while queued").toHaveCount(0);
    expect(await usageCount(), "no worker ran in E2E").toBe(0);

    // 종단 fixture → 새 AI 글이 최신, 출처는 AI(수정됨 표시 0), v1 보존, 다시 수정 가능.
    const regenerated = "ci-only 비 그친 뒤 오래 걸은 하루.";
    await finishRegeneration(account, job!, regenerated);
    await page.reload();
    await expectBody(page, regenerated, "regenerated");
    await expect(story(page)).not.toContainText(EDITED_SOURCE);
    await expect(editButton(page)).toBeEnabled();
    expect(await storiesOf(account.userId)).toEqual([
      { version: 1, origin: "ai", base: null, rev, body: V1 },
      { version: 2, origin: "ai", base: 1, rev, body: regenerated },
    ]);
    await editButton(page).click();
    await expect(content(page)).toHaveValue(regenerated);
    await content(page).fill(`${regenerated} ci-only 손봄`);
    await saveButton(page).click();
    await expect(content(page)).toHaveCount(0);
    expect((await storiesOf(account.userId)).map((r) => [r.version, r.origin, r.base])).toEqual([[1, "ai", null], [2, "ai", 1], [3, "user_edit", 2]]);
    await expect(story(page)).toContainText(EDITED_SOURCE);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
