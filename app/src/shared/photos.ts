/** 사진의 공개 참조와 입력 한도. 저장소·소유자·해시는 서버 안에만 둔다. */
export type PhotoRef = { src: string; width: number; height: number };
export type PhotoError =
  | "invalid_request" | "invalid_body" | "invalid_photo" | "photo_too_large"
  | "not_signed_in" | "forbidden" | "conflict" | "busy" | "unavailable";

export const PHOTO_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_REQUEST_MAX_BYTES = 9 * 1024 * 1024;
export const PHOTO_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 40_000_000;
export const PHOTO_MAX_SIDE = 2560;
