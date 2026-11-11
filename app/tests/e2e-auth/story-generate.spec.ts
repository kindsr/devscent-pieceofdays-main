// PLAN_ai-story-live-generation §5·§6.1 RED(E2E). 기존 auth E2E harness(mock OIDC·일회용 PG18·next dev)만 쓴다.
// - global setup은 시험 전용 가짜 ANTHROPIC_API_KEY·POD_STORY_WORKER_TOKEN만 더한다(키 준비 상태). worker route·CLI·cron은 실행 0 → 외부 송신 0.
// - 메모·동의·생성 요청은 실제 화면과 Server Action으로 만든다. job의 종단 상태와 이야기 행만 관리자 fixture로 둔다(실제 API 경로 주장 0).
// - 날짜는 실제 메모 행의 localDate로 고정한다(서버 현재일 추측 없음).
// - 이 파일 전용 도우미만 둔다(공통 support·diary-support·issuer·global setup·config는 읽기만 재사용).
import { createHash } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type pg from "pg";
import { readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV, TEXT, WIDTHS, expectLayoutOk } from "./support";
import { DIARY_TEXT, addDays, momentsOf, signIn, statusWith, topAdd, type Account } from "./diary-support";

const STORY = "AI 하루 이야기";
const UNAVAILABLE = /AI 하루 이야기는 아직 준비 중이에요/;
const MAKE = "AI 이야기 만들기";
const MAKING = /만드는 중이에요/;
const PHOTO_FAILED = /사진을 읽지 못해 만들지 못했어요/;
const LIMITED = /오늘은 더 만들 수 없어요/;
const MANUAL = "직접 만들기 허용";
const AUTO = /^회고 시간\(현재 \d{2}:\d{2}\)에 자동으로 만들기$/;

const dialog = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => dialog(page).getByRole("textbox", { name: "메모" });
const piece = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const story = (page: Page) => page.getByRole("region", { name: STORY, exact: true });
const makeButton = (page: Page) => story(page).getByRole("button", { name: MAKE, exact: true });
const aiSettings = (page: Page) => page.locator("#story-ai");

// ---------------------------------------------------------------- 이 파일 전용 DB fixture(관리자, 일회용 DB)

function dbName(): string {
  const v = process.env[E2E_ENV.db];
  if (!v) throw new Error("[e2e-story-generate] POD_E2E_AUTH_DB is missing — run through playwright.auth.config.ts (globalSetup)");
  return v;
}
const admin = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => withAdmin(readDisposableEnv(), fn, dbName());

/** 0006 선행 조건(제품 GREEN 이전에는 여기서 명시 단언으로 멈춘다). */
async function expectGenerationSchema(): Promise<void> {
  const rows = await admin(async (c) => (await c.query<{ t: string; ok: boolean }>(
    "SELECT t, to_regclass('pod.' || t) IS NOT NULL AS ok FROM unnest(ARRAY['story_versions', 'story_ai_settings', 'story_jobs', 'story_usage']) AS t",
  )).rows);
  expect(rows, "0005/0006 tables must exist (PLAN_ai-story-live-generation §2)").toEqual([
    { t: "story_versions", ok: true }, { t: "story_ai_settings", ok: true }, { t: "story_jobs", ok: true }, { t: "story_usage", ok: true },
  ]);
}

type JobRow = { id: string; date: string; kind: string; state: string; rev: boolean; gen: string | null; cv: number | null; cr: string | null; error: string | null };
async function jobsOf(userId: string): Promise<JobRow[]> {
  return admin(async (c) => (await c.query<JobRow>(
    `SELECT id::text, local_date::text AS date, kind, state, source_revision IS NOT NULL AS rev, auth_generation::text AS gen,
            consent_version AS cv, consent_revision::text AS cr, error
       FROM pod.story_jobs WHERE user_id = $1::uuid ORDER BY created_at, id`, [userId])).rows);
}
async function settingsOf(userId: string): Promise<{ manual: boolean; auto: boolean; cr: string }[]> {
  return admin(async (c) => (await c.query<{ manual: boolean; auto: boolean; cr: string }>(
    "SELECT manual_enabled AS manual, auto_enabled AS auto, consent_revision::text AS cr FROM pod.story_ai_settings WHERE user_id = $1::uuid", [userId])).rows);
}
async function usageCount(): Promise<number> {
  return admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.story_usage")).rows[0]!.n);
}

function revisionV1(date: string, refs: { id: string; version: number }[]): string {
  const lines = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => `${r.id}:${r.version}\n`);
  return createHash("sha256").update(`v1\n${date}\n${lines.join("")}`, "utf8").digest("hex");
}

/** worker가 성공한 것과 같은 종단 상태: v1 revision 이야기 1행 + 그 job을 succeeded·story_id로(owner fixture). */
async function finishJobWithStory(account: Account, jobId: string, date: string, body: string): Promise<void> {
  const refs = (await momentsOf(account.userId)).filter((m) => m.localDate === date).map((m) => ({ id: m.id, version: m.version }));
  await admin(async (c) => {
    const version = (await c.query<{ v: number }>("SELECT COALESCE(max(version), 0)::int + 1 AS v FROM pod.story_versions WHERE user_id = $1::uuid AND local_date = $2::date", [account.userId, date])).rows[0]!.v;
    const story = await c.query<{ id: string }>(
      "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1::uuid, $2::date, $3, $4, $5) RETURNING id::text",
      [account.userId, date, version, revisionV1(date, refs), body]);
    const r = await c.query("UPDATE pod.story_jobs SET state = 'succeeded', story_id = $2::uuid, updated_at = now() WHERE id = $1::uuid AND state = 'queued'", [jobId, story.rows[0]!.id]);
    expect(r.rowCount, "the queued job was finished by the fixture").toBe(1);
  });
}
async function failJob(jobId: string, error: string): Promise<void> {
  await admin(async (c) => {
    const r = await c.query("UPDATE pod.story_jobs SET state = 'failed', error = $2, updated_at = now() WHERE id = $1::uuid AND state = 'queued'", [jobId, error]);
    expect(r.rowCount, "the queued job was failed by the fixture").toBe(1);
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

async function editMemo(page: Page, from: string, to: string): Promise<void> {
  await piece(page, from).getByRole("button", { name: /조각 수정$/ }).click();
  await expect(memo(page)).toHaveValue(from);
  await memo(page).fill(to);
  await dialog(page).getByRole("button", { name: "고치기", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.edited)).toBeVisible();
}

/** /settings의 AI 이야기 영역에서 두 동의를 정하고 저장한 뒤 DB에 반영됐는지 확인한다. */
async function saveConsent(page: Page, account: Account, manual: boolean, auto: boolean): Promise<void> {
  await page.goto("/settings");
  const section = aiSettings(page);
  await expect(section, "settings has the AI story section (id story-ai)").toBeVisible();
  await section.getByRole("checkbox", { name: MANUAL, exact: true }).setChecked(manual);
  await section.getByRole("checkbox", { name: AUTO }).setChecked(auto);
  const before = (await settingsOf(account.userId))[0]?.cr ?? "0";
  await section.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(async () => settingsOf(account.userId), { message: "consent saved by the real action" })
    .toEqual([{ manual, auto, cr: String(Number(before) + 1) }]);
}

async function capture(page: Page, state: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectLayoutOk(page, `${state} ${width}px`);
    await page.screenshot({ path: test.info().outputPath(`story-generate-${state}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

// ---------------------------------------------------------------- 사례

test("explicit manual consent enables one real queued job from the date screen; fixture-finished results reload as a story or a fixed failure", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  await expectGenerationSchema();
  const contexts: BrowserContext[] = [];
  try {
    const context = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(context);
    const page = await context.newPage();
    const account = await signIn(page);
    const first = "ci-only 공원에서 산책했다";
    const date = await createMemo(page, account, first);
    const path = `/days/${date}`;

    // 미동의: 기존 준비 중 문구 + 버튼 0 + AI 설정 링크 1(기존 정확 /settings 링크 1은 그대로).
    await page.goto(path);
    await expect(story(page)).toContainText(UNAVAILABLE);
    await expect(story(page).getByRole("button"), "no generate button without consent").toHaveCount(0);
    await expect(story(page).getByRole("link", { name: "AI 이야기 설정", exact: true })).toHaveAttribute("href", "/settings#story-ai");
    await expect(story(page).locator('a[href="/settings"]'), "the existing reflection-time settings link stays single").toHaveCount(1);

    // 설정: 고지 확인, 둘 다 기본 꺼짐, 직접 만들기만 명시 동의.
    await page.goto("/settings");
    const section = aiSettings(page);
    await expect(section).toContainText("Anthropic");
    await expect(section).toContainText(/512px/);
    await expect(section).toContainText(/회수/);
    await expect(section.getByRole("checkbox", { name: MANUAL, exact: true })).not.toBeChecked();
    await expect(section.getByRole("checkbox", { name: AUTO })).not.toBeChecked();
    await expect(section.getByRole("checkbox", { name: AUTO }), "shows the account's reflection time").toHaveAccessibleName("회고 시간(현재 20:00)에 자동으로 만들기");
    await capture(page, "settings");
    await saveConsent(page, account, true, false);

    // 준비됨 → 버튼 → 실제 Server Action이 queued job 1건.
    await page.goto(path);
    await expect(makeButton(page)).toHaveCount(1);
    await capture(page, "ready");
    await makeButton(page).click();
    await expect.poll(async () => (await jobsOf(account.userId)).length, { message: "the action enqueued exactly one job" }).toBe(1);
    const [job] = await jobsOf(account.userId);
    expect(job).toEqual({ id: job!.id, date, kind: "manual", state: "queued", rev: true, gen: "1", cv: 1, cr: "1", error: null });
    await page.reload();
    await expect(story(page)).toContainText(MAKING);
    await expect(makeButton(page), "no second button while a job is queued").toHaveCount(0);
    await capture(page, "queued");
    expect(await usageCount(), "no worker ran in E2E: no usage row").toBe(0);

    // 종단 fixture(성공) → reload에서 이야기, 버튼 0(현재 이야기).
    const body = "ci-only 공원 산책으로 기억되는 하루.";
    await finishJobWithStory(account, job!.id, date, body);
    await page.reload();
    await expect(story(page)).toContainText(body);
    await expect(makeButton(page), "no button for a current story").toHaveCount(0);

    // 메모 수정 → outdated + 준비됨 → 버튼 → 두 번째 job → 사진 실패 fixture → 고정 문구.
    await editMemo(page, first, "ci-only 공원에서 오래 산책했다");
    await page.reload();
    await expect(makeButton(page), "an outdated story can be remade").toHaveCount(1);
    await makeButton(page).click();
    await expect.poll(async () => (await jobsOf(account.userId)).length).toBe(2);
    const second = (await jobsOf(account.userId))[1]!;
    expect(second).toMatchObject({ kind: "manual", state: "queued", rev: true, cr: "1" });
    await failJob(second.id, "photo_unavailable");
    await page.reload();
    await expect(story(page)).toContainText(PHOTO_FAILED);
    await expect(story(page), "the earlier story body stays visible").toContainText(body);
    await capture(page, "failed");

    // 동의 철회 → 버튼 0, 준비 중 문구.
    await saveConsent(page, account, false, false);
    await page.goto(path);
    await expect(makeButton(page)).toHaveCount(0);
    await expect(story(page).getByRole("button")).toHaveCount(0);
    expect((await jobsOf(account.userId)).length, "withdrawal creates no job").toBe(2);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("three manual requests on one Seoul day limit the account; other accounts and signed-out viewers get no button, job or story", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  await expectGenerationSchema();
  const contexts: BrowserContext[] = [];
  try {
    const aContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(aContext);
    const pa = await aContext.newPage();
    const a = await signIn(pa);
    const date = await createMemo(pa, a, "ci-only 한도 시험 메모");
    const path = `/days/${date}`;
    await saveConsent(pa, a, true, false);
    // 같은 서울 요청일에 이미 수동 3회(다른 날짜 대상, 모두 실패)가 있는 계정(관리자 fixture, 오늘 created_at).
    const gen = (await admin(async (c) => (await c.query<{ g: string }>("SELECT auth_generation::text AS g FROM pod.users WHERE id = $1::uuid", [a.userId])).rows[0]!.g));
    for (let i = 1; i <= 3; i++) {
      await admin((c) => c.query(
        "INSERT INTO pod.story_jobs (user_id, local_date, kind, state, source_revision, auth_generation, consent_version, consent_revision, error) VALUES ($1::uuid, $2::date, 'manual', 'failed', $3, $4::bigint, 1, 1, 'unavailable')",
        [a.userId, addDays(date, -i), createHash("sha256").update(`ci-only-limit-${i}`).digest("hex"), gen]));
    }
    await pa.goto(path);
    await expect(story(pa)).toContainText(LIMITED);
    await expect(makeButton(pa), "no button after three manual requests today").toHaveCount(0);
    expect((await jobsOf(a.userId)).filter((j) => j.date === date), "no job for the limited day").toEqual([]);

    const bContext = await browser.newContext({ baseURL: AUTH_BASE });
    contexts.push(bContext);
    const pb = await bContext.newPage();
    const b = await signIn(pb);
    expect(b.userId).not.toBe(a.userId);
    await pb.goto(path);
    await expect(makeButton(pb), "another account without input or consent has no button").toHaveCount(0);
    await expect(pb.locator("body")).not.toContainText("ci-only 한도 시험 메모");
    expect(await jobsOf(b.userId)).toEqual([]);
    expect(await settingsOf(b.userId), "another account's consent is untouched").toEqual([]);

    await pa.goto("/settings");
    await pa.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(pa).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    await expect(pa.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
    await pa.goto(path);
    expect(new URL(pa.url()).pathname, "signed-out viewer is sent to login").toBe("/login");
    await expect(pa.getByRole("button", { name: MAKE })).toHaveCount(0);
    expect(await usageCount()).toBe(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
