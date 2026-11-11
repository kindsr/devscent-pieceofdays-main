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
