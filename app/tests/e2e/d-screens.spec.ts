import { expect, test, type Page } from "@playwright/test";

// D 화면 골격: 375/768/1440 수평 넘침 없음, 작성·수정은 화면 메모리에만 있고 저장됐다고 하지 않는다.
const SCREENS = [
  ["today", "/"],
  ["days", "/days"],
  ["day", "/days/2026-11-01"],
  ["settings", "/settings"],
] as const;
const WIDTHS = [375, 768, 1440] as const;
const SHOTS = process.env.SCREENSHOT_DIR;

async function noHorizontalOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

for (const w of WIDTHS) {
  test(`D screens fit ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [name, path] of SCREENS) {
      await page.goto(path);
      await expect(page.locator("#view h1")).toBeVisible();
      await noHorizontalOverflow(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true });
    }
  });
}

test("add a piece: memory only, gone after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "조각 추가" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "붙이기" }).click();
  await expect(dialog.getByText("메모를 한 줄 적어 주세요.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "메모" }).fill("<b>시험 조각</b>");
  await dialog.getByRole("button", { name: "붙이기" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".piece.is-new")).toContainText("<b>시험 조각</b>");
  await expect(page.locator("[aria-live]").first()).toContainText("저장되지 않아");
  await page.reload();
  await expect(page.getByText("<b>시험 조각</b>")).toHaveCount(0);
});

test("edit a piece keeps its time and count", async ({ page }) => {
  await page.goto("/days/2026-11-01");
  await page.getByRole("button", { name: "11월 1일 일요일 15:05 조각 수정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toContainText("조각 고치기");
  await dialog.getByRole("textbox", { name: "메모" }).fill("고친 글");
  await dialog.getByRole("button", { name: "고치기" }).click();
  await expect(page.locator(".pieces")).toContainText("고친 글");
  await expect(page.locator(".pieces > li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "11월 1일 일요일 15:05 조각 수정" })).toBeFocused();
});

test("record font applies only from the allowlist", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("radio", { name: /명조/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-record-font", "serif");
  await page.getByRole("button", { name: "기본값(고딕)으로 되돌리기" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-record-font", /.*/);
});

test("unknown dates are not found", async ({ page }) => {
  const res = await page.goto("/days/2026-02-30");
  expect(res?.status()).toBe(404);
});

test("browser Back closes the add dialog, Forward reopens it with the draft kept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "조각 추가" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#write$/);
  await dialog.getByRole("textbox", { name: "메모" }).fill("뒤로 가기 초안");

  await page.goBack();
  await expect(page).not.toHaveURL(/#write/);
  await expect(dialog).toBeHidden();
  await expect(page.locator(".pieces")).not.toContainText("뒤로 가기 초안");

  await page.goForward();
  await expect(page).toHaveURL(/#write$/);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "메모" })).toHaveValue("뒤로 가기 초안");
});

test("changes also reset when moving to another screen, and the notice says so", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "조각 추가" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "메모" }).fill("이동 시험 조각");
  await dialog.getByRole("button", { name: "붙이기" }).click();
  await expect(page.locator("[aria-live]").first()).toContainText("다른 화면으로 이동하면 사라집니다");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "모아보기" }).click();
  await expect(page.locator("#view h1")).toHaveText("모아보기");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "오늘" }).click();
  await expect(page.locator(".pieces")).toBeVisible();
  await expect(page.getByText("이동 시험 조각")).toHaveCount(0);
});

test("one-line summary on a picked day returns focus to the picked heading", async ({ page }) => {
  await page.goto("/days/2026-11-02");
  await page.getByRole("button", { name: "고쳐 쓰기" }).click();
  await page.getByRole("textbox", { name: "오늘을 한 줄로" }).fill("고친 한 줄");
  await page.getByRole("button", { name: "반영" }).click();
  await expect(page.locator(".oneline")).toContainText("고친 한 줄");
  await expect(page.locator("#picked-h")).toBeFocused();
  await expect(page.locator("[aria-live]").first()).toContainText("다른 화면으로 이동하면");
});
