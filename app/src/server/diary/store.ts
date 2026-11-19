import type { Result } from "../result";

/** 기록 읽기 타입은 UI와 공유하므로 shared/diary.ts에 둔다. 서버 코드는 기존처럼 여기서 가져온다. */
export type { DiaryDay, DiaryMoment, DiaryStore, SampleImageKey } from "@/shared/diary";

export type MomentRef = { id: string; version: number };

/** 기록 쓰기 port(PLAN_mvp-domain-storage §3). userId는 신뢰된 서버 문맥에서만 받는다. */
export interface DiaryWriteStore {
  createMoment(userId: string, body: string): Promise<Result<MomentRef, "invalid_body" | "not_found">>;
  updateMoment(
    userId: string,
    id: string,
    expectedVersion: number,
    body: string,
  ): Promise<Result<MomentRef, "invalid_body" | "invalid_version" | "not_found" | "conflict">>;
  deleteMoment(
    userId: string,
    id: string,
    expectedVersion: number,
  ): Promise<Result<null, "invalid_version" | "not_found" | "conflict">>;
  saveSummary(
    userId: string,
    date: string,
    expectedVersion: number | null,
    body: string,
  ): Promise<
    Result<{ version: number } | null, "invalid_body" | "invalid_date" | "invalid_version" | "not_found" | "conflict">
  >;
}
