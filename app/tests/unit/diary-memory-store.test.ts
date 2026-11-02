import { describe, expect, it } from "vitest";
import { createMemoryDiaryStore } from "@/server/diary/store.memory";
import type { DiaryDay } from "@/server/diary/store";

// 메모리 저장 구현도 소유자 제한을 지킨다: 다른 사용자 ID로는 "없음"과 같은 결과를 받는다.
const OWNER = "owner-a";
const OTHER = "owner-b";
const days: DiaryDay[] = [
  { date: "2026-11-02", summary: "s", moments: [{ id: "m1", time: "07:40", text: "t", image: null }] },
  { date: "2026-10-30", summary: "", moments: [{ id: "m2", time: "19:45", text: "u", image: null }] },
];

describe("memory diary store", () => {
  const store = createMemoryDiaryStore(OWNER, days);

  it("returns the owner's day", async () => {
    expect((await store.getDay(OWNER, "2026-11-02"))?.moments).toHaveLength(1);
  });

  it("answers another user exactly like a missing day", async () => {
    expect(await store.getDay(OTHER, "2026-11-02")).toBeNull();
    expect(await store.getDay(OWNER, "2026-11-03")).toBeNull();
    expect(await store.listMonth(OTHER, 2026, 11)).toEqual([]);
  });

  it("lists only the requested month", async () => {
    expect((await store.listMonth(OWNER, 2026, 10)).map((d) => d.date)).toEqual(["2026-10-30"]);
  });

  it("does not let callers mutate stored data through returned values", async () => {
    const day = await store.getDay(OWNER, "2026-11-02");
    day!.moments.length = 0;
    expect((await store.getDay(OWNER, "2026-11-02"))?.moments).toHaveLength(1);
  });
});
