/** 회고 시간만 읽고 쓴다. 기존 글꼴·디자인과 조각의 원본 시각은 바꾸지 않는다. */
import "server-only";
import type { DatabaseError } from "pg";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { DEFAULT_REFLECTION_TIME, parseReflectionTime } from "@/shared/reflection-time";

export async function getReflectionTime(db: Db, userId: string): Promise<string> {
  if (!isUuid(userId)) return DEFAULT_REFLECTION_TIME;
  const r = await db.query<{ reflection_time: string }>(
    "SELECT reflection_time FROM pod.preferences WHERE user_id = $1::uuid",
    [userId],
  );
  return parseReflectionTime(r.rows[0]?.reflection_time) ?? DEFAULT_REFLECTION_TIME;
}

export async function setReflectionTime(
  db: Db,
  userId: string,
  input: unknown,
): Promise<Result<string, "invalid_reflection_time" | "not_found">> {
  if (!isUuid(userId)) return { ok: false, error: "not_found" };
  const time = parseReflectionTime(input);
  if (time === null) return { ok: false, error: "invalid_reflection_time" };
  try {
    await db.query(
      `INSERT INTO pod.preferences (user_id, reflection_time) VALUES ($1::uuid, $2)
       ON CONFLICT (user_id) DO UPDATE SET reflection_time = EXCLUDED.reflection_time, updated_at = now()`,
      [userId, time],
    );
    return { ok: true, value: time };
  } catch (err) {
    if ((err as Partial<DatabaseError> | null)?.code === "23503") return { ok: false, error: "not_found" };
    throw err;
  }
}
