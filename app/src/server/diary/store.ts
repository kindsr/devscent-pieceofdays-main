import type { LocalDate } from "@/shared/local-date";

/** 예시 이미지 키(앱 동봉 정적 자산). 실제 사진 업로드는 PRD Q1 결정 후. */
export type SampleImageKey = "window" | "noodle" | "ginkgo";

export type DiaryMoment = { id: string; time: string; text: string; image: SampleImageKey | null };
export type DiaryDay = { date: LocalDate; summary: string; moments: DiaryMoment[] };

/** 일기 저장 port. 모든 함수는 userId를 첫 인자로 받고 소유자 기록만 돌려준다. PostgreSQL 구현은 F2 이후. */
export interface DiaryStore {
  getDay(userId: string, date: LocalDate): Promise<DiaryDay | null>;
  listMonth(userId: string, year: number, month: number): Promise<DiaryDay[]>;
}
