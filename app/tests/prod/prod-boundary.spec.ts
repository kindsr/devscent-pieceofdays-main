import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

// 운영 빌드(next start, 고정 사용자 플래그 없음)에서는 예시 기록·시험 fixture가 드러나지 않고,
// 플래그를 켠 운영 실행은 시작을 거부한다. 위조한 사용자 ID 헤더·질의값도 인증으로 쓰이지 않는다.
// 예시 기록 본문과 고정 사용자 ID. 위조 질의값은 Next가 요청 주소 그대로 페이로드에 되돌려 주므로,
// 고정 사용자 ID는 주소에 넣지 않은 요청에서만 확인한다.
const FIXTURE_TEXT = ["창문을 열었더니", "엄마와 20분 통화", "은행나무 길이 반쯤"];
const FIXTURE_USER = "local-fixture-user";
const FORGED = { headers: { "x-user-id": FIXTURE_USER } };

for (const path of ["/", "/days", "/days/2026-11-02"]) {
  test(`${path} shows the not-ready notice and no sample data`, async ({ request }) => {
    for (const url of [path, `${path}?userId=${FIXTURE_USER}&user=${FIXTURE_USER}`]) {
      for (const opts of [{}, FORGED]) {
        const res = await request.get(url, opts);
        expect(res.status(), url).toBe(200);
        const html = await res.text();
        expect(html.includes("아직 준비 중이에요"), `${url} notice`).toBe(true);
        for (const t of FIXTURE_TEXT) expect(html.includes(t), `${url} must not contain ${t}`).toBe(false);
        if (!url.includes(FIXTURE_USER)) expect(html.includes(FIXTURE_USER), `${url} must not contain the fixture user id`).toBe(false);
      }
    }
  });
}

test("Konva test fixture is not found, even with forged identity", async ({ request }) => {
  for (const opts of [{}, FORGED]) {
    expect((await request.get("/dev/konva-smoke?userId=local-fixture-user", opts)).status()).toBe(404);
  }
});

test("rendered page has no write button or sample pieces", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "아직 준비 중이에요" })).toBeVisible();
  await expect(page.getByRole("link", { name: "조각 추가" })).toHaveCount(0);
  await expect(page.locator(".piece")).toHaveCount(0);
});

test("production start with POD_LOCAL_FIXTURE=1 refuses to start", async () => {
  const port = String(Number(process.env.PROD_SMOKE_PORT ?? 3200) + 1);
  // 자식 프로세스에만 플래그를 준다(현재 프로세스 env는 바꾸지 않음).
  const child = spawn("npx", ["next", "start", "-p", port, "-H", "127.0.0.1"], {
    env: { ...process.env, POD_LOCAL_FIXTURE: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  clearTimeout(timer);
  expect(out).toContain("POD_LOCAL_FIXTURE=1 is refused in phase-production-server");
  expect(code).toBe(1);
});
