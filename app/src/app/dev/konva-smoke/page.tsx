import { notFound } from "next/navigation";
import { isFixtureModeEnabled } from "@/server/runtime-mode";
import { KonvaSmokeLoader } from "@/ui/decorate/KonvaSmokeLoader";

export const dynamic = "force-dynamic";

/** 시험 fixture 전용 화면. 로컬 고정 사용자 모드(development/test)가 아니면 없는 주소로 응답한다. */
export default function KonvaSmokePage() {
  if (!isFixtureModeEnabled(process.env)) notFound();
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>Konva 호환 스모크</h1>
        <p className="sub">시험 fixture · 꾸미기 편집기 아님</p>
      </header>
      <KonvaSmokeLoader />
    </>
  );
}
