"use client";

import dynamic from "next/dynamic";

// Konva는 브라우저 전용이라 서버 렌더에서 불러오지 않는다(ssr: false).
const KonvaSmokeStage = dynamic(() => import("./KonvaSmokeStage"), {
  ssr: false,
  loading: () => <p data-testid="konva-loading">그리기 영역을 불러오는 중…</p>,
});

export function KonvaSmokeLoader() {
  return <KonvaSmokeStage />;
}
