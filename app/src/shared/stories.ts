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

// ---------------------------------------------------------------- S3 실제 생성(PLAN_ai-story-live-generation §3)

export const STORY_PHOTO_MAX = 30;
export const STORY_PHOTO_SIDE = 512;
/** 이야기용으로 다시 만든 JPEG 한 장의 상한. */
export const STORY_PHOTO_MAX_BYTES = 256 * 1024;
export const STORY_PHOTOS_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
/** 서울 요청일 기준 계정당 수동 생성 요청 수(실패 포함). */
export const STORY_MANUAL_DAILY_MAX = 3;
/** 설정 화면 고지문(정책) 버전. 바뀌면 기존 동의는 꺼진 것으로 본다. */
export const STORY_CONSENT_VERSION = 1;

export type StoryJobFailure =
  | "photo_unavailable"
  | "input_changed"
  | "unavailable"
  | "timeout"
  | "invalid_output"
  | "lease_expired"
  | "consent_missing"
  | "not_signed_in"
  | "invalid_input"
  | "input_too_large";

/** 날짜 화면의 생성 상태. 사용자·job 식별자와 원문 오류는 넣지 않는다. */
export type StoryGenerationView =
  | { state: "unavailable" }
  | { state: "off"; manualEnabled: false; autoEnabled: boolean }
  | { state: "ready"; autoEnabled: boolean }
  | { state: "queued" | "running"; kind: "manual" | "scheduled" }
  | { state: "failed"; failure: StoryJobFailure; canRetry: boolean }
  | { state: "limited" };

export type StoryAiSettingsView = { manualEnabled: boolean; autoEnabled: boolean; reflectionTime: string };

export type StoryRequestError =
  | "not_signed_in"
  | "invalid_date"
  | "consent_missing"
  | "unavailable"
  | "no_input"
  | "input_too_large"
  | "invalid_input"
  | "already_current"
  | "busy"
  | "limited";
