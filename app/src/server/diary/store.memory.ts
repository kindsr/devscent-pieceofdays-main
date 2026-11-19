import "server-only";
import type { DiaryDay, DiaryStore } from "./store";

/** 메모리 구현: UI 골격과 단위 시험 전용. 읽기만 하며 아무것도 저장하지 않는다. */
export function createMemoryDiaryStore(ownerId: string, seed: readonly DiaryDay[]): DiaryStore {
  const days = structuredClone(seed) as DiaryDay[];
  return {
    async getDay(userId, date) {
      if (userId !== ownerId) return null;
      const day = days.find((d) => d.date === date);
      return day ? structuredClone(day) : null;
    },
    async listMonth(userId, year, month) {
      if (userId !== ownerId) return [];
      const prefix = `${year}-${String(month).padStart(2, "0")}-`;
      return structuredClone(days.filter((d) => d.date.startsWith(prefix)));
    },
  };
}
