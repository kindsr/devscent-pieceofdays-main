import type { NextRequest } from "next/server";
import { flowCookieOptions } from "@/server/auth/flow-cookie";
import { handleCallback } from "@/server/auth/handlers";
import { readAuth, toResponse } from "@/server/auth/http";
import { getAppDb } from "@/server/db/pool";

export const runtime = "nodejs";

/** GET /auth/{provider}/callback — B2 handleCallback의 얇은 어댑터. query의 중복 항목은 그대로 넘긴다. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const auth = readAuth();
  const { provider } = await ctx.params;
  const flow = auth.ok ? req.cookies.get(flowCookieOptions(auth.value.session, new Date(0)).name)?.value : undefined;
  const query = new URLSearchParams(req.nextUrl.search);
  return toResponse(await handleCallback(auth, () => getAppDb(), provider, query, { flow }), { callback: true });
}
