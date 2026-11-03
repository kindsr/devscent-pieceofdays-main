import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // F4a: Next 내장 `server-only`의 Vitest 전용 no-op(제품 build에는 적용되지 않는다).
      "server-only": fileURLToPath(new URL("./tests/server-only-noop.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
