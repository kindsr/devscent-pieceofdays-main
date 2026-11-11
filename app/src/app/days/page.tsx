import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { parsePhotoConfig } from "@/server/photos/config";
import { readDaysView } from "@/server/diary/view-data";
import { readStoryDates } from "@/server/stories/view-data";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DaysPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="모아보기" readFailed={ctx.reason === "db_unavailable"} />;
  const login = `/login?returnTo=${encodeURIComponent("/days")}`;
  if (ctx.kind === "signed_out") redirect(login);
  let data: Awaited<ReturnType<typeof readDaysView>>;
  try {
    data = await readDaysView(ctx, null);
  } catch {
    return <NotConnected title="모아보기" readFailed />;
  }
  const dates = ctx.kind === "account" ? await readStoryDates(data.today) : null;
  if (dates?.kind === "signed_out") redirect(login);
  const photos = ctx.kind === "account" ? parsePhotoConfig(process.env) : null;
  return <DaysView {...data} mode={ctx.kind} photosEnabled={!!(photos?.ok && photos.value)} storyDates={dates?.kind === "ok" ? dates.dates : undefined} />;
}
