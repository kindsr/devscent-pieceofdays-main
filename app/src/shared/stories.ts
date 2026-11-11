/** AI 하루 이야기 S1 공유 상한·DTO(PLAN_ai-daily-story-storage §2). 서버 모듈을 import하지 않는다. */
export const STORY_INPUT_MAX_MOMENTS = 30;
export const STORY_TEXT_MAX = 300;
export const STORY_INPUT_MAX_BYTES = 48 * 1024;
export const STORY_MAX = 2000;

export type StoryError =
  | "invalid_date"
  | "not_signed_in"
  | "no_input"
  | "input_too_large"
  | "invalid_input"
  | "conflict"
  | "unavailable"
  | "timeout"
  | "invalid_output";

/** 저장된 이야기 한 버전. 사용자·조각·사진 식별자와 내부 revision은 넣지 않는다. */
export type StoryRef = { id: string; version: number; body: string; createdAt: string };

/** 날짜별 읽기 결과. inputRevision은 예상 입력 비교용 불투명 값이며 조각을 읽지 못하면 null이다. */
export type StoryDay = {
  date: string;
  inputRevision: string | null;
  story: StoryRef | null;
  state: "none" | "current" | "outdated";
  generation: "unavailable";
};
