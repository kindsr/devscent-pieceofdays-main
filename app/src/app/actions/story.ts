"use server";
/**
 * AI 하루 이야기 Server Actions(PLAN_ai-story-live-generation §4.8). 서버 전용이다.
 *
 * - 순서는 기존 기록 actions와 같다: 인증 설정 → 같은 Origin → 매 호출 getViewer(user만) → 입력 → 저장 함수.
 * - 생성 요청은 job을 queued로 넣기만 한다. 실제 생성은 내부 worker가 다음 호출(1분 이내)에서 한다.
 * - 예상 밖 오류는 unavailable이다. 원문·스택·DB URL·쿠키를 응답하거나 로그하지 않는다.
 * - 직접 수정·재생성(PLAN_story-edit-regenerate §2)도 같은 순서다. 수정은 키·외부 전송 동의가 필요 없고, 재생성은 키가 있어야 받는다.
 */
import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { loadAuthConfig } from "@/server/auth/config";
import { assertSameOrigin } from "@/server/auth/session";
import { getViewer } from "@/server/context";
import { getAppDb } from "@/server/db/pool";
import { parseClaudeConfig } from "@/server/stories/claude";
import { requestManualStory } from "@/server/stories/jobs.pg";
import { saveStoryAiSettings } from "@/server/stories/settings.pg";
import { editStoryVersion } from "@/server/stories/store.pg";
import type { StoryEditActionResult, StoryRegenerationActionError, StoryRegenerationActionResult } from "@/shared/stories";

export type StorySettingsError = "forbidden" | "not_signed_in" | "unavailable" | "invalid_input";
export type StoryActionError = StoryRegenerationActionError;

type Subject = { userId: string; gen: number };

async function verifiedSubject(): Promise<{ ok: true; subject: Subject } | { ok: false; error: "forbidden" | "not_signed_in" | "unavailable" }> {
  try {
    const config = loadAuthConfig(process.env, process.env.NODE_ENV);
    if (!config.ok) return { ok: false, error: "unavailable" };
    const origin = (await headers()).get("origin");
    if (!assertSameOrigin(config.value.session, origin).ok) return { ok: false, error: "forbidden" };
    const viewer = await getViewer();
    if (viewer.kind === "user") return { ok: true, subject: { userId: viewer.userId, gen: viewer.gen } };
    return { ok: false, error: viewer.kind === "unavailable" ? "unavailable" : "not_signed_in" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 수동·자동 동의를 저장한다. 저장할 때마다 동의 epoch가 바뀌어 이전 job은 보내거나 저장하지 않는다. */
export async function saveStorySettingsAction(input: unknown): Promise<
  { ok: true; value: { manualEnabled: boolean; autoEnabled: boolean } } | { ok: false; error: StorySettingsError }
> {
  const user = await verifiedSubject();
  if (!user.ok) return user;
  try {
    const r = await saveStoryAiSettings(getAppDb(), user.subject, input);
    if (r.ok) revalidatePath("/", "layout");
    return r;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 날짜 화면의 ‘AI 이야기 만들기’. 키가 없으면 요청을 받지 않는다. */
export async function requestStoryAction(date: unknown): Promise<{ ok: true } | { ok: false; error: StoryActionError }> {
  const user = await verifiedSubject();
  if (!user.ok) return user;
  if (typeof date !== "string") return { ok: false, error: "invalid_date" };
  const claude = parseClaudeConfig(process.env);
  if (!claude.ok || claude.value === null) return { ok: false, error: "unavailable" };
  try {
    const r = await requestManualStory(getAppDb(), user.subject, date);
    revalidatePath("/", "layout");
    return r.ok ? { ok: true } : r;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** form action용(날짜를 bind한다). 결과는 다시 그린 날짜 화면의 생성 상태로 보인다. */
export async function requestStoryFormAction(date: string): Promise<void> {
  await requestStoryAction(date);
}

/** 날짜 화면의 ‘이야기 수정’ 저장. input은 정확히 { expectedVersion, body }이며 검증은 editStoryVersion이 한다. */
export async function saveStoryEditAction(date: unknown, input: unknown): Promise<StoryEditActionResult> {
  const user = await verifiedSubject();
  if (!user.ok) return user;
  if (typeof date !== "string") return { ok: false, error: "invalid_date" };
  try {
    const r = await editStoryVersion(getAppDb(), user.subject, date, input);
    if (r.ok && !r.value.unchanged) revalidatePath("/", "layout");
    return r;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** 확인 단계의 ‘AI로 다시 만들기’. 화면의 최신 version을 기대값으로 보내 같은 입력 재생성 job 1건만 queued로 넣는다. */
export async function requestStoryRegenerationAction(date: unknown, expectedVersion: unknown): Promise<StoryRegenerationActionResult> {
  const user = await verifiedSubject();
  if (!user.ok) return user;
  if (typeof date !== "string") return { ok: false, error: "invalid_date" };
  if (expectedVersion === undefined) return { ok: false, error: "conflict" };
  const claude = parseClaudeConfig(process.env);
  if (!claude.ok || claude.value === null) return { ok: false, error: "unavailable" };
  try {
    const r = await requestManualStory(getAppDb(), user.subject, date, { expectedStoryVersion: expectedVersion });
    revalidatePath("/", "layout");
    return r.ok ? { ok: true } : r;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
