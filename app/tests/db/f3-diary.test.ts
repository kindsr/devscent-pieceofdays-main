// F3 slice ② RED — 조각·하루 한 줄 CRUD, 소유권, 낙관적 잠금, 서울 날짜(PLAN_mvp-domain-storage §3·§5 ②;
// DATA_CONTRACT §4.4~§4.6·§5). 실제 app role 연결(pg.Pool)로 createPgDiaryStore를 호출해 판정한다.
//
// - 이 파일 전용 일회용 DB 하나를 첫 사용 때 만들고 F2 CLI up으로 준비한다(각 it 안에서 단언, beforeAll skip 없음).
//   사례마다 owner로 독립 사용자를 만든다. 제품 쓰기는 제품 함수로만 한다.
// - 제품에는 db.urls.app의 Pool만 넘긴다. Pool은 각 it의 finally에서 닫고, afterAll에서 이번 실행이 만든 DB만 지운다.
// - store.pg.ts는 각 it 안에서 동적 import한다. 계약 타입은 f3-diary-support.ts의 최소 로컬 타입이다.
// - [가정] 미래 날짜 판정의 "서울 오늘"은 주입 시계 now()의 seoulLocalDate다.
// - [가정] 저장되는 본문은 trim() 결과다(검증이 trim 후 길이로 하므로 DB CHECK와 맞으려면 같아야 한다).
// - 월 목록의 날짜 순서는 계약에 없으므로 집합으로 비교한다.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupAll, readDisposableEnv, type DisposableDatabase, type HarnessEnv } from "./helpers";
import { UUID_RE, appBackend, endAllPools, freshMigratedDb, openAppPool } from "./f3-support";
import {
  MISSING_UUID,
  createUser,
  expectNoSql,
  loadCreatePgDiaryStore,
  makeClock,
  momentRows,
  okValue,
  pgSeoulWall,
  summaryRows,
  tableCounts,
  type Day,
  type PgDiaryStore,
} from "./f3-diary-support";

const CASE_TIMEOUT = 90_000;
const NOW = "2026-11-02T03:00:00.000Z"; // 서울 2026-11-02 12:00
const TODAY = "2026-11-02";

let env: HarnessEnv;
let pending: Promise<DisposableDatabase> | undefined;

beforeAll(() => {
  env = readDisposableEnv();
});

afterAll(async () => {
  await endAllPools();
  if (env) await cleanupAll(env);
});

/** 파일 공용 일회용 DB(첫 호출에서 생성·up). 실패하면 그 it이 환경 오류로 실패한다. */
function migrated(): Promise<DisposableDatabase> {
  pending ??= freshMigratedDb(env, "f3diary");
  return pending;
}

type Ctx = { db: DisposableDatabase; pool: pg.Pool; store: PgDiaryStore; clock: ReturnType<typeof makeClock> };

/** DB·app Pool(max 1) 준비 → 제품 모듈 로드 → fn. finally에서 Pool을 닫는다. */
async function withStore(fn: (ctx: Ctx) => Promise<void>, startAt = NOW): Promise<void> {
  const db = await migrated();
  const pool = openAppPool(db, 1);
  try {
    await appBackend(pool);
    const createPgDiaryStore = await loadCreatePgDiaryStore();
    const clock = makeClock(startAt);
    const store = createPgDiaryStore(pool, { now: clock.now });
    await fn({ db, pool, store, clock });
    expect(pool.idleCount, "every client was released").toBe(pool.totalCount);
  } finally {
    await endAllPools();
  }
}

async function create(store: PgDiaryStore, userId: string, body: string): Promise<string> {
  const ref = okValue(await store.createMoment(userId, body), `create ${JSON.stringify(body.slice(0, 20))}`);
  expect(ref.id).toMatch(UUID_RE);
  expect(ref.version).toBe(1);
  return ref.id;
}

const byDate = (days: Day[]) => [...days].sort((a, b) => a.date.localeCompare(b.date));

describe("createMoment + getDay: stored rows and public read", () => {
  it(
    "creates at the injected now with the Seoul date, version 1, image null, summaryVersion null; empty day is null",
    async () => {
      await withStore(async ({ db, store }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "  첫 조각  ");
        const rows = await momentRows(env, db, u);
        expect(rows).toEqual([
          {
            id,
            local_date: TODAY,
            occurred_at: NOW,
            seoul_wall: "2026-11-02 12:00",
            time_zone: "Asia/Seoul",
            body: "첫 조각",
            version: 1,
          },
        ]);
        expect(await store.getDay(u, TODAY)).toEqual({
          date: TODAY,
          summary: "",
          summaryVersion: null,
          moments: [{ id, time: "12:00", text: "첫 조각", image: null, version: 1 }],
        });
        expect(await store.getDay(u, "2026-11-01"), "a day without moments or summary").toBeNull();
        expect(await store.listMonth(u, 2026, 11)).toEqual([
          {
            date: TODAY,
            summary: "",
            summaryVersion: null,
            moments: [{ id, time: "12:00", text: "첫 조각", image: null, version: 1 }],
          },
        ]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "body is trimmed then counted in code points: 1·300 (incl. emoji) accepted, 0·301·whitespace rejected without SQL; SQL metacharacters stay data",
    async () => {
      await withStore(async ({ db, pool, store }) => {
        const u = await createUser(env, db);
        const accepted = [
          "a",
          "x".repeat(300),
          "😀".repeat(300), // 300 코드포인트 = 600 UTF-16 단위
          "가".repeat(300),
          ` \n${"y".repeat(300)}\t `, // trim 후 300
          "x'); DROP TABLE pod.diary_moments; --",
          "$1 $2::uuid \\ \" ' % _ * first_login:",
        ];
        for (const body of accepted) await create(store, u, body);
        const rejected = ["", " ", " \n\t ", "x".repeat(301), "😀".repeat(301), ` ${"z".repeat(301)} `];
        const results = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const body of rejected) out.push(await store.createMoment(u, body));
          return out;
        });
        results.forEach((r, i) =>
          expect(r, JSON.stringify(rejected[i]!.slice(0, 10))).toEqual({ ok: false, error: "invalid_body" }),
        );
        const stored = (await momentRows(env, db, u)).map((r) => r.body);
        expect(stored).toHaveLength(accepted.length);
        expect(new Set(stored)).toEqual(new Set(accepted.map((b) => b.trim())));
        const day = await store.getDay(u, TODAY);
        expect(new Set(day?.moments.map((m) => m.text))).toEqual(new Set(accepted.map((b) => b.trim())));
      });
    },
    CASE_TIMEOUT,
  );
});

describe("Seoul date of created moments (injected clock)", () => {
  it(
    "modern midnight, month end, leap day and year end follow Asia/Seoul",
    async () => {
      await withStore(async ({ db, store, clock }) => {
        const u = await createUser(env, db);
        const cases: [string, string, string][] = [
          ["2026-11-01T14:59:59.000Z", "2026-11-01", "23:59"],
          ["2026-11-01T15:00:00.000Z", "2026-11-02", "00:00"],
          ["2026-01-31T15:00:00.000Z", "2026-02-01", "00:00"],
          ["2026-02-28T15:00:00.000Z", "2026-03-01", "00:00"],
          ["2028-02-28T15:00:00.000Z", "2028-02-29", "00:00"],
          ["2026-12-31T14:59:59.000Z", "2026-12-31", "23:59"],
          ["2026-12-31T15:00:00.000Z", "2027-01-01", "00:00"],
        ];
        for (const [iso, date, time] of cases) {
          clock.set(iso);
          const id = await create(store, u, `at ${iso}`);
          const row = (await momentRows(env, db, u)).find((r) => r.id === id);
          expect(row, iso).toMatchObject({ local_date: date, occurred_at: iso });
          const day = await store.getDay(u, date);
          expect(day?.moments.find((m) => m.id === id), iso).toMatchObject({ time, version: 1, image: null });
        }
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "IANA history: 1988-08-01T14:30Z → 1988-08-02 00:30 and 1960-01-01T15:15Z → 1960-01-01 23:45 in both stored local_date and PG time",
    async () => {
      const db = await migrated();
      // 양성 제어: PG tzdata의 Asia/Seoul 이력(제품과 무관).
      expect(await pgSeoulWall(env, db, "1988-08-01T14:30:00Z")).toBe("1988-08-02 00:30");
      expect(await pgSeoulWall(env, db, "1960-01-01T15:15:00Z")).toBe("1960-01-01 23:45");
      await withStore(async ({ store, clock }) => {
        const u = await createUser(env, db);
        const cases: [string, string, string][] = [
          ["1988-08-01T14:30:00.000Z", "1988-08-02", "00:30"],
          ["1960-01-01T15:15:00.000Z", "1960-01-01", "23:45"],
        ];
        for (const [iso, date, time] of cases) {
          clock.set(iso);
          const id = await create(store, u, `history ${iso}`);
          const row = (await momentRows(env, db, u)).find((r) => r.id === id);
          expect(row, `stored local_date must equal the PG Seoul date for ${iso}`).toMatchObject({
            local_date: date,
            occurred_at: iso,
            seoul_wall: `${date} ${time}`,
          });
          const day = await store.getDay(u, date);
          expect(day?.moments.map((m) => [m.id, m.time]), iso).toEqual([[id, time]]);
        }
      });
    },
    CASE_TIMEOUT,
  );
});

describe("updateMoment / deleteMoment: optimistic locking and ownership", () => {
  it(
    "update bumps version and keeps occurred_at/local_date/time; delete removes the row; the day becomes null",
    async () => {
      await withStore(async ({ db, store, clock }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "before");
        const [before] = await momentRows(env, db, u);
        clock.set("2026-11-05T10:00:00.000Z"); // 다른 날로 시계를 옮겨도 수정은 시각·날짜를 바꾸지 않는다
        expect(await store.updateMoment(u, id, 1, "  after  ")).toEqual({ ok: true, value: { id, version: 2 } });
        expect(await momentRows(env, db, u)).toEqual([{ ...before!, body: "after", version: 2 }]);
        expect(await store.getDay(u, TODAY)).toEqual({
          date: TODAY,
          summary: "",
          summaryVersion: null,
          moments: [{ id, time: "12:00", text: "after", image: null, version: 2 }],
        });
        expect(await store.getDay(u, "2026-11-05")).toBeNull();
        expect(await store.updateMoment(u, id, 2, "third")).toEqual({ ok: true, value: { id, version: 3 } });
        expect(await store.deleteMoment(u, id, 3)).toEqual({ ok: true, value: null });
        expect(await momentRows(env, db, u)).toEqual([]);
        expect(await store.getDay(u, TODAY)).toBeNull();
        // 삭제된 id는 not_found
        expect(await store.updateMoment(u, id, 3, "x")).toEqual({ ok: false, error: "not_found" });
        expect(await store.deleteMoment(u, id, 3)).toEqual({ ok: false, error: "not_found" });
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "stale version → conflict (row unchanged); another user's, missing and deleted ids → not_found",
    async () => {
      await withStore(async ({ db, store }) => {
        const a = await createUser(env, db);
        const b = await createUser(env, db);
        const id = await create(store, a, "mine");
        okValue(await store.updateMoment(a, id, 1, "mine v2"), "update to v2");
        const snapshot = await momentRows(env, db, a);
        expect(await store.updateMoment(a, id, 1, "stale")).toEqual({ ok: false, error: "conflict" });
        expect(await store.updateMoment(a, id, 3, "ahead")).toEqual({ ok: false, error: "conflict" });
        expect(await store.deleteMoment(a, id, 1)).toEqual({ ok: false, error: "conflict" });
        // 타인: 버전이 맞아도 틀려도 존재를 드러내지 않는다
        expect(await store.updateMoment(b, id, 2, "theirs")).toEqual({ ok: false, error: "not_found" });
        expect(await store.updateMoment(b, id, 1, "theirs")).toEqual({ ok: false, error: "not_found" });
        expect(await store.deleteMoment(b, id, 2)).toEqual({ ok: false, error: "not_found" });
        expect(await store.getDay(b, TODAY)).toBeNull();
        // 없는 id
        expect(await store.updateMoment(a, MISSING_UUID, 1, "x")).toEqual({ ok: false, error: "not_found" });
        expect(await store.deleteMoment(a, MISSING_UUID, 1)).toEqual({ ok: false, error: "not_found" });
        expect(await momentRows(env, db, a), "nothing changed").toEqual(snapshot);
        expect(await momentRows(env, db, b)).toEqual([]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "validation order user → id → version → date → body, each rejected before any SQL",
    async () => {
      await withStore(async ({ db, pool, store }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "keep");
        const bad = "not-a-uuid";
        const long = "x".repeat(301);
        const got = await expectNoSql(pool, async () => ({
          create: [await store.createMoment(bad, ""), await store.createMoment(u, "   ")],
          update: [
            await store.updateMoment(bad, bad, 0, long),
            await store.updateMoment(u, bad, 0, long),
            await store.updateMoment(u, id, 0, long),
            await store.updateMoment(u, id, 1, long),
            await store.updateMoment(u, id, 1, " "),
          ],
          del: [
            await store.deleteMoment(bad, bad, 0),
            await store.deleteMoment(u, bad, 0),
            await store.deleteMoment(u, id, 0),
          ],
          summary: [
            await store.saveSummary(bad, "2026-02-30", 0, long),
            await store.saveSummary(u, "2026-02-30", 0, long),
            await store.saveSummary(u, "2026-02-30", null, long),
            await store.saveSummary(u, "2026-11-03", null, long), // 주입 시계 기준 미래
            await store.saveSummary(u, "2026-11-2", 1, "x"),
            await store.saveSummary(u, TODAY, null, long),
            await store.saveSummary(u, TODAY, 1, long),
          ],
          reads: [
            await store.getDay(bad, TODAY),
            await store.getDay(u, "2026-02-30"),
            await store.getDay(u, "2026-11-2"),
            await store.listMonth(bad, 2026, 11),
          ],
        }));
        const nf = { ok: false, error: "not_found" };
        const iv = { ok: false, error: "invalid_version" };
        const ib = { ok: false, error: "invalid_body" };
        const id8 = { ok: false, error: "invalid_date" };
        expect(got.create).toEqual([nf, ib]);
        expect(got.update).toEqual([nf, nf, iv, ib, ib]);
        expect(got.del).toEqual([nf, nf, iv]);
        expect(got.summary).toEqual([nf, iv, id8, id8, id8, ib, ib]);
        expect(got.reads).toEqual([null, null, null, []]);
        expect((await momentRows(env, db, u)).map((r) => [r.body, r.version])).toEqual([["keep", 1]]);
        expect(await summaryRows(env, db, u)).toEqual([]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "expectedVersion 0/negative/fraction/NaN/±Infinity/unsafe integer → invalid_version without SQL",
    async () => {
      await withStore(async ({ db, pool, store }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "v");
        okValue(await store.saveSummary(u, TODAY, null, "line"), "summary v1");
        const versions = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, -0.5];
        const got = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const v of versions) {
            out.push(await store.updateMoment(u, id, v, "x"));
            out.push(await store.deleteMoment(u, id, v));
            out.push(await store.saveSummary(u, TODAY, v, "x"));
            out.push(await store.saveSummary(u, TODAY, v, ""));
          }
          return out;
        });
        got.forEach((r, i) =>
          expect(r, `version ${String(versions[Math.floor(i / 4)])} call ${i % 4}`).toEqual({
            ok: false,
            error: "invalid_version",
          }),
        );
        expect((await momentRows(env, db, u)).map((r) => [r.body, r.version])).toEqual([["v", 1]]);
        expect(await summaryRows(env, db, u)).toEqual([{ local_date: TODAY, body: "line", version: 1 }]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "safe integers beyond int4 (2^31, MAX_SAFE_INTEGER) are valid versions: conflict on own rows, not_found otherwise (no raw 22003)",
    async () => {
      await withStore(async ({ db, store }) => {
        const a = await createUser(env, db);
        const b = await createUser(env, db);
        const id = await create(store, a, "big");
        okValue(await store.saveSummary(a, TODAY, null, "line"), "summary v1");
        for (const v of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
          expect(await store.updateMoment(a, id, v, "x"), `update own ${v}`).toEqual({ ok: false, error: "conflict" });
          expect(await store.deleteMoment(a, id, v), `delete own ${v}`).toEqual({ ok: false, error: "conflict" });
          expect(await store.saveSummary(a, TODAY, v, "x"), `summary own ${v}`).toEqual({ ok: false, error: "conflict" });
          expect(await store.saveSummary(a, TODAY, v, ""), `summary own delete ${v}`).toEqual({
            ok: false,
            error: "conflict",
          });
          expect(await store.updateMoment(b, id, v, "x"), `update other ${v}`).toEqual({ ok: false, error: "not_found" });
          expect(await store.deleteMoment(a, MISSING_UUID, v), `delete missing ${v}`).toEqual({
            ok: false,
            error: "not_found",
          });
          expect(await store.saveSummary(b, TODAY, v, "x"), `summary other ${v}`).toEqual({
            ok: false,
            error: "not_found",
          });
          expect(await store.saveSummary(a, "2026-10-01", v, "x"), `summary missing ${v}`).toEqual({
            ok: false,
            error: "not_found",
          });
        }
        expect((await momentRows(env, db, a)).map((r) => [r.body, r.version])).toEqual([["big", 1]]);
        expect(await summaryRows(env, db, a)).toEqual([{ local_date: TODAY, body: "line", version: 1 }]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "a valid UUID that is not a user gets not_found for every write (no raw 23503) and no rows are created",
    async () => {
      await withStore(async ({ db, store }) => {
        const before = await tableCounts(env, db);
        expect(await store.createMoment(MISSING_UUID, "ghost")).toEqual({ ok: false, error: "not_found" });
        expect(await store.updateMoment(MISSING_UUID, MISSING_UUID, 1, "ghost")).toEqual({ ok: false, error: "not_found" });
        expect(await store.deleteMoment(MISSING_UUID, MISSING_UUID, 1)).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(MISSING_UUID, TODAY, null, "ghost")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(MISSING_UUID, TODAY, null, "")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(MISSING_UUID, TODAY, 1, "ghost")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(MISSING_UUID, TODAY, 1, "")).toEqual({ ok: false, error: "not_found" });
        expect(await store.getDay(MISSING_UUID, TODAY)).toBeNull();
        expect(await store.listMonth(MISSING_UUID, 2026, 11)).toEqual([]);
        expect(await tableCounts(env, db)).toEqual(before);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("getDay / listMonth: order, ownership, ranges", () => {
  it(
    "getDay orders moments by occurred_at then id, and only the owner sees them",
    async () => {
      await withStore(async ({ db, store, clock }) => {
        const a = await createUser(env, db);
        const b = await createUser(env, db);
        clock.set("2026-11-02T05:00:00.000Z");
        const late = await create(store, a, "late");
        clock.set("2026-11-01T22:00:00.000Z");
        const early = await create(store, a, "early");
        clock.set("2026-11-02T01:30:00.000Z");
        const same1 = await create(store, a, "same 1");
        const same2 = await create(store, a, "same 2"); // 같은 occurred_at → id 순
        await create(store, b, "b's moment");
        const tie = [same1, same2].sort();
        const day = await store.getDay(a, TODAY);
        expect(day?.moments.map((m) => [m.id, m.time])).toEqual([
          [early, "07:00"],
          [tie[0], "10:30"],
          [tie[1], "10:30"],
          [late, "14:00"],
        ]);
        expect(day?.moments.every((m) => m.version === 1 && m.image === null)).toBe(true);
        const bDay = await store.getDay(b, TODAY);
        expect(bDay?.moments.map((m) => m.text)).toEqual(["b's moment"]);
        const c = await createUser(env, db);
        expect(await store.getDay(c, TODAY)).toBeNull();
        expect(await store.listMonth(c, 2026, 11)).toEqual([]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "listMonth covers [first day, next month) incl. summary-only and moment-only days, year change and leap February; excludes others",
    async () => {
      await withStore(async ({ db, store, clock }) => {
        const u = await createUser(env, db);
        const other = await createUser(env, db);
        const at = async (iso: string, body: string, who = u) => {
          clock.set(iso);
          return create(store, who, body);
        };
        await at("2026-10-31T14:59:59.000Z", "oct 31"); // 서울 10-31
        await at("2026-10-31T15:00:00.000Z", "nov 1"); // 서울 11-01
        await at("2026-11-30T14:00:00.000Z", "nov 30");
        await at("2026-11-30T15:00:00.000Z", "dec 1"); // 서울 12-01
        await at("2026-12-31T14:00:00.000Z", "dec 31");
        await at("2026-12-31T15:00:00.000Z", "jan 1"); // 서울 2027-01-01
        await at("2028-02-28T15:00:00.000Z", "feb 29");
        await at("2028-02-29T15:00:00.000Z", "mar 1");
        await at("2026-11-10T03:00:00.000Z", "other's", other);
        clock.set("2028-03-02T03:00:00.000Z");
        okValue(await store.saveSummary(u, "2026-11-15", null, "summary only"), "summary only day");
        okValue(await store.saveSummary(u, "2026-11-01", null, "with moment"), "summary + moment day");
        okValue(await store.saveSummary(other, "2026-11-20", null, "other's line"), "other's summary");

        const nov = byDate(await store.listMonth(u, 2026, 11));
        expect(nov.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-15", "2026-11-30"]);
        expect(nov[0]).toMatchObject({ summary: "with moment", summaryVersion: 1 });
        expect(nov[0]!.moments.map((m) => m.text)).toEqual(["nov 1"]);
        expect(nov[1]).toEqual({ date: "2026-11-15", summary: "summary only", summaryVersion: 1, moments: [] });
        expect(nov[2]).toMatchObject({ summary: "", summaryVersion: null });
        expect(nov[2]!.moments.map((m) => [m.text, m.time, m.version, m.image])).toEqual([["nov 30", "23:00", 1, null]]);

        const sets = async (y: number, m: number) => new Set((await store.listMonth(u, y, m)).map((d) => d.date));
        expect(await sets(2026, 10)).toEqual(new Set(["2026-10-31"]));
        expect(await sets(2026, 12)).toEqual(new Set(["2026-12-01", "2026-12-31"]));
        expect(await sets(2027, 1)).toEqual(new Set(["2027-01-01"]));
        expect(await sets(2028, 2)).toEqual(new Set(["2028-02-29"]));
        expect(await sets(2028, 3)).toEqual(new Set(["2028-03-01"]));
        // getDay도 summary-only 날을 돌려준다
        expect(await store.getDay(u, "2026-11-15")).toEqual({
          date: "2026-11-15",
          summary: "summary only",
          summaryVersion: 1,
          moments: [],
        });
        // 범위 끝 정상 값은 오류 없이 빈 배열
        expect(await store.listMonth(u, 1, 1)).toEqual([]);
        expect(await store.listMonth(u, 9999, 12)).toEqual([]);
        expect((await store.listMonth(other, 2026, 11)).map((d) => d.date).sort()).toEqual(["2026-11-10", "2026-11-20"]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "listMonth rejects out-of-range or non-integer year/month and non-UUID users with [] and no SQL",
    async () => {
      await withStore(async ({ db, pool, store }) => {
        const u = await createUser(env, db);
        await create(store, u, "exists");
        const bad: [string, number, number][] = [
          ["not-a-uuid", 2026, 11],
          [u, 2026, 13],
          [u, 2026, 0],
          [u, 2026, -1],
          [u, 0, 1],
          [u, 10000, 1],
          [u, 2026.5, 11],
          [u, 2026, 10.5],
          [u, Number.NaN, 11],
          [u, 2026, Number.NaN],
          [u, Number.POSITIVE_INFINITY, 11],
        ];
        const got = await expectNoSql(pool, async () => {
          const out: unknown[] = [];
          for (const [who, y, m] of bad) out.push(await store.listMonth(who, y, m));
          return out;
        });
        got.forEach((r, i) => expect(r, JSON.stringify(bad[i])).toEqual([]));
        expect((await store.listMonth(u, 2026, 11)).map((d) => d.date)).toEqual([TODAY]);
      });
    },
    CASE_TIMEOUT,
  );
});

describe("saveSummary: PLAN §3 table, bodies and dates", () => {
  it(
    "all 8 cells of the expectedVersion × body × existing-row table",
    async () => {
      await withStore(async ({ db, store }) => {
        const u = await createUser(env, db);
        const d = "2026-10-20";
        const rows = () => summaryRows(env, db, u);
        // null + 빈 값 + 없음 → no-op
        expect(await store.saveSummary(u, d, null, "")).toEqual({ ok: true, value: null });
        expect(await store.saveSummary(u, d, null, "   ")).toEqual({ ok: true, value: null });
        expect(await rows()).toEqual([]);
        // n + 본문 + 없음 → not_found / n + 빈 값 + 없음 → not_found
        expect(await store.saveSummary(u, d, 1, "x")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(u, d, 1, "")).toEqual({ ok: false, error: "not_found" });
        expect(await rows()).toEqual([]);
        // null + 본문 + 없음 → INSERT v1 (trim 저장)
        expect(await store.saveSummary(u, d, null, "  하루 한 줄  ")).toEqual({ ok: true, value: { version: 1 } });
        expect(await rows()).toEqual([{ local_date: d, body: "하루 한 줄", version: 1 }]);
        // null + 본문 + 있음 → conflict / null + 빈 값 + 있음 → conflict(버전 없이 삭제하지 않음)
        expect(await store.saveSummary(u, d, null, "overwrite")).toEqual({ ok: false, error: "conflict" });
        expect(await store.saveSummary(u, d, null, "")).toEqual({ ok: false, error: "conflict" });
        expect(await rows()).toEqual([{ local_date: d, body: "하루 한 줄", version: 1 }]);
        // n + 본문 + 있음: 일치 → UPDATE, 불일치 → conflict
        expect(await store.saveSummary(u, d, 1, "고친 줄")).toEqual({ ok: true, value: { version: 2 } });
        expect(await store.saveSummary(u, d, 1, "stale")).toEqual({ ok: false, error: "conflict" });
        expect(await store.saveSummary(u, d, 3, "ahead")).toEqual({ ok: false, error: "conflict" });
        expect(await rows()).toEqual([{ local_date: d, body: "고친 줄", version: 2 }]);
        // n + 빈 값 + 있음: 불일치 → conflict, 일치 → DELETE ok(null)
        expect(await store.saveSummary(u, d, 1, "")).toEqual({ ok: false, error: "conflict" });
        expect(await rows()).toHaveLength(1);
        expect(await store.saveSummary(u, d, 2, " \n ")).toEqual({ ok: true, value: null });
        expect(await rows()).toEqual([]);
        expect(await store.getDay(u, d), "no moments and no summary → null").toBeNull();
        // 삭제 뒤에는 다시 '없음' 행으로 돌아간다
        expect(await store.saveSummary(u, d, 2, "x")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(u, d, null, "again")).toEqual({ ok: true, value: { version: 1 } });
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "body 300/301 code points and emoji, past dates allowed, future (by injected Seoul today) and impossible dates rejected; read paths",
    async () => {
      await withStore(async ({ db, store, clock }) => {
        const u = await createUser(env, db);
        expect(await store.saveSummary(u, "2026-11-01", null, "x".repeat(300))).toEqual({ ok: true, value: { version: 1 } });
        expect(await store.saveSummary(u, "2026-10-31", null, "😀".repeat(300))).toEqual({ ok: true, value: { version: 1 } });
        expect(await store.saveSummary(u, "2026-10-30", null, "x".repeat(301))).toEqual({ ok: false, error: "invalid_body" });
        expect(await store.saveSummary(u, "2026-10-30", null, "😀".repeat(301))).toEqual({ ok: false, error: "invalid_body" });
        expect(await store.saveSummary(u, "2020-02-29", null, "leap past")).toEqual({ ok: true, value: { version: 1 } });
        expect(await store.saveSummary(u, TODAY, null, "today")).toEqual({ ok: true, value: { version: 1 } });
        expect(await store.saveSummary(u, "2026-11-03", null, "future")).toEqual({ ok: false, error: "invalid_date" });
        expect(await store.saveSummary(u, "2027-01-01", null, "future")).toEqual({ ok: false, error: "invalid_date" });
        expect(await store.saveSummary(u, "2026-02-29", null, "no such day")).toEqual({ ok: false, error: "invalid_date" });
        expect(await store.saveSummary(u, "2026-13-01", null, "x")).toEqual({ ok: false, error: "invalid_date" });
        // 서울 날짜가 바뀌는 순간(15:00Z) 이후에는 그 날이 '오늘'이 된다
        clock.set("2026-11-02T14:59:59.000Z");
        expect(await store.saveSummary(u, "2026-11-03", null, "too early")).toEqual({ ok: false, error: "invalid_date" });
        clock.set("2026-11-02T15:00:00.000Z");
        expect(await store.saveSummary(u, "2026-11-03", null, "now today")).toEqual({ ok: true, value: { version: 1 } });
        expect((await summaryRows(env, db, u)).map((r) => [r.local_date, [...r.body].length])).toEqual([
          ["2020-02-29", 9],
          ["2026-10-31", 300],
          ["2026-11-01", 300],
          ["2026-11-02", 5],
          ["2026-11-03", 9],
        ]);
        // summary-only 날도 읽기에 나오고, 조각이 있는 날은 한 줄을 지워도 남는다
        expect(await store.getDay(u, "2020-02-29")).toEqual({
          date: "2020-02-29",
          summary: "leap past",
          summaryVersion: 1,
          moments: [],
        });
        const m = await create(store, u, "moment on summary day");
        expect(okValue(await store.saveSummary(u, "2026-11-03", 1, ""), "delete line")).toBeNull();
        const day = await store.getDay(u, "2026-11-03");
        expect(day).toMatchObject({ date: "2026-11-03", summary: "", summaryVersion: null });
        expect(day?.moments.map((x) => x.id)).toEqual([m]);
        expect(okValue(await store.deleteMoment(u, m, 1), "delete moment")).toBeNull();
        expect(await store.getDay(u, "2026-11-03")).toBeNull();
        expect(new Set((await store.listMonth(u, 2026, 11)).map((d) => d.date))).toEqual(new Set(["2026-11-01", TODAY]));
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "another user can neither read nor overwrite/delete someone's summary on the same date",
    async () => {
      await withStore(async ({ db, store }) => {
        const a = await createUser(env, db);
        const b = await createUser(env, db);
        okValue(await store.saveSummary(a, TODAY, null, "a's line"), "a creates");
        expect(await store.getDay(b, TODAY)).toBeNull();
        expect(await store.listMonth(b, 2026, 11)).toEqual([]);
        expect(await store.saveSummary(b, TODAY, 1, "hijack")).toEqual({ ok: false, error: "not_found" });
        expect(await store.saveSummary(b, TODAY, 1, "")).toEqual({ ok: false, error: "not_found" });
        // b의 null 생성은 b 자신의 행이다
        expect(await store.saveSummary(b, TODAY, null, "b's line")).toEqual({ ok: true, value: { version: 1 } });
        expect(await summaryRows(env, db, a)).toEqual([{ local_date: TODAY, body: "a's line", version: 1 }]);
        expect(await summaryRows(env, db, b)).toEqual([{ local_date: TODAY, body: "b's line", version: 1 }]);
        expect(await store.getDay(a, TODAY)).toMatchObject({ summary: "a's line", summaryVersion: 1 });
        expect(await store.getDay(b, TODAY)).toMatchObject({ summary: "b's line", summaryVersion: 1 });
      });
    },
    CASE_TIMEOUT,
  );
});

describe("concurrency over two real app-role connections", () => {
  /** 실제 연결 2개(서로 다른 backend pid)의 store 둘. */
  async function twoStores(db: DisposableDatabase): Promise<[PgDiaryStore, PgDiaryStore]> {
    const pools = [openAppPool(db, 1), openAppPool(db, 1)];
    const pids = await Promise.all(pools.map((p) => appBackend(p)));
    expect(new Set(pids).size, "2 distinct backend connections").toBe(2);
    const createPgDiaryStore = await loadCreatePgDiaryStore();
    const clock = makeClock(NOW);
    return [createPgDiaryStore(pools[0]!, { now: clock.now }), createPgDiaryStore(pools[1]!, { now: clock.now })];
  }

  it(
    "two updates with the same expected version: exactly one succeeds, the other conflicts; the row matches the winner",
    async () => {
      await withStore(async ({ db, store }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "base");
        const [s1, s2] = await twoStores(db);
        const results = await Promise.all([s1.updateMoment(u, id, 1, "from one"), s2.updateMoment(u, id, 1, "from two")]);
        const wins = results.filter((r) => r.ok);
        const losses = results.filter((r) => !r.ok);
        expect(wins).toEqual([{ ok: true, value: { id, version: 2 } }]);
        expect(losses).toEqual([{ ok: false, error: "conflict" }]);
        const winnerBody = results[0]!.ok ? "from one" : "from two";
        expect((await momentRows(env, db, u)).map((r) => [r.body, r.version])).toEqual([[winnerBody, 2]]);
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "concurrent delete and update of the same version: one wins and the loser reports a consistent error",
    async () => {
      await withStore(async ({ db, store }) => {
        const u = await createUser(env, db);
        const id = await create(store, u, "base");
        const [s1, s2] = await twoStores(db);
        const [del, upd] = await Promise.all([s1.deleteMoment(u, id, 1), s2.updateMoment(u, id, 1, "updated")]);
        const rows = await momentRows(env, db, u);
        if (del.ok) {
          // 삭제가 먼저 커밋: 수정은 행을 못 찾는다
          expect(del).toEqual({ ok: true, value: null });
          expect(upd).toEqual({ ok: false, error: "not_found" });
          expect(rows).toEqual([]);
        } else {
          // 수정이 먼저 커밋: 삭제는 버전 충돌
          expect(upd).toEqual({ ok: true, value: { id, version: 2 } });
          expect(del).toEqual({ ok: false, error: "conflict" });
          expect(rows.map((r) => [r.body, r.version])).toEqual([["updated", 2]]);
        }
      });
    },
    CASE_TIMEOUT,
  );

  it(
    "summary: two null creates race → one {version:1} and one conflict; two updates of version n race → one success and one conflict",
    async () => {
      await withStore(async ({ db }) => {
        const u = await createUser(env, db);
        const [s1, s2] = await twoStores(db);
        const created = await Promise.all([s1.saveSummary(u, TODAY, null, "one"), s2.saveSummary(u, TODAY, null, "two")]);
        expect(created.filter((r) => r.ok)).toEqual([{ ok: true, value: { version: 1 } }]);
        expect(created.filter((r) => !r.ok)).toEqual([{ ok: false, error: "conflict" }]);
        const firstBody = created[0]!.ok ? "one" : "two";
        expect(await summaryRows(env, db, u)).toEqual([{ local_date: TODAY, body: firstBody, version: 1 }]);

        const updated = await Promise.all([s1.saveSummary(u, TODAY, 1, "uno"), s2.saveSummary(u, TODAY, 1, "dos")]);
        expect(updated.filter((r) => r.ok)).toEqual([{ ok: true, value: { version: 2 } }]);
        expect(updated.filter((r) => !r.ok)).toEqual([{ ok: false, error: "conflict" }]);
        const secondBody = updated[0]!.ok ? "uno" : "dos";
        expect(await summaryRows(env, db, u)).toEqual([{ local_date: TODAY, body: secondBody, version: 2 }]);
      });
    },
    CASE_TIMEOUT,
  );
});
