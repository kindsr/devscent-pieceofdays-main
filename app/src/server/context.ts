import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import type { DiaryContext } from "@/shared/diary";
import { seoulLocalDate } from "@/shared/local-date";
import { verifyActiveAccount } from "./account/lifecycle";
import { loadAuthConfig } from "./auth/config";
import { readSession, sessionCookieOptions } from "./auth/session";
import { getAppDb } from "./db/pool";
import type { DiaryStore } from "./diary/store";
import { createMemoryDiaryStore } from "./diary/store.memory";
import { createPgDiaryStore } from "./diary/store.pg";
import { FIXTURE_DAYS, FIXTURE_TODAY } from "./diary/fixture";
import { assertAuthModeAllowed, isFixtureModeEnabled } from "./runtime-mode";

export type { DiaryContext };

/** 요청의 사용자(PLAN_mvp-oidc-integration §7). userId·gen은 검증된 세션 쿠키에서만 온다. */
export type RequestViewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };

const FIXTURE_USER_ID = "local-fixture-user";
// 로컬 고정 사용자 모드의 메모리 예시 기록만 모듈에 둔다. 실제 사용자 정보는 모듈 전역에 두지 않는다.
let fixtureStore: DiaryStore | undefined;

/**
 * §7 순서: 모드 충돌 → fixture → 설정 → 정확한 이름의 세션 쿠키 → readSession → 활성 계정 확인.
 * React cache로 한 요청 렌더 안에서만 memo한다. 헤더·URL·다른 쿠키의 사용자 ID는 읽지 않는다.
 */
export const getViewer = cache(async (): Promise<RequestViewer> => {
  assertAuthModeAllowed(null, process.env);
  if (isFixtureModeEnabled(process.env)) return { kind: "fixture" };

  const config = loadAuthConfig(process.env, process.env.NODE_ENV);
  if (!config.ok) return { kind: "unavailable", reason: config.error };

  const name = sessionCookieOptions(config.value.session, new Date()).name;
  const session = await readSession(config.value.session, (await cookies()).get(name)?.value);
  if (!session.ok) return { kind: "signed_out" };

  const subject = { userId: session.value.userId, gen: session.value.gen };
  let active: boolean;
  try {
    active = await verifyActiveAccount(getAppDb(), subject);
  } catch {
    return { kind: "unavailable", reason: "db_unavailable" };
  }
  return active ? { kind: "user", ...subject } : { kind: "signed_out" };
});

/** 일반 서버 함수에서 읽기를 마친 뒤 화면 자료만 JSX에 넘긴다. 문맥 자체는 props로 넘기지 않는다. */
export async function getDiaryContext(): Promise<DiaryContext> {
  const viewer = await getViewer();
  switch (viewer.kind) {
    case "fixture":
      fixtureStore ??= createMemoryDiaryStore(FIXTURE_USER_ID, FIXTURE_DAYS);
      return { kind: "fixture", userId: FIXTURE_USER_ID, store: fixtureStore, today: FIXTURE_TODAY };
    case "user":
      try {
        return { kind: "account", userId: viewer.userId, store: createPgDiaryStore(getAppDb()), today: seoulLocalDate(new Date()) };
      } catch {
        return { kind: "unavailable", reason: "db_unavailable" };
      }
    case "signed_out":
      return { kind: "signed_out" };
    case "unavailable":
      return viewer.reason === "db_unavailable" ? { kind: "unavailable", reason: "db_unavailable" } : { kind: "unavailable" };
  }
}
