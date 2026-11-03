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

/** F4 auth 모드 검사에 쓰는 env(PLAN_mvp-oidc-integration §4.2). 이 파일은 순수 Node 경로로 남는다. */
type ModeEnv = {
  readonly NODE_ENV?: string;
  readonly POD_LOCAL_FIXTURE?: string;
  readonly POD_AUTH_PROVIDERS?: string;
  readonly POD_AUTH_MOCK_OIDC_ISSUER?: string;
};

const nonBlank = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

/** 고정 사용자와 실제 auth 동시 사용, 또는 development/test 밖의 mock issuer를 찾는다(§4.2 표, 위에서부터). */
export function authModeProblem(env: ModeEnv, nodeEnv: string | undefined): "fixture_with_auth" | "mock_outside_dev" | null {
  if (env.POD_LOCAL_FIXTURE === "1" && nonBlank(env.POD_AUTH_PROVIDERS)) return "fixture_with_auth";
  if (nonBlank(env.POD_AUTH_MOCK_OIDC_ISSUER) && nodeEnv !== "development" && nodeEnv !== "test") return "mock_outside_dev";
  return null;
}

/** next.config.ts는 모든 phase에서 호출한다. phase가 null이면 요청 시점이다. */
export function assertAuthModeAllowed(phase: string | null, env: ModeEnv): void {
  const problem = authModeProblem(env, env.NODE_ENV);
  if (problem === "fixture_with_auth") {
    throw new Error("POD_LOCAL_FIXTURE=1 cannot be combined with POD_AUTH_PROVIDERS: the fixed local user and real login are exclusive");
  }
  if (phase !== null && PRODUCTION_PHASES.has(phase) && nonBlank(env.POD_AUTH_MOCK_OIDC_ISSUER)) {
    throw new Error(`POD_AUTH_MOCK_OIDC_ISSUER is refused in ${phase}: the mock issuer is development/test only`);
  }
  if (phase !== null && problem === "mock_outside_dev") {
    throw new Error("POD_AUTH_MOCK_OIDC_ISSUER is refused outside NODE_ENV development/test");
  }
}
