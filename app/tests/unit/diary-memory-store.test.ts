import { describe, expect, it } from "vitest";
import { createMemoryDiaryStore } from "@/server/diary/store.memory";

// 메모리 저장 구현도 소유자 제한을 지킨다: 다른 사용자 ID로는 "없음"과 같은 결과를 받는다.
const OWNER = "owner-a";
const OTHER = "owner-b";
// PLAN §6 B2: 타입 주석 없는 변수(신선한 리터럴 excess property 검사 없음). slice ② version 필드를 미리 둔다.
const days = [
  {
    date: "2026-11-02",
    summary: "s",
    summaryVersion: 1,
    moments: [{ id: "m1", time: "07:40", text: "t", image: null, version: 1 }],
  },
  {
    date: "2026-10-30",
    summary: "",
    summaryVersion: null,
    moments: [{ id: "m2", time: "19:45", text: "u", image: null, version: 1 }],
  },
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
