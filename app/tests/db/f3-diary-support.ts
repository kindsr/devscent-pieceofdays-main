// F3 slice ② RED 시험 전용 보조 함수(PLAN_mvp-domain-storage §3·§5 ②). 제품 코드가 아니며 제품 CRUD를 대신하지 않는다.
// - 사용자 행 준비와 저장 결과 확인만 owner 경로(withOwner)로 한다. 조각·한 줄 쓰기는 제품 함수로만 한다.
// - 제품에는 db.urls.app으로 만든 pg.Pool만 넘긴다(f3-support의 openAppPool).
// - 새 제품 모듈은 f3-support의 loadExport로 각 it 안에서 동적 import한다.
import path from "node:path";
import pg from "pg";
import { expect, vi } from "vitest";
import type { DisposableDatabase, HarnessEnv } from "./helpers";
import { APP_DIR, withOwner } from "./f2-support";
import { loadExport, type Result } from "./f3-support";

// ---------------------------------------------------------------- 공개 계약(최소 로컬 타입, PLAN §3)

export const PG_DIARY_MODULE = path.join(APP_DIR, "src", "server", "diary", "store.pg.ts");

export type Moment = { id: string; time: string; text: string; image: null | string; version: number };
export type Day = { date: string; summary: string; summaryVersion: number | null; moments: Moment[] };
export type MomentRef = { id: string; version: number };

export type PgDiaryStore = {
  getDay(userId: string, date: string): Promise<Day | null>;
  listMonth(userId: string, year: number, month: number): Promise<Day[]>;
  createMoment(userId: string, body: string): Promise<Result<MomentRef, "invalid_body" | "not_found">>;
  updateMoment(
    userId: string,
    id: string,
    expectedVersion: number,
    body: string,
  ): Promise<Result<MomentRef, "invalid_body" | "invalid_version" | "not_found" | "conflict">>;
  deleteMoment(
    userId: string,
    id: string,
    expectedVersion: number,
  ): Promise<Result<null, "invalid_version" | "not_found" | "conflict">>;
  saveSummary(
    userId: string,
    date: string,
    expectedVersion: number | null,
    body: string,
  ): Promise<
    Result<{ version: number } | null, "invalid_body" | "invalid_date" | "invalid_version" | "not_found" | "conflict">
  >;
};
export type CreatePgDiaryStore = (db: pg.Pool, opts?: { now?: () => Date }) => PgDiaryStore;

export const loadCreatePgDiaryStore = () => loadExport<CreatePgDiaryStore>(PG_DIARY_MODULE, "createPgDiaryStore");

/** 주입 시계. set으로 바꾼 값이 이후 호출의 now()가 된다. */
export function makeClock(iso: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(iso);
  return { now: () => new Date(current.getTime()), set: (next) => (current = new Date(next)) };
}

/** 유효 UUID 형식이지만 pod.users에 없는 사용자·행 ID(uuidv7 기본값과 겹치지 않는 v4 형식). */
export const MISSING_UUID = "00000000-0000-4000-8000-00000000f3d2";

// ---------------------------------------------------------------- 시험 데이터·조회(owner)

/** 사용자 행만 owner로 미리 만든다(사례마다 독립 사용자). */
export async function createUser(env: HarnessEnv, db: DisposableDatabase): Promise<string> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ id: string }>("INSERT INTO pod.users DEFAULT VALUES RETURNING id::text AS id");
    return r.rows[0]!.id;
  });
}

export type MomentRow = {
  id: string;
  local_date: string;
  occurred_at: string; // UTC ISO(ms)
  seoul_wall: string; // PG가 time_zone 열로 계산한 'YYYY-MM-DD HH24:MI'
  time_zone: string;
  body: string;
  version: number;
};

/** 한 사용자의 조각 행. DATE는 local_date::text로 읽어 driver Date 변환을 피한다. */
export async function momentRows(env: HarnessEnv, db: DisposableDatabase, userId: string): Promise<MomentRow[]> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<MomentRow>(
      `SELECT id::text AS id, local_date::text AS local_date,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
              to_char(occurred_at AT TIME ZONE time_zone, 'YYYY-MM-DD HH24:MI') AS seoul_wall,
              time_zone, body, version
         FROM pod.diary_moments WHERE user_id = $1::uuid ORDER BY occurred_at, id`,
      [userId],
    );
    return r.rows;
  });
}

export type SummaryRow = { local_date: string; body: string; version: number };

export async function summaryRows(env: HarnessEnv, db: DisposableDatabase, userId: string): Promise<SummaryRow[]> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<SummaryRow>(
      `SELECT local_date::text AS local_date, body, version
         FROM pod.day_summaries WHERE user_id = $1::uuid ORDER BY local_date`,
      [userId],
    );
    return r.rows;
  });
}

/** 전체 조각·한 줄·사용자 수(없는 사용자 쓰기가 아무 행도 만들지 않았는지). */
export async function tableCounts(
  env: HarnessEnv,
  db: DisposableDatabase,
): Promise<{ users: number; moments: number; summaries: number }> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ users: number; moments: number; summaries: number }>(
      `SELECT (SELECT count(*)::int FROM pod.users) AS users,
              (SELECT count(*)::int FROM pod.diary_moments) AS moments,
              (SELECT count(*)::int FROM pod.day_summaries) AS summaries`,
    );
    return r.rows[0]!;
  });
}

/** PG 자체의 IANA Asia/Seoul 계산(제품과 무관한 양성 제어). */
export async function pgSeoulWall(env: HarnessEnv, db: DisposableDatabase, iso: string): Promise<string> {
  return withOwner(env, db, async (c) => {
    const r = await c.query<{ w: string }>(
      "SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS w",
      [iso],
    );
    return r.rows[0]!.w;
  });
}

// ---------------------------------------------------------------- SQL 미실행 관찰(관찰용 spy만, 동작은 그대로)

/** fn 실행 동안 Pool.connect·Pool.query가 한 번도 불리지 않았는지 확인한다. spy는 원래 동작을 그대로 호출한다. */
export async function expectNoSql<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const connectSpy = vi.spyOn(pool, "connect");
  const querySpy = vi.spyOn(pool, "query");
  try {
    const out = await fn();
    expect(connectSpy, "no connection is taken before validation passes").not.toHaveBeenCalled();
    expect(querySpy, "no SQL is sent before validation passes").not.toHaveBeenCalled();
    return out;
  } finally {
    connectSpy.mockRestore();
    querySpy.mockRestore();
  }
}

/** 결과가 ok인지 단언하고 값을 돌려준다. */
export function okValue<T, E extends string>(r: Result<T, E>, label: string): T {
  expect(r, label).toMatchObject({ ok: true });
  if (!r.ok) throw new Error(`${label}: unexpected ${r.error}`);
  return r.value;
}
