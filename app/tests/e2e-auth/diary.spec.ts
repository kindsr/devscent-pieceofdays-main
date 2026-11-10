// F5 S3b RED — 실제 계정 기록 화면(PLAN_dev-diary-actions §4). auth E2E harness 그대로:
// next dev(127.0.0.1:3300) + 실제 mock OIDC 로그인 + 실제 B2·S3a·F3 + 일회용 PG18(globalSetup).
// - 계정·세션은 실제 로그인으로만 만든다. 기록은 실제 화면과 실제 Server Action으로만 만든다.
// - DB 직접 쓰기는 diary-support의 날짜 fixture(과거 날로 옮김)와 SELECT 권한 잠시 회수(finally 복원)뿐이다.
// - Server Action은 fetch라 보류 중에도 화면을 볼 수 있다. 보류·중단은 page.route로 실제 요청에 건다(Next 내부 ID를 적지 않는다).
import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import { AUTH_BASE, TEXT, WIDTHS, expectLayoutOk } from "./support";
import {
  DIARY_TEXT,
  FIXTURE_TEXT,
  addDays,
  collectBodies,
  dateLabel,
  escapeRe,
  fontOf,
  momentsOf,
  moveMomentToPreviousDay,
  replayAction,
  seoulDate,
  serverSeoulToday,
  signIn,
  statusWith,
  summariesOf,
  tapActions,
  topAdd,
  withRevokedSelect,
  type Account,
  type ActionTap,
} from "./diary-support";

// ---------------------------------------------------------------- 화면 조작(공개 문구·역할만 쓴다)

const composer = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => composer(page).getByRole("textbox", { name: "메모" });
const item = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const boardHeading = (page: Page, date: string) => page.getByRole("heading", { level: 1, name: new RegExp(escapeRe(dateLabel(date))) });

async function openComposer(page: Page): Promise<void> {
  await topAdd(page).click();
  await expect(composer(page)).toBeVisible();
  await expect(memo(page)).toBeVisible();
}

/** 오늘 화면에서 조각 하나를 실제 화면으로 저장하고 목록에 보일 때까지 기다린다. */
async function createPiece(page: Page, tap: ActionTap, text: string): Promise<void> {
  const before = tap.calls.length;
  await openComposer(page);
  await memo(page).fill(text);
  await composer(page).getByRole("button", { name: "저장" }).click();
  await expect(composer(page)).toHaveCount(0);
  await expect(item(page, text)).toHaveCount(1);
  expect(tap.calls.length, `one action POST for "${text}"`).toBe(before + 1);
}

/** 같은 계정으로 새 browser context에서 다시 실제 로그인한다. */
async function sameAccountContext(browser: Browser, a: Account): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const again = await signIn(page, a.provider, a.subject);
  expect(again.userId, "same account").toBe(a.userId);
  return { page, close: () => context.close() };
}

// ================================================================= 첫 화면

test("first real login lands on an empty account board for the Seoul today: memo-only composer without sample images or a client time, write entry in the top bar", async ({ page }) => {
  const a = await signIn(page);
  const today = await serverSeoulToday();
  await expect(boardHeading(page, today)).toBeVisible();
  await expect(page.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: TEXT.signedIn })).toHaveCount(0);
  for (const t of FIXTURE_TEXT) await expect(page.getByText(t)).toHaveCount(0);
  await expect(page.locator("main img")).toHaveCount(0);

  // 키보드로 상단 진입점을 열면 메모 칸에 초점이 간다. 예시 이미지 선택·업로드·client 시각이 없다.
  await page.clock.setFixedTime(new Date("2031-03-04T00:13:00Z")); // 브라우저만 09:13(서울)
  await page.reload();
  await topAdd(page).focus();
  await page.keyboard.press("Enter");
  await expect(memo(page)).toBeFocused();
  await expect(composer(page).getByRole("radio")).toHaveCount(0);
  await expect(composer(page).getByLabel("사진 1장", { exact: true })).toHaveCount(1);
  await expect(composer(page).getByLabel("사진 1장", { exact: true })).toBeEnabled();
  await expect(composer(page).locator("img")).toHaveCount(0);
  await expect(composer(page).getByText(/예시 이미지/)).toHaveCount(0);
  await expect(composer(page), "no client-clock time in the add dialog").not.toContainText("09:13");
  await expect(memo(page), "no UTF-16 maxlength on the account memo").not.toHaveAttribute("maxlength", /.*/);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `empty board + composer ${w}`);
  }
  await page.keyboard.press("Escape");
  await expect(composer(page)).toHaveCount(0);
  expect(await momentsOf(a.userId)).toEqual([]);
});

// ================================================================= 작성·보류·유지

test("create: trimmed 1..300 code points; one held action shows 저장 중… and blocks duplicates, input and closing; the canonical piece appears only after commit and survives reload and a second context", async ({ page, browser }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  await openComposer(page);

  await memo(page).fill("   \n\t ");
  await composer(page).getByRole("button", { name: "저장" }).click();
  await expect(composer(page).getByText(DIARY_TEXT.blank, { exact: true })).toBeVisible();
  const emoji301 = "😀".repeat(301);
  await memo(page).fill(emoji301);
  await expect(memo(page), "not truncated by UTF-16 length").toHaveValue(emoji301);
  await composer(page).getByRole("button", { name: "저장" }).click();
  await expect(composer(page).getByText(DIARY_TEXT.tooLong, { exact: true })).toBeVisible();
  expect(await momentsOf(a.userId), "rejected bodies write nothing").toEqual([]);

  const emoji300 = "😀".repeat(300);
  await memo(page).fill(`  ${emoji300}  `);
  const held = tap.next("hold");
  const calls = tap.calls.length;
  await composer(page).getByRole("button", { name: "저장" }).click();
  await held.reached;
  await expect(statusWith(page, DIARY_TEXT.saving)).toBeVisible();
  await expect(memo(page), "input blocked while pending").not.toBeEditable();
  await composer(page).getByRole("button", { name: "저장" }).dispatchEvent("click");
  await page.keyboard.press("Escape");
  await composer(page).getByRole("button", { name: "닫기" }).dispatchEvent("click");
  await expect(composer(page), "Esc/닫기 cannot hide a pending save").toBeVisible();
  await expect(page.getByText(DIARY_TEXT.created, { exact: true })).toHaveCount(0);
  expect(await momentsOf(a.userId), "nothing written while the request is held").toEqual([]);
  expect(tap.calls.length, "duplicate submit refused").toBe(calls + 1);

  held.release();
  await expect(page.getByText(DIARY_TEXT.created, { exact: true })).toBeAttached();
  await expect(composer(page)).toHaveCount(0);
  const rows = await momentsOf(a.userId);
  expect(rows.map((r) => [r.body, r.version, r.localDate]), "trimmed, server date").toEqual([[emoji300, 1, await serverSeoulToday()]]);
  await expect(item(page, emoji300)).toContainText(rows[0]!.time);
  expect(tap.calls.length, "no retry").toBe(calls + 1);

  await page.reload();
  await expect(item(page, emoji300)).toHaveCount(1);
  const second = await sameAccountContext(browser, a);
  try {
    await expect(item(second.page, emoji300)).toContainText(rows[0]!.time);
  } finally {
    await second.close();
  }
});

// ================================================================= 수정·삭제·과거 날

test("edit keeps the server time and order (today and a past day via a date fixture); delete asks in the D dialog — 취소/Esc write nothing, 지우기 removes it and focuses the board heading", async ({ page }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  await createPiece(page, tap, "첫 번째 조각");
  await createPiece(page, tap, "두 번째 조각");
  const [p1, p2] = await momentsOf(a.userId);
  const order = async () => (await page.getByRole("listitem").filter({ hasText: /번째 조각/ }).allTextContents()).map((t) => (t.includes("첫") ? 1 : 2));
  expect(await order()).toEqual([1, 2]);

  await item(page, "첫 번째 조각").getByRole("button", { name: /조각 수정$/ }).click();
  await expect(composer(page), "edit shows the stored server time").toContainText(p1!.time);
  await expect(memo(page)).toHaveValue("첫 번째 조각");
  await memo(page).fill("첫 번째 조각 고침");
  await composer(page).getByRole("button", { name: "고치기" }).click();
  await expect(page.getByText(DIARY_TEXT.edited, { exact: true })).toBeAttached();
  await expect(item(page, "첫 번째 조각 고침")).toContainText(p1!.time);
  expect(await order()).toEqual([1, 2]);
  const afterEdit = await momentsOf(a.userId);
  expect(afterEdit.map((r) => [r.id, r.body, r.version, r.occurredAt])).toEqual([
    [p1!.id, "첫 번째 조각 고침", 2, p1!.occurredAt],
    [p2!.id, "두 번째 조각", 1, p2!.occurredAt],
  ]);

  const callsBefore = tap.calls.length;
  const openDelete = async () => {
    await item(page, "두 번째 조각").getByRole("button", { name: /조각 삭제/ }).click();
    const dlg = page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(DIARY_TEXT.deleteBody, { exact: true })).toBeVisible();
    return dlg;
  };
  await (await openDelete()).getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle })).toHaveCount(0);
  await openDelete();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle })).toHaveCount(0);
  expect(tap.calls.length, "취소·Esc send nothing").toBe(callsBefore);
  expect(await momentsOf(a.userId)).toHaveLength(2);

  const dlg = await openDelete();
  const held = tap.next("hold");
  await dlg.getByRole("button", { name: "지우기" }).click();
  await held.reached;
  await expect(statusWith(page, DIARY_TEXT.saving)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg, "a pending delete cannot be dismissed").toBeVisible();
  expect(await momentsOf(a.userId), "not deleted while held").toHaveLength(2);
  held.release();
  await expect(page.getByText(DIARY_TEXT.deleted, { exact: true })).toBeAttached();
  await expect(item(page, "두 번째 조각")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 }), "focus returns to the board heading").toBeFocused();
  expect((await momentsOf(a.userId)).map((r) => r.id)).toEqual([p1!.id]);
  expect(tap.calls.length, "one delete POST").toBe(callsBefore + 1);

  // 과거 날: 날짜 fixture로 하루 전으로 옮긴 조각을 그 날 화면에서 고친다.
  await moveMomentToPreviousDay(p1!.id);
  const yesterday = addDays(await serverSeoulToday(), -1);
  await page.goto(`/days/${yesterday}`);
  await item(page, "첫 번째 조각 고침").getByRole("button", { name: /조각 수정$/ }).click();
  await memo(page).fill("어제로 옮긴 조각 고침");
  await composer(page).getByRole("button", { name: "고치기" }).click();
  await expect(item(page, "어제로 옮긴 조각 고침")).toContainText(p1!.time);
  const past = await momentsOf(a.userId);
  expect(past.map((r) => [r.body, r.version, r.localDate, r.time])).toEqual([["어제로 옮긴 조각 고침", 3, yesterday, p1!.time]]);
});

// ================================================================= 하루 한 줄·달력

test("one-line summary: writable with 0 pieces, empty text deletes, a past day with pieces can create one; the calendar links summary-only days as `<date> 하루 한 줄` and keeps the pieces label", async ({ page }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  const today = await serverSeoulToday();
  const yesterday = addDays(today, -1);

  await expect(page.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "한 줄 쓰기" }).click();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await page.getByRole("textbox").fill("조각 없는 날의 한 줄");
  const held = tap.next("hold");
  await page.getByRole("button", { name: "저장" }).click();
  await held.reached;
  await expect(statusWith(page, DIARY_TEXT.saving)).toBeVisible();
  await expect(page.getByRole("textbox")).not.toBeEditable();
  expect(await summariesOf(a.userId), "nothing written while held").toEqual([]);
  held.release();
  await expect(page.getByText(DIARY_TEXT.summarySaved, { exact: true })).toBeAttached();
  expect(await summariesOf(a.userId)).toEqual([{ localDate: today, body: "조각 없는 날의 한 줄", version: 1 }]);

  await page.getByRole("button", { name: "고쳐 쓰기" }).click();
  await page.getByRole("textbox").fill("");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(DIARY_TEXT.summaryDeleted, { exact: true })).toBeAttached();
  expect(await summariesOf(a.userId), "empty text deletes").toEqual([]);
  await page.getByRole("button", { name: "한 줄 쓰기" }).click();
  await page.getByRole("textbox").fill("다시 쓴 한 줄");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("다시 쓴 한 줄", { exact: true })).toBeVisible();

  // 코드포인트 경계: 301 emoji는 잘리지 않고 거부되며 저장된 한 줄은 그대로, 300 emoji는 저장된다.
  await page.getByRole("button", { name: "고쳐 쓰기" }).click();
  const emoji301 = "😀".repeat(301);
  await page.getByRole("textbox").fill(emoji301);
  await expect(page.getByRole("textbox"), "not truncated by UTF-16 length").toHaveValue(emoji301);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(DIARY_TEXT.tooLong, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox"), "rejected text stays for editing").toHaveValue(emoji301);
  expect(await summariesOf(a.userId), "301 code points write nothing").toEqual([{ localDate: today, body: "다시 쓴 한 줄", version: 1 }]);
  const emoji300 = "😀".repeat(300);
  await page.getByRole("textbox").fill(emoji300);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(statusWith(page, DIARY_TEXT.summarySaved)).toBeVisible();
  await expect(page.getByRole("textbox"), "the saved summary form is closed").toHaveCount(0);
  await expect(page.getByText(emoji300, { exact: true })).toBeVisible();
  expect(await summariesOf(a.userId), "300 code points saved").toEqual([{ localDate: today, body: emoji300, version: 2 }]);

  // 자료가 없는 과거 날에는 그날 한 줄을 새로 쓰는 진입점이 없다(상단 오늘 조각 추가는 그대로).
  await page.goto(`/days/${addDays(today, -2)}`);
  await expect(page.getByRole("heading", { level: 1, name: "모아보기", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "한 줄 쓰기" }), "no summary entry for an empty past day").toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(topAdd(page), "global add for today stays").toBeVisible();
  await page.goto("/");

  await createPiece(page, tap, "어제가 될 조각");
  await moveMomentToPreviousDay((await momentsOf(a.userId))[0]!.id);
  await page.goto("/days");
  await expect(page.getByRole("link", { name: `${dateLabel(today)} 하루 한 줄`, exact: true }), "summary-only day").toBeVisible();
  await expect(page.getByRole("link", { name: `${dateLabel(yesterday)}, 조각 1개`, exact: true }), "pieces label unchanged").toBeVisible();

  await page.getByRole("link", { name: `${dateLabel(today)} 하루 한 줄`, exact: true }).click();
  await expect(page).toHaveURL(`${AUTH_BASE}/days/${today}`);
  await expect(page.getByText(emoji300, { exact: true })).toBeVisible();

  await page.goto(`/days/${yesterday}`);
  await page.getByRole("button", { name: "한 줄 쓰기" }).click();
  await page.getByRole("textbox").fill("어제의 한 줄");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(DIARY_TEXT.summarySaved, { exact: true })).toBeAttached();
  expect(await summariesOf(a.userId)).toEqual([
    { localDate: yesterday, body: "어제의 한 줄", version: 1 },
    { localDate: today, body: emoji300, version: 2 },
  ]);
  await page.goto("/days");
  await expect(page.getByRole("link", { name: `${dateLabel(yesterday)}, 조각 1개`, exact: true })).toBeVisible();
});

// ================================================================= 충돌·삭제된 대상

test("conflict between two contexts of the same account: a stale save keeps the draft, only an explicit 다시 불러오기 shows 서버의 최신 글 and lets the draft be saved; a deleted target cannot be resubmitted but the draft stays", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const a = await signIn(page);
  const tapA = await tapActions(page);
  await createPiece(page, tapA, "처음 글");
  const b = await sameAccountContext(browser, a);
  try {
    const tapB = await tapActions(b.page);
    await page.reload();
    await item(page, "처음 글").getByRole("button", { name: /조각 수정$/ }).click();
    await memo(page).fill("A의 초안");

    await item(b.page, "처음 글").getByRole("button", { name: /조각 수정$/ }).click();
    await memo(b.page).fill("B가 먼저 고침");
    await composer(b.page).getByRole("button", { name: "고치기" }).click();
    await expect(b.page.getByText(DIARY_TEXT.edited, { exact: true })).toBeAttached();

    const callsA = tapA.calls.length;
    await composer(page).getByRole("button", { name: "고치기" }).click();
    await expect(page.getByText(DIARY_TEXT.conflict, { exact: true })).toBeVisible();
    await expect(memo(page), "draft kept after conflict").toHaveValue("A의 초안");
    expect((await momentsOf(a.userId)).map((r) => [r.body, r.version])).toEqual([["B가 먼저 고침", 2]]);
    await page.getByRole("button", { name: DIARY_TEXT.reload }).click();
    await expect(composer(page).getByText(DIARY_TEXT.serverLatest)).toBeVisible();
    await expect(composer(page)).toContainText("B가 먼저 고침");
    await expect(memo(page), "draft kept after reload").toHaveValue("A의 초안");
    expect(tapA.calls.length, "다시 불러오기 only reads").toBe(callsA + 1);
    await composer(page).getByRole("button", { name: "고치기" }).click();
    await expect(page.getByText(DIARY_TEXT.edited, { exact: true })).toBeAttached();
    expect((await momentsOf(a.userId)).map((r) => [r.body, r.version])).toEqual([["A의 초안", 3]]);

    // 삭제된 대상: B가 지운 뒤 A의 오래된 화면에서 고치기
    await b.page.reload();
    await item(b.page, "A의 초안").getByRole("button", { name: /조각 삭제/ }).click();
    await b.page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle }).getByRole("button", { name: "지우기" }).click();
    await expect(b.page.getByText(DIARY_TEXT.deleted, { exact: true })).toBeAttached();
    expect(await momentsOf(a.userId)).toEqual([]);
    expect(tapB.calls.length, "B: one edit + one delete").toBe(2);

    await item(page, "A의 초안").getByRole("button", { name: /조각 수정$/ }).click();
    await memo(page).fill("지운 뒤의 초안");
    await composer(page).getByRole("button", { name: "고치기" }).click();
    await expect(page.getByText(DIARY_TEXT.notFound, { exact: true })).toBeVisible();
    await expect(memo(page)).toHaveValue("지운 뒤의 초안");
    const callsDeleted = tapA.calls.length;
    await page.getByRole("button", { name: DIARY_TEXT.reload }).click();
    await expect(memo(page), "the draft stays copyable").toHaveValue("지운 뒤의 초안");
    const resubmit = composer(page).getByRole("button", { name: "고치기" });
    expect((await resubmit.count()) === 0 || (await resubmit.isDisabled()), "no resubmit for a deleted target").toBe(true);
    expect(tapA.calls.length).toBe(callsDeleted);
    expect(await momentsOf(a.userId), "nothing recreated").toEqual([]);
  } finally {
    await b.close();
  }
});

test("a deleted summary stays blocked after the first and second explicit reload: the draft stays copyable and no action recreates the row", async ({ page, browser }) => {
  const a = await signIn(page);
  const today = await serverSeoulToday();
  await page.getByRole("button", { name: "한 줄 쓰기" }).click();
  await page.getByRole("textbox", { name: "하루 한 줄" }).fill("삭제 전 한 줄");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "고쳐 쓰기" })).toBeVisible();
  expect(await summariesOf(a.userId)).toEqual([{ localDate: today, body: "삭제 전 한 줄", version: 1 }]);

  const b = await sameAccountContext(browser, a);
  const tap = await tapActions(page);
  try {
    await page.getByRole("button", { name: "고쳐 쓰기" }).click();
    const draft = "삭제 뒤에도 복사할 내 초안";
    const field = page.getByRole("textbox", { name: "하루 한 줄" });
    const save = page.getByRole("button", { name: "저장", exact: true });
    await field.fill(draft);

    await b.page.getByRole("button", { name: "고쳐 쓰기" }).click();
    await b.page.getByRole("textbox", { name: "하루 한 줄" }).fill("");
    await b.page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(statusWith(b.page, DIARY_TEXT.summaryDeleted)).toBeVisible();
    expect(await summariesOf(a.userId), "the other context deleted the summary").toEqual([]);

    await save.click();
    await expect(page.getByText(DIARY_TEXT.notFound, { exact: true })).toBeVisible();
    expect(tap.calls.length, "one refused stale save").toBe(1);

    for (const attempt of ["first", "second"]) {
      const reload = page.getByRole("button", { name: DIARY_TEXT.reload, exact: true });
      await reload.click();
      // 비활성인 pending 상태를 통과로 세지 않는다. 명시 재조회가 끝난 뒤의 상태를 확인한다.
      await expect(reload, `${attempt} explicit reload finished`).toBeEnabled();
      await expect(field, `${attempt} explicit reload keeps the copyable draft`).toHaveValue(draft);
      expect(await summariesOf(a.userId), `${attempt} explicit reload does not recreate the deleted summary`).toEqual([]);
      expect(tap.calls.length, `${attempt} explicit reload only reads`).toBe(1);
      await expect(save, `${attempt} explicit reload must keep a deleted summary's save disabled`).toBeDisabled();
    }

    await save.dispatchEvent("click");
    expect(tap.calls.length, "a disabled resubmit sends no action").toBe(1);
    expect(await summariesOf(a.userId), "the deleted summary is never recreated").toEqual([]);
    await expect(field).toHaveValue(draft);
  } finally {
    await tap.dispose();
    await b.close();
  }
});

// ================================================================= 통신 실패

test("transport: aborted before the server → 0 rows; response lost after commit → exactly 1 row; both show the unavailable text, keep the draft, never retry, and 다시 불러오기 only reads", async ({ page }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);

  const lost = tap.next("abort-before");
  await openComposer(page);
  await memo(page).fill("보내지 못한 조각");
  await composer(page).getByRole("button", { name: "저장" }).click();
  await lost.reached;
  await expect(page.getByText(DIARY_TEXT.unavailable, { exact: true })).toBeVisible();
  await expect(memo(page)).toHaveValue("보내지 못한 조각");
  await page.waitForTimeout(1500); // 자동 재시도가 없는지 지켜본다(상한 있는 대기)
  expect(tap.calls.length, "no automatic retry").toBe(1);
  expect(await momentsOf(a.userId), "server never saw the request").toEqual([]);
  await page.getByRole("button", { name: DIARY_TEXT.reload }).click();
  await expect(composer(page).getByRole("button", { name: "닫기", exact: true }), "read-only refresh finished before Esc").toBeEnabled();
  await expect(memo(page)).toHaveValue("보내지 못한 조각");
  expect(tap.calls.length, "reload sends no action").toBe(1);
  await page.keyboard.press("Escape");
  await expect(composer(page), "Esc closes the composer after read-only refresh").toHaveCount(0);

  await page.reload();
  const cut = tap.next("lose-response");
  await openComposer(page);
  await memo(page).fill("응답만 끊긴 조각");
  await composer(page).getByRole("button", { name: "저장" }).click();
  await cut.reached;
  await expect(page.getByText(DIARY_TEXT.unavailable, { exact: true })).toBeVisible();
  await expect(memo(page)).toHaveValue("응답만 끊긴 조각");
  await expect(page.getByText(DIARY_TEXT.created, { exact: true }), "no success claimed").toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(tap.calls.length, "no automatic retry").toBe(2);
  expect((await momentsOf(a.userId)).map((r) => r.body), "committed exactly once").toEqual(["응답만 끊긴 조각"]);
  await page.getByRole("button", { name: DIARY_TEXT.reload }).click();
  await expect(item(page, "응답만 끊긴 조각")).toHaveCount(1);
  await expect(memo(page), "draft kept for the user to decide").toHaveValue("응답만 끊긴 조각");
  expect(tap.calls.length).toBe(2);
});

// ================================================================= 쓰는 중 세션 만료

test("session lost while composing: the save is refused as not signed in with a login link, the draft stays and nothing is written", async ({ page }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  await openComposer(page);
  await memo(page).fill("세션이 끊긴 뒤의 초안");
  await page.context().clearCookies(); // 브라우저 세션 쿠키만 지운다(제품·DB는 그대로)
  await composer(page).getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(DIARY_TEXT.notSignedIn, { exact: true })).toBeVisible();
  const loginLink = page.getByRole("link", { name: /로그인/ });
  await expect(loginLink.first()).toBeVisible();
  expect(await loginLink.first().getAttribute("href"), "link to the login page").toMatch(/^\/login(\?|$)/);
  await expect(memo(page), "draft kept").toHaveValue("세션이 끊긴 뒤의 초안");
  await expect(page.getByText(DIARY_TEXT.created, { exact: true })).toHaveCount(0);
  expect(tap.calls.length, "one refused action, no retry").toBe(1);
  expect(await momentsOf(a.userId), "nothing written").toEqual([]);
});

// ================================================================= 계정 분리·Origin

test("accounts are isolated: B never sees A's records, A's id replayed through B's captured action is refused, extra userId arguments are ignored, and a foreign/\"null\"/missing Origin on a captured action writes nothing", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const a = await signIn(page);
  const tapA = await tapActions(page);
  await createPiece(page, tapA, "A만의 조각");
  await page.getByRole("button", { name: "한 줄 쓰기" }).click();
  await page.getByRole("textbox").fill("A만의 한 줄");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(DIARY_TEXT.summarySaved, { exact: true })).toBeAttached();
  const [aPiece] = await momentsOf(a.userId);
  const today = await serverSeoulToday();

  const ctxB = await browser.newContext();
  try {
    const pb = await ctxB.newPage();
    const b = await signIn(pb, "kakao");
    await expect(pb.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
    for (const path of ["/", "/days", `/days/${today}`]) {
      await pb.goto(path);
      await expect(pb.getByText("A만의 조각")).toHaveCount(0);
      await expect(pb.getByText("A만의 한 줄")).toHaveCount(0);
    }
    await pb.goto("/days");
    await expect(pb.getByRole("link", { name: new RegExp(`^${escapeRe(dateLabel(today))}`) }), "no calendar link from A's day").toHaveCount(0);

    await pb.goto("/");
    const tapB = await tapActions(pb);
    await createPiece(pb, tapB, "B의 조각");
    const createCall = tapB.calls[0]!;
    const [bPiece] = await momentsOf(b.userId);
    await item(pb, "B의 조각").getByRole("button", { name: /조각 수정$/ }).click();
    await memo(pb).fill("B의 조각 고침");
    await composer(pb).getByRole("button", { name: "고치기" }).click();
    await expect(item(pb, "B의 조각 고침")).toHaveCount(1);
    const updateCall = tapB.calls[1]!;
    expect(updateCall.body, "the captured update carries B's piece id").toContain(bPiece!.id);

    // B 세션으로 A의 id를 넣어 보낸다 → A는 그대로
    const tampered = await replayAction(pb, updateCall, updateCall.body.split(bPiece!.id).join(aPiece!.id).replace("B의 조각 고침", "B가 A를 바꿈"));
    expect(tampered.status(), "replayed action answered").toBeLessThan(500);
    expect((await momentsOf(a.userId)).map((r) => [r.id, r.body, r.version])).toEqual([[aPiece!.id, "A만의 조각", 1]]);

    // 여분 인자로 A의 userId를 붙여도 B의 조각이 된다
    const args = JSON.parse(createCall.body) as unknown[];
    expect(Array.isArray(args), "captured create body is the action argument list").toBe(true);
    const extra = await replayAction(pb, createCall, JSON.stringify(["여분 인자 조각", a.userId, { userId: a.userId }]));
    expect(extra.status()).toBeLessThan(500);
    expect((await momentsOf(a.userId)).map((r) => r.body), "A unchanged").toEqual(["A만의 조각"]);
    expect((await momentsOf(b.userId)).map((r) => r.body).sort()).toEqual(["B의 조각 고침", "여분 인자 조각"].sort());

    // Origin이 다르거나 "null"이거나 없으면 쓰기 0(프레임워크가 먼저 막아도 된다)
    const before = await momentsOf(b.userId);
    for (const origin of ["https://evil.example", "null", undefined]) {
      await replayAction(pb, createCall, JSON.stringify([`origin ${String(origin)}`]), origin);
    }
    expect(await momentsOf(b.userId), "no write without the same Origin").toEqual(before);
  } finally {
    await ctxB.close();
  }
});

// ================================================================= 읽기 실패

test("read failures (SELECT revoked on a diary table or preferences, restored in finally) show the fixed failure notice under the page h1 — no empty board, no partial calendar, no font editor", async ({ page }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  await createPiece(page, tap, "읽기 실패 전 조각");
  const today = await serverSeoulToday();
  const pages: [string, string][] = [
    ["/", "오늘"],
    ["/days", "모아보기"],
    [`/days/${today}`, "모아보기"],
  ];
  for (const table of ["pod.day_summaries", "pod.diary_moments"]) {
    await withRevokedSelect([table], async () => {
      for (const [path, h1] of pages) {
        await page.goto(path);
        const l = `${table} revoked: ${path}`;
        await expect(page.getByRole("heading", { level: 1, name: h1, exact: true }), l).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: DIARY_TEXT.readFailed, exact: true }), l).toBeVisible();
        await expect(page.getByText(DIARY_TEXT.readFailedBody, { exact: true }), l).toBeVisible();
        await expect(page.getByText(DIARY_TEXT.empty), `${l}: not an empty board`).toHaveCount(0);
        await expect(page.getByText("읽기 실패 전 조각"), `${l}: no partial data`).toHaveCount(0);
        await expect(page.getByRole("region", { name: /^\d{4}년 \d{1,2}월$/ }), `${l}: no calendar`).toHaveCount(0);
        for (const t of FIXTURE_TEXT) await expect(page.getByText(t), `${l}: no fixture fallback`).toHaveCount(0);
      }
    });
  }
  await page.goto("/");
  await expect(item(page, "읽기 실패 전 조각"), "reads work again after restoring").toHaveCount(1);

  await withRevokedSelect(["pod.preferences"], async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "설정", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: DIARY_TEXT.fontReadFailed, exact: true })).toBeVisible();
    await expect(page.getByText(DIARY_TEXT.readFailedBody, { exact: true })).toBeVisible();
    await expect(page.getByRole("radio"), "no editable default").toHaveCount(0);
    await page.goto("/");
    await expect(item(page, "읽기 실패 전 조각"), "layout font failure only falls back for display").toHaveCount(1);
  });
  expect(await momentsOf(a.userId)).toHaveLength(1);
});

// ================================================================= 기록 글꼴

test("record font is saved to the account before the UI changes: serif/hand in the SSR html attribute, none for gothic, kept across reload and a new context; a failed save keeps the previous font; signed-out has no editor", async ({ page, browser }) => {
  const a = await signIn(page);
  const tap = await tapActions(page);
  await page.goto("/settings");
  await expect(page.getByText(DIARY_TEXT.fontHint, { exact: true })).toBeVisible();
  const radio = (name: string) => page.getByRole("radio", { name: new RegExp(`^${name}`) });
  await expect(radio("고딕")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-record-font", /.*/);

  const held = tap.next("hold");
  await radio("명조").click();
  await held.reached;
  await expect(statusWith(page, DIARY_TEXT.saving)).toBeVisible();
  await expect(radio("고딕"), "unchanged until the server saved it").toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-record-font", /.*/);
  expect(await fontOf(a.userId)).toBeNull();
  held.release();
  await expect(page.getByText(DIARY_TEXT.fontSaved, { exact: true })).toBeAttached();
  await expect(radio("명조")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-record-font", "serif");
  expect(await fontOf(a.userId)).toBe("serif");
  const ssr = await page.request.get("/");
  expect(await ssr.text(), "server-rendered attribute").toMatch(/<html[^>]*data-record-font="serif"/);

  const failed = tap.next("abort-before");
  await radio("손글씨").click();
  await failed.reached;
  await expect(page.getByText(DIARY_TEXT.unavailable, { exact: true })).toBeVisible();
  await expect(radio("명조"), "previous font kept").toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-record-font", "serif");
  expect(await fontOf(a.userId)).toBe("serif");

  await page.reload();
  await expect(radio("명조")).toBeChecked();
  const other = await sameAccountContext(browser, a);
  try {
    await other.page.goto("/settings");
    await expect(other.page.getByRole("radio", { name: /^명조/ })).toBeChecked();
    await expect(other.page.locator("html")).toHaveAttribute("data-record-font", "serif");
  } finally {
    await other.close();
  }

  await radio("손글씨").click();
  await expect(page.locator("html")).toHaveAttribute("data-record-font", "hand");
  expect(await fontOf(a.userId)).toBe("hand");
  await page.getByRole("button", { name: DIARY_TEXT.fontReset }).click();
  await expect(radio("고딕")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-record-font", /.*/);
  expect(await fontOf(a.userId)).toBe("gothic");
  expect(await (await page.request.get("/")).text()).not.toMatch(/<html[^>]*data-record-font=/);
  expect(tap.calls.length, "serif, failed hand, hand, reset").toBe(4);

  const anon = await browser.newContext();
  try {
    const p = await anon.newPage();
    await p.goto("/settings");
    await expect(p.getByRole("heading", { level: 1, name: "설정" })).toBeVisible();
    await expect(p.getByRole("radio"), "signed-out sees no font editor").toHaveCount(0);
    await expect(p.getByText(DIARY_TEXT.fontHint)).toHaveCount(0);
  } finally {
    await anon.close();
  }
});

// ================================================================= 서버 날짜·시각

test("the browser clock does not decide the record date or time: with a far-future browser clock the piece is stored on the server's Seoul today at the server time", async ({ page }) => {
  const a = await signIn(page);
  await page.clock.setFixedTime(new Date("2031-03-04T00:13:00Z")); // 브라우저만 2031-03-04 09:13(서울)
  await page.reload();
  const tap = await tapActions(page);
  await createPiece(page, tap, "시계와 무관한 조각");
  const today = await serverSeoulToday();
  const [row] = await momentsOf(a.userId);
  expect(row!.localDate, "server Seoul date").toBe(today);
  expect(row!.localDate).not.toBe("2031-03-04");
  await expect(item(page, "시계와 무관한 조각")).toContainText(row!.time);
  await expect(boardHeading(page, today)).toBeVisible();
  expect(seoulDate(new Date(row!.occurredAt)), "occurred_at is the server instant").toBe(today);
});

// ================================================================= 식별자 비직렬화·화면

test("the account UUID never reaches document HTML, RSC or action responses; board, dialog, calendar and settings have no overflow and ≥44px targets at 375/768/1440; keyboard-only create", async ({ page }) => {
  const caseStartedAt = Date.now();
  test.setTimeout(180_000);
  const bodies = collectBodies(page);
  const a = await signIn(page);
  type ActionBody = { url: string; type: string; text: string };
  type Encoding = "none" | "identity" | "gzip" | "br" | "deflate" | "other";
  type ActionStage = {
    fetchReturned: boolean; bodyBuffered: boolean; fulfillStarted: boolean; fulfillReturned: boolean; handlerFailed: boolean; bodyBytes: number;
    rawEncoding: Encoding | null; rawContentLengthPresent: boolean; rawContentLength: number | null;
    transferChunked: boolean; transferSupported: boolean; rawLengthMatchesBody: boolean | null; normalizedDelivery: boolean;
  };
  const actionBodies = new Map<Request, ActionBody>();
  const actionStages = new Map<Request, ActionStage>();
  const framing = (stage?: ActionStage) => ({
    rawEncoding: stage?.rawEncoding ?? null, rawContentLengthPresent: stage?.rawContentLengthPresent ?? false,
    rawContentLength: stage?.rawContentLength ?? null, transferChunked: stage?.transferChunked ?? false,
    transferSupported: stage?.transferSupported ?? false, bodyBytes: stage?.bodyBytes ?? 0,
    rawLengthMatchesBody: stage?.rawLengthMatchesBody ?? null, normalizedDelivery: stage?.normalizedDelivery ?? false,
  });
  let actionCount = 0;
  // Capture the real server body before browser refresh/navigation can discard it.
  // This single handler both counts the original UI POST and delivers those same bytes.
  await page.route((url) => url.origin === AUTH_BASE, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !(await request.headerValue("next-action"))) return route.fallback();
    actionCount++;
    const actionNumber = actionCount;
    const stage: ActionStage = {
      fetchReturned: false, bodyBuffered: false, fulfillStarted: false, fulfillReturned: false, handlerFailed: false, bodyBytes: 0,
      rawEncoding: null, rawContentLengthPresent: false, rawContentLength: null, transferChunked: false,
      transferSupported: false, rawLengthMatchesBody: null, normalizedDelivery: false,
    };
    actionStages.set(request, stage);
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      stage.fetchReturned = true;
      const buffer = await response.body();
      stage.bodyBuffered = true;
      stage.bodyBytes = buffer.length;
      const raw = response.headers();
      const encoding = raw["content-encoding"]?.trim().toLowerCase();
      stage.rawEncoding = encoding === undefined ? "none" : ["identity", "gzip", "br", "deflate"].includes(encoding) ? encoding as Encoding : "other";
      stage.rawContentLengthPresent = raw["content-length"] !== undefined;
      const length = raw["content-length"];
      stage.rawContentLength = length !== undefined && /^[0-9]+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
      const transfer = raw["transfer-encoding"]?.trim().toLowerCase();
      stage.transferChunked = transfer === "chunked";
      stage.transferSupported = transfer === undefined || stage.transferChunked;
      stage.rawLengthMatchesBody = stage.rawContentLength === null ? null : stage.rawContentLength === buffer.length;
      expect(stage.rawEncoding !== "other" && stage.transferSupported, "only supported upstream body encodings are delivered").toBe(true);
      expect(response.status(), "upstream action status").toBe(200);
      expect((raw["content-type"] ?? "").includes("text/x-component"), "upstream action is RSC").toBe(true);
      const text = buffer.toString("utf8");
      expect(text.toLowerCase().includes(a.userId.toLowerCase()), "complete upstream action body must not contain the account id").toBe(false);
      actionBodies.set(request, { url: new URL(request.url()).pathname, type: raw["content-type"] ?? "", text });
      // APIResponse.body is decoded. Keep every non-framing header and send these same bytes
      // with their actual length, rather than reusing compression or transfer framing.
      const framingHeaders = new Set(["content-encoding", "transfer-encoding", "content-length"]);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(raw)) if (!framingHeaders.has(name.toLowerCase())) headers[name] = value;
      headers["content-length"] = String(buffer.length);
      expect(Object.entries(raw).every(([name, value]) => framingHeaders.has(name.toLowerCase()) || headers[name] === value), "non-framing response headers remain unchanged").toBe(true);
      stage.fulfillStarted = true;
      await route.fulfill({ response, headers, body: buffer });
      stage.fulfillReturned = true;
      stage.normalizedDelivery = true;
      console.info("RSC action framing", JSON.stringify({ action: actionNumber === 1 ? "keyboard_create" : actionNumber === 2 ? "account_font" : "other", actionNumber, ...framing(stage) }));
    } catch {
      stage.handlerFailed = true;
      console.error("RSC action framing failure", JSON.stringify({ action: actionNumber === 1 ? "keyboard_create" : actionNumber === 2 ? "account_font" : "other", actionNumber, ...framing(stage) }));
      throw new Error("RSC action interception failed; raw request and response details withheld");
    }
  });
  const today = await serverSeoulToday();
  const completeAction = async (label: "keyboard create" | "account font", submit: () => Promise<void>): Promise<void> => {
    type Terminal = { finished: boolean; failed: boolean; failureCode: "none" | "net::ERR_ABORTED" | "net::ERR_FAILED" | "other" };
    const terminal = new Map<Request, Terminal>();
    const failures = new Map<Request, { promise: Promise<never>; reject: (error: Error) => void }>();
    let matched: Request | undefined;
    let responseSeen = false, status200 = false, rscType = false;
    let finishedSettled = false, finishedNull = false;
    let phase = "waiting_response";
    const isAction = (request: Request) => new URL(request.url()).origin === AUTH_BASE && request.method() === "POST" && Boolean(request.headers()["next-action"]);
    const failureFor = (request: Request) => {
      let failure = failures.get(request);
      if (!failure) {
        let reject!: (error: Error) => void;
        const promise = new Promise<never>((_resolve, fail) => { reject = fail; });
        void promise.catch(() => undefined); // terminal events can precede the response waiter.
        failure = { promise, reject };
        failures.set(request, failure);
      }
      return failure;
    };
    const onFinished = (request: Request) => {
      if (!isAction(request)) return;
      terminal.set(request, { finished: true, failed: false, failureCode: "none" });
    };
    const onFailed = (request: Request) => {
      if (!isAction(request)) return;
      const rawCode = request.failure()?.errorText;
      const failureCode = rawCode === "net::ERR_ABORTED" || rawCode === "net::ERR_FAILED" ? rawCode : "other";
      terminal.set(request, { finished: false, failed: true, failureCode });
      failureFor(request).reject(new Error(`RSC action browser request failed: ${failureCode}`));
    };
    const diagnose = (reason: "verification_failed" | "case_deadline") => {
      const stage = matched ? actionStages.get(matched) : undefined;
      const end = matched ? terminal.get(matched) : undefined;
      console.error("RSC action diagnostic", JSON.stringify({
        action: label === "keyboard create" ? "keyboard_create" : "account_font", reason, phase, actionCount,
        trackedRequests: actionStages.size, responseSeen, status200, rscType, finishedSettled, finishedNull, sameRequestMatched: Boolean(matched && stage),
        fetchReturned: stage?.fetchReturned ?? false, bodyBuffered: stage?.bodyBuffered ?? false,
        mapPresent: Boolean(matched && actionBodies.has(matched)), fulfillStarted: stage?.fulfillStarted ?? false, fulfillReturned: stage?.fulfillReturned ?? false,
        handlerFailed: stage?.handlerFailed ?? false, terminalMatched: Boolean(end), requestFinished: end?.finished ?? false,
        requestFailed: end?.failed ?? false, failureCode: end?.failureCode ?? "none", ...framing(stage),
      }));
    };
    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    // Diagnostic only: the existing case deadline remains the failing upper bound.
    const deadline = setTimeout(() => diagnose("case_deadline"), Math.max(1, 180_000 - (Date.now() - caseStartedAt) - 250));
    try {
      const responseWaiter = page.waitForResponse((res) => new URL(res.url()).origin === AUTH_BASE && res.request().method() === "POST" && Boolean(res.request().headers()["next-action"]));
      void responseWaiter.catch(() => undefined);
      const submitted = submit();
      void submitted.catch(() => undefined);
      const [response] = await Promise.all([responseWaiter, submitted]);
      matched = response.request();
      responseSeen = true;
      status200 = response.status() === 200;
      rscType = (response.headers()["content-type"] ?? "").includes("text/x-component");
      phase = "status_and_type";
      expect(response.status(), `${label}: successful action response`).toBe(200);
      expect(response.headers()["content-type"] ?? "", `${label}: actual RSC action response`).toContain("text/x-component");
      phase = "browser_finished";
      const finished = response.finished();
      void finished.catch(() => undefined);
      void finished.then((value) => { finishedSettled = true; finishedNull = value === null; }, () => { finishedSettled = true; });
      expect(await Promise.race([finished, failureFor(matched).promise]), `${label}: browser received the complete response`).toBeNull();
      phase = "captured_body";
      const captured = actionBodies.get(response.request());
      expect(captured, `${label}: the original action body was captured and delivered`).toBeDefined();
      phase = "uuid_absent";
      expect(captured!.text.toLowerCase().includes(a.userId.toLowerCase()), `${label}: complete action body must not contain the account id`).toBe(false);
    } catch {
      diagnose("verification_failed");
      const unknownUi = { writeDialogVisible: null, errorPresent: null, fixtureMemoVisible: null, fontIsSerif: null, hashIsWrite: null };
      const ui = page.evaluate(() => {
        const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
        return {
          writeDialogVisible: [...document.querySelectorAll("dialog[open]")].some(visible),
          errorPresent: [...document.querySelectorAll('[role="alert"]')].some(visible),
          fixtureMemoVisible: [...document.querySelectorAll("li.piece p")].some((element) => element.textContent === "키보드로 쓴 조각" && visible(element)),
          fontIsSerif: document.documentElement.getAttribute("data-record-font") === "serif",
          hashIsWrite: location.hash === "#write",
        };
      }).catch(() => unknownUi);
      let uiDeadline: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([ui, new Promise<typeof unknownUi>((resolve) => { uiDeadline = setTimeout(() => resolve(unknownUi), 250); })]);
      clearTimeout(uiDeadline);
      console.error("RSC action UI diagnostic", JSON.stringify(snapshot));
      throw new Error(`RSC action verification failed at ${phase}; safe diagnostic recorded`);
    } finally {
      clearTimeout(deadline);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    }
  };

  // 키보드만으로 작성
  await topAdd(page).focus();
  await page.keyboard.press("Enter");
  await expect(memo(page)).toBeFocused();
  await page.keyboard.type("키보드로 쓴 조각");
  const save = composer(page).getByRole("button", { name: "저장" });
  for (let i = 0; i < 12 && !(await save.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(save, "reached by Tab").toBeFocused();
  expect(await save.evaluate((e) => getComputedStyle(e).outlineStyle), "visible focus ring").not.toBe("none");
  await completeAction("keyboard create", () => page.keyboard.press("Enter"));
  await expect(statusWith(page, DIARY_TEXT.created)).toBeVisible();
  await expect(item(page, "키보드로 쓴 조각")).toHaveCount(1);
  expect(actionCount).toBe(1);

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `board ${w}`);
    await item(page, "키보드로 쓴 조각").getByRole("button", { name: /조각 수정$/ }).click();
    await expectLayoutOk(page, `edit dialog ${w}`);
    await page.keyboard.press("Escape");
    await expect(composer(page)).toHaveCount(0);
  }
  await page.getByRole("link", { name: "모아보기" }).click(); // 클라이언트 이동(RSC)
  await expect(page.getByRole("heading", { level: 1, name: "모아보기" })).toBeVisible();
  await page.goto(`/days/${today}`);
  await page.goto("/settings");
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `settings ${w}`);
  }
  await completeAction("account font", () => page.getByRole("radio", { name: /^명조/ }).click());
  expect(actionCount, "one create and one font action, without retries").toBe(2);
  await expect(page.getByRole("radio", { name: /^명조/ })).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-record-font", "serif");
  await page.goto("/days");
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `calendar ${w}`);
  }

  const seen = [...await bodies.bodies(), ...actionBodies.values()];
  expect(seen.some((b) => b.type.includes("text/html")), "document HTML collected").toBe(true);
  expect(seen.some((b) => b.type.includes("text/x-component")), "RSC/action responses collected").toBe(true);
  for (const b of seen) expect(b.text.toLowerCase().includes(a.userId.toLowerCase()), `${b.url} (${b.type}) must not contain the account id`).toBe(false);
  for (const path of ["/", "/days", `/days/${today}`, "/settings"]) {
    const res = await page.request.get(path, { headers: { RSC: "1" } });
    expect((await res.text()).toLowerCase(), `RSC ${path}`).not.toContain(a.userId.toLowerCase());
  }
});
