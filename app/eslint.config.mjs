import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Konva는 클라이언트 전용 꾸미기 모듈(src/ui/decorate/) 밖에서 import하지 않는다.
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/ui/decorate/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "konva", message: "Konva는 src/ui/decorate/ 클라이언트 모듈에서만 쓴다." }, { name: "react-konva", message: "react-konva는 src/ui/decorate/ 클라이언트 모듈에서만 쓴다." }], patterns: ["konva/*"] },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "next-env.d.ts", "test-results/**", "playwright-report/**"]),
]);
