import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

// 운영 빌드(next start, 고정 사용자 플래그 없음)에서는 예시 기록·시험 fixture가 드러나지 않고,
// 플래그를 켠 운영 실행은 시작을 거부한다. 위조한 사용자 ID 헤더·질의값도 인증으로 쓰이지 않는다.
// 예시 기록 본문과 고정 사용자 ID. 위조 질의값은 Next가 요청 주소 그대로 페이로드에 되돌려 주므로,
// 고정 사용자 ID는 주소에 넣지 않은 요청에서만 확인한다.
const FIXTURE_TEXT = ["창문을 열었더니", "엄마와 20분 통화", "은행나무 길이 반쯤"];
const FIXTURE_USER = "local-fixture-user";
const FORGED = { headers: { "x-user-id": FIXTURE_USER } };

for (const path of ["/", "/days", "/days/2026-11-02"]) {
  test(`${path} shows the not-ready notice and no sample data`, async ({ request }) => {
    for (const url of [path, `${path}?userId=${FIXTURE_USER}&user=${FIXTURE_USER}`]) {
      for (const opts of [{}, FORGED]) {
        const res = await request.get(url, opts);
        expect(res.status(), url).toBe(200);
        const html = await res.text();
        expect(html.includes("아직 준비 중이에요"), `${url} notice`).toBe(true);
        for (const t of FIXTURE_TEXT) expect(html.includes(t), `${url} must not contain ${t}`).toBe(false);
        if (!url.includes(FIXTURE_USER)) expect(html.includes(FIXTURE_USER), `${url} must not contain the fixture user id`).toBe(false);
      }
    }
  });
}

test("Konva test fixture is not found, even with forged identity", async ({ request }) => {
  for (const opts of [{}, FORGED]) {
    expect((await request.get("/dev/konva-smoke?userId=local-fixture-user", opts)).status()).toBe(404);
  }
});

test("rendered page has no write button or sample pieces", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "아직 준비 중이에요" })).toBeVisible();
  await expect(page.getByRole("link", { name: "조각 추가" })).toHaveCount(0);
  await expect(page.locator(".piece")).toHaveCount(0);
});

test("production start with POD_LOCAL_FIXTURE=1 refuses to start", async () => {
  const port = String(Number(process.env.PROD_SMOKE_PORT ?? 3200) + 1);
  // 자식 프로세스에만 플래그를 준다(현재 프로세스 env는 바꾸지 않음).
  const child = spawn("npx", ["next", "start", "-p", port, "-H", "127.0.0.1"], {
    env: { ...process.env, POD_LOCAL_FIXTURE: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  clearTimeout(timer);
  expect(out).toContain("POD_LOCAL_FIXTURE=1 is refused in phase-production-server");
  expect(code).toBe(1);
});

// ---------------------------------------------------------------- F4 B4 (PLAN_mvp-oidc-integration §6.2·§6.3·§9 P1)
// 기본 운영 서버는 인증 env가 없다(auth_not_configured). route는 고정 503, /login은 "준비 중"이다.
// 아래 child 서버는 이미 만든 빌드로 next start만 다시 띄운다(새 build 없음). 값은 모두 가짜다.

const BODY_503 = "지금은 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요.";
const AUTH_ROUTES: [method: "GET" | "POST", path: string, form?: Record<string, string>][] = [
  ["POST", "/auth/google/start", { returnTo: "/" }],
  ["POST", "/auth/kakao/start", { returnTo: "/" }],
  ["GET", "/auth/google/callback?code=forged&state=forged"],
  ["POST", "/auth/logout"],
  ["POST", "/auth/withdraw", { confirm: "withdraw" }],
  ["POST", "/auth/restore"],
];

async function expectFixed503(res: import("@playwright/test").APIResponse, label: string): Promise<void> {
  expect(res.status(), label).toBe(503);
  expect(await res.text(), `${label} body`).toBe(BODY_503);
  expect(res.headers()["content-type"]?.toLowerCase().replace(/\s+/g, ""), `${label} content-type`).toBe("text/plain;charset=utf-8");
  expect(res.headers()["cache-control"] ?? "", `${label} no-store`).toMatch(/no-store/);
  expect(res.headers()["location"], `${label} no Location`).toBeUndefined();
  expect(res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie"), `${label} no cookies`).toEqual([]);
}

test("without auth env every auth route answers the fixed 503 (no Location, no cookies), even with forged identity", async ({ request, baseURL }) => {
  for (const [method, path, form] of AUTH_ROUTES) {
    for (const extra of [{}, { "x-user-id": FIXTURE_USER, "x-forwarded-host": "evil.example" }] as Record<string, string>[]) {
      const headers: Record<string, string> = { origin: baseURL!, cookie: "__Host-pod_session=forged; pod_session=forged; pod_oauth=forged", ...extra };
      const res = method === "GET" ? await request.get(path, { headers, maxRedirects: 0 }) : await request.post(path, { form, headers, maxRedirects: 0 });
      await expectFixed503(res, `${method} ${path}`);
    }
  }
});

test("without auth env /login shows 로그인을 준비하고 있어요 and no provider form; the account pages show no actions", async ({ page, request }) => {
  const res = await request.get("/login?userId=local-fixture-user", FORGED);
  expect(res.status()).toBe(200);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "로그인을 준비하고 있어요" })).toBeVisible();
  await expect(page.locator('form[action$="/start"]')).toHaveCount(0);
  await page.goto("/account/restore");
  await expect(page.locator('form[action="/auth/restore"]')).toHaveCount(0);
  await page.goto("/account/withdraw");
  await expect(page.locator('form[action="/auth/withdraw"]')).toHaveCount(0);
});

test("dynamic pages are never publicly cacheable (Cache-Control no-store, no public/s-maxage)", async ({ request }) => {
  for (const path of ["/", "/days", "/days/2026-11-02", "/settings", "/login", "/account/restore"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    const cc = res.headers()["cache-control"] ?? "";
    expect(cc, `${path} no-store`).toMatch(/no-store/);
    expect(cc, `${path} not public`).not.toMatch(/public|s-maxage/);
  }
});

type Child = { out: () => string; exited: Promise<number | null>; stop: () => Promise<void> };

/** 이미 만든 빌드로 next start를 child로 띄운다(현재 프로세스 env는 바꾸지 않는다). */
function startChild(port: number, env: Record<string, string>): Child {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", POD_LOCAL_FIXTURE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  return {
    out: () => out,
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function expectRefusedToStart(env: Record<string, string>, message: string, port: number): Promise<void> {
  const child = startChild(port, env);
  const timer = setTimeout(() => void child.stop(), 30_000);
  const code = await child.exited;
  clearTimeout(timer);
  expect(child.out()).toContain(message);
  expect(code).toBe(1);
}

const PROD_PORT = Number(process.env.PROD_SMOKE_PORT ?? 3200);
const FAKE_AUTH = {
  POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: "ci-only-b4-prod-session-key-1-".padEnd(40, "x") }),
  POD_AUTH_PROVIDERS: "google",
  POD_AUTH_GOOGLE_CLIENT_ID: "ci-only-b4-google-client",
  POD_AUTH_GOOGLE_CLIENT_SECRET: "ci-only-b4-google-secret",
};

test("production start with the mock OIDC issuer (with or without POD_AUTH_PROVIDERS) refuses to start", async () => {
  for (const [i, env] of [{ POD_AUTH_MOCK_OIDC_ISSUER: "http://127.0.0.1:9" }, { ...FAKE_AUTH, POD_AUTH_BASE_URL: "https://pieceofdays.example", POD_AUTH_MOCK_OIDC_ISSUER: "http://127.0.0.1:9" }].entries()) {
    await expectRefusedToStart(env, "POD_AUTH_MOCK_OIDC_ISSUER is refused in phase-production-server", PROD_PORT + 2 + i);
  }
});

test("production start with POD_LOCAL_FIXTURE=1 and POD_AUTH_PROVIDERS refuses to start", async () => {
  const child = startChild(PROD_PORT + 4, { ...FAKE_AUTH, POD_AUTH_BASE_URL: "https://pieceofdays.example", POD_LOCAL_FIXTURE: "1" });
  const timer = setTimeout(() => void child.stop(), 30_000);
  const code = await child.exited;
  clearTimeout(timer);
  expect(child.out()).toMatch(/POD_LOCAL_FIXTURE=1 is refused in phase-production-server|POD_LOCAL_FIXTURE=1 cannot be combined with POD_AUTH_PROVIDERS/);
  expect(code).toBe(1);
});

test("production with PROVIDERS but an http base URL is invalid config: /login 준비 중, POST start 503 without Location or cookies, forged ids ignored", async ({ playwright }) => {
  const port = PROD_PORT + 5;
  const base = `http://127.0.0.1:${port}`;
  const child = startChild(port, { ...FAKE_AUTH, POD_AUTH_BASE_URL: base });
  const api = await playwright.request.newContext({ baseURL: base });
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        await api.get("/settings", { maxRedirects: 0 });
        ready = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    expect(ready, `server on ${base} answered:\n${child.out().slice(-2000)}`).toBe(true);
    const login = await api.get("/login?userId=local-fixture-user", FORGED);
    expect(login.status()).toBe(200);
    const html = await login.text();
    expect(html).toContain("로그인을 준비하고 있어요");
    expect(html).not.toMatch(/action="\/auth\/[a-z]+\/start"/);
    for (const [method, path, form] of AUTH_ROUTES) {
      const headers = { origin: base, "x-user-id": FIXTURE_USER };
      const res = method === "GET" ? await api.get(path, { headers, maxRedirects: 0 }) : await api.post(path, { form, headers, maxRedirects: 0 });
      await expectFixed503(res, `invalid-config ${method} ${path}`);
    }
    for (const path of ["/", "/days"]) {
      const res = await api.get(`${path}?userId=${FIXTURE_USER}`, FORGED);
      const body = await res.text();
      for (const t of FIXTURE_TEXT) expect(body.includes(t), `${path} must not contain ${t}`).toBe(false);
      expect(body.includes("로그인됐어요"), `${path} must not look signed in`).toBe(false);
    }
  } finally {
    await api.dispose();
    await child.stop();
  }
});
