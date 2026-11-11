import type { Result } from "../result";

export type ClaudeConfig = Readonly<{ apiKey: string; model: string }>;
export type ClaudeStory = { body: string; model: string; usage: { inputTokens: number; outputTokens: number } };
export type ClaudeStoryError = "unavailable" | "invalid_input" | "timeout" | "invalid_output";
export type ClaudeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseClaudeConfig(env: Record<string, string | undefined>):
  Result<ClaudeConfig | null, "invalid_claude_config">;
/** input은 런타임에 정확한 {date, moments:[{time,text}]}인지 검사한다. */
export function generateClaudeStory(
  config: ClaudeConfig | null,
  input: unknown,
  options?: { fetch?: ClaudeFetch; signal?: AbortSignal },
): Promise<Result<ClaudeStory, ClaudeStoryError>>;

export type ClaudeUsage = { inputTokens: number; outputTokens: number };
export type ClaudePhotoMoment = { time: string; text: string; photo: { mediaType: "image/jpeg"; data: string } | null };
/** sent는 HTTP 요청을 시작했는지, usage는 응답에서 실측한 값(없으면 null)이다. */
export type ClaudePhotoStoryResult =
  | { ok: true; value: { body: string; model: string }; sent: true; usage: ClaudeUsage }
  | { ok: false; error: ClaudeStoryError; sent: boolean; usage: ClaudeUsage | null };
/** input은 런타임에 정확한 {date, moments:[{time,text,photo}]}인지 검사한다. 사진이 0장인 날도 같은 함수로 보낸다. */
export function generateClaudePhotoStory(
  config: ClaudeConfig | null,
  input: unknown,
  options?: { fetch?: ClaudeFetch; signal?: AbortSignal },
): Promise<ClaudePhotoStoryResult>;
