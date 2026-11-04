import { redirect } from "next/navigation";
import { getDiaryContext } from "@/server/context";
import { DaysView } from "@/ui/d/DaysView";
import { NotConnected } from "@/ui/d/NotConnected";

export const dynamic = "force-dynamic";

export default async function DaysPage() {
  const ctx = await getDiaryContext();
  if (ctx.kind === "unavailable") return <NotConnected title="모아보기" />;
  if (ctx.kind === "signed_out") redirect(`/login?returnTo=${encodeURIComponent("/days")}`);
  if (ctx.kind === "signed_in") {
    // F5 전: 실제 계정에는 기록을 읽거나 쓰지 않는다. 안내만 한다.
    return (
      <>
        <header className="board-head">
          <h1 tabIndex={-1}>모아보기</h1>
        </header>
        <section className="notice" aria-labelledby="si-h">
          <h2 id="si-h">로그인됐어요</h2>
          <p>기록 쓰기·불러오기는 다음 단계에서 연결돼요.</p>
        </section>
      </>
    );
  }
  return <DaysView ctx={ctx} picked={null} />;
}
