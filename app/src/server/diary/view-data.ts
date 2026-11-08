import "server-only";
import type { DiaryContext } from "@/shared/diary";
import { dateParts, type LocalDate } from "@/shared/local-date";

/** React 컴포넌트가 아닌 서버 읽기 함수. 반환값에는 날짜와 기록만 들어간다. */
export async function readDaysView(ctx: Extract<DiaryContext, { kind: "fixture" | "account" }>, picked: LocalDate | null) {
  const t = dateParts(ctx.today);
  const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  const [thisMonth, lastMonth, day] = await Promise.all([
    ctx.store.listMonth(ctx.userId, t.y, t.m),
    ctx.store.listMonth(ctx.userId, prev.y, prev.m),
    picked ? ctx.store.getDay(ctx.userId, picked) : Promise.resolve(null),
  ]);
  return { today: ctx.today, picked, thisMonth, lastMonth, day };
}
