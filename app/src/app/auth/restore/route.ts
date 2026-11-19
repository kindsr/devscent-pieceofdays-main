import type { NextRequest } from "next/server";
import { handleRestore } from "@/server/auth/handlers";
import { readAuth, toResponse } from "@/server/auth/http";
import { recoveryCookieOptions } from "@/server/auth/recovery-cookie";
import { getAppDb } from "@/server/db/pool";

export const runtime = "nodejs";

/** POST /auth/restore — B2 handleRestore의 얇은 어댑터. 탈퇴 gate와 무관하다. */
export async function POST(req: NextRequest): Promise<Response> {
  const auth = readAuth();
  const recovery = auth.ok ? req.cookies.get(recoveryCookieOptions(auth.value.session, new Date(0)).name)?.value : undefined;
  return toResponse(await handleRestore(auth, () => getAppDb(), req.headers.get("origin"), { recovery }));
}
