import type { NextRequest } from "next/server";
import { handleLogout } from "@/server/auth/handlers";
import { readAuth, toResponse } from "@/server/auth/http";

export const runtime = "nodejs";

/** POST /auth/logout — B2 handleLogout의 얇은 어댑터. */
export async function POST(req: NextRequest): Promise<Response> {
  return toResponse(handleLogout(readAuth(), req.headers.get("origin")));
}
