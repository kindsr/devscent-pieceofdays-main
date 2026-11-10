"use server";
/**
 * 기록 Server Actions(PLAN_dev-diary-actions §1·§2). 서버 전용이다.
 *
 * - 순서: 인증 설정 → 같은 Origin → 매 호출 getViewer(user만) → 입력 형태 → F3 저장 함수.
 * - userId는 검증된 viewer에서만 온다. 인자·헤더·다른 쿠키의 사용자 ID는 쓰지 않는다.
 * - UUID·trim·300 코드포인트·버전·날짜·소유권 판정은 F3에 맡긴다. 여기서는 F3가 받을 수 없는 형태만 거부한다.
 * - 예상 밖 오류는 모두 unavailable이다. 원문·스택·DB URL·쿠키를 응답하거나 로그하지 않는다. 재시도·캐시 갱신은 하지 않는다.
 */
import "server-only";
import { headers } from "next/headers";
import { setFontKey } from "@/server/account/preferences.pg";
import { setReflectionTime } from "@/server/account/reflection-time.pg";
import { loadAuthConfig } from "@/server/auth/config";
import { assertSameOrigin } from "@/server/auth/session";
import { getViewer } from "@/server/context";
import { getAppDb } from "@/server/db/pool";
import { createPgDiaryStore } from "@/server/diary/store.pg";
import type { FontKey } from "@/shared/fonts";

export type ActionError =
  | "forbidden"
  | "not_signed_in"
  | "unavailable"
  | "invalid_body"
  | "invalid_version"
  | "invalid_date"
  | "invalid_font"
  | "invalid_reflection_time"
  | "not_found"
  | "conflict";
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };

const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const fail = (error: ActionError) => ({ ok: false, error }) as const;

/** 설정 → Origin → viewer. 통과하면 검증된 userId, 아니면 거부 결과다. 어느 단계든 예외는 unavailable이다. */
async function verifiedUserId(): Promise<{ ok: true; userId: string } | { ok: false; error: ActionError }> {
  try {
    const config = loadAuthConfig(process.env, process.env.NODE_ENV);
    if (!config.ok) return fail("unavailable");
    const origin = (await headers()).get("origin");
    if (!assertSameOrigin(config.value.session, origin).ok) return fail("forbidden");
    const viewer = await getViewer();
    if (viewer.kind === "user") return { ok: true, userId: viewer.userId };
    return fail(viewer.kind === "unavailable" ? "unavailable" : "not_signed_in");
  } catch {
    return fail("unavailable");
  }
}

/** 검증된 사용자로 F3 호출을 실행한다. DB·연결 오류는 unavailable로 바꾸고 원문을 버린다. */
async function asUser<T>(run: (userId: string) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  const user = await verifiedUserId();
  if (!user.ok) return user;
  try {
    return await run(user.userId);
  } catch {
    return fail("unavailable");
  }
}

export async function createMomentAction(body: unknown): Promise<ActionResult<{ id: string; version: number }>> {
  return asUser(async (userId) => {
    if (typeof body !== "string") return fail("invalid_body");
    return createPgDiaryStore(getAppDb()).createMoment(userId, body);
  });
}

export async function updateMomentAction(
  id: unknown,
  expectedVersion: unknown,
  body: unknown,
): Promise<ActionResult<{ id: string; version: number }>> {
  return asUser(async (userId) => {
    if (typeof id !== "string") return fail("not_found");
    if (!isVersion(expectedVersion)) return fail("invalid_version");
    if (typeof body !== "string") return fail("invalid_body");
    return createPgDiaryStore(getAppDb()).updateMoment(userId, id, expectedVersion, body);
  });
}

export async function deleteMomentAction(id: unknown, expectedVersion: unknown): Promise<ActionResult<null>> {
  return asUser(async (userId) => {
    if (typeof id !== "string") return fail("not_found");
    if (!isVersion(expectedVersion)) return fail("invalid_version");
    return createPgDiaryStore(getAppDb()).deleteMoment(userId, id, expectedVersion);
  });
}

/** 생성은 expectedVersion null, 수정·삭제(빈 본문)는 양의 안전 정수다. undefined는 invalid_version이다. */
export async function saveSummaryAction(
  date: unknown,
  expectedVersion: unknown,
  body: unknown,
): Promise<ActionResult<{ version: number } | null>> {
  return asUser(async (userId) => {
    if (expectedVersion !== null && !isVersion(expectedVersion)) return fail("invalid_version");
    if (typeof date !== "string") return fail("invalid_date");
    if (typeof body !== "string") return fail("invalid_body");
    return createPgDiaryStore(getAppDb()).saveSummary(userId, date, expectedVersion, body);
  });
}

export async function setFontAction(key: unknown): Promise<ActionResult<FontKey>> {
  return asUser((userId) => setFontKey(getAppDb(), userId, key));
}

export async function setReflectionTimeAction(time: unknown): Promise<ActionResult<string>> {
  return asUser((userId) => setReflectionTime(getAppDb(), userId, time));
}
