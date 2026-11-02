import { getDiaryContext } from "@/server/context";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DaysPage() {
  const ctx = getDiaryContext();
  if (ctx.kind !== "fixture") return <NotConnected title="모아보기" />;
  return <DaysView ctx={ctx} picked={null} />;
}
