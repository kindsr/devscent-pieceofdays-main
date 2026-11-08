import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { readDaysView } from "@/server/diary/view-data";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DaysPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="모아보기" readFailed={ctx.reason === "db_unavailable"} />;
  if (ctx.kind === "signed_out") redirect(`/login?returnTo=${encodeURIComponent("/days")}`);
  try {
    const data = await readDaysView(ctx, null);
    return <DaysView {...data} mode={ctx.kind} />;
  } catch {
    return <NotConnected title="모아보기" readFailed />;
  }
}
