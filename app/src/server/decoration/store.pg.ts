/**
 * 개인 디자인 버전 저장·목록·읽기(PLAN_mvp-domain-storage §4). app role Pool만 쓴다.
 *
 * - 저장은 엄격 validateManifest(형식 + 허용 목록) 통과 뒤 private 새 행만 INSERT한다. 수정·삭제·자동 적용은 없다.
 * - 읽기는 같은 소유자 조건으로 조회한 뒤 manifestForRender 결과를 돌려준다(과거 행은 null 또는 항목 drop).
 * - userId는 신뢰된 서버 호출 인자로만 받는다. 값은 모두 $n 매개변수다.
 */
import "server-only";
import type { DatabaseError } from "pg";
import type { Db } from "../db/pool";
import { isUuid } from "../ids";
import type { Result } from "../result";
import { manifestForRender, validateManifest, type Manifest, type ManifestOpts } from "@/shared/manifest";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const isFkViolation = (err: unknown) => (err as Partial<DatabaseError> | null)?.code === "23503";

export async function saveDesignVersion(
  db: Db,
  userId: string,
  input: unknown,
  opts?: ManifestOpts,
): Promise<Result<{ id: string; createdAt: Date }, "invalid_manifest" | "not_found">> {
  if (!isUuid(userId)) return { ok: false, error: "not_found" };
  const checked = validateManifest(input, opts);
  if (!checked.ok) return { ok: false, error: "invalid_manifest" };
  try {
    const r = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO pod.design_versions (owner_id, manifest) VALUES ($1::uuid, $2::jsonb)
       RETURNING id::text AS id, created_at`,
      [userId, JSON.stringify(checked.value)],
    );
    const row = r.rows[0];
    if (!row) throw new Error("saveDesignVersion: insert returned no row");
    return { ok: true, value: { id: row.id, createdAt: row.created_at } };
  } catch (err) {
    if (isFkViolation(err)) return { ok: false, error: "not_found" };
    throw err;
  }
}

export async function listDesignVersions(db: Db, userId: string, limit?: number): Promise<{ id: string; createdAt: Date }[]> {
  if (!isUuid(userId)) return [];
  const n = Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= MAX_LIMIT ? (limit as number) : DEFAULT_LIMIT;
  const r = await db.query<{ id: string; created_at: Date }>(
    `SELECT id::text AS id, created_at FROM pod.design_versions
      WHERE owner_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, n],
  );
  return r.rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
}

export async function getDesignVersion(db: Db, userId: string, id: string, opts?: ManifestOpts): Promise<Manifest | null> {
  if (!isUuid(userId) || !isUuid(id)) return null;
  const r = await db.query<{ manifest: unknown }>(
    "SELECT manifest FROM pod.design_versions WHERE id = $1::uuid AND owner_id = $2::uuid",
    [id, userId],
  );
  const row = r.rows[0];
  return row ? manifestForRender(row.manifest, opts) : null;
}
