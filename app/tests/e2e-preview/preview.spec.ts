// DEV PREVIEW RED — 개발 정적 이미지 /try/ 체험판의 실제 브라우저 사용자 흐름(docs/plans/PLAN_dev-local-preview.md).
//
// - playwright.preview.config.ts가 frontend/public을 127.0.0.1 정적 서버로 연다(격리 환경 전용). Next·DB·로그인 없음.
// - 브라우저 저장은 빠른 체험용 임시 기본값이다. 계정·서버 저장·이미지·꾸미기·감정덩어리·마켓은 기대하지 않는다.
// - UI 계약(D 문구·상태, 최소 고정):
//   제목 "오늘의 조각" 또는 "M월 D일 X요일의 조각" · "조각 추가" · 조각마다 "수정"/"삭제" 버튼 ·
//   작성 팝업(dialog) "메모" 칸 + "저장"/"취소" · 삭제·전체 지우기는 확인 dialog("취소"로 취소) ·
//   "하루 한 줄" 칸(form 또는 dialog 안의 "저장") · 메뉴(navigation) "오늘"/"모아보기"/"설정" ·
//   모아보기 달력의 날짜 링크 이름에 "M월 D일" · 설정의 글꼴 라디오 고딕/명조/손글씨 · "기록 내려받기" · "체험 기록 지우기" ·
//   "이 브라우저에 저장"과 "계정 동기화 전" 안내.
// - 각 사례는 새 브라우저 context(빈 localStorage)에서 시작한다. 날짜 기대값은 시험 실행 시각의 서울 날짜다.
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";

const KEY = "pieceofdays.dev-preview.v1";

function seoulParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { m: Number(p.month), d: Number(p.day), iso: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` };
}
const today = seoulParts();
const TODAY_LABEL = `${today.m}월 ${today.d}일`;

async function openTry(page: Page, path = "/try/"): Promise<void> {
  const res = await page.goto(path);
  expect(res?.status(), `GET ${path} (the /try/ preview must exist)`).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const raw = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), KEY);
const nav = (page: Page, name: "오늘" | "모아보기" | "설정") =>
  page.getByRole("navigation").getByRole("link", { name, exact: true }).first().click();
const addButton = (page: Page) =>
  page.getByRole("button", { name: /조각 추가/ }).or(page.getByRole("link", { name: /조각 추가/ })).first();
const piece = (page: Page, text: string): Locator => page.getByRole("listitem").filter({ hasText: text });
const dialog = (page: Page) => page.getByRole("dialog");

async function writePiece(page: Page, text: string): Promise<void> {
  await addButton(page).click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await dlg.getByRole("textbox", { name: "메모" }).fill(text);
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(piece(page, text)).toBeVisible();
}

async function writeSummary(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "하루 한 줄" });
  if (!(await box.isVisible())) await page.getByRole("button", { name: /하루 한 줄|한 줄 쓰기|고쳐 쓰기/ }).first().click();
  await expect(box).toBeVisible();
  await box.fill(text);
  await box.locator("xpath=ancestor::*[self::form or self::dialog][1]").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(o.sw, `${label}: no horizontal overflow`).toBeLessThanOrEqual(o.cw);
}

// ================================================================= 정적 서버 대조

test("control: the isolated static server serves the existing dev root and D artboard (200)", async ({ request }) => {
  expect((await request.get("/")).status()).toBe(200);
  expect((await request.get("/design/d-warm-pieces/")).status()).toBe(200);
});

// ================================================================= 첫 화면

test("starts as an empty Seoul-today D board with the browser-storage notice and no login/sample/credit/market features", async ({ page }) => {
  await openTry(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(new RegExp(`(오늘|${TODAY_LABEL} .요일)의 조각`));
  await expect(page.getByText(/이 브라우저에 저장/).first()).toBeVisible();
  await expect(page.getByText(/계정 동기화 전/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /수정/ })).toHaveCount(0);
  await expect(addButton(page)).toBeVisible();
  for (const name of ["오늘", "모아보기", "설정"]) {
    await expect(page.getByRole("navigation").getByRole("link", { name, exact: true }).first()).toBeVisible();
  }
  const body = await page.locator("body").innerText();
  for (const word of ["로그인", "감정덩어리", "감정 덩어리", "마켓", "예시 이미지"]) expect(body, word).not.toContain(word);
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect((await raw(page)) ?? "", "opening the page creates no sample data").not.toMatch(/"text"/);
});

// ================================================================= 작성·수정·모아보기·삭제

test("write → reload → edit → 모아보기 → reopen the date → delete (cancel first) persists across reloads", async ({ page }) => {
  await openTry(page);
  await writePiece(page, "국숫집 줄이 짧았다");
  await page.reload();
  await expect(piece(page, "국숫집 줄이 짧았다")).toBeVisible();

  await piece(page, "국숫집 줄이 짧았다").getByRole("button", { name: /수정/ }).click();
  const dlg = dialog(page);
  await expect(dlg.getByRole("textbox", { name: "메모" })).toHaveValue("국숫집 줄이 짧았다");
  await dlg.getByRole("textbox", { name: "메모" }).fill("국숫집 줄이 생각보다 짧았다");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다")).toBeVisible();
  await page.reload();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^국숫집 줄이 짧았다$/ })).toHaveCount(0);

  await nav(page, "모아보기");
  await page.getByRole("link", { name: new RegExp(TODAY_LABEL) }).first().click();
  await expect(page.getByRole("heading", { name: new RegExp(`${TODAY_LABEL}.*의 조각`) }).first()).toBeVisible();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다").first()).toBeVisible();

  await nav(page, "오늘");
  await piece(page, "국숫집 줄이 생각보다 짧았다").getByRole("button", { name: /삭제/ }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다")).toBeVisible();
  await piece(page, "국숫집 줄이 생각보다 짧았다").getByRole("button", { name: /삭제/ }).click();
  await dialog(page).getByRole("button", { name: /삭제/ }).click();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다")).toHaveCount(0);
  await page.reload();
  await expect(piece(page, "국숫집 줄이 생각보다 짧았다")).toHaveCount(0);
});

test("하루 한 줄 and the record font survive a reload", async ({ page }) => {
  await openTry(page);
  await writePiece(page, "아침 산책");
  await writeSummary(page, "맑고 조용한 하루");
  await nav(page, "설정");
  await page.getByRole("radio", { name: /^명조/ }).check();
  await page.reload();
  await nav(page, "설정");
  await expect(page.getByRole("radio", { name: /^명조/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^고딕/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /^손글씨/ })).toBeVisible();
  await nav(page, "오늘");
  await expect(page.getByText("맑고 조용한 하루", { exact: true })).toBeVisible();
  await expect(piece(page, "아침 산책")).toBeVisible();
});

// ================================================================= 내려받기·전체 지우기

test("설정: 기록 내려받기 gives the v1 JSON; 체험 기록 지우기 asks first (cancel keeps, confirm clears only this key)", async ({ page }) => {
  await openTry(page);
  await writePiece(page, "내려받을 조각");
  await page.evaluate(() => window.localStorage.setItem("other.site.setting", "keep-me"));
  await nav(page, "설정");
  await expect(page.getByText(/이 브라우저에 저장/).first()).toBeVisible();
  const download = page.getByRole("button", { name: "기록 내려받기" }).or(page.getByRole("link", { name: "기록 내려받기" })).first();
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  const doc = JSON.parse(await readFile((await file.path())!, "utf8")) as { v: number; days: { moments: { text: string }[] }[] };
  expect(doc.v).toBe(1);
  expect(doc.days.flatMap((d) => d.moments.map((m) => m.text))).toContain("내려받을 조각");

  const clearBtn = page.getByRole("button", { name: "체험 기록 지우기" });
  await clearBtn.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  expect(await raw(page), "cancel keeps the record").toContain("내려받을 조각");
  await clearBtn.click();
  await dialog(page).getByRole("button", { name: /지우기/ }).click();
  expect(await raw(page)).toBeNull();
  expect(await page.evaluate(() => window.localStorage.getItem("other.site.setting"))).toBe("keep-me");
  await nav(page, "오늘");
  await expect(piece(page, "내려받을 조각")).toHaveCount(0);
});

// ================================================================= 입력 오류·XSS

test("empty memo is refused without saving; markup in a memo is shown as plain text and never executed", async ({ page }) => {
  await openTry(page);
  await addButton(page).click();
  const dlg = dialog(page);
  await dlg.getByRole("textbox", { name: "메모" }).fill("   ");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("textbox", { name: "메모" })).toHaveAttribute("aria-invalid", "true");
  expect(await raw(page), "nothing stored").toBeNull();
  await dlg.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dlg).toBeHidden();

  const xss = '<img src=x onerror="window.__podXss=1"><script>window.__podXss=2</script>';
  await writePiece(page, xss);
  await page.reload();
  await expect(piece(page, xss)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __podXss?: number }).__podXss)).toBeUndefined();
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(page.locator("main script")).toHaveCount(0);
});

// ================================================================= 저장 실패·손상 자료

test("setItem failure keeps the draft open and shows no success; after recovery the same draft saves", async ({ page }) => {
  await openTry(page);
  await page.evaluate(() => {
    const w = window as unknown as { __podSetItem?: Storage["setItem"] };
    w.__podSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await addButton(page).click();
  const dlg = dialog(page);
  await dlg.getByRole("textbox", { name: "메모" }).fill("저장 실패 초안");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dlg, "draft stays open").toBeVisible();
  await expect(dlg.getByRole("textbox", { name: "메모" })).toHaveValue("저장 실패 초안");
  await expect(piece(page, "저장 실패 초안")).toHaveCount(0);
  await expect(page.getByText(/저장했|저장됐|저장되었/)).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __podSetItem?: Storage["setItem"] };
    Storage.prototype.setItem = w.__podSetItem!;
  });
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dlg).toBeHidden();
  await page.reload();
  await expect(piece(page, "저장 실패 초안")).toBeVisible();
});

test("corrupt stored data is neither overwritten nor deleted by opening, writing or reloading", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((k) => window.localStorage.setItem(k, '{"v":1,"days":broken'), KEY);
  await openTry(page);
  expect(await raw(page)).toBe('{"v":1,"days":broken');
  await addButton(page).click();
  const dlg = dialog(page);
  if (await dlg.isVisible()) {
    await dlg.getByRole("textbox", { name: "메모" }).fill("손상 위에 쓰기");
    await dlg.getByRole("button", { name: "저장", exact: true }).click();
  }
  expect(await raw(page), "not overwritten").toBe('{"v":1,"days":broken');
  await page.reload();
  expect(await raw(page), "not deleted").toBe('{"v":1,"days":broken');
});

// ================================================================= 키보드·화면 폭

test("keyboard: open the compose dialog with Enter, Esc closes it without saving; delete confirm also closes with Esc", async ({ page }) => {
  await openTry(page);
  await addButton(page).focus();
  await page.keyboard.press("Enter");
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await page.keyboard.type("키보드 초안");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await raw(page)).toBeNull();
  await writePiece(page, "키보드로 지울 조각");
  await piece(page, "키보드로 지울 조각").getByRole("button", { name: /삭제/ }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(piece(page, "키보드로 지울 조각")).toBeVisible();
});

test("375 / 768 / 1440 widths: today, 모아보기 and 설정 have no horizontal overflow", async ({ page }) => {
  await openTry(page);
  await writePiece(page, "화면 폭 확인용 조각");
  await writeSummary(page, "화면 폭 확인용 한 줄");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await nav(page, "오늘");
    await expectNoHorizontalOverflow(page, `${width} 오늘`);
    await nav(page, "모아보기");
    await expectNoHorizontalOverflow(page, `${width} 모아보기`);
    await nav(page, "설정");
    await expectNoHorizontalOverflow(page, `${width} 설정`);
  }
});
