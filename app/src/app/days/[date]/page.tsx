import { notFound } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { parseLocalDate } from "@/shared/local-date";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DayPage({ params }: PageProps<"/days/[date]">) {
  const date = parseLocalDate((await params).date);
  if (!date) notFound();
  const ctx = getDiaryContext();
  if (ctx.kind !== "fixture") return <NotConnected title="모아보기" />;
  return <DaysView ctx={ctx} picked={date} />;
}
