import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getDiaryContext } from "@/server/context";
import { TopBar } from "@/ui/d/TopBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "pieceofdays",
  description: "개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays",
  // 앱 골격 단계: 검색 노출 금지(dev 정책과 같음).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // layout은 이동마다 다시 렌더되지 않으므로 상단 표시에만 쓴다. 접근 확인은 각 page가 한다(PLAN §7).
  const canWrite = (await getDiaryContext()).kind === "fixture";
  return (
    <html lang="ko">
      <body>
        <TopBar canWrite={canWrite} />
        <main id="view" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
