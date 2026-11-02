import type { DiaryStore } from "./diary/store";
import { createMemoryDiaryStore } from "./diary/store.memory";
import { FIXTURE_DAYS, FIXTURE_TODAY } from "./diary/fixture";
import { isFixtureModeEnabled } from "./runtime-mode";

/**
 * 요청의 기록 문맥. userId는 세션에서만 얻는다(F4). 헤더·URL·폼 값의 사용자 ID는 쓰지 않는다.
 * F1에는 실제 로그인과 저장소가 없으므로, 로컬 고정 사용자 모드가 아니면 "연결 안 됨"을 돌려준다.
 */
export type DiaryContext =
  | { kind: "fixture"; userId: string; store: DiaryStore; today: string }
  | { kind: "unavailable" };

const FIXTURE_USER_ID = "local-fixture-user";
let fixtureStore: DiaryStore | undefined;

export function getDiaryContext(): DiaryContext {
  if (!isFixtureModeEnabled(process.env)) return { kind: "unavailable" };
  fixtureStore ??= createMemoryDiaryStore(FIXTURE_USER_ID, FIXTURE_DAYS);
  return { kind: "fixture", userId: FIXTURE_USER_ID, store: fixtureStore, today: FIXTURE_TODAY };
}
