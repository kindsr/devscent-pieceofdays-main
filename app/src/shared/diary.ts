import type { LocalDate } from "./local-date";

/** UI와 서버가 함께 쓰는 기록 타입(PLAN_mvp-domain-storage §1·§3). 서버 모듈을 import하지 않는다. */

/** 예시 이미지 키(앱 동봉 정적 자산). 실제 사진 업로드는 PRD Q1 결정 후. */
export type SampleImageKey = "window" | "noodle" | "ginkgo";

export type DiaryMoment = { id: string; time: string; text: string; image: SampleImageKey | null };
export type DiaryDay = { date: LocalDate; summary: string; moments: DiaryMoment[] };

/** 일기 저장 port. 모든 함수는 userId를 첫 인자로 받고 소유자 기록만 돌려준다. PostgreSQL 구현은 F2 이후. */
export interface DiaryStore {
  getDay(userId: string, date: LocalDate): Promise<DiaryDay | null>;
  listMonth(userId: string, year: number, month: number): Promise<DiaryDay[]>;
}

/**
 * 요청의 기록 문맥. userId는 세션에서만 얻는다(F4). 헤더·URL·폼 값의 사용자 ID는 쓰지 않는다.
 * F1에는 실제 로그인과 저장소가 없으므로, 로컬 고정 사용자 모드가 아니면 "연결 안 됨"을 돌려준다.
 */
export type DiaryContext =
  | { kind: "fixture"; userId: string; store: DiaryStore; today: string }
  | { kind: "unavailable" };
