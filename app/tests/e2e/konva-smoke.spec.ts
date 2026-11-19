import { expect, test } from "@playwright/test";

// Konva/react-konva 최소 호환: 서버 렌더에 캔버스가 없고, 브라우저에서 스티커 1개 끌기와 펜 획 1개가 동작한다.
test("Konva is not server-rendered", async ({ request }) => {
  const html = await (await request.get("/dev/konva-smoke")).text();
  expect(html).toContain('data-testid="konva-loading"');
  expect(html).not.toContain("<canvas");
});

test("drag one sticker and draw one pen stroke", async ({ page }) => {
  await page.goto("/dev/konva-smoke");
  const root = page.getByTestId("konva-smoke");
  const canvas = root.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect(root).toHaveAttribute("data-sticker", "70,70");
  const box = (await canvas.boundingBox())!;

  await page.mouse.move(box.x + 70, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 120, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(root).toHaveAttribute("data-sticker", "200,150");
  await expect(root).toHaveAttribute("data-strokes", "0");

  await page.mouse.move(box.x + 30, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 210, { steps: 6 });
  await page.mouse.move(box.x + 130, box.y + 205, { steps: 6 });
  await page.mouse.up();
  await expect(root).toHaveAttribute("data-strokes", "1");
  expect(Number(await root.getAttribute("data-last-points"))).toBeGreaterThanOrEqual(6);
  await expect(root).toHaveAttribute("data-sticker", "200,150");
});
