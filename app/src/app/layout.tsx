import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getDiaryContext } from "@/server/context";
import { getPreferences } from "@/server/account/preferences.pg";
import { getAppDb } from "@/server/db/pool";
import { DEFAULT_FONT_KEY, type FontKey } from "@/shared/fonts";
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
  const ctx = await getDiaryContext();
  let font: FontKey = DEFAULT_FONT_KEY;
  if (ctx.kind === "account") {
    try {
      font = (await getPreferences(getAppDb(), ctx.userId)).fontKey;
    } catch {
      // 표시용 기본 글꼴만 쓴다. 각 page/action의 접근 확인·읽기 실패는 그대로다.
    }
  }
  return (
    <html lang="ko" data-record-font={font === DEFAULT_FONT_KEY ? undefined : font}>
      <body>
        <TopBar canWrite={ctx.kind === "fixture" || ctx.kind === "account"} viewer={ctx.kind} />
        <main id="view" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
