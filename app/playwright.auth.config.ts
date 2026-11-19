import { defineConfig, devices } from "@playwright/test";

// F4 B4 인증 E2E(PLAN_mvp-oidc-integration §9 E1). 격리 Cloud·CI 전용:
// - globalSetup(tests/e2e-auth/global-setup.ts)이 POD_FULL_CHECK_ISOLATED=1·일회용 PG18 guard를 먼저 확인하고,
//   일회용 DB(migration CLI up)·실제 mock OIDC issuer(RS256·PKCE·state·nonce 검증)를 준비한 뒤
//   next dev를 127.0.0.1:3300에 직접 띄운다(포트가 이미 쓰이면 재사용하지 않고 실패).
//   Playwright webServer는 globalSetup보다 먼저 시작되어 mock 주소·DB URL을 받을 수 없으므로 쓰지 않는다.
// - 순차 실행(worker 1). trace·video·screenshot·HAR을 남기지 않는다(쿠키·code·state가 담길 수 있다).
// - 실제 Google·Kakao를 호출하지 않는다. 자격·키는 모두 ci-only 가짜 값이다.
export const AUTH_E2E_PORT = 3300;

export default defineConfig({
  testDir: "tests/e2e-auth",
  globalSetup: "./tests/e2e-auth/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${AUTH_E2E_PORT}`,
    trace: "off",
    video: "off",
    screenshot: "off",
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", testMatch: "**/device.spec.ts", use: { ...devices["Desktop Safari"] } },
  ],
});
