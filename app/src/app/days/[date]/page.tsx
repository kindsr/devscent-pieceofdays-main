import { notFound, redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { parsePhotoConfig } from "@/server/photos/config";
import { readDaysView } from "@/server/diary/view-data";
import { readStoryDates, readStoryView } from "@/server/stories/view-data";
import { parseLocalDate } from "@/shared/local-date";
import { DailyStory } from "@/ui/d/DailyStory";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DayPage({ params }: PageProps<"/days/[date]">) {
  const date = parseLocalDate((await params).date);
  if (!date) notFound();
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="모아보기" readFailed={ctx.reason === "db_unavailable"} />;
  // returnTo는 검증된 날짜로 서버가 만든 경로만 쓴다.
  const login = `/login?returnTo=${encodeURIComponent(`/days/${date}`)}`;
  if (ctx.kind === "signed_out") redirect(login);
  let data: Awaited<ReturnType<typeof readDaysView>>;
  try {
    data = await readDaysView(ctx, date);
  } catch {
    return <NotConnected title="모아보기" readFailed />;
  }
  // 이야기는 계정 모드에서만 읽는다. 읽기 함수는 실패를 null로 돌려주므로 redirect는 try 밖에서 한다.
  const [story, dates] = ctx.kind === "account" ? await Promise.all([readStoryView(date), readStoryDates(data.today)]) : [null, null];
  if (story?.kind === "signed_out" || dates?.kind === "signed_out") redirect(login);
  const hasMoments = !!data.day?.moments.length;
  // 원본·이야기가 모두 없는 날은 영역을 두지 않는다(기존 빈 날 유지). 읽기 실패는 고정 안내로 보인다.
  const storySlot = story?.kind === "ok" && (hasMoments || story.data === null || story.data.story !== null)
    ? <DailyStory date={date} data={story.data} reflectionTime={story.reflectionTime} hasMoments={hasMoments} headingLevel={3} />
    : undefined;
  const photos = ctx.kind === "account" ? parsePhotoConfig(process.env) : null;
  return (
    <DaysView
      {...data}
      mode={ctx.kind}
      photosEnabled={!!(photos?.ok && photos.value)}
      storyDates={dates?.kind === "ok" ? dates.dates : undefined}
      story={storySlot}
    />
  );
}
