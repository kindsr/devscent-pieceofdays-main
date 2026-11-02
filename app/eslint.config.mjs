import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Konva는 클라이언트 전용 꾸미기 모듈(src/ui/decorate/) 밖에서 import하지 않는다.
const KONVA_PATHS = [
  { name: "konva", message: "Konva는 src/ui/decorate/ 클라이언트 모듈에서만 쓴다." },
  { name: "react-konva", message: "react-konva는 src/ui/decorate/ 클라이언트 모듈에서만 쓴다." },
];
const KONVA_SUBPATH = { group: ["konva/*"], message: "Konva는 src/ui/decorate/ 클라이언트 모듈에서만 쓴다." };
// UI·공유 모듈은 서버 모듈을 import하지 않는다(타입 import 포함, alias @/server·상대 경로 …/server).
// 경로 규칙이라 전이 import(ui → shared → server)까지 보장하지 않는다. F4/F5에서 강화 검증한다.
const SERVER_IMPORT = {
  regex: "^(@/server|(\\.{1,2}/)+(.+/)?server)(/.*)?$",
  message: "src/ui·src/shared는 서버 모듈을 import하지 않는다. 공유 타입은 @/shared에 둔다.",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/ui/decorate/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: KONVA_PATHS, patterns: ["konva/*"] }],
    },
  },
  {
    // flat config에서는 뒤 블록의 같은 규칙이 앞 블록 옵션을 덮어쓰므로 Konva 금지와 server 금지를 합성한다.
    files: ["src/ui/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    ignores: ["src/ui/decorate/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: KONVA_PATHS, patterns: [KONVA_SUBPATH, SERVER_IMPORT] }],
    },
  },
  {
    // decorate 안에서는 Konva를 허용하고 server import만 막는다.
    files: ["src/ui/decorate/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [SERVER_IMPORT] }],
    },
  },
  globalIgnores([".next/**", "out/**", "next-env.d.ts", "test-results/**", "playwright-report/**"]),
]);
