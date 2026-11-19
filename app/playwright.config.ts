import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// E2E는 로컬 고정 사용자 모드(next dev + POD_LOCAL_FIXTURE=1)에서만 돈다. 운영 빌드에서는 이 모드가 거부된다.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/settings`,
    env: { POD_LOCAL_FIXTURE: "1", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
