// PLAN_reflection-time-settings RED. 실제 mock OIDC·계정 UI·Server Action과 기존 일회용 PG 하네스만 쓴다.
// DB는 SELECT만, 실패 재현은 기존 tapActions/withRevokedSelect로 한정한다. 세션·계정·설정 값을 주입하지 않는다.
import { expect, test, type Page } from "@playwright/test";
import { readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV, expectLayoutOk } from "./support";
import { signIn, tapActions, withRevokedSelect } from "./diary-support";

const LABEL = "매일 회고할 시간";
const SAVED = "회고 시간을 저장했어요.";
const READ_FAILED = "회고 시간을 불러오지 못했어요";
const time = (page: Page) => page.getByLabel(LABEL, { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "저장", exact: true });

/** 관리자 SELECT: 실제 UI 저장 결과만 확인하며 행이 없으면 null이다. */
async function storedTime(userId: string): Promise<string | null> {
  const database = process.env[E2E_ENV.db];
  if (!database) throw new Error("reflection E2E requires the existing disposable DB globalSetup");
  return withAdmin(readDisposableEnv(), async (c) => {
    const r = await c.query<{ reflection_time: string }>("SELECT reflection_time FROM pod.preferences WHERE user_id = $1::uuid", [userId]);
    return r.rows[0]?.reflection_time ?? null;
  }, database);
}

/** 저장 성공·pending 해제·실제 DB 확인 뒤에만 다음 navigation을 진행한다. */
async function expectSaved(page: Page, userId: string, value: string): Promise<void> {
  await expect(page.getByText(SAVED, { exact: true })).toBeVisible();
  await expect(time(page)).toBeEnabled();
  await expect(save(page)).toBeEnabled();
  await expect.poll(() => storedTime(userId)).toBe(value);
}

test("reflection settings default to 20:00, save explicitly, survive reload and an independent same-account login, and stay separate for another account", async ({ page, browser }) => {
  const account = await signIn(page);
  const tap = await tapActions(page);
  try {
    await page.getByRole("navigation", { name: "사용자 메뉴", exact: true }).getByRole("link", { name: "설정", exact: true }).click();
    await expect(page).toHaveURL(`${AUTH_BASE}/settings`);
    await expect(time(page)).toHaveValue("20:00");
    await expect(time(page)).toHaveAttribute("type", "time");
    await expect(time(page)).toHaveAttribute("step", "60");
    await expect(page.getByText(/한국 시간.*Asia\/Seoul/)).toBeVisible();
    await expectLayoutOk(page, "reflection default settings");
    expect(await storedTime(account.userId), "viewing a default creates no preferences row").toBeNull();
    await time(page).fill("21:35");
    expect(tap.calls.length, "editing alone does not submit").toBe(0);
    expect(await storedTime(account.userId)).toBeNull();
    await save(page).click();
    await expectSaved(page, account.userId, "21:35");
    expect(tap.calls.length).toBe(1);
    await page.reload();
    await expect(time(page)).toHaveValue("21:35");

    const context = await browser.newContext({ baseURL: AUTH_BASE });
    try {
      const other = await context.newPage();
      const same = await signIn(other, account.provider, account.subject);
      expect(same.userId).toBe(account.userId);
      await other.goto("/settings");
      await expect(time(other)).toHaveValue("21:35");
    } finally {
      await context.close();
    }
    const separateContext = await browser.newContext({ baseURL: AUTH_BASE });
    try {
      const other = await separateContext.newPage();
      const separate = await signIn(other);
      expect(separate.userId).not.toBe(account.userId);
      await other.goto("/settings");
      await expect(time(other)).toHaveValue("20:00");
      expect(await storedTime(separate.userId)).toBeNull();
      expect(await storedTime(account.userId)).toBe("21:35");
    } finally {
      await separateContext.close();
    }
  } finally {
    await tap.dispose();
  }
});

test("pending locks the time and submit against duplicates; a failed save keeps the draft, never claims success, and can be retried once", async ({ page }) => {
  const account = await signIn(page);
  const tap = await tapActions(page);
  let release: () => void = () => undefined;
  try {
    await page.goto("/settings");
    await expect(time(page)).toHaveValue("20:00");
    await time(page).fill("22:10");
    const held = tap.next("hold");
    release = held.release;
    await save(page).click();
    await held.reached;
    await expect(time(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: /^저장(?: 중…)?$/ })).toBeDisabled();
    await expect(page.getByText("저장 중…", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect(tap.calls.length, "pending keyboard attempts send no duplicate POST").toBe(1);
    expect(await storedTime(account.userId), "held request has not reached the server").toBeNull();
    held.release();
    await expectSaved(page, account.userId, "22:10");

    await time(page).fill("23:15");
    const failed = tap.next("abort-before");
    await save(page).click();
    await failed.reached;
    const error = page.getByRole("alert").or(page.getByRole("status").filter({ hasText: /못|실패|다시/ }));
    await expect(error.first(), "an accessible save failure is announced").toBeVisible();
    await expect(time(page)).toBeEnabled();
    await expect(time(page)).toHaveValue("23:15");
    await expect(save(page)).toBeEnabled();
    await expect(page.getByText(SAVED, { exact: true }), "no stale or false success after failure").toHaveCount(0);
    expect(await storedTime(account.userId)).toBe("22:10");
    expect(tap.calls.length, "failed save is not retried automatically").toBe(2);
    await save(page).click();
    await expectSaved(page, account.userId, "23:15");
    expect(tap.calls.length).toBe(3);
    await page.reload();
    await expect(time(page)).toHaveValue("23:15");
  } finally {
    release();
    await tap.dispose();
  }
});

test("a preferences read failure shows no editable false default, recovers after SELECT is restored, and signed-out settings expose no time editor", async ({ page, browser }) => {
  await signIn(page);
  await withRevokedSelect(["pod.preferences"], async () => {
    await page.goto("/settings");
    await expect(page.getByText(READ_FAILED, { exact: true })).toBeVisible();
    await expect(time(page), "DB failure does not become a default editor").toHaveCount(0);
    await expect(save(page)).toHaveCount(0);
  });
  await page.reload();
  await expect(time(page)).toHaveValue("20:00");
  await expect(time(page)).toBeEnabled();
  const anonymous = await browser.newContext({ baseURL: AUTH_BASE });
  try {
    const signedOut = await anonymous.newPage();
    await signedOut.goto("/settings");
    await expect(time(signedOut)).toHaveCount(0);
    await expect(save(signedOut)).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
});
