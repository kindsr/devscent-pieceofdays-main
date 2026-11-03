/**
 * 기록 글꼴·디자인 적용 설정(PLAN_mvp-domain-storage §4). app role Pool만 쓴다.
 *
 * - 읽기는 행을 만들지 않는다. 행이 없으면 gothic / null이다.
 * - 쓰기는 각자 담당 열만 upsert한다(글꼴은 적용 id를, 적용은 글꼴을 덮어쓰지 않는다).
 * - 비UUID·없는 사용자는 not_found이고 FK 오류(23503)는 밖으로 내보내지 않는다. 값은 모두 $n 매개변수다.
 */
import "server-only";
import type { DatabaseError } from "pg";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { DEFAULT_FONT_KEY, parseFontKey, type FontKey } from "@/shared/fonts";

const isFkViolation = (err: unknown) => (err as Partial<DatabaseError> | null)?.code === "23503";

export async function getPreferences(
  db: Db,
  userId: string,
): Promise<{ fontKey: FontKey; appliedDesignVersionId: string | null }> {
  const defaults = { fontKey: DEFAULT_FONT_KEY, appliedDesignVersionId: null };
  if (!isUuid(userId)) return defaults;
  const r = await db.query<{ font_key: string; applied: string | null }>(
    "SELECT font_key, applied_design_version_id::text AS applied FROM pod.preferences WHERE user_id = $1::uuid",
    [userId],
  );
  const row = r.rows[0];
  if (!row) return defaults;
  return { fontKey: parseFontKey(row.font_key) ?? DEFAULT_FONT_KEY, appliedDesignVersionId: row.applied };
}

export async function setFontKey(db: Db, userId: string, key: unknown): Promise<Result<FontKey, "invalid_font" | "not_found">> {
  if (!isUuid(userId)) return { ok: false, error: "not_found" };
  const fontKey = parseFontKey(key);
  if (fontKey === null) return { ok: false, error: "invalid_font" };
  try {
    await db.query(
      `INSERT INTO pod.preferences (user_id, font_key) VALUES ($1::uuid, $2)
       ON CONFLICT (user_id) DO UPDATE SET font_key = EXCLUDED.font_key, updated_at = now()`,
      [userId, fontKey],
    );
    return { ok: true, value: fontKey };
  } catch (err) {
    if (isFkViolation(err)) return { ok: false, error: "not_found" };
    throw err;
  }
}

export async function applyDesign(db: Db, userId: string, versionId: string | null): Promise<Result<null, "not_found">> {
  if (!isUuid(userId)) return { ok: false, error: "not_found" };
  if (versionId !== null) {
    if (!isUuid(versionId)) return { ok: false, error: "not_found" };
    const owned = await db.query("SELECT 1 FROM pod.design_versions WHERE id = $1::uuid AND owner_id = $2::uuid", [
      versionId,
      userId,
    ]);
    if (owned.rowCount !== 1) return { ok: false, error: "not_found" };
  }
  try {
    // 복합 FK (applied_design_version_id, user_id)가 마지막 방어선이다.
    await db.query(
      `INSERT INTO pod.preferences (user_id, applied_design_version_id) VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (user_id) DO UPDATE
         SET applied_design_version_id = EXCLUDED.applied_design_version_id, updated_at = now()`,
      [userId, versionId],
    );
    return { ok: true, value: null };
  } catch (err) {
    if (isFkViolation(err)) return { ok: false, error: "not_found" };
    throw err;
  }
}
