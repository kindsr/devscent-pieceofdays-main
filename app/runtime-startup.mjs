// standalone 앱 기동 wrapper(PLAN_dev-app-deployment §4 "app/runtime-startup.mjs").
// standalone server.js는 빌드 때 직렬화한 설정을 써서 next.config의 모드 검사가 기동 때 다시 돈다고 가정하지 않는다.
// 그래서 원본 순수 모듈의 기존 검사를 운영 서버 phase로 먼저 실행한 뒤 server.js를 불러온다. 검사 규칙은 복제하지 않는다.
import { assertAuthModeAllowed, assertFixtureModeAllowed } from "./src/server/runtime-mode.ts";

const PHASE = "phase-production-server";
assertFixtureModeAllowed(PHASE, process.env);
assertAuthModeAllowed(PHASE, process.env);

await import("./server.js");
