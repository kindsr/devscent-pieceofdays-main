// Vitest 전용 `server-only` no-op(PLAN_mvp-authentication §6). 제품 `next build`에는 쓰지 않는다.
// Next는 `server-only`를 내장 처리하지만 Vitest는 그 모듈을 해석하지 못하므로 alias로 이 파일을 대신 읽는다.
export {};
