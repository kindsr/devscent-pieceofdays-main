import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { parsePhotoConfig } from "@/server/photos/config";
import { readStoryView } from "@/server/stories/view-data";
import type { DiaryDay } from "@/shared/diary";
import { requestStoryFormAction } from "@/app/actions/story";
import { DailyStory } from "@/ui/d/DailyStory";
import { DayBoard } from "@/ui/d/DayBoard";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="오늘" readFailed={ctx.reason === "db_unavailable"} />;
  const login = `/login?returnTo=${encodeURIComponent("/")}`;
  if (ctx.kind === "signed_out") redirect(login);
  let day: DiaryDay;
  try {
    day = (await ctx.store.getDay(ctx.userId, ctx.today)) ?? { date: ctx.today, summary: "", summaryVersion: null, moments: [] };
  } catch {
    return <NotConnected title="오늘" readFailed />;
  }
  // 이야기는 계정 모드에서만 읽는다. 읽기 함수는 실패를 null로 돌려주므로 redirect는 try 밖에서 한다.
  const story = ctx.kind === "account" ? await readStoryView(ctx.today) : null;
  if (story?.kind === "signed_out") redirect(login);
  const hasMoments = day.moments.length > 0;
  // 원본·이야기가 모두 없는 날은 영역을 두지 않는다(기존 첫 조각 화면 유지). 읽기 실패는 고정 안내로 보인다.
  const storySlot = story?.kind === "ok" && (hasMoments || story.data === null || story.data.story !== null)
    ? <DailyStory date={day.date} data={story.data} reflectionTime={story.reflectionTime} hasMoments={hasMoments} generation={story.generation} requestAction={requestStoryFormAction.bind(null, day.date)} headingLevel={2} />
    : undefined;
  const photos = ctx.kind === "account" ? parsePhotoConfig(process.env) : null;
  return (
    <DayBoard
      day={day}
      mode={ctx.kind}
      photosEnabled={!!(photos?.ok && photos.value)}
      isToday
      sub="오늘"
      showSettingsLink
      story={storySlot}
    />
  );
}
