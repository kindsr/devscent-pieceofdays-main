import type { NextRequest } from "next/server";
import { handleWithdraw } from "@/server/auth/handlers";
import { fixedResponse, formOf, readAuth, toResponse } from "@/server/auth/http";
import { sessionCookieOptions } from "@/server/auth/session";
import { getAppDb } from "@/server/db/pool";

export const runtime = "nodejs";

/**
 * POST /auth/withdraw — 탈퇴 gate(PLAN_dev-usable-app §6). POD_WITHDRAWAL_ENABLED가 정확히 "1"일 때만 B2 handleWithdraw로 간다.
 * 닫혀 있으면 설정·쿠키·처리 함수·DB를 건드리기 전에 고정 503이다.
 */
export async function POST(req: NextRequest): Promise<Response> {
  if (process.env.POD_WITHDRAWAL_ENABLED !== "1") return fixedResponse(503);
  const auth = readAuth();
  const form = auth.ok ? await formOf(req) : new FormData();
  const session = auth.ok ? req.cookies.get(sessionCookieOptions(auth.value.session, new Date(0)).name)?.value : undefined;
  return toResponse(await handleWithdraw(auth, () => getAppDb(), req.headers.get("origin"), form, { session }));
}
