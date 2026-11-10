// PC·휴대폰 계정 기록 여정. 실제 mock OIDC·일회용 PG18 하네스만 사용한다.
// 기기별 context에서 각각 로그인하며 계정·세션·쿠키·저장 상태를 주입/복사하지 않는다.
// 쓰기는 화면·실제 Server Action만, 계정/지급/날짜 확인은 기존 SELECT helper만 쓴다.
// Chromium PC↔WebKit iPhone・WebKit PC↔Chromium Android emulation이며 실제 기기·Google 검증은 아니다.
import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { AUTH_BASE, TEXT, accountOf, expectLayoutOk } from "./support";
import { DIARY_TEXT, dateLabel, momentsOf, signIn, topAdd } from "./diary-support";

const dialog = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => dialog(page).getByRole("textbox", { name: "메모" });
const piece = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });

test("PC and phone log in independently to one account without another grant; a PC creation and phone edit survive reload on the other device, calendar and account font agree, and each device logs out independently", async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  if (browserName !== "chromium" && browserName !== "webkit") throw new Error("device journey requires Chromium or WebKit");
  const desktop = browserName === "webkit" ? "Desktop Safari" : "Desktop Chrome";
  const mobile = browserName === "webkit" ? "Pixel 7" : "iPhone 13";
  expect(devices[desktop], "desktop descriptor exists").toBeDefined();
  expect(devices[mobile], "phone descriptor exists").toBeDefined();
  const contexts: BrowserContext[] = [];
  let mobileBrowser: Browser | undefined;

  try {
    const pcContext = await browser.newContext({ ...devices[desktop], baseURL: AUTH_BASE });
    contexts.push(pcContext);
    mobileBrowser = await (browserName === "webkit" ? chromium : webkit).launch();
    const phoneContext = await mobileBrowser.newContext({ ...devices[mobile], baseURL: AUTH_BASE });
    contexts.push(phoneContext);
    const pc = await pcContext.newPage();
    const phone = await phoneContext.newPage();
    expect(pcContext, "independent browser contexts").not.toBe(phoneContext);

    await pc.goto("/login");
    await expectLayoutOk(pc, `${desktop}: login`);
    const account = await signIn(pc, "google");
    const firstGrant = await accountOf(account.provider, account.subject);
    expect(firstGrant).toMatchObject({ userId: account.userId, status: "active", balance: 10, ledger: 1, firstLogin: true });
    await expect(pc.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
    await expectLayoutOk(pc, `${desktop}: empty board`);

    await phone.goto("/login");
    await expectLayoutOk(phone, `${mobile}: login`);
    const sameAccount = await signIn(phone, "google", account.subject);
    expect(sameAccount, "the phone independently logs into the same server account").toEqual(account);
    expect(await accountOf(account.provider, account.subject), "no second first-login grant").toEqual(firstGrant);
    await expect(phone.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
    await expectLayoutOk(phone, `${mobile}: empty board`);

    const initial = "PC에서 작성한 기기 호환 조각";
    const edited = "휴대폰에서 고친 같은 계정의 조각";
    await topAdd(pc).click();
    await expect(memo(pc)).toBeVisible();
    await expectLayoutOk(pc, `${desktop}: create dialog`);
    await memo(pc).fill(initial);
    await dialog(pc).getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog(pc)).toHaveCount(0);
    const saved = await momentsOf(account.userId);
    expect(saved, "one piece was committed through the PC UI").toHaveLength(1);
    expect(saved[0]!.body).toBe(initial);
    const recordDate = saved[0]!.localDate;
    const recordPath = `/days/${recordDate}`;
    await pc.goto(recordPath);
    await expect(piece(pc, initial)).toHaveCount(1);
    await expectLayoutOk(pc, `${desktop}: saved board`);

    await phone.goto(recordPath);
    await phone.reload();
    await expect(piece(phone, initial)).toHaveCount(1);
    await expectLayoutOk(phone, `${mobile}: reloaded PC creation`);
    await piece(phone, initial).getByRole("button", { name: /조각 수정$/ }).click();
    await expect(memo(phone)).toHaveValue(initial);
    await expectLayoutOk(phone, `${mobile}: edit dialog`);
    await memo(phone).fill(edited);
    await dialog(phone).getByRole("button", { name: "고치기", exact: true }).click();
    await expect(dialog(phone)).toHaveCount(0);
    await expect(piece(phone, edited)).toHaveCount(1);
    await expect(piece(phone, initial)).toHaveCount(0);

    await pc.reload();
    await expect(piece(pc, edited)).toHaveCount(1);
    await expect(piece(pc, initial)).toHaveCount(0);
    await expectLayoutOk(pc, `${desktop}: reloaded phone edit`);

    for (const [page, device] of [[pc, desktop], [phone, mobile]] as const) {
      await page.getByRole("link", { name: "모아보기", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "모아보기", exact: true })).toBeVisible();
      const day = page.getByRole("link", { name: `${dateLabel(recordDate)}, 조각 1개`, exact: true });
      await expect(day).toBeVisible();
      await expectLayoutOk(page, `${device}: calendar`);
      await day.click();
      await expect(page).toHaveURL(`${AUTH_BASE}${recordPath}`);
      await expect(piece(page, edited)).toHaveCount(1);
      await expectLayoutOk(page, `${device}: day detail`);
    }

    await phone.goto("/settings");
    await expectLayoutOk(phone, `${mobile}: font settings`);
    await phone.getByRole("radio", { name: /^명조/ }).click();
    await expect(phone.getByText(DIARY_TEXT.fontSaved, { exact: true })).toBeAttached();
    await expect(phone.getByRole("radio", { name: /^명조/ })).toBeChecked();
    await expect(phone.locator("html")).toHaveAttribute("data-record-font", "serif");
    await phone.reload();
    await expect(phone.getByRole("radio", { name: /^명조/ })).toBeChecked();
    await expect(phone.locator("html")).toHaveAttribute("data-record-font", "serif");
    await pc.reload();
    await expect(pc.locator("html")).toHaveAttribute("data-record-font", "serif");
    await expect(piece(pc, edited)).toHaveCount(1);
    await pc.goto("/settings");
    await expect(pc.getByRole("radio", { name: /^명조/ })).toBeChecked();
    await expect(pc.locator("html")).toHaveAttribute("data-record-font", "serif");
    await expectLayoutOk(pc, `${desktop}: account font settings`);

    await phone.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(phone).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    await expect(phone.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
    await phone.goto(recordPath);
    const phoneLogin = new URL(phone.url());
    expect([phoneLogin.pathname, phoneLogin.searchParams.get("returnTo")]).toEqual(["/login", recordPath]);
    await expect(phone.getByRole("heading", { level: 1, name: TEXT.loginTitle })).toBeVisible();
    await expectLayoutOk(phone, `${mobile}: signed out`);

    await pc.reload();
    await expect(pc.getByRole("button", { name: "로그아웃", exact: true }), "phone logout leaves the PC session active").toBeVisible();
    await pc.goto(recordPath);
    await expect(piece(pc, edited)).toHaveCount(1);
    await expect(pc.locator("html")).toHaveAttribute("data-record-font", "serif");
    await pc.goto("/settings");
    await pc.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(pc).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
    await expect(pc.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
    await pc.goto(recordPath);
    const pcLogin = new URL(pc.url());
    expect([pcLogin.pathname, pcLogin.searchParams.get("returnTo")]).toEqual(["/login", recordPath]);
    await expect(pc.getByRole("heading", { level: 1, name: TEXT.loginTitle })).toBeVisible();
    await expectLayoutOk(pc, `${desktop}: signed out`);
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()));
    } finally {
      await mobileBrowser?.close();
    }
  }
});
