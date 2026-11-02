// F3 slice ③ RED — 개인 디자인 버전(불변 저장·목록·렌더 읽기)과 기록 글꼴·적용 설정
// (PLAN_mvp-domain-storage §4·§5 ③; DATA_CONTRACT §4.3·§4.7·§5; DECORATION_MARKET_ARCHITECTURE §3.4·§5·§7).
// 실제 app role 연결(pg.Pool)로 제품 함수를 호출하고, 결과는 owner 경로의 실제 행으로 확인한다.
//
// - 이 파일 전용 일회용 DB 하나를 첫 사용 때 만들고 F2 CLI up으로 준비한다(각 it 안에서 단언, beforeAll skip 없음).
//   사례마다 owner로 독립 사용자를 만든다. 제품에는 db.urls.app의 Pool만 넘긴다.
// - store.pg.ts·preferences.pg.ts는 각 it 안에서 동적 import한다(f3-support.loadExport).
// - SQL 미실행 확인은 Pool.connect·Pool.query 관찰 spy만 쓴다(f3-diary-support.expectNoSql).
// - 여러 오류가 겹친 입력의 우선순위는 계약에 없으므로 거부 사례는 한 가지만 틀리게 둔다.
// - 저장이 자동으로 적용되는지는 요구하지 않는다(저장→적용 조율은 F5).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { expectSqlError, withApp } from "./f2-support";
import { UUID_RE, appBackend, endAllPools, freshMigratedDb, openAppPool } from "./f3-support";
import { MISSING_UUID, createUser, expectNoSql, okValue } from "./f3-diary-support";
import {
  ALLOW,
  ASSET,
  cornerPlacement,
  countRows,
  designRows,
  insertLegacyVersion,
  insertPreferences,
  insertVersionsAt,
  loadDecoration,
  loadPreferences,
  manifestRoot,
  penStroke,
  prefRow,
  type DecorationApi,
  type ManifestOpts,
  type Obj,
  type PreferencesApi,
} from "./f3-decoration-support";

const CASE_TIMEOUT = 90_000;
const DEFAULTS = { fontKey: "gothic", appliedDesignVersionId: null };

let env: HarnessEnv;
let pending: Promise<DisposableDatabase> | undefined;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  await endAllPools();
  if (env) await cleanupAll(env);
});

function migrated(): Promise<DisposableDatabase> {
  pending ??= freshMigratedDb(env, "f3deco");
  return pending;
}

type Ctx = { db: DisposableDatabase; pool: pg.Pool; deco: DecorationApi; prefs: PreferencesApi };

/** DB·app Pool(max 1) 준비 → 제품 모듈 로드 → fn. finally에서 Pool을 닫는다. */
async function withApi(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = await migrated();
  const pool = openAppPool(db, 1);
  try {
    await appBackend(pool);
    const deco = await loadDecoration();
    const prefs = await loadPreferences();
    await fn({ db, pool, deco, prefs });
    expect(pool.idleCount, "every client was released").toBe(pool.totalCount);
  } finally {
    await endAllPools();
  }
}

const VALID = manifestRoot([cornerPlacement()], [penStroke()]);
const PEN_ONLY = manifestRoot([], [penStroke({ slot: "empty.illust", color: "ink", width: 4 })]);

const WITH_ASSET = { allowedAssets: ALLOW };

async function save(deco: DecorationApi, pool: pg.Pool, userId: string, input: Obj, opts?: ManifestOpts): Promise<string> {
  const v = okValue(await deco.saveDesignVersion(pool, userId, input, opts), "saveDesignVersion");
  expect(v.id).toMatch(UUID_RE);
  expect(v.createdAt).toBeInstanceOf(Date);
  return v.id;
}

describe("saveDesignVersion: immutable private versions", () => {
  it(
    "saving a valid manifest twice creates two private rows with the exact manifest; reads match; app cannot UPDATE/DELETE",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const u = await createUser(env, db);
        const r1 = okValue(await deco.saveDesignVersion(pool, u, VALID, { allowedAssets: ALLOW }), "save 1");
        const r2 = okValue(await deco.saveDesignVersion(pool, u, VALID, { allowedAssets: ALLOW }), "save 2");
        expect(r1.id).toMatch(UUID_RE);
        expect(r2.id).toMatch(UUID_RE);
        expect(r1.id).not.toBe(r2.id);
        expect(r1.createdAt).toBeInstanceOf(Date);
        expect(r2.createdAt).toBeInstanceOf(Date);
        const rows = await designRows(env, db, u);
        expect(rows.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
        for (const [ref, row] of [r1, r2].map((ref) => [ref, rows.find((x) => x.id === ref.id)!] as const)) {
          expect(row).toMatchObject({ owner_id: u, visibility: "private", manifest: VALID });
          expect(Math.abs(Number(row.created_ms) - ref.createdAt.getTime()), "createdAt matches created_at").toBeLessThanOrEqual(1);
        }
        expect(await deco.getDesignVersion(pool, u, r1.id, { allowedAssets: ALLOW })).toEqual(VALID);
        const list = await deco.listDesignVersions(pool, u);
        expect(new Set(list.map((v) => v.id))).toEqual(new Set([r1.id, r2.id]));
        expect(list.every((v) => v.createdAt instanceof Date)).toBe(true);
        // 권한 회귀: 저장된 버전은 app role로 고치거나 지울 수 없다
        await withApp(env, db, async (c) => {
          await expectSqlError(c.query("UPDATE pod.design_versions SET manifest = manifest WHERE owner_id = $1", [u]), "42501");
          await expectSqlError(c.query("DELETE FROM pod.design_versions WHERE owner_id = $1", [u]), "42501");
        });
        expect((await designRows(env, db, u)).map((r) => r.manifest)).toEqual([VALID, VALID]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "pen-only manifests save with the default (empty) allowlist; asset placements need the allowlist",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const u = await createUser(env, db);
        const id = await save(deco, pool, u, PEN_ONLY);
        expect(okValue(await deco.saveDesignVersion(pool, u, PEN_ONLY), "pen only, no opts").id).toMatch(UUID_RE);
        expect(await deco.saveDesignVersion(pool, u, VALID)).toEqual({ ok: false, error: "invalid_manifest" });
        expect(await deco.saveDesignVersion(pool, u, VALID, {})).toEqual({ ok: false, error: "invalid_manifest" });
        expect(
          await deco.saveDesignVersion(pool, u, VALID, { allowedAssets: new Set(["builtin:moon"]) }),
        ).toEqual({ ok: false, error: "invalid_manifest" });
        expect((await designRows(env, db, u)).map((r) => r.manifest)).toEqual([PEN_ONLY, PEN_ONLY]);
        expect(await deco.getDesignVersion(pool, u, id)).toEqual(PEN_ONLY);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "invalid manifests and non-UUID users are rejected before SQL; a valid UUID that is not a user gets not_found (no raw 23503)",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const u = await createUser(env, db);
        const before = await countRows(env, db);
        const invalid: [string, unknown][] = [
          ["null", null],
          ["schema 2", { ...VALID, schema: 2 }],
          ["missing ink", { schema: 1, base: "d-warm-pieces@1", placements: [] }],
          ["extra root key", { ...VALID, font: "serif" }],
          ["x 1.5", manifestRoot([cornerPlacement({ x: 1.5 })])],
          ["ink color red", manifestRoot([], [penStroke({ color: "red" })])],
          ["three corner placements", manifestRoot([cornerPlacement(), cornerPlacement(), cornerPlacement()])],
          ["malformed asset", manifestRoot([cornerPlacement({ asset: "https://example.com/a.png" })])],
        ];
        const got = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const [, input] of invalid) out.push(await deco.saveDesignVersion(pool, u, input, { allowedAssets: ALLOW }));
          out.push(await deco.saveDesignVersion(pool, "not-a-uuid", VALID, { allowedAssets: ALLOW }));
          out.push(await deco.saveDesignVersion(pool, "", PEN_ONLY));
          return out;
        });
        invalid.forEach(([label], i) => expect(got[i], label).toEqual({ ok: false, error: "invalid_manifest" }));
        expect(got.slice(invalid.length)).toEqual([
          { ok: false, error: "not_found" },
          { ok: false, error: "not_found" },
        ]);
        expect(await deco.saveDesignVersion(pool, MISSING_UUID, VALID, { allowedAssets: ALLOW })).toEqual({
          ok: false,
          error: "not_found",
        });
        expect(await deco.saveDesignVersion(pool, MISSING_UUID, PEN_ONLY)).toEqual({ ok: false, error: "not_found" });
        expect(await countRows(env, db), "no rows or preferences were created").toEqual(before);
        expect(await prefRow(env, db, u)).toBeNull();
      });
    },
    CASE_TIMEOUT,
  );
});

describe("listDesignVersions: owner only, created_at DESC then id DESC, limit default 20", () => {
  it(
    "orders ties by id DESC, honors limits 1..100 and falls back to 20 for 0/101/2.5/NaN/negative/Infinity",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const u = await createUser(env, db);
        const other = await createUser(env, db);
        const base = Date.UTC(2026, 10, 1, 0, 0, 0);
        // 105행: 앞 5행은 가장 늦은 같은 시각(동률 → 목록 맨 앞), 나머지는 1초 간격
        const times = Array.from({ length: 105 }, (_, i) => new Date(base + (i < 5 ? 500_000 : i * 1000)).toISOString());
        const rows = await insertVersionsAt(env, db, u, times);
        await insertVersionsAt(env, db, other, [new Date(base + 999_000).toISOString()]); // 타인 행이 더 늦어도 섞이지 않는다
        const expected = [...rows].sort((a, b) => b.createdMs - a.createdMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const ids = (n: number) => expected.slice(0, n).map((r) => r.id);

        const all20 = await deco.listDesignVersions(pool, u);
        expect(all20.map((v) => v.id)).toEqual(ids(20));
        expect(all20.map((v) => v.createdAt.getTime())).toEqual(expected.slice(0, 20).map((r) => r.createdMs));
        expect((await deco.listDesignVersions(pool, u, 1)).map((v) => v.id)).toEqual(ids(1));
        expect((await deco.listDesignVersions(pool, u, 100)).map((v) => v.id)).toEqual(ids(100));
        for (const limit of [0, 101, 2.5, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
          expect((await deco.listDesignVersions(pool, u, limit)).map((v) => v.id), `limit ${limit}`).toEqual(ids(20));
        }
        // 동률 5행(가장 늦은 시각)은 맨 앞에 id DESC로 온다
        const ties = rows.filter((r) => r.createdMs === base + 500_000).map((r) => r.id).sort().reverse();
        expect(ties).toHaveLength(5);
        expect(all20.slice(0, 5).map((v) => v.id)).toEqual(ties);
        expect(new Set(all20.slice(0, 5).map((v) => v.createdAt.getTime()))).toEqual(new Set([base + 500_000]));

        expect((await deco.listDesignVersions(pool, other)).map((v) => v.id)).toHaveLength(1);
        expect(await deco.listDesignVersions(pool, MISSING_UUID)).toEqual([]);
        const nonUuid = await expectNoSql(pool, () => deco.listDesignVersions(pool, "not-a-uuid"));
        expect(nonUuid).toEqual([]);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("getDesignVersion: owner only, render fallback for stored rows", () => {
  it(
    "returns own versions only; others'/missing/non-UUID ids are null",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const a = await createUser(env, db);
        const b = await createUser(env, db);
        const id = await save(deco, pool, a, VALID, WITH_ASSET);
        expect(await deco.getDesignVersion(pool, a, id, { allowedAssets: ALLOW })).toEqual(VALID);
        expect(await deco.getDesignVersion(pool, b, id, { allowedAssets: ALLOW })).toBeNull();
        expect(await deco.getDesignVersion(pool, a, MISSING_UUID, { allowedAssets: ALLOW })).toBeNull();
        expect(await deco.getDesignVersion(pool, MISSING_UUID, id, { allowedAssets: ALLOW })).toBeNull();
        const got = await expectNoSql(pool, async () => [
          await deco.getDesignVersion(pool, a, "not-a-uuid", { allowedAssets: ALLOW }),
          await deco.getDesignVersion(pool, "not-a-uuid", id, { allowedAssets: ALLOW }),
        ]);
        expect(got).toEqual([null, null]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "legacy rows: unknown schema/base, broken structure and known-slot bad values read as null; unknown slots and non-allowlisted assets are dropped",
    async () => {
      await withApi(async ({ db, pool, deco }) => {
        const u = await createUser(env, db);
        const legacy = (m: Obj) => insertLegacyVersion(env, db, u, m);
        const nulls: [string, Obj][] = [
          ["schema 2", { ...VALID, schema: 2 }],
          ["base other", { ...VALID, base: "d-warm-pieces@9" }],
          ["placements not array", { ...VALID, placements: "x" }],
          ["missing ink", { schema: 1, base: "d-warm-pieces@1", placements: [] }],
          ["known slot x 1.5", manifestRoot([cornerPlacement({ x: 1.5 })], [penStroke()])],
          ["ink width 3", manifestRoot([], [penStroke({ width: 3 })])],
        ];
        for (const [label, m] of nulls) {
          const id = await legacy(m);
          expect(await deco.getDesignVersion(pool, u, id, { allowedAssets: ALLOW }), label).toBeNull();
        }
        const future = cornerPlacement({ slot: "board.future" });
        const tape = cornerPlacement({ slot: "oneline.tape", asset: "builtin:sun" });
        const corner = cornerPlacement();
        const pen = penStroke();
        const mixedId = await legacy(manifestRoot([future, corner, tape], [pen]));
        expect(await deco.getDesignVersion(pool, u, mixedId, { allowedAssets: ALLOW })).toEqual(manifestRoot([corner], [pen]));
        // 기본(빈) 허용 목록이면 asset 항목은 모두 버리고 펜은 남는다
        expect(await deco.getDesignVersion(pool, u, mixedId)).toEqual(manifestRoot([], [pen]));
        expect(await deco.getDesignVersion(pool, u, mixedId, { allowedAssets: new Set([ASSET, "builtin:sun"]) })).toEqual(
          manifestRoot([corner, tape], [pen]),
        );
      });
    },
    CASE_TIMEOUT,
  );
});

describe("preferences: font key and applied design", () => {
  it(
    "defaults gothic/null for no row, missing users and non-UUID users; reading creates no row",
    async () => {
      await withApi(async ({ db, pool, prefs }) => {
        const u = await createUser(env, db);
        const before = await countRows(env, db);
        expect(await prefs.getPreferences(pool, u)).toEqual(DEFAULTS);
        expect(await prefs.getPreferences(pool, MISSING_UUID)).toEqual(DEFAULTS);
        expect(await expectNoSql(pool, () => prefs.getPreferences(pool, "not-a-uuid"))).toEqual(DEFAULTS);
        expect(await prefRow(env, db, u)).toBeNull();
        expect(await countRows(env, db)).toEqual(before);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "setFontKey stores each allowed key and keeps the applied design; invalid keys → invalid_font before SQL; bad/missing users → not_found",
    async () => {
      await withApi(async ({ db, pool, deco, prefs }) => {
        const u = await createUser(env, db);
        const v = await save(deco, pool, u, PEN_ONLY);
        expect(await prefs.applyDesign(pool, u, v)).toEqual({ ok: true, value: null });
        for (const key of ["serif", "hand", "gothic", "serif"] as const) {
          expect(await prefs.setFontKey(pool, u, key)).toEqual({ ok: true, value: key });
          expect(await prefs.getPreferences(pool, u)).toEqual({ fontKey: key, appliedDesignVersionId: v });
          expect(await prefRow(env, db, u)).toEqual({ font_key: key, applied: v });
        }
        const bad: unknown[] = ["comic", "GOTHIC", " serif", "serif ", "", null, undefined, 1, true, {}, ["serif"]];
        const got = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const key of bad) out.push(await prefs.setFontKey(pool, u, key));
          out.push(await prefs.setFontKey(pool, "not-a-uuid", "hand"));
          return out;
        });
        bad.forEach((key, i) => expect(got[i], JSON.stringify(key) ?? "undefined").toEqual({ ok: false, error: "invalid_font" }));
        expect(got[bad.length]).toEqual({ ok: false, error: "not_found" });
        expect(await prefRow(env, db, u)).toEqual({ font_key: "serif", applied: v });

        const before = await countRows(env, db);
        expect(await prefs.setFontKey(pool, MISSING_UUID, "hand")).toEqual({ ok: false, error: "not_found" });
        expect(await countRows(env, db)).toEqual(before);
        // 행이 없던 사용자도 글꼴만 저장되고 적용 값은 null
        const fresh = await createUser(env, db);
        expect(await prefs.setFontKey(pool, fresh, "hand")).toEqual({ ok: true, value: "hand" });
        expect(await prefs.getPreferences(pool, fresh)).toEqual({ fontKey: "hand", appliedDesignVersionId: null });
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "applyDesign applies/switches/clears own versions and keeps the font; others'/missing/non-UUID versions and users → not_found with values unchanged",
    async () => {
      await withApi(async ({ db, pool, deco, prefs }) => {
        const u = await createUser(env, db);
        const other = await createUser(env, db);
        const v1 = await save(deco, pool, u, PEN_ONLY);
        const v2 = await save(deco, pool, u, VALID, WITH_ASSET);
        const theirs = await save(deco, pool, other, PEN_ONLY);
        // 행이 없을 때 null 해제는 성공하고 기본값 그대로
        expect(await prefs.applyDesign(pool, u, null)).toEqual({ ok: true, value: null });
        expect(await prefs.getPreferences(pool, u)).toEqual(DEFAULTS);
        expect(okValue(await prefs.setFontKey(pool, u, "hand"), "font hand")).toBe("hand");
        expect(await prefs.applyDesign(pool, u, v1)).toEqual({ ok: true, value: null });
        expect(await prefs.getPreferences(pool, u)).toEqual({ fontKey: "hand", appliedDesignVersionId: v1 });
        expect(await prefs.applyDesign(pool, u, v2)).toEqual({ ok: true, value: null });
        expect(await prefs.getPreferences(pool, u)).toEqual({ fontKey: "hand", appliedDesignVersionId: v2 });

        const nf = { ok: false, error: "not_found" };
        expect(await prefs.applyDesign(pool, u, theirs), "another user's version").toEqual(nf);
        expect(await prefs.applyDesign(pool, u, MISSING_UUID), "missing version").toEqual(nf);
        expect(await prefs.applyDesign(pool, u, "not-a-uuid"), "non-UUID version").toEqual(nf);
        expect(await expectNoSql(pool, () => prefs.applyDesign(pool, "not-a-uuid", v1)), "non-UUID user").toEqual(nf);
        expect(await prefs.applyDesign(pool, other, v1), "other applying my version").toEqual(nf);
        expect(await prefRow(env, db, u)).toEqual({ font_key: "hand", applied: v2 });
        expect(await prefRow(env, db, other)).toBeNull();

        const before = await countRows(env, db);
        expect(await prefs.applyDesign(pool, MISSING_UUID, null), "missing user clearing").toEqual(nf);
        expect(await prefs.applyDesign(pool, MISSING_UUID, v1), "missing user applying").toEqual(nf);
        expect(await countRows(env, db)).toEqual(before);

        expect(await prefs.applyDesign(pool, u, null)).toEqual({ ok: true, value: null });
        expect(await prefs.getPreferences(pool, u)).toEqual({ fontKey: "hand", appliedDesignVersionId: null });
        expect(await prefRow(env, db, u)).toEqual({ font_key: "hand", applied: null });
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "concurrent setFontKey and applyDesign on two real connections keep both values (no row yet, and existing row)",
    async () => {
      await withApi(async ({ db, pool, deco, prefs }) => {
        const p1 = openAppPool(db, 1);
        const p2 = openAppPool(db, 1);
        const pids = await Promise.all([appBackend(p1), appBackend(p2)]);
        expect(new Set(pids).size, "2 distinct backend connections").toBe(2);
        for (let round = 0; round < 5; round += 1) {
          // 행이 없는 사용자
          const fresh = await createUser(env, db);
          const fv = await save(deco, pool, fresh, PEN_ONLY);
          const [f1, f2] = await Promise.all([prefs.setFontKey(p1, fresh, "serif"), prefs.applyDesign(p2, fresh, fv)]);
          expect([f1, f2], `fresh round ${round}`).toEqual([
            { ok: true, value: "serif" },
            { ok: true, value: null },
          ]);
          expect(await prefRow(env, db, fresh)).toEqual({ font_key: "serif", applied: fv });

          // 기존 행이 있는 사용자
          const u = await createUser(env, db);
          const v1 = await save(deco, pool, u, PEN_ONLY);
          const v2 = await save(deco, pool, u, PEN_ONLY);
          await insertPreferences(env, db, u, "hand", v1);
          const [e1, e2] = await Promise.all([prefs.applyDesign(p1, u, v2), prefs.setFontKey(p2, u, "gothic")]);
          expect([e1, e2], `existing round ${round}`).toEqual([
            { ok: true, value: null },
            { ok: true, value: "gothic" },
          ]);
          expect(await prefRow(env, db, u)).toEqual({ font_key: "gothic", applied: v2 });
          expect(await prefs.getPreferences(pool, u)).toEqual({ fontKey: "gothic", appliedDesignVersionId: v2 });
        }
        expect(p1.idleCount).toBe(p1.totalCount);
        expect(p2.idleCount).toBe(p2.totalCount);
      });
    },
    CASE_TIMEOUT,
  );
});
