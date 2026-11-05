// F6a1 RED — liveness·readiness route(PLAN_dev-app-deployment §4 "health route").
//
// 대상(아직 없음, main 고정 경로):
//   src/app/healthz/route.ts        GET → 200 "ok". DB·env를 읽지 않는다(liveness).
//   src/app/healthz/ready/route.ts  GET → 앱 Pool을 쓰지 않는 단발 pg.Client(POD_DATABASE_URL, connectionTimeoutMillis 2000,
//     query_timeout 2000)로 SELECT 1 → 200 "ok". 미설정·실패·요청 시작부터 전체 2초 deadline이면 503 "not ready".
//     connect와 query의 직렬 timeout 합계를 전체 deadline으로 세지 않는다. 모든 경로에서 타이머를 해제하고 client 종료를 시작하되
//     client.end()를 기다려 응답을 늦추지 않는다. 종료 거부·late rejection은 처리해 원문 로그·unhandled rejection이 없다.
//   두 route 모두 Cache-Control no-store, text/plain 고정 본문.
// - 각 it에서 vi.resetModules 뒤 절대경로로 동적 import한다. 모듈 부재는 그 it만 실패한다(정상 RED).
// - pg는 사례별로 fake Client(연결·쿼리·종료를 시험이 조절)를 쓴다. 마지막 사례만 실제 pg Client로
//   loopback의 무응답 TCP 서버에 붙어 남은 socket 0을 확인한다(외부 네트워크·DB 없음).
// - deadline 사례는 vitest fake timers(setTimeout·clearTimeout)를 쓴다. route의 전체 deadline 타이머가 이 시계를 따라야 한다.
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type Step = "resolve" | "reject" | "hang";
type Plan = { connect: Step; query: Step; end: Step; connectDelayMs?: number };

const h = vi.hoisted(() => ({
  plan: { connect: "resolve", query: "resolve", end: "resolve" } as { connect: string; query: string; end: string; connectDelayMs?: number },
  clients: [] as { config: unknown; queries: string[]; ended: number; settle: { connect?: (ok: boolean) => void; query?: (ok: boolean) => void } }[],
  pools: 0,
  real: false,
}));

const RAW_MARKER = "f6a1-raw-driver-error-5c1e";

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  const realPg = ((actual as unknown as { default?: typeof import("pg") }).default ?? actual) as typeof import("pg");

  const step = (kind: string, settleSlot: (fn: (ok: boolean) => void) => void, value: unknown, delayMs = 0): Promise<unknown> => {
    if (kind === "resolve" && delayMs === 0) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const settle = (ok: boolean) => (ok ? resolve(value) : reject(Object.assign(new Error(`${RAW_MARKER}: driver failure`), { code: "ECONNREFUSED" })));
      settleSlot(settle);
      if (kind === "reject") settle(false);
      else if (kind === "resolve") setTimeout(() => settle(true), delayMs);
      // hang: 시험이 settle을 부를 때까지 끝나지 않는다
    });
  };

  function FakeClient(this: unknown, config: unknown) {
    if (h.real) return new realPg.Client(config as never);
    const rec = { config, queries: [] as string[], ended: 0, settle: {} as { connect?: (ok: boolean) => void; query?: (ok: boolean) => void } };
    h.clients.push(rec);
    return {
      connect: () => step(h.plan.connect, (fn) => (rec.settle.connect = fn), undefined, h.plan.connectDelayMs ?? 0),
      query: (sql: unknown) => {
        rec.queries.push(typeof sql === "string" ? sql : JSON.stringify(sql));
        return step(h.plan.query, (fn) => (rec.settle.query = fn), { rowCount: 1, rows: [{ "?column?": 1 }] });
      },
      end: () => {
        rec.ended++;
        return step(h.plan.end, () => undefined, undefined);
      },
      on: () => undefined,
      once: () => undefined,
      removeListener: () => undefined,
    };
  }
  function FakePool(this: unknown, config: unknown) {
    h.pools++;
    return new realPg.Pool(config as never);
  }
  const pg = { ...realPg, Client: FakeClient, Pool: FakePool };
  return { ...pg, default: pg };
});

const LIVE = path.join(APP_DIR, "src", "app", "healthz", "route.ts");
const READY = path.join(APP_DIR, "src", "app", "healthz", "ready", "route.ts");
const URL_SECRET = "ci-only-ready-not-a-secret-7d2";
const FAKE_URL = `postgres://pod_ci_app:${URL_SECRET}@127.0.0.1:5432/pod_ci_ready_0000000000000000`;

type GetFn = (req: Request) => Promise<Response> | Response;

async function loadGet(file: string): Promise<GetFn> {
  vi.resetModules();
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F6a1 product module ${path.relative(APP_DIR, file)} could not be loaded (expected before GREEN): ${msg}`);
  }
  expect(typeof mod.GET, `${path.relative(APP_DIR, file)} must export GET`).toBe("function");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(mod[m], `${path.relative(APP_DIR, file)} must not export ${m}`).toBeUndefined();
  return mod.GET as GetFn;
}

const req = (p: string) => new Request(new URL(p, "http://127.0.0.1:3000"));

async function expectPlain(res: Response, status: number, body: string, label: string): Promise<void> {
  expect(res.status, `${label}: status`).toBe(status);
  expect(await res.text(), `${label}: fixed body`).toBe(body);
  expect(res.headers.get("content-type")?.toLowerCase().replace(/\s+/g, ""), `${label}: text/plain`).toBe("text/plain;charset=utf-8");
  expect(res.headers.get("cache-control") ?? "", `${label}: no-store`).toMatch(/(^|,|\s)no-store(,|$|\s)/);
}

/** console 출력과 unhandled rejection을 모은다. */
function watch(): { output: () => string; unhandled: () => unknown[]; restore: () => void } {
  const lines: string[] = [];
  const unhandled: unknown[] = [];
  const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "))),
  );
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return {
    output: () => lines.join("\n"),
    unhandled: () => unhandled,
    restore: () => {
      for (const s of spies) s.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

function expectNoLeak(w: ReturnType<typeof watch>, label: string): void {
  const out = w.output();
  for (const s of [FAKE_URL, URL_SECRET, RAW_MARKER]) expect(out.includes(s), `${label}: log must not contain ${s}`).toBe(false);
  expect(w.unhandled(), `${label}: no unhandled rejection`).toEqual([]);
}

/** 대기 중인 microtask·즉시 타이머를 비운다(fake timers에서도 실제 시계를 진행하지 않는다). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  h.plan = { connect: "resolve", query: "resolve", end: "resolve" };
  h.clients = [];
  h.pools = 0;
  h.real = false;
});

// ================================================================= liveness

describe("GET /healthz (liveness)", () => {
  it("answers the fixed 200 ok (text/plain, no-store) without touching the DB, with or without POD_DATABASE_URL", async () => {
    for (const url of [undefined, FAKE_URL]) {
      vi.stubEnv("POD_DATABASE_URL", url);
      const GET = await loadGet(LIVE);
      const w = watch();
      try {
        await expectPlain(await GET(req("/healthz")), 200, "ok", `liveness (url ${url ? "set" : "unset"})`);
      } finally {
        w.restore();
      }
      expect(h.clients, "no pg.Client").toEqual([]);
      expect(h.pools, "no pg.Pool").toBe(0);
    }
  });

  it("does not read any POD_* environment value", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const GET = await loadGet(LIVE);
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy(realEnv, {
      get(t, k) {
        if (typeof k === "string" && k.startsWith("POD_")) reads.push(k);
        return Reflect.get(t, k);
      },
    });
    try {
      await expectPlain(await GET(req("/healthz")), 200, "ok", "liveness env");
    } finally {
      process.env = realEnv;
    }
    expect(reads).toEqual([]);
  });
});

// ================================================================= readiness

describe("GET /healthz/ready (readiness, one-shot client)", () => {
  it("without POD_DATABASE_URL (unset or empty) → fixed 503 not ready, no client", async () => {
    for (const url of [undefined, ""]) {
      vi.stubEnv("POD_DATABASE_URL", url);
      const GET = await loadGet(READY);
      await expectPlain(await GET(req("/healthz/ready")), 503, "not ready", `url ${JSON.stringify(url)}`);
      expect(h.clients).toEqual([]);
      expect(h.pools).toBe(0);
    }
  });

  it("success → 200 ok with one new pg.Client (no Pool) configured from POD_DATABASE_URL with 2s connect/query timeouts, SELECT 1 only, closed afterwards", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const GET = await loadGet(READY);
    const w = watch();
    try {
      await expectPlain(await GET(req("/healthz/ready")), 200, "ok", "ready");
    } finally {
      w.restore();
    }
    expect(h.pools, "the app Pool is never used").toBe(0);
    expect(h.clients).toHaveLength(1);
    const c = h.clients[0]!;
    expect(c.config).toMatchObject({ connectionString: FAKE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 });
    expect(c.queries.map((q) => q.trim().replace(/\s+/g, " ").replace(/;$/, "").toUpperCase()), "SELECT 1 only (no writes)").toEqual(["SELECT 1"]);
    expect(c.ended, "client end started").toBe(1);
    expectNoLeak(w, "ready");
  });

  it("every request uses its own new client (concurrent requests → separate clients, each closed)", async () => {
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    const GET = await loadGet(READY);
    const [a, b, c] = await Promise.all([GET(req("/healthz/ready")), GET(req("/healthz/ready")), GET(req("/healthz/ready"))]);
    for (const r of [a, b, c]) await expectPlain(r, 200, "ok", "concurrent");
    expect(h.clients).toHaveLength(3);
    expect(new Set(h.clients).size).toBe(3);
    for (const x of h.clients) expect(x.ended).toBe(1);
  });

  it("connect or query failure → fixed 503 not ready, client end started, no raw error or URL in logs, no unhandled rejection", async () => {
    for (const plan of [
      { connect: "reject", query: "resolve", end: "resolve" },
      { connect: "resolve", query: "reject", end: "resolve" },
      { connect: "reject", query: "resolve", end: "reject" },
      { connect: "resolve", query: "reject", end: "reject" },
    ] as Plan[]) {
      vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
      h.plan = plan;
      h.clients = [];
      const GET = await loadGet(READY);
      const w = watch();
      const label = JSON.stringify(plan);
      try {
        await expectPlain(await GET(req("/healthz/ready")), 503, "not ready", label);
        await flush();
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        w.restore();
      }
      expect(h.clients[0]?.ended, `${label}: end started`).toBe(1);
      expectNoLeak(w, label);
    }
  });

  it("a hung connect → 503 exactly at the 2s request deadline (not before), the timer is cleared and end is started", async () => {
    vi.useFakeTimers();
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    h.plan = { connect: "hang", query: "resolve", end: "resolve" };
    const GET = await loadGet(READY);
    const w = watch();
    try {
      let settled: Response | undefined;
      void Promise.resolve(GET(req("/healthz/ready"))).then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled, "still waiting before 2s").toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(settled, "answered at the 2s deadline").toBeDefined();
      await expectPlain(settled!, 503, "not ready", "deadline");
      expect(h.clients[0]?.ended, "end started").toBe(1);
      expect(vi.getTimerCount(), "deadline timer cleared").toBe(0);
      // 늦게 끝나는 connect 거부도 처리된다(unhandled 없음)
      h.clients[0]?.settle.connect?.(false);
      await flush();
    } finally {
      w.restore();
    }
    expectNoLeak(w, "deadline");
  });

  it("the 2s deadline covers the whole request: connect at 1.5s + a hung query → 503 at 2.0s, not at 1.5s + 2s", async () => {
    vi.useFakeTimers();
    vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
    h.plan = { connect: "resolve", connectDelayMs: 1500, query: "hang", end: "resolve" };
    const GET = await loadGet(READY);
    const w = watch();
    try {
      let settled: Response | undefined;
      void Promise.resolve(GET(req("/healthz/ready"))).then((r) => (settled = r));
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled, "still waiting at 1.999s").toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(settled, "answered at 2.0s total").toBeDefined();
      await expectPlain(settled!, 503, "not ready", "whole-request deadline");
      expect(h.clients[0]?.ended).toBe(1);
      expect(vi.getTimerCount(), "no timers left").toBe(0);
      h.clients[0]?.settle.query?.(false);
      await flush();
    } finally {
      w.restore();
    }
    expectNoLeak(w, "whole-request deadline");
  });

  it("success and failure answers never wait for client.end(): a hanging end still answers immediately and leaves no timer", async () => {
    vi.useFakeTimers();
    for (const plan of [
      { connect: "resolve", query: "resolve", end: "hang" },
      { connect: "reject", query: "resolve", end: "hang" },
    ] as Plan[]) {
      vi.stubEnv("POD_DATABASE_URL", FAKE_URL);
      h.plan = plan;
      h.clients = [];
      const GET = await loadGet(READY);
      let settled: Response | undefined;
      void Promise.resolve(GET(req("/healthz/ready"))).then((r) => (settled = r));
      await flush();
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      const label = JSON.stringify(plan);
      expect(settled, `${label}: answered without advancing the clock`).toBeDefined();
      await expectPlain(settled!, plan.connect === "resolve" ? 200 : 503, plan.connect === "resolve" ? "ok" : "not ready", label);
      expect(h.clients[0]?.ended, `${label}: end started`).toBe(1);
      expect(vi.getTimerCount(), `${label}: deadline timer cleared`).toBe(0);
    }
  });

  it("real pg Client against a silent loopback server: 503 within the deadline and no socket left open afterwards", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => undefined);
      // 시작 메시지를 받아도 답하지 않는다
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      h.real = true;
      vi.stubEnv("POD_DATABASE_URL", `postgres://pod_ci_app:${URL_SECRET}@127.0.0.1:${port}/pod_ci_silent`);
      const GET = await loadGet(READY);
      const w = watch();
      try {
        const t0 = Date.now();
        await expectPlain(await GET(req("/healthz/ready")), 503, "not ready", "silent server");
        const elapsed = Date.now() - t0;
        expect(elapsed, "answered by the 2s deadline").toBeLessThan(2_600);
        expect(elapsed, "did not answer before connecting was attempted").toBeGreaterThanOrEqual(1_900);
        const deadline = Date.now() + 5_000;
        while (sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(sockets.size, "no socket left open").toBe(0);
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        w.restore();
      }
      expectNoLeak(w, "silent server");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
