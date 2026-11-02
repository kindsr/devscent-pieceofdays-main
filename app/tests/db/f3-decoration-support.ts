// F3 slice ③ RED 시험 전용 보조 함수(PLAN_mvp-domain-storage §4·§5 ③). 제품 코드가 아니며 제품 저장·렌더를 대신하지 않는다.
// - owner 경로(withOwner)는 사용자·과거(legacy) 버전 행 준비와 저장 결과 확인에만 쓴다.
// - 제품에는 db.urls.app으로 만든 pg.Pool만 넘긴다(f3-support의 openAppPool).
// - 새 제품 모듈은 f3-support의 loadExport로 각 it 안에서 동적 import한다.
import path from "node:path";
import pg from "pg";
import type { FontKey } from "@/shared/fonts";
import type { DisposableDatabase, HarnessEnv } from "./helpers";
import { APP_DIR, withOwner } from "./f2-support";
import { loadExport, type Result } from "./f3-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §4)

export const DECORATION_MODULE = path.join(APP_DIR, "src", "server", "decoration", "store.pg.ts");
export const PREFERENCES_MODULE = path.join(APP_DIR, "src", "server", "account", "preferences.pg.ts");

export type Obj = Record<string, unknown>;
export type ManifestOpts = { allowedAssets?: ReadonlySet<string> };
export type VersionRef = { id: string; createdAt: Date };

export type SaveDesignVersion = (
  db: pg.Pool,
  userId: string,
  input: unknown,
  opts?: ManifestOpts,
) => Promise<Result<VersionRef, "invalid_manifest" | "not_found">>;
export type ListDesignVersions = (db: pg.Pool, userId: string, limit?: number) => Promise<VersionRef[]>;
export type GetDesignVersion = (db: pg.Pool, userId: string, id: string, opts?: ManifestOpts) => Promise<Obj | null>;
export type Preferences = { fontKey: FontKey; appliedDesignVersionId: string | null };
export type GetPreferences = (db: pg.Pool, userId: string) => Promise<Preferences>;
export type SetFontKey = (db: pg.Pool, userId: string, key: unknown) => Promise<Result<FontKey, "invalid_font" | "not_found">>;
export type ApplyDesign = (db: pg.Pool, userId: string, versionId: string | null) => Promise<Result<null, "not_found">>;

export type DecorationApi = {
  saveDesignVersion: SaveDesignVersion;
  listDesignVersions: ListDesignVersions;
  getDesignVersion: GetDesignVersion;
};
export type PreferencesApi = { getPreferences: GetPreferences; setFontKey: SetFontKey; applyDesign: ApplyDesign };

export async function loadDecoration(): Promise<DecorationApi> {
  return {
    saveDesignVersion: await loadExport<SaveDesignVersion>(DECORATION_MODULE, "saveDesignVersion"),
    listDesignVersions: await loadExport<ListDesignVersions>(DECORATION_MODULE, "listDesignVersions"),
    getDesignVersion: await loadExport<GetDesignVersion>(DECORATION_MODULE, "getDesignVersion"),
  };
}

export async function loadPreferences(): Promise<PreferencesApi> {
  return {
    getPreferences: await loadExport<GetPreferences>(PREFERENCES_MODULE, "getPreferences"),
    setFontKey: await loadExport<SetFontKey>(PREFERENCES_MODULE, "setFontKey"),
    applyDesign: await loadExport<ApplyDesign>(PREFERENCES_MODULE, "applyDesign"),
  };
}

// ---------------------------------------------------------------- manifest fixture(PLAN §4 형식)

export const ASSET = "builtin:star";
export const ALLOW: ReadonlySet<string> = new Set([ASSET]);

export const manifestRoot = (placements: Obj[] = [], ink: Obj[] = []): Obj => ({
  schema: 1,
  base: "d-warm-pieces@1",
  placements,
  ink,
});
export const cornerPlacement = (over: Obj = {}): Obj => ({
  slot: "board.corner",
  asset: ASSET,
  anchor: "end",
  x: 0.8,
  y: 0.1,
  max_w: 0.25,
  rotate: -4,
  ...over,
});
export const penStroke = (over: Obj = {}): Obj => ({
  slot: "board.corner",
  anchor: "start",
  color: "accent",
  width: 2,
  points: [
    [0.12, 0.4],
    [0.18, 0.35],
  ],
  ...over,
});

// ---------------------------------------------------------------- 행 준비·조회(owner)

export type DesignRow = { id: string; owner_id: string; manifest: Obj; visibility: string; created_ms: string };

/** 한 사용자의 디자인 버전 행(created_at은 ms 정수 문자열로 읽는다). */
export async function designRows(env: HarnessEnv, db: DisposableDatabase, ownerId: string): Promise<DesignRow[]> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<DesignRow>(
      `SELECT id::text AS id, owner_id::text AS owner_id, manifest, visibility,
              floor(extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms
         FROM pod.design_versions WHERE owner_id = $1::uuid ORDER BY id`,
      [ownerId],
    );
    return r.rows;
  });
}

export async function countRows(
  env: HarnessEnv,
  db: DisposableDatabase,
): Promise<{ versions: number; preferences: number; users: number }> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ versions: number; preferences: number; users: number }>(
      `SELECT (SELECT count(*)::int FROM pod.design_versions) AS versions,
              (SELECT count(*)::int FROM pod.preferences) AS preferences,
              (SELECT count(*)::int FROM pod.users) AS users`,
    );
    return r.rows[0]!;
  });
}

export type PrefRow = { font_key: string; applied: string | null };

/** preferences 행(없으면 null). */
export async function prefRow(env: HarnessEnv, db: DisposableDatabase, userId: string): Promise<PrefRow | null> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<PrefRow>(
      "SELECT font_key, applied_design_version_id::text AS applied FROM pod.preferences WHERE user_id = $1::uuid",
      [userId],
    );
    return r.rows[0] ?? null;
  });
}

/**
 * 과거(legacy) 버전 행을 owner로 직접 넣는다. DB는 최소 형태(object + schema·base 키)만 막으므로
 * 앱 검증을 통과하지 못하는 manifest도 넣을 수 있다. createdAt을 주면 그 시각으로 고정한다.
 */
export async function insertLegacyVersion(
  env: HarnessEnv,
  db: DisposableDatabase,
  ownerId: string,
  manifest: Obj,
  createdAt?: string,
): Promise<string> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO pod.design_versions (owner_id, manifest, created_at)
       VALUES ($1::uuid, $2::jsonb, COALESCE($3::timestamptz, now())) RETURNING id::text AS id`,
      [ownerId, JSON.stringify(manifest), createdAt ?? null],
    );
    return r.rows[0]!.id;
  });
}

/** 같은 created_at을 포함한 여러 버전 행을 한 번에 넣고 [id, created_at ISO] 목록을 돌려준다. */
export async function insertVersionsAt(
  env: HarnessEnv,
  db: DisposableDatabase,
  ownerId: string,
  createdAts: string[],
): Promise<{ id: string; createdMs: number }[]> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ id: string; ms: string }>(
      `INSERT INTO pod.design_versions (owner_id, manifest, created_at)
       SELECT $1::uuid, $2::jsonb, t::timestamptz FROM unnest($3::text[]) AS t
       RETURNING id::text AS id, floor(extract(epoch FROM created_at) * 1000)::bigint::text AS ms`,
      [ownerId, JSON.stringify(manifestRoot([], [penStroke()])), createdAts],
    );
    return r.rows.map((x) => ({ id: x.id, createdMs: Number(x.ms) }));
  });
}

/** 기존 preferences 행을 owner로 준비한다. */
export async function insertPreferences(
  env: HarnessEnv,
  db: DisposableDatabase,
  userId: string,
  fontKey: FontKey,
  applied: string | null,
): Promise<void> {
  await withOwner(env, db, (c) =>
    c.query("INSERT INTO pod.preferences (user_id, font_key, applied_design_version_id) VALUES ($1::uuid, $2, $3::uuid)", [
      userId,
      fontKey,
      applied,
    ]),
  );
}
