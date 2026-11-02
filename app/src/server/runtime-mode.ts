/**
 * 로컬·테스트 전용 고정 사용자(예시 데이터·메모리 저장) 모드.
 * POD_LOCAL_FIXTURE=1 이고 NODE_ENV가 development/test일 때만 켜진다.
 * 운영 빌드·실행에서 켜져 있으면 시작을 거부한다(PLAN_mvp-foundation §1).
 */
type Env = { readonly NODE_ENV?: string; readonly POD_LOCAL_FIXTURE?: string };

const PRODUCTION_PHASES = new Set(["phase-production-build", "phase-production-server", "phase-export"]);

function flagOn(env: Env): boolean {
  const v = env.POD_LOCAL_FIXTURE;
  if (v === undefined || v === "") return false;
  if (v !== "1") throw new Error(`POD_LOCAL_FIXTURE must be unset or exactly "1" (got ${JSON.stringify(v)})`);
  return true;
}

export function isFixtureModeEnabled(env: Env): boolean {
  if (!flagOn(env)) return false;
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return true;
  throw new Error(
    `POD_LOCAL_FIXTURE=1 is local/test only and is refused outside development/test (NODE_ENV=${env.NODE_ENV ?? "unset"}); never enable it in production`,
  );
}

/** next.config.ts에서 호출한다. 운영 빌드/서버 단계에서 플래그가 켜져 있으면 거부한다. */
export function assertFixtureModeAllowed(phase: string, env: Env): void {
  if (PRODUCTION_PHASES.has(phase) && flagOn(env)) {
    throw new Error(`POD_LOCAL_FIXTURE=1 is refused in ${phase}: the fixed local user must never run in a production build or server`);
  }
  isFixtureModeEnabled(env);
}
