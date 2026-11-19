/** 예상한 실패를 값으로 돌려주는 결과 형(PLAN_mvp-domain-storage §1). 예상 밖 오류는 throw한다. */
export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
