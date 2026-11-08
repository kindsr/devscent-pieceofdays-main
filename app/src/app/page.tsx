import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { DayBoard } from "@/ui/d/DayBoard";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="오늘" readFailed={ctx.reason === "db_unavailable"} />;
  if (ctx.kind === "signed_out") redirect(`/login?returnTo=${encodeURIComponent("/")}`);
  try {
    const day = (await ctx.store.getDay(ctx.userId, ctx.today)) ?? { date: ctx.today, summary: "", summaryVersion: null, moments: [] };
    return <DayBoard day={day} mode={ctx.kind} isToday sub="오늘" showSettingsLink />;
  } catch {
    return <NotConnected title="오늘" readFailed />;
  }
}
