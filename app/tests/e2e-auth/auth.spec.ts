// F4 B4 RED — 실제 로그인 흐름 E2E(PLAN_mvp-oidc-integration §6.3·§8·§9 E1, PLAN_dev-usable-app 탈퇴 gate 활성 모드).
// next dev(127.0.0.1:3300) + 실제 mock OIDC issuer(RS256·PKCE·state·nonce) + 실제 B2 처리 함수·F3 지급·L2 수명주기 + 일회용 PG18.
// 서버 env는 POD_WITHDRAWAL_ENABLED=1(탈퇴 흐름 확인용). 비활성 경계는 tests/unit/auth-routes.test.ts가 맡는다.
// 세션은 화면 흐름으로만 얻는다(시험이 쿠키를 봉인·주입하지 않는다).
import { expect, test, type Page } from "@playwright/test";
import {
  AUTH_BASE,
  COOKIE,
  PROVIDER_BUTTON,
  TEXT,
  WIDTHS,
  accountOf,
  beginLogin,
  controlAuthorize,
  cookie,
  expectLayoutOk,
  holdStart,
  login,
  observeAuthForms,
  newSubject,
  providerButton,
  sha256,
  userCount,
  type Provider,
} from "./support";
import { DIARY_TEXT, FIXTURE_TEXT, dateLabel, escapeRe, seoulDate, topAdd } from "./diary-support";

const SEVEN_DAYS_S = 7 * 24 * 3600;

// F5 S3b 전환(PLAN_dev-diary-actions §4): 로그인한 계정은 "기록 연결 전" 안내 대신 실제 계정 기록 화면을 본다.
// 오늘(/)은 서울 오늘의 빈 계정 보드, /days·/days/<date>는 모아보기. 상단에 조각 추가 진입점이 있다.
async function expectSignedInHome(page: Page, label: string): Promise<void> {
  const path = new URL(page.url()).pathname;
  if (path === "/") {
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(escapeRe(dateLabel(seoulDate()))) }), `${label}: today board`).toBeVisible();
    await expect(page.getByText(DIARY_TEXT.empty, { exact: true }), `${label}: empty account board`).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { level: 1, name: "모아보기", exact: true }), `${label}: ${path}`).toBeVisible();
  }
  await expect(topAdd(page), `${label}: account write entry`).toBeVisible();
  await expect(page.getByRole("heading", { name: TEXT.signedIn }), `${label}: no not-connected notice`).toHaveCount(0);
  await expect(page.getByText(TEXT.signedInBody), `${label}: no not-connected text`).toHaveCount(0);
}

async function expectLoginNotice(page: Page, text: string, query: string): Promise<void> {
  const u = new URL(page.url());
  expect(`${u.pathname}${u.search}`, "landing URL").toBe(`/login?${query}`);
  await expect(page.getByRole("heading", { name: TEXT.loginTitle })).toBeVisible();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

const tamper = (callback: string, key: string) => {
  const u = new URL(callback);
  const v = u.searchParams.get(key) ?? "";
  u.searchParams.set(key, `${v.slice(0, -1)}${v.endsWith("A") ? "B" : "A"}`);
  return u.href;
};

// ================================================================= 로그인 화면

test("/login: D login screen with the official provider buttons (POD_AUTH_PROVIDERS order), the /try/ notice and no artboard tools", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: TEXT.loginTitle })).toBeVisible();
  const g = providerButton(page, "google");
  const k = providerButton(page, "kakao");
  await expect(g).toBeVisible();
  await expect(k).toBeVisible();
  const [gb, kb] = [await g.boundingBox(), await k.boundingBox()];
  expect(gb!.y, "Google first (vertical order)").toBeLessThan(kb!.y);

  for (const p of ["google", "kakao"] as const) {
    const spec = PROVIDER_BUTTON[p];
    const img = providerButton(page, p).getByRole("img", { name: spec.img, exact: true });
    await expect(img, `${p} official image`).toBeVisible();
    const box = (await img.boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)], `${p} rendered size`).toEqual([...spec.size]);
    const src = await img.evaluate((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src);
    const res = await page.request.get(src);
    expect(res.status(), `${p} asset`).toBe(200);
    expect(sha256(await res.body()), `${p} asset bytes are the official file (PR47 SOURCES.md)`).toBe(spec.sha256);
  }

  const forms = page.locator('form[action^="/auth/"][action$="/start"]');
  await expect(forms).toHaveCount(2);
  for (const f of await forms.all()) {
    expect((await f.getAttribute("method"))?.toLowerCase()).toBe("post");
    await expect(f.locator('input[type="hidden"][name="returnTo"]')).toHaveValue("/");
  }
  await expect(page.getByRole("link", { name: TEXT.tryLink })).toHaveAttribute("href", "/try/");
  await expect(page.getByText(TEXT.tryNote)).toBeVisible();
  await expect(page.getByText("정적 아트보드")).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `/login ${w}`);
  }
});

test("/login shows only allow-listed notices and never reflects the query", async ({ page }) => {
  const all = [TEXT.cancelled, TEXT.failed, TEXT.expired, TEXT.purgeDue, TEXT.signedOut, TEXT.withdrawn];
  for (const q of ["error=bogus", "notice=%3Cb%3Ex%3C%2Fb%3E", "error=cancelled%20"]) {
    await page.goto(`/login?${q}`);
    await expect(page.getByRole("heading", { name: TEXT.loginTitle })).toBeVisible();
    for (const t of all) await expect(page.getByText(t, { exact: true }), `${q}: ${t}`).toHaveCount(0);
    expect(await page.content()).not.toContain("<b>x</b>");
  }
});

// ================================================================= 성공·지급

for (const p of ["google", "kakao"] as const satisfies readonly Provider[]) {
  test(`${p}: success grants 10 once, sets only an HttpOnly Lax session cookie, lands signed in; a second login reuses the account without a new grant`, async ({
    page,
    context,
  }) => {
    const subject = newSubject(p);
    const before = await userCount();
    expect(await login(page, p, subject)).toBe(`${AUTH_BASE}/`);
    await expectSignedInHome(page, p);

    const s = await cookie(page, COOKIE.session);
    expect(s, "session cookie").toBeDefined();
    expect([s!.httpOnly, s!.sameSite, s!.path, s!.secure]).toEqual([true, "Lax", "/", false]);
    expect(Math.abs(s!.expires - (Date.now() / 1000 + SEVEN_DAYS_S)), "7-day session").toBeLessThan(60);
    expect(await cookie(page, COOKIE.flow), "flow cookie consumed").toBeUndefined();
    expect(await cookie(page, COOKIE.recovery)).toBeUndefined();

    const first = await accountOf(p, subject);
    expect(first).toMatchObject({ status: "active", gen: 1, balance: 10, ledger: 1, firstLogin: true });
    expect(await userCount()).toBe(before + 1);

    await page.goto("/login");
    expect(new URL(page.url()).pathname, "signed-in /login → /").toBe("/");

    await context.clearCookies();
    expect(await login(page, p, subject)).toBe(`${AUTH_BASE}/`);
    await expectSignedInHome(page, `${p} again`);
    expect(await accountOf(p, subject), "same account, no second grant").toEqual(first);
    expect(await userCount()).toBe(before + 1);
  });
}

test("signed-in pages show the account's own (empty) diary: write entry allowed, no sample pieces, balance or /try/ note in the diary body", async ({ page }) => {
  await login(page, "google", newSubject("google"));
  for (const path of ["/", "/days", "/days/2026-11-03"]) {
    await page.goto(path);
    await expectSignedInHome(page, path);
    for (const t of FIXTURE_TEXT) await expect(page.getByText(t), `${path}: no fixture piece`).toHaveCount(0);
    await expect(page.locator("main img"), `${path}: no sample images`).toHaveCount(0);
    await expect(page.getByText(/감정덩어리|잔액/)).toHaveCount(0);
    await expect(page.getByText(TEXT.tryNote)).toHaveCount(0);
  }
});

// ================================================================= 실패 callback

test("cancel at the provider → /login?error=cancelled, no session and no account", async ({ page }) => {
  const subject = newSubject("google");
  const callback = await beginLogin(page, "google", { deny: true, subject });
  await page.goto(callback);
  await expectLoginNotice(page, TEXT.cancelled, "error=cancelled");
  expect(await cookie(page, COOKIE.session)).toBeUndefined();
  expect(await cookie(page, COOKIE.flow)).toBeUndefined();
  expect(await accountOf("google", subject)).toBeNull();
});

test("tampered state → /login?error=failed, nothing created", async ({ page }) => {
  const subject = newSubject("google");
  const callback = await beginLogin(page, "google", { subject });
  await page.goto(tamper(callback, "state"));
  await expectLoginNotice(page, TEXT.failed, "error=failed");
  expect(await cookie(page, COOKIE.session)).toBeUndefined();
  expect(await accountOf("google", subject)).toBeNull();
});

test("flow cookie deleted before the callback → /login?error=expired, nothing created", async ({ page, context }) => {
  const subject = newSubject("kakao");
  const callback = await beginLogin(page, "kakao", { subject });
  expect(await cookie(page, COOKIE.flow), "start set the flow cookie").toBeDefined();
  await context.clearCookies({ name: COOKIE.flow });
  await page.goto(callback);
  await expectLoginNotice(page, TEXT.expired, "error=expired");
  expect(await accountOf("kakao", subject)).toBeNull();
});

test("re-requesting a successful callback URL → 303 expired without touching the session or the grant", async ({ page }) => {
  const subject = newSubject("google");
  const callback = await beginLogin(page, "google", { subject });
  await page.goto(callback);
  await expectSignedInHome(page, "first");
  const s1 = (await cookie(page, COOKIE.session))!.value;
  const res = await page.request.get(callback, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()["location"]).toBe(`${AUTH_BASE}/login?error=expired`);
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  const set = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value.split("=")[0]);
  expect(set, "only the flow cookie is deleted").toEqual([COOKIE.flow]);
  expect((await cookie(page, COOKIE.session))!.value, "session untouched").toBe(s1);
  expect(await accountOf("google", subject)).toMatchObject({ ledger: 1, balance: 10 });
});

test("a failed or cancelled callback while signed in keeps the existing session", async ({ page }) => {
  await login(page, "google", newSubject("google"));
  const s1 = (await cookie(page, COOKIE.session))!.value;
  for (const [opts, broken, expected] of [
    [{}, (c: string) => tamper(c, "state"), "/login?error=failed"],
    [{ deny: true }, (c: string) => c, "/login?error=cancelled"],
  ] as const) {
    const start = await page.request.post("/auth/google/start", { form: { returnTo: "/" }, headers: { origin: AUTH_BASE }, maxRedirects: 0 });
    expect(start.status()).toBe(303);
    const callback = await controlAuthorize(start.headers()["location"] ?? "", { ...opts, subject: newSubject("google") });
    const res = await page.request.get(broken(callback), { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()["location"]).toBe(`${AUTH_BASE}${expected}`);
    expect((await cookie(page, COOKIE.session))!.value, `${expected}: session kept`).toBe(s1);
  }
  await page.goto("/");
  await expectSignedInHome(page, "still signed in");
});

// ================================================================= returnTo

test("returnTo: a protected /days/… page sends you to /login and back after login; //evil and absolute URLs fall back to /", async ({ page, context }) => {
  await page.goto("/days/2026-11-03");
  const u = new URL(page.url());
  expect(u.pathname).toBe("/login");
  expect(u.searchParams.get("returnTo")).toBe("/days/2026-11-03");
  expect(await login(page, "google", newSubject("google"), "")).toBe(`${AUTH_BASE}/days/2026-11-03`);
  await expectSignedInHome(page, "returned");

  for (const bad of ["//evil.example", "https://evil.example/x", "/login", "/auth/logout"]) {
    await context.clearCookies();
    await page.goto(`/login?returnTo=${encodeURIComponent(bad)}`);
    await expect(page.locator('input[type="hidden"][name="returnTo"]').first()).toHaveValue("/");
    expect(await login(page, "kakao", newSubject("kakao"), ""), bad).toBe(`${AUTH_BASE}/`);
  }
});

// ================================================================= 로그아웃

test("settings › 로그아웃 → /login?notice=signed_out, session gone, protected pages ask to log in again; settings links the browser diary", async ({ page }) => {
  await login(page, "google", newSubject("google"));
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: TEXT.tryLink })).toHaveAttribute("href", "/try/");
  await expect(page.getByText(TEXT.tryNote)).toBeVisible();
  await expect(page.getByRole("link", { name: "계정 탈퇴" })).toHaveAttribute("href", "/account/withdraw");
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `/settings ${w}`);
  }
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
  await expect(page.getByText(TEXT.signedOut, { exact: true })).toBeVisible();
  expect(await cookie(page, COOKIE.session)).toBeUndefined();
  await page.goto("/");
  const u = new URL(page.url());
  expect([u.pathname, u.searchParams.get("returnTo")]).toEqual(["/login", "/"]);
});

// ================================================================= 탈퇴·복구

async function withdrawViaUi(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("link", { name: "계정 탈퇴" }).click();
  await expect(page).toHaveURL(`${AUTH_BASE}/account/withdraw`);
  await expect(page.getByText(TEXT.withdrawWarn)).toBeVisible();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `/account/withdraw ${w}`);
  }
  await page.getByRole("checkbox").check();
  await page.locator('form[action="/auth/withdraw"]').getByRole("button").click();
  await expect(page).toHaveURL(`${AUTH_BASE}/login?notice=withdrawn`);
  await expect(page.getByText(TEXT.withdrawn, { exact: true })).toBeVisible();
  expect(await cookie(page, COOKIE.session)).toBeUndefined();
}

test("withdraw → fresh login → 복구하기: the pending account is restored (gen+1) without a second grant", async ({ page }) => {
  const subject = newSubject("google");
  await login(page, "google", subject);
  const before = await accountOf("google", subject);
  await withdrawViaUi(page);
  expect(await accountOf("google", subject)).toMatchObject({ userId: before!.userId, status: "pending_deletion", gen: 2, balance: 10, ledger: 1 });
  await page.goto("/");
  expect(new URL(page.url()).pathname, "old session no longer works").toBe("/login");

  expect(await login(page, "google", subject)).toBe(`${AUTH_BASE}/account/restore`);
  await expect(page.getByText(TEXT.restoreAsk)).toBeVisible();
  expect(await cookie(page, COOKIE.recovery), "recovery proof").toBeDefined();
  expect(await cookie(page, COOKIE.session), "no session while pending").toBeUndefined();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectLayoutOk(page, `/account/restore ${w}`);
  }
  await page.getByRole("button", { name: /^(계정 )?복구하기$/ }).click();
  await expect(page).toHaveURL(`${AUTH_BASE}/`);
  await expectSignedInHome(page, "restored");
  expect(await cookie(page, COOKIE.recovery)).toBeUndefined();
  expect(await cookie(page, COOKIE.session)).toBeDefined();
  expect(await accountOf("google", subject)).toMatchObject({ userId: before!.userId, status: "active", gen: 3, balance: 10, ledger: 1 });
});

test("withdraw → fresh login → 복구하지 않기: signs out and keeps the account pending", async ({ page }) => {
  const subject = newSubject("kakao");
  await login(page, "kakao", subject);
  await withdrawViaUi(page);
  expect(await login(page, "kakao", subject)).toBe(`${AUTH_BASE}/account/restore`);
  await page.getByRole("button", { name: "복구하지 않기" }).click();
  await expect(page).toHaveURL(`${AUTH_BASE}/login?notice=signed_out`);
  expect(await cookie(page, COOKIE.recovery)).toBeUndefined();
  expect(await cookie(page, COOKIE.session)).toBeUndefined();
  expect(await accountOf("kakao", subject)).toMatchObject({ status: "pending_deletion", gen: 2 });
});

test("/account/restore without a proof shows the expired text and a /login link; signed-out /account/withdraw → /login?returnTo=/settings", async ({ page }) => {
  await page.goto("/account/restore");
  await expect(page.getByText(TEXT.recoveryExpired)).toBeVisible();
  await expect(page.locator('main a[href="/login"]')).toHaveCount(1);
  await expect(page.locator('form[action="/auth/restore"]')).toHaveCount(0);
  await page.goto("/account/withdraw");
  const u = new URL(page.url());
  expect([u.pathname, u.searchParams.get("returnTo")]).toEqual(["/login", "/settings"]);
});

// ================================================================= 키보드·이동 중·JS 없음

for (const w of WIDTHS) {
  test(`keyboard only at ${w}px: Tab to Google, Enter shows 이동 중… once (double submit refused, label unchanged), then the login completes`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/login");
    await expectLayoutOk(page, `/login ${w}`);
    const held = await holdStart(page, { subject: newSubject("google") }, false);
    const g = providerButton(page, "google");
    for (let i = 0; i < 30 && !(await g.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(g, "reached by Tab").toBeFocused();
    const outline = await g.evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline, "visible focus ring").not.toBe("none");
    // 제출 뒤에는 navigation(붙잡힌 start POST)이 끝나지 않으므로 locator·evaluate를 쓰지 않는다:
    // 페이지 안 관찰 보고와 keyboard·mouse 입력만 쓴다(미리 잰 Kakao 좌표).
    const kakaoBox = await providerButton(page, "kakao").boundingBox();
    expect(kakaoBox, "Kakao button measured before submitting").not.toBeNull();
    const observed = await observeAuthForms(page);
    const labels = { google: PROVIDER_BUTTON.google.name, kakao: PROVIDER_BUTTON.kakao.name };
    const before = await observed.waitFor((s) => s.buttons.length === 2, "initial provider state");
    expect(before.buttons.map((b) => [b.provider, b.label]), "labels before submitting").toEqual([["google", labels.google], ["kakao", labels.kakao]]);
    await page.keyboard.press("Enter");
    const moving = await observed.waitFor((s) => s.status.some((x) => x.text === TEXT.moving && x.visible), "visible 이동 중… status");
    expect(moving.buttons.map((b) => [b.provider, b.label]), "provider labels unchanged while moving").toEqual([["google", labels.google], ["kakao", labels.kakao]]);
    expect(moving.buttons.map((b) => [b.provider, b.visible]), "both provider buttons stay visible while moving").toEqual([["google", true], ["kakao", true]]);
    const google = moving.buttons.find((b) => b.provider === "google");
    expect(google?.ariaDisabled === "true" || google?.disabled === true, "button marked busy").toBe(true);
    await page.keyboard.press("Enter");
    await page.mouse.click(kakaoBox!.x + kakaoBox!.width / 2, kakaoBox!.y + kakaoBox!.height / 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(held.count(), "only one start POST").toBe(1);
    const after = observed.last();
    expect(after?.buttons.map((b) => [b.provider, b.label]), "labels still unchanged after the second attempts").toEqual([["google", labels.google], ["kakao", labels.kakao]]);
    expect(after?.status.some((x) => x.text === TEXT.moving && x.visible), "still moving").toBe(true);
    expect(after?.buttons.map((b) => [b.provider, b.visible]), "both provider buttons still visible after the second attempts").toEqual([["google", true], ["kakao", true]]);
    held.release();
    const { callback } = await held.result();
    await held.dispose();
    await page.goto(callback);
    await expectSignedInHome(page, `keyboard ${w}`);
  });
}

test("without JavaScript the provider form still POSTs (303) and the login completes", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const subject = newSubject("kakao");
    await page.goto("/login");
    const held = await holdStart(page, { subject });
    await providerButton(page, "kakao").click();
    const r = await held.result();
    expect(r.status).toBe(303);
    await held.dispose();
    await page.goto(r.callback);
    // JS 없이도 실제 SSR 빈 계정 보드에 도착한다(상호작용 쓰기는 요구하지 않는다).
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(escapeRe(dateLabel(seoulDate()))) })).toBeVisible();
    await expect(page.getByText(DIARY_TEXT.empty, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: TEXT.signedIn })).toHaveCount(0);
    expect(await accountOf("kakao", subject)).toMatchObject({ status: "active", balance: 10, ledger: 1 });
  } finally {
    await context.close();
  }
});

test("real HTTP: logout/withdraw/restore/start reject a missing, \"null\" or foreign Origin (403, nothing changes); withdraw without confirm=withdraw returns to /account/withdraw", async ({ page }) => {
  const subject = newSubject("google");
  await login(page, "google", subject);
  const s1 = (await cookie(page, COOKIE.session))!.value;
  for (const origin of [undefined, "null", "https://evil.example", "http://127.0.0.1:3301"]) {
    for (const [path, form] of [
      ["/auth/logout", {}],
      ["/auth/withdraw", { confirm: "withdraw" }],
      ["/auth/restore", {}],
      ["/auth/google/start", { returnTo: "/" }],
    ] as const) {
      const res = await page.request.post(path, { form, headers: origin === undefined ? {} : { origin }, maxRedirects: 0 });
      expect(res.status(), `${path} origin=${String(origin)}`).toBe(403);
      expect(res.headers()["location"]).toBeUndefined();
      expect(res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie"), `${path}: no cookies`).toEqual([]);
    }
  }
  const noConfirm = await page.request.post("/auth/withdraw", { form: { confirm: "yes" }, headers: { origin: AUTH_BASE }, maxRedirects: 0 });
  expect(noConfirm.status()).toBe(303);
  expect(noConfirm.headers()["location"]).toBe(`${AUTH_BASE}/account/withdraw`);
  expect((await cookie(page, COOKIE.session))!.value, "session kept").toBe(s1);
  expect(await accountOf("google", subject)).toMatchObject({ status: "active", gen: 1, ledger: 1 });
  for (const path of ["/auth/logout", "/auth/withdraw", "/auth/restore", "/auth/google/start"]) {
    expect((await page.request.get(path, { maxRedirects: 0 })).status(), `GET ${path}`).toBe(405);
  }
});
