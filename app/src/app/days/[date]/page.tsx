import { notFound, redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { readDaysView } from "@/server/diary/view-data";
import { parseLocalDate } from "@/shared/local-date";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DayPage({ params }: PageProps<"/days/[date]">) {
  const date = parseLocalDate((await params).date);
  if (!date) notFound();
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="모아보기" readFailed={ctx.reason === "db_unavailable"} />;
  // returnTo는 검증된 날짜로 서버가 만든 경로만 쓴다.
  if (ctx.kind === "signed_out") redirect(`/login?returnTo=${encodeURIComponent(`/days/${date}`)}`);
  let data: Awaited<ReturnType<typeof readDaysView>>;
  try {
    data = await readDaysView(ctx, date);
  } catch {
    return <NotConnected title="모아보기" readFailed />;
  }
  return <DaysView {...data} mode={ctx.kind} />;
}
