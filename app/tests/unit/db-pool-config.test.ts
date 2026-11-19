// 운영 앱 승격 RED — 선택적 POD_DATABASE_POOL_MAX(PLAN_production-app-deployment §3).
// 미설정 = 기존 5. 설정하면 정규 10진수 1..5만 허용한다. import 시 env를 읽거나 접속하지 않는다.
//
// - 공개 계약: src/server/db/pool.ts가 parseDbPoolMax(value: string | undefined): number를 export한다.
//   형식이 틀리면 throw한다. getAppDb()는 첫 호출에 이 값을 Pool max로 쓴다.
// - 실제 네트워크·DB 없음: 기존 db-pool.test.ts와 같은 fake pg.Pool로 입력·호출만 본다.
// - 기능 부재는 "parseDbPoolMax export 없음" 단언으로 실패한다(import/type 오류가 아니다).
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

type PoolApi = { getAppDb: () => unknown; parseDbPoolMax: (value: string | undefined) => number };

async function freshPool(): Promise<PoolApi> {
  vi.resetModules();
  h.constructed = [];
  h.networkCalls = [];
  const mod = (await import(/* @vite-ignore */ POOL_MODULE)) as Record<string, unknown>;
  expect(typeof mod.getAppDb, "src/server/db/pool.ts must export getAppDb").toBe("function");
  expect(typeof mod.parseDbPoolMax, "src/server/db/pool.ts must export parseDbPoolMax(value: string | undefined): number").toBe("function");
  return mod as unknown as PoolApi;
}

const VALID: readonly (readonly [string, number])[] = [
  ["1", 1],
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
];
// 빈 문자열(설정됐지만 값 없음)·경계 밖·비정규 10진수·공백·부호·다른 진법·지수·소수·비ASCII 숫자·문자.
const INVALID: readonly string[] = [
  "", "0", "6", "10", "99", "-1", "+3", "03", "05", "00", " 3", "3 ", "\t3", "3\n",
  "3.0", "3.", "1e0", "0x3", "0o3", "0b11", "３", "٣", "three", "3a", "Infinity", "NaN",
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseDbPoolMax: optional POD_DATABASE_POOL_MAX format", () => {
  it("only unset (undefined) keeps the existing default 5; an empty string is invalid", async () => {
    const { parseDbPoolMax } = await freshPool();
    expect(parseDbPoolMax(undefined)).toBe(5);
  });

  it("accepts exactly the canonical decimals 1..5 and returns that number", async () => {
    const { parseDbPoolMax } = await freshPool();
    for (const [raw, n] of VALID) expect(parseDbPoolMax(raw), JSON.stringify(raw)).toBe(n);
  });

  it("rejects out-of-range, non-canonical, padded, signed, other-radix and non-ASCII values by throwing", async () => {
    const { parseDbPoolMax } = await freshPool();
    for (const raw of INVALID) expect(() => parseDbPoolMax(raw), JSON.stringify(raw)).toThrow();
  });

  it("the thrown error never echoes the raw value", async () => {
    const { parseDbPoolMax } = await freshPool();
    const marker = "4242424242";
    let message = "";
    try {
      parseDbPoolMax(marker);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, "must throw").not.toBe("");
    expect(message).not.toContain(marker);
  });
});

describe("getAppDb: Pool max follows POD_DATABASE_POOL_MAX", () => {
  it("uses the configured max with the other fixed options unchanged", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    vi.stubEnv("POD_DATABASE_POOL_MAX", "3");
    const { getAppDb } = await freshPool();
    getAppDb();
    expect(h.constructed).toEqual([
      { connectionString: FAKE_URL, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
    ]);
    expect(h.networkCalls).toEqual([]);
  });

  it("without POD_DATABASE_POOL_MAX the Pool max stays 5", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const { getAppDb } = await freshPool();
    getAppDb();
    expect((h.constructed[0] as Record<string, unknown> | undefined)?.max).toBe(5);
  });

  it("an invalid POD_DATABASE_POOL_MAX makes getAppDb throw and creates no Pool", async () => {
    for (const raw of ["", "0", "6", "05", " 3"]) {
      vi.unstubAllEnvs();
      vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
      vi.stubEnv("POD_DATABASE_POOL_MAX", raw);
      const { getAppDb } = await freshPool();
      expect(() => getAppDb(), JSON.stringify(raw)).toThrow();
      expect(h.constructed, JSON.stringify(raw)).toEqual([]);
      expect(h.networkCalls).toEqual([]);
    }
  });

  it("importing the module reads no pool setting: an invalid value does not throw at import", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    vi.stubEnv("POD_DATABASE_POOL_MAX", "not-a-number");
    await freshPool();
    expect(h.constructed).toEqual([]);
    expect(h.networkCalls).toEqual([]);
  });
});
