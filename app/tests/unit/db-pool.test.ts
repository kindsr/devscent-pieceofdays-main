// F6a1 RED — 앱 요청 Pool의 명시 설정(PLAN_dev-app-deployment §3 연결 예산·§4 "server/db/pool.ts 명시 설정").
// app role connection limit 6 = 앱 Pool max 5 + 단발 readiness 1. 연결 대기 timeout 5초, idle 10초.
//
// - 실제 네트워크·DB 없음: pg.Pool을 시험 전용 fake 생성자로 바꿔 입력·호출 횟수·동일성만 본다(connect·query 호출 0).
// - 각 it에서 vi.resetModules 뒤 기존 공개 모듈 src/server/db/pool.ts를 동적 import한다(모듈 전역 Pool이 사례마다 새로 시작).
// - 기존 의미 유지 사례(지연 생성·단일 Pool·URL 없으면 throw)는 지금도 통과한다. 새 옵션 사례만 정상 RED다.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

const h = vi.hoisted(() => ({
  constructed: [] as unknown[],
  networkCalls: [] as string[],
}));

vi.mock("pg", () => {
  class FakePool {
    readonly options: unknown;
    constructor(options: unknown) {
      this.options = options;
      h.constructed.push(options);
    }
    connect() {
      h.networkCalls.push("connect");
      return Promise.reject(new Error("fake pool: no network in unit tests"));
    }
    query() {
      h.networkCalls.push("query");
      return Promise.reject(new Error("fake pool: no network in unit tests"));
    }
    end() {
      return Promise.resolve();
    }
    on() {
      return this;
    }
  }
  class FakeClient {
    constructor() {
      h.networkCalls.push("client");
    }
  }
  const pg = { Pool: FakePool, Client: FakeClient };
  return { default: pg, ...pg };
});

const POOL_MODULE = path.join(APP_DIR, "src", "server", "db", "pool.ts");
const FAKE_URL = "postgres://pod_ci_app:ci-only-app-not-a-secret@127.0.0.1:5432/pod_ci_pool_0000000000000000";

type PoolApi = { getAppDb: () => unknown };

async function freshPool(): Promise<PoolApi> {
  vi.resetModules();
  h.constructed = [];
  h.networkCalls = [];
  const mod = (await import(/* @vite-ignore */ POOL_MODULE)) as Record<string, unknown>;
  expect(typeof mod.getAppDb, "src/server/db/pool.ts must export getAppDb").toBe("function");
  return mod as unknown as PoolApi;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAppDb: explicit Pool budget (F6a)", () => {
  it("creates the Pool with exactly { connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const { getAppDb } = await freshPool();
    getAppDb();
    expect(h.constructed, "one Pool with the fixed options only").toEqual([
      { connectionString: FAKE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
    ]);
  });

  it("the Pool budget stays below the app role connection limit 6 (max 5 leaves 1 for the one-shot readiness client)", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const { getAppDb } = await freshPool();
    getAppDb();
    const opts = h.constructed[0] as Record<string, unknown> | undefined;
    expect(opts?.max, "explicit max (pg default is 10)").toBe(5);
    expect(opts?.connectionTimeoutMillis, "explicit connection wait timeout (pg default waits forever)").toBe(5000);
    expect(opts?.idleTimeoutMillis).toBe(10000);
  });
});

describe("getAppDb: existing semantics are kept", () => {
  it("is lazy: importing the module creates no Pool and opens no connection", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    await freshPool();
    expect(h.constructed).toEqual([]);
    expect(h.networkCalls).toEqual([]);
  });

  it("returns one shared Pool for every call and never connects by itself", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const { getAppDb } = await freshPool();
    const a = getAppDb();
    const b = getAppDb();
    expect(a).toBe(b);
    expect(h.constructed).toHaveLength(1);
    expect(h.networkCalls, "no connect/query/client until a caller uses the Pool").toEqual([]);
  });

  it("throws without POD_DATABASE_URL (unset or empty) and creates no Pool", async () => {
    for (const value of [undefined, ""]) {
      vi.unstubAllEnvs();
      vi.stubEnv("POD_DATABASE_URL", value);
      const { getAppDb } = await freshPool();
      expect(() => getAppDb(), `POD_DATABASE_URL=${JSON.stringify(value)}`).toThrow("POD_DATABASE_URL is not set");
      expect(h.constructed).toEqual([]);
    }
  });

  it("reads only POD_DATABASE_URL: other database URLs in the environment are ignored", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    vi.stubEnv("DATABASE_URL", "postgres://other:x@127.0.0.1:5432/other");
    vi.stubEnv("POD_MIGRATE_DATABASE_URL", "postgres://pod_ci_migrator:x@127.0.0.1:5432/m");
    vi.stubEnv("PGHOST", "evil.example");
    const { getAppDb } = await freshPool();
    getAppDb();
    expect((h.constructed[0] as Record<string, unknown> | undefined)?.connectionString).toBe(FAKE_URL);
  });
});
