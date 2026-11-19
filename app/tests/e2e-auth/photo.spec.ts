// Real account UI + PG + private SeaweedFS storage. Synthetic images only; no product DI/auth bypass.
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { readDisposableEnv, withAdmin } from "../db/helpers";
import { AUTH_BASE, E2E_ENV } from "./support";
import { DIARY_TEXT, momentsOf, signIn, statusWith, topAdd } from "./diary-support";
import { expectCleanupRefusesApp, fixtureObject, runPhotoCleanup, syntheticPhoto } from "./photo-store-fixture";

const FAILURE = "사진 저장을 확인하지 못했어요. 고른 사진과 메모는 그대로 두었어요. 다시 시도해 주세요.";
const dialog = (page: Page) => page.getByRole("dialog");
const memo = (page: Page) => dialog(page).getByRole("textbox", { name: "메모", exact: true });
const input = (page: Page) => dialog(page).getByLabel("사진 1장", { exact: true });
const piece = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function photosOf(userId: string) {
  const name = process.env[E2E_ENV.db];
  if (!name) throw new Error("photo E2E must use successful auth globalSetup");
  return withAdmin(readDisposableEnv(), async (client) => (await client.query<{
    id: string; moment_id: string; object_key: string; sha256: string; width: number; height: number;
  }>("SELECT p.id::text, p.moment_id::text, u.object_key, p.sha256, p.width, p.height FROM pod.moment_photos p JOIN pod.photo_uploads u ON u.id = p.id WHERE p.user_id = $1 ORDER BY p.created_at, p.id", [userId])).rows, name);
}

test("one synthetic photo can be selected/cancelled, really stored/read privately, denied to another account, then deleted through the real cleanup CLI", async ({ page, browser }) => {
  const account = await signIn(page);
  await topAdd(page).click();
  await memo(page).fill("한 장으로 남긴 가짜 시험 기억");
  const file = await syntheticPhoto();
  await input(page).setInputFiles(file);
  await expect(dialog(page).getByRole("button", { name: "사진 선택 취소", exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "사진 선택 취소", exact: true }).click();
  expect(await input(page).evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
  await expect(memo(page)).toHaveValue("한 장으로 남긴 가짜 시험 기억");
  expect(await momentsOf(account.userId)).toEqual([]);
  await input(page).setInputFiles(file);
  const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/photos/upload" && response.request().method() === "POST");
  await dialog(page).getByRole("button", { name: "저장", exact: true }).click();
  const upload = await uploaded;
  expect(upload.status()).toBe(201);
  const reply = await upload.json() as { ok: boolean; value: { id: string; version: number } };
  expect(reply).toEqual({ ok: true, value: { id: expect.any(String), version: 1 } });
  await expect(dialog(page)).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.created)).toBeVisible();
  const rows = await photosOf(account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.moment_id).toBe(reply.value.id);
  const src = `/photos/${rows[0]!.id}`;
  const image = piece(page, "한 장으로 남긴 가짜 시험 기억").getByRole("img", { name: "조각 사진", exact: true });
  await expect(image).toHaveAttribute("src", src);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(48);
  const owned = await page.request.get(src, { maxRedirects: 0 });
  expect(owned.status()).toBe(200);
  expect(owned.headers()["content-type"]).toBe("image/jpeg");
  expect(owned.headers()["cache-control"]).toBe("private, no-store");
  expect(owned.headers()["x-content-type-options"]).toBe("nosniff");
  const bytes = await owned.body();
  expect(hash(bytes)).toBe(rows[0]!.sha256);
  expect(hash((await fixtureObject(rows[0]!.object_key))!)).toBe(hash(bytes));
  for (const privateValue of [account.userId, rows[0]!.object_key, rows[0]!.sha256]) expect(JSON.stringify(reply).includes(privateValue)).toBe(false);

  const foreign = await browser.newContext({ baseURL: AUTH_BASE });
  try {
    const otherPage = await foreign.newPage();
    await signIn(otherPage, "kakao");
    const denied = await foreign.request.get(src, { maxRedirects: 0 });
    const absent = await foreign.request.get(`/photos/${randomUUID()}`, { maxRedirects: 0 });
    expect(denied.status()).toBe(404);
    expect(absent.status()).toBe(404);
    expect(await denied.body()).toEqual(await absent.body());
    expect(denied.headers()["content-type"]).not.toContain("image/");
    expect(denied.headers()["cache-control"]).toBe("private, no-store");
    expect(denied.headers()["x-content-type-options"]).toBe("nosniff");
  } finally { await foreign.close(); }
  const signedOut = await browser.newContext({ baseURL: AUTH_BASE });
  try {
    const denied = await signedOut.request.get(src, { maxRedirects: 0 });
    expect(denied.status()).toBe(401);
    expect(denied.headers()["content-type"]).not.toContain("image/");
    expect(denied.headers()["cache-control"]).toBe("private, no-store");
  } finally { await signedOut.close(); }

  await piece(page, "한 장으로 남긴 가짜 시험 기억").getByRole("button", { name: /조각 삭제/ }).click();
  await page.getByRole("dialog", { name: DIARY_TEXT.deleteTitle }).getByRole("button", { name: "지우기", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(statusWith(page, DIARY_TEXT.deleted)).toBeVisible();
  expect(await momentsOf(account.userId)).toEqual([]);
  expect(await photosOf(account.userId)).toEqual([]);
  const deletedHttp = await page.request.get(src, { maxRedirects: 0 });
  expect(deletedHttp.status()).toBe(404);
  expect(deletedHttp.headers()["content-type"]).not.toContain("image/");
  expect(await fixtureObject(rows[0]!.object_key), "metadata deletion queues the real object before cleanup").not.toBeNull();
  await expectCleanupRefusesApp();
  expect(await fixtureObject(rows[0]!.object_key), "wrong-role cleanup did not delete the object").not.toBeNull();
  const stats = await runPhotoCleanup(100);
  expect(stats.failed).toBe(0);
  expect(stats.deleted).toBeGreaterThan(0);
  expect(await fixtureObject(rows[0]!.object_key), "real SDK Get404 after the actual Node cleanup batch").toBeNull();
});

test("a pending upload locks repeat/close; a lost committed response keeps File and memo, and explicit retry confirms the same moment without duplicates", async ({ page }) => {
  const account = await signIn(page);
  await topAdd(page).click();
  const draft = "저장 확인을 잃어도 보존할 원고";
  const file = await syntheticPhoto();
  await memo(page).fill(draft);
  await input(page).setInputFiles(file);
  let calls = 0;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  await page.route("**/photos/upload", async (route) => {
    calls++;
    if (calls !== 1) return route.continue();
    reached();
    await gate;
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status(), "the server really commits before the response is lost").toBe(201);
    await response.body();
    return route.abort("connectionreset");
  });
  try {
    await dialog(page).getByRole("button", { name: "저장", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await entered;
    await expect(dialog(page).getByRole("button", { name: "저장 중…", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    expect(await momentsOf(account.userId), "no success before the HTTP request is released").toEqual([]);
    release();
    await expect(page.getByText(FAILURE, { exact: true })).toBeVisible();
    await expect(memo(page)).toHaveValue(draft);
    expect(await input(page).evaluate((element: HTMLInputElement) => ({ name: element.files?.[0]?.name, count: element.files?.length }))).toEqual({ name: file.name, count: 1 });
    await expect(statusWith(page, DIARY_TEXT.created)).toHaveCount(0);
    expect(await momentsOf(account.userId), "the first response was unknown to the UI, not an uncommitted write").toHaveLength(1);
    expect(await photosOf(account.userId)).toHaveLength(1);
    const confirmed = page.waitForResponse((response) => new URL(response.url()).pathname === "/photos/upload" && response.request().method() === "POST");
    await dialog(page).getByRole("button", { name: "저장", exact: true }).click();
    expect((await confirmed).status()).toBe(200);
    await expect(dialog(page)).toHaveCount(0);
    await expect(statusWith(page, DIARY_TEXT.created)).toBeVisible();
    expect(calls).toBe(2);
    expect(await momentsOf(account.userId)).toHaveLength(1);
    expect(await photosOf(account.userId)).toHaveLength(1);
  } finally { release(); await page.unroute("**/photos/upload"); }
});

test("real multipart HTTP rejects wrong Origin, unknown fields and disguised content with fixed errors; a valid replay is 200 and changed input is 409", async ({ page }) => {
  const account = await signIn(page);
  const file = await syntheticPhoto();
  const requestId = randomUUID();
  const multipart = { memo: "실제 HTTP 사진 요청", requestId, photo: file };
  const post = (values: typeof multipart & Record<string, unknown>, origin = AUTH_BASE) => page.request.post("/photos/upload", { headers: { origin }, multipart: values as typeof multipart, maxRedirects: 0 });
  const forbidden = await post(multipart, "https://ci-only-wrong-origin.invalid");
  expect(forbidden.status()).toBe(403);
  expect(await forbidden.json()).toEqual({ ok: false, error: "forbidden" });
  const unknown = await post({ ...multipart, userId: account.userId });
  expect(unknown.status()).toBe(400);
  expect(await unknown.json()).toEqual({ ok: false, error: "invalid_request" });
  const disguised = await post({ ...multipart, photo: { name: "ci-only.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>") } });
  expect(disguised.status()).toBe(400);
  expect(await disguised.json()).toEqual({ ok: false, error: "invalid_photo" });
  expect(await momentsOf(account.userId)).toEqual([]);
  const first = await post(multipart);
  expect(first.status()).toBe(201);
  const result = await first.json();
  expect(result).toEqual({ ok: true, value: { id: expect.any(String), version: 1 } });
  const repeated = await post(multipart);
  expect(repeated.status()).toBe(200);
  expect(await repeated.json()).toEqual(result);
  const conflict = await post({ ...multipart, memo: "다른 요청 내용" });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toEqual({ ok: false, error: "conflict" });
  expect(await momentsOf(account.userId)).toHaveLength(1);
  expect(await photosOf(account.userId)).toHaveLength(1);
});
