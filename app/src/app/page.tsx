import { getDiaryContext } from "@/server/context";
import { DayBoard } from "@/ui/d/DayBoard";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const ctx = getDiaryContext();
  if (ctx.kind !== "fixture") return <NotConnected title="오늘" />;
  const day = (await ctx.store.getDay(ctx.userId, ctx.today)) ?? { date: ctx.today, summary: "", summaryVersion: null, moments: [] };
  return <DayBoard day={day} isToday sub="오늘" showSettingsLink />;
}
