"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** D 상단: 브랜드 · 오늘/모아보기 세그먼트 · 조각 추가(예시 사용자) 또는 로그인(로그아웃 상태). viewer는 종류 문자열만 받는다. */
export function TopBar({ canWrite, viewer }: { canWrite: boolean; viewer: "fixture" | "account" | "signed_out" | "unavailable" }) {
  const path = usePathname();
  const inDays = path.startsWith("/days");
  const inToday = path === "/";
  return (
    <header className="top">
      <div className="top-in">
        <Link className="brand" href="/">
          pieceofdays
          <svg className="squiggle" viewBox="0 0 120 10" aria-hidden="true" focusable="false">
            <path d="M2 6 C 14 1, 22 9, 34 5 S 56 1, 68 6 S 92 9, 118 3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </Link>
        <nav className="seg" aria-label="주 메뉴">
          <Link href="/" aria-current={inToday ? "page" : undefined}>
            오늘
          </Link>
          <Link href="/days" aria-current={inDays ? "page" : undefined}>
            모아보기
          </Link>
        </nav>
        {canWrite ? (
          // 같은 문서의 해시 이동(hashchange)으로 오늘 화면의 작성 팝업을 연다. Link는 hashchange를 내지 않아 <a>를 쓴다.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a className="btn-add" href="/#write">
            <span aria-hidden="true">+</span> 조각 추가
          </a>
        ) : viewer === "signed_out" ? (
          <Link className="text-btn top-login" href="/login">
            로그인
          </Link>
        ) : null}
      </div>
    </header>
  );
}
