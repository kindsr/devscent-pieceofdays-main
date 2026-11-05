import type { NextRequest } from "next/server";
import { handleStart } from "@/server/auth/handlers";
import { formOf, readAuth, toResponse } from "@/server/auth/http";

export const runtime = "nodejs";

/** POST /auth/{provider}/start — B2 handleStart의 얇은 어댑터(PLAN_mvp-oidc-integration §6.3). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const auth = readAuth();
  const { provider } = await ctx.params;
  const form = auth.ok ? await formOf(req) : new FormData();
  return toResponse(await handleStart(auth, provider, req.headers.get("origin"), form));
}
