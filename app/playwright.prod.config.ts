import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PROD_SMOKE_PORT ?? 3200);

// 운영 모드 경계 시험: 이미 만든 빌드(.next)를 next start로 loopback(127.0.0.1)에서만 띄운다.
// 로컬 고정 사용자 플래그는 명시적으로 비운다. dev E2E(3100)와 다른 포트이며 순차 실행한다.
export default defineConfig({
  testDir: "tests/prod",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/settings`,
    env: { POD_LOCAL_FIXTURE: "", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
