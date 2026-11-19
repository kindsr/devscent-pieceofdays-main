/**
 * 이야기 생성기 port(PLAN_ai-daily-story-storage §2). S1에서는 실제 생성기를 연결하지 않는다.
 * 동의·원자적 예약·공유 비용 한도(후속 0006)가 검증되기 전에는 getStoryGenerator()가 항상 null이다.
 */
import "server-only";
import type { Result } from "../result";

export type StoryGeneratorError = "unavailable" | "timeout" | "invalid_output";

export interface StoryGenerator {
  generate(
    input: { date: string; moments: { time: string; text: string }[] },
    signal: AbortSignal,
  ): Promise<Result<{ body: string }, StoryGeneratorError>>;
}

export function getStoryGenerator(): StoryGenerator | null {
  return null;
}
