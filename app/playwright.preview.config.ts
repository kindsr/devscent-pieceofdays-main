import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PREVIEW_PORT ?? 3400);

// 개발 도메인 /try/ 체험판(정적 파일) 브라우저 시험(docs/plans/PLAN_dev-local-preview.md).
// - 격리 Cloud/CI/개발 PC에서만 실행한다(POD_FULL_CHECK_ISOLATED=1). 공유 서버에서 띄우지 않는다.
// - Next 서버·DB·실제 공급자 없이 frontend/public을 python 표준 정적 서버로 127.0.0.1에만 연다.
// - 다른 E2E(3100)·운영 경계(3200)와 다른 포트이며 순차 실행한다. 기존 app lock의 Playwright만 쓴다.
if (process.env.POD_FULL_CHECK_ISOLATED !== "1") {
  throw new Error("playwright.preview.config.ts runs only in an isolated Cloud/CI/dev PC (set POD_FULL_CHECK_ISOLATED=1)");
}

export default defineConfig({
  testDir: "tests/e2e-preview",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off", acceptDownloads: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ../frontend/public`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
