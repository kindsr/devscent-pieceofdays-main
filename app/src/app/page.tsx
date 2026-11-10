import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { parsePhotoConfig } from "@/server/photos/config";
import type { DiaryDay } from "@/shared/diary";
import { DayBoard } from "@/ui/d/DayBoard";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="오늘" readFailed={ctx.reason === "db_unavailable"} />;
  if (ctx.kind === "signed_out") redirect(`/login?returnTo=${encodeURIComponent("/")}`);
  let day: DiaryDay;
  try {
    day = (await ctx.store.getDay(ctx.userId, ctx.today)) ?? { date: ctx.today, summary: "", summaryVersion: null, moments: [] };
  } catch {
    return <NotConnected title="오늘" readFailed />;
  }
  const photos = ctx.kind === "account" ? parsePhotoConfig(process.env) : null;
  return <DayBoard day={day} mode={ctx.kind} photosEnabled={!!(photos?.ok && photos.value)} isToday sub="오늘" showSettingsLink />;
}
