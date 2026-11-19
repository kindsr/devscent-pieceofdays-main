import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// DB 시험 전용(npm run test:db). 일회용 PostgreSQL 18 컨테이너에서만 실행한다.
// globalSetup이 POD_TEST_DB_DISPOSABLE=1·loopback POD_TEST_ADMIN_URL을 먼저 확인하고 role을 준비한다.
// 단위 시험(vitest.config.ts)은 tests/unit만 검색하므로 이 시험을 포함하지 않는다.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // F4a: Next 내장 `server-only`의 Vitest 전용 no-op(제품 build에는 적용되지 않는다).
      "server-only": fileURLToPath(new URL("./tests/server-only-noop.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/db/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
