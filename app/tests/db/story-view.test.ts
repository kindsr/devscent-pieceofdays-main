// PLAN_ai-daily-story-view §2·§3 S2 RED(DB): listStoryDates. 일회용 PG18·app role·기존 하네스만 쓴다. 실제 API·키·서비스 DB 0.
// - 선행 조건: S1 0005_daily_stories(pod.story_versions)가 기본 up에 있어야 한다. S1 GREEN을 받기 전에는
//   'S1 precondition' 문구의 단언에서 멈춘다 — 이것은 S2 UI/calendar RED가 아니다.
// - 신규 calendar.pg.ts는 existsSync 뒤 변수 경로로 동적 import한다(정적 import 없음 → TS2307이 아닌 단언 실패).
// - 이야기 행은 owner가 합성 값으로 준비한다(시험 전용). 제품 권한을 완화하지 않는다.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { APP_DIR, readMigrationRows, relationExists, withOwner } from "./f2-support";
import { appBackend, endAllPools, expectLedgerInvariants, freshMigratedDb, openAppPool, type Result } from "./f3-support";
import { MISSING_UUID } from "./f3-diary-support";
import { seedUser, setPending } from "./f4-lifecycle-support";

type Subject = { userId: string; gen: number };
type ListStoryDates = (db: unknown, subject: Subject, from: string, to: string) => Promise<Result<string[], "invalid_date" | "not_signed_in">>;

const CALENDAR = path.join(APP_DIR, "src", "server", "stories", "calendar.pg.ts");
const UUID = "0190f0a0-0000-7000-8000-0000000000c1";
const rev = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let env: HarnessEnv;
beforeAll(() => { env = readDisposableEnv(); });
afterAll(async () => { try { await endAllPools(); } finally { if (env) await cleanupAll(env); } });

async function loadListStoryDates(): Promise<ListStoryDates> {
  const rel = path.relative(APP_DIR, CALENDAR);
  expect(existsSync(CALENDAR), `${rel} must exist (PLAN_ai-daily-story-view §2)`).toBe(true);
  const mod = (await import(/* @vite-ignore */ CALENDAR)) as Record<string, unknown>;
  expect(typeof mod.listStoryDates, `${rel} must export function listStoryDates`).toBe("function");
  return mod.listStoryDates as ListStoryDates;
}

/** S1 선행 조건: 기존 0001~0004 뒤에 0005_daily_stories와 pod.story_versions가 있어야 한다. */
async function expectS1Storage(db: DisposableDatabase): Promise<void> {
  const pairs = ((await withOwner(env, db, (c) => readMigrationRows(c))) ?? []).map((r) => [r.version, r.name]);
  expect(pairs.slice(0, 4), "existing harness migrates 0001~0004").toEqual([[1, "init"], [2, "account_lifecycle"], [3, "reflection_time"], [4, "private_photos"]]);
  expect(pairs[4], "S1 precondition (not an S2 RED): 0005_daily_stories must be applied by the default up").toEqual([5, "daily_stories"]);
  expect(await withOwner(env, db, (c) => relationExists(c, "pod.story_versions")), "S1 precondition: to_regclass('pod.story_versions')").toBe(true);
}

async function withCalendar(label: string, fn: (list: ListStoryDates, pool: pg.Pool, db: DisposableDatabase) => Promise<void>): Promise<void> {
  const db = await freshMigratedDb(env, label);
  await expectS1Storage(db);
  const list = await loadListStoryDates();
  const pool = openAppPool(db);
  try {
    await appBackend(pool);
    await fn(list, pool, db);
    await expectLedgerInvariants(env, db);
  } finally {
    await endAllPools();
  }
}

/** owner 전용 합성 이야기 행(날짜·version·revision·본문). */
async function seedStories(db: DisposableDatabase, userId: string, rows: [date: string, version: number][]): Promise<void> {
  await withOwner(env, db, async (c) => {
    for (const [date, version] of rows) {
      await c.query(
        "INSERT INTO pod.story_versions (user_id, local_date, version, source_revision, body) VALUES ($1::uuid, $2::date, $3, $4, $5)",
        [userId, date, version, rev(`${userId}:${date}:${version}`), `합성 이야기 ${date} v${version}`],
      );
    }
  });
}

async function dump(db: DisposableDatabase): Promise<unknown[]> {
  return withOwner(env, db, async (c) => [
    (await c.query("SELECT id::text, user_id::text, local_date::text, version, source_revision, body, created_at::text FROM pod.story_versions ORDER BY id")).rows,
    (await c.query("SELECT id::text, local_date::text, body, version, updated_at::text FROM pod.diary_moments ORDER BY id")).rows,
    (await c.query("SELECT id::text, status, auth_generation FROM pod.users ORDER BY id")).rows,
  ]);
}

describe("listStoryDates", () => {
  it("returns distinct ascending story dates in [from, to) up to 62 days for the active user only, allows future ranges and writes nothing", async () => {
    await withCalendar("storydates", async (list, pool, db) => {
      const a = await seedUser(env, db, []);
      const b = await seedUser(env, db, []);
      await seedStories(db, a, [["2026-11-15", 1], ["2026-11-15", 2], ["2026-11-15", 3], ["2026-10-31", 1], ["2026-11-01", 1], ["2026-11-30", 1], ["2026-12-01", 1], ["2026-12-02", 1]]);
      await seedStories(db, b, [["2026-11-02", 1]]);
      // 원본 조각만 있고 이야기가 없는 날은 이야기 날짜가 아니다.
      await withOwner(env, db, (c) => c.query(
        "INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, body) VALUES ($1::uuid, DATE '2026-11-03', TIMESTAMPTZ '2026-11-03 09:00:00+09', '이야기 없는 조각')", [a],
      ));
      const before = await dump(db);
      const sa = { userId: a, gen: 1 };
      expect(await list(pool, sa, "2026-11-01", "2026-12-01"), "from included, to excluded, versions deduplicated").toEqual({ ok: true, value: ["2026-11-01", "2026-11-15", "2026-11-30"] });
      expect(await list(pool, sa, "2026-10-01", "2026-12-02"), "exactly 62 days").toEqual({ ok: true, value: ["2026-10-31", "2026-11-01", "2026-11-15", "2026-11-30", "2026-12-01"] });
      expect(await list(pool, sa, "2026-11-15", "2026-11-16"), "one-day range").toEqual({ ok: true, value: ["2026-11-15"] });
      expect(await list(pool, sa, "2027-01-01", "2027-01-31"), "future range is allowed").toEqual({ ok: true, value: [] });
      expect(await list(pool, sa, "2026-11-02", "2026-11-03"), "another user's story date is invisible").toEqual({ ok: true, value: [] });
      expect(await list(pool, { userId: b, gen: 1 }, "2026-11-01", "2026-12-01")).toEqual({ ok: true, value: ["2026-11-02"] });
      expect(await dump(db), "listing writes nothing").toEqual(before);
    });
  }, 90_000);

  it("refuses bad subjects (not_signed_in) before bad ranges (invalid_date) without SQL, refuses stale/pending/missing accounts and rethrows DB errors", async () => {
    const list = await loadListStoryDates();
    const query = vi.fn(async () => { throw new Error("ci-only: SQL must not run before validation"); });
    const connect = vi.fn(async () => { throw new Error("ci-only: no connection before validation"); });
    const fake = { query, connect };
    for (const subject of [{ userId: "not-a-uuid", gen: 1 }, { userId: UUID, gen: 0 }, { userId: UUID, gen: 1.5 }, { userId: UUID, gen: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(await list(fake, subject, "2026-11-01", "2026-11-01"), JSON.stringify(subject)).toEqual({ ok: false, error: "not_signed_in" });
    }
    for (const [from, to] of [
      ["2026-11-01", "2026-11-01"], ["2026-11-02", "2026-11-01"], ["2026-10-01", "2026-12-03"], ["2026-02-30", "2026-03-02"],
      ["2026-11-1", "2026-11-20"], ["2026-11-01", ""], ["", "2026-11-02"], ["2026-11-01T00:00", "2026-11-02"],
    ] as const) {
      expect(await list(fake, { userId: UUID, gen: 1 }, from, to), `${from} → ${to}`).toEqual({ ok: false, error: "invalid_date" });
    }
    expect(query, "no SQL before validation").not.toHaveBeenCalled();
    expect(connect, "no connection before validation").not.toHaveBeenCalled();
    await expect(list(fake, { userId: UUID, gen: 1 }, "2026-11-01", "2026-12-01"), "unexpected DB errors are thrown").rejects.toBeDefined();

    await withCalendar("storydatesfence", async (listDb, pool, db) => {
      const stale = await seedUser(env, db, [], { gen: 2 });
      const pending = await seedUser(env, db, []);
      await seedStories(db, stale, [["2026-11-10", 1]]);
      await seedStories(db, pending, [["2026-11-10", 1]]);
      await setPending(env, db, pending, "now()", 2);
      for (const subject of [{ userId: stale, gen: 1 }, { userId: pending, gen: 2 }, { userId: MISSING_UUID, gen: 1 }]) {
        expect(await listDb(pool, subject, "2026-11-01", "2026-12-01"), JSON.stringify(subject)).toEqual({ ok: false, error: "not_signed_in" });
      }
      expect(await listDb(pool, { userId: stale, gen: 2 }, "2026-11-01", "2026-12-01")).toEqual({ ok: true, value: ["2026-11-10"] });
    });
  }, 90_000);
});
