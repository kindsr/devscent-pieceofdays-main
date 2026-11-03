import "server-only";
import type { DiaryContext } from "@/shared/diary";
import type { DiaryStore } from "./diary/store";
import { createMemoryDiaryStore } from "./diary/store.memory";
import { FIXTURE_DAYS, FIXTURE_TODAY } from "./diary/fixture";
import { isFixtureModeEnabled } from "./runtime-mode";

export type { DiaryContext };

const FIXTURE_USER_ID = "local-fixture-user";
let fixtureStore: DiaryStore | undefined;

export function getDiaryContext(): DiaryContext {
  if (!isFixtureModeEnabled(process.env)) return { kind: "unavailable" };
  fixtureStore ??= createMemoryDiaryStore(FIXTURE_USER_ID, FIXTURE_DAYS);
  return { kind: "fixture", userId: FIXTURE_USER_ID, store: fixtureStore, today: FIXTURE_TODAY };
}
