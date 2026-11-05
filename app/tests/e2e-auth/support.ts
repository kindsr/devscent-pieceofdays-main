// F4 B4 인증 E2E 보조(시험 전용). globalSetup과 spec이 함께 쓴다. vitest를 import하지 않는다.
// - 브라우저의 POST /auth/{p}/start를 page.route로 붙잡아 route.fetch(maxRedirects 0)로 **실제 Next route**에 그대로 보낸다
//   (브라우저 Origin·쿠키 그대로). 303 Location이 그 공급자의 mock authorize인지 확인하고, globalSetup 제어 서버가 같은 URL로
//   실제 mock.authorize(url, opts)를 실행해 callback URL을 만든다. 브라우저에는 start 응답의 Set-Cookie(flow)와 빈 대기 문서를 준다.
//   (Playwright는 redirect로 이어진 다른 origin 요청을 route로 붙잡지 않으므로 start에서 끊는다.)
//   시험은 돌려받은 callback으로 직접 이동한다 — state 변조·flow 삭제·재요청 사례를 그 사이에 끼울 수 있다.
// - DB는 관리자 연결로 읽기만 한다(사용자·지급·상태 확인). 쓰기·세션 발급은 하지 않는다.
import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { readDisposableEnv, withAdmin } from "../db/helpers";
import type { AuthorizeOptions } from "../support/mock-oidc-issuer";

export const AUTH_PORT = 3300;
export const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
// 가짜 값(CI·격리 Cloud 전용). 실제 공급자 자격이 아니다.
export const CI_SESSION_KEY = "ci-only-b4-e2e-session-key-1-".padEnd(40, "x");
export const CI_CLIENTS = {
  google: { id: "ci-only-b4-google-client", secret: "ci-only-b4-google-secret" },
  kakao: { id: "ci-only-b4-kakao-client", secret: "ci-only-b4-kakao-secret" },
} as const;
export const E2E_ENV = { control: "POD_E2E_AUTH_CONTROL", db: "POD_E2E_AUTH_DB", mockOrigin: "POD_E2E_AUTH_MOCK_ORIGIN" } as const;

export type Provider = "google" | "kakao";
export const COOKIE = { session: "pod_session", recovery: "pod_recovery", flow: "pod_oauth" } as const; // http base → __Host- 없음

/** 공식 버튼(PR47 B4-d 공식 에셋, SOURCES.md sha256). */
export const PROVIDER_BUTTON = {
  google: { name: "Sign in with Google (Google 계정으로 로그인)", img: "Sign in with Google", size: [207, 46], sha256: "e048546f162b43a5f3809796f88df02a8e13f07ca1280a9c1635018956e05c05" },
  kakao: { name: "카카오 로그인", img: "카카오 로그인", size: [224, 46], sha256: "ab90ab44616f14a671844cd991b3fbb33277f42c5bb2cc5a9422344a854c9398" },
} as const;

export const TEXT = {
  loginTitle: "pieceofdays에 로그인",
  moving: "이동 중…",
  cancelled: "로그인을 취소했어요. 다시 시도할 수 있어요.",
  failed: "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  expired: "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요.",
  purgeDue: "복구 기간이 지나 이 계정을 되돌릴 수 없어요.",
  signedOut: "로그아웃했어요",
  withdrawn: "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요.",
  withdrawWarn: "탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요",
  restoreAsk: "탈퇴를 요청한 계정이에요. 복구할까요?",
  recoveryExpired: "확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요.",
  signedIn: "로그인됐어요",
  signedInBody: "기록 쓰기·불러오기는 다음 단계에서 연결돼요.",
  tryLink: "브라우저 기록장",
  tryNote: "체험판 기록은 이 브라우저에만 있고 계정으로 옮겨지지 않아요. 설정에서 내려받아 두세요.",
} as const;

function envOf(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[e2e-auth] ${name} is missing — run through playwright.auth.config.ts (globalSetup)`);
  return v;
}

let seq = 0;
/** 사례별 고유 subject(가짜). 같은 사람이 다시 로그인하는 사례는 같은 값을 다시 쓴다. */
export const newSubject = (p: Provider) => `e2e-${p}-${Date.now().toString(36)}-${++seq}`;

/** 제어 서버로 실제 mock.authorize를 실행해 callback URL을 받는다. */
export async function controlAuthorize(url: string, opts: AuthorizeOptions): Promise<string> {
  const res = await fetch(`${envOf(E2E_ENV.control)}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, opts }),
  });
  if (!res.ok) throw new Error(`[e2e-auth] mock authorize refused (status ${res.status})`);
  return ((await res.json()) as { callback: string }).callback;
}

export type HeldStart = {
  /** 붙잡은 start의 결과: 실제 route 응답 status·Location과 mock authorize 뒤의 callback URL. */
  result(): Promise<{ status: number; location: string; callback: string }>;
  /** 붙잡은 navigation을 풀어 준다(빈 대기 문서). autoRelease면 바로 풀린다. */
  release(): void;
  /** 붙잡힌 start 요청 수. */
  count(): number;
  dispose(): Promise<void>;
};

/** 다음 start POST를 붙잡는다. release 전까지 브라우저는 응답을 기다린다(이동 중 상태 확인용). */
export async function holdStart(page: Page, opts: AuthorizeOptions = {}, autoRelease = true): Promise<HeldStart> {
  const mockOrigin = envOf(E2E_ENV.mockOrigin);
  let resolveR!: (v: { status: number; location: string; callback: string }) => void;
  let rejectR!: (e: unknown) => void;
  const result = new Promise<{ status: number; location: string; callback: string }>((res, rej) => ((resolveR = res), (rejectR = rej)));
  result.catch(() => undefined);
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  if (autoRelease) releaseGate();
  let n = 0;
  const matcher = (u: URL) => u.origin === AUTH_BASE && /^\/auth\/(google|kakao)\/start$/.test(u.pathname);
  await page.route(matcher, async (route) => {
    n++;
    if (n > 1) return route.abort();
    const res = await route.fetch({ maxRedirects: 0 });
    const status = res.status();
    const location = res.headers()["location"] ?? "";
    const setCookie = res.headersArray().filter((x) => x.name.toLowerCase() === "set-cookie").map((x) => x.value);
    try {
      const provider = /^\/auth\/(google|kakao)\/start$/.exec(new URL(route.request().url()).pathname)?.[1];
      if (status !== 303 || !location.startsWith(`${mockOrigin}/${provider}/authorize?`)) {
        throw new Error(`[e2e-auth] start did not redirect to the ${provider} mock authorize endpoint (status ${status})`);
      }
      resolveR({ status, location, callback: await controlAuthorize(location, opts) });
    } catch (err) {
      rejectR(err);
    }
    await gate;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(setCookie.length ? { "set-cookie": setCookie.join("\n") } : {}) },
      body: "<!doctype html><title>e2e provider hold</title>",
    });
  });
  return {
    result: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          result,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("[e2e-auth] start response was not observed within 30 seconds")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release: () => releaseGate(),
    count: () => n,
    dispose: async () => {
      if (page.isClosed()) return;
      try {
        await page.unroute(matcher);
      } catch (err) {
        if (!page.isClosed()) throw err;
      }
    },
  };
}

export const providerButton = (page: Page, p: Provider) => page.getByRole("button", { name: PROVIDER_BUTTON[p].name, exact: true });

/** /login에서 공급자 버튼을 눌러 callback URL을 받는다(아직 callback으로 가지 않는다). */
export async function beginLogin(page: Page, p: Provider, opts: AuthorizeOptions = {}, loginPath = "/login"): Promise<string> {
  const held = await holdStart(page, opts);
  try {
    if (loginPath) await page.goto(loginPath);
    await providerButton(page, p).click();
    return (await held.result()).callback;
  } finally {
    await held.dispose();
  }
}

/** 전체 로그인: 버튼 → (mock 인가) → callback으로 이동 → 최종 주소. */
export async function login(page: Page, p: Provider, subject: string, loginPath = "/login"): Promise<string> {
  const callback = await beginLogin(page, p, { subject }, loginPath);
  await page.goto(callback);
  return page.url();
}

export async function cookie(page: Page, name: string) {
  return (await page.context().cookies(AUTH_BASE)).find((c) => c.name === name);
}

// ---------------------------------------------------------------- DB 읽기(관리자, 읽기 전용)

export type AccountRow = { userId: string; status: string; gen: number; balance: number | null; ledger: number; firstLogin: boolean };

export async function accountOf(p: Provider, subject: string): Promise<AccountRow | null> {
  return withAdmin(
    readDisposableEnv(),
    async (c) => {
      const r = await c.query<{ id: string; status: string; gen: number; balance: number | null; ledger: number; fl: boolean }>(
        `SELECT u.id::text AS id, u.status, u.auth_generation::int AS gen,
                (SELECT balance FROM pod.credit_accounts a WHERE a.user_id = u.id) AS balance,
                (SELECT count(*)::int FROM pod.emotion_ledger l WHERE l.user_id = u.id) AS ledger,
                u.first_login_at IS NOT NULL AS fl
           FROM pod.auth_identities i JOIN pod.users u ON u.id = i.user_id
          WHERE i.provider = $1 AND i.subject = $2`,
        [p, subject],
      );
      const x = r.rows[0];
      return x ? { userId: x.id, status: x.status, gen: x.gen, balance: x.balance, ledger: x.ledger, firstLogin: x.fl } : null;
    },
    envOf(E2E_ENV.db),
  );
}

export async function userCount(): Promise<number> {
  return withAdmin(readDisposableEnv(), async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pod.users")).rows[0]!.n, envOf(E2E_ENV.db));
}

// ---------------------------------------------------------------- 화면 점검

export const WIDTHS = [375, 768, 1440] as const;

/** 가로 넘침 0, 보이는 버튼·링크·체크 라벨 높이 ≥ 44px(main 안), h1 하나. */
export async function expectLayoutOk(page: Page, label: string): Promise<void> {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `${label}: horizontal overflow`).toBeLessThanOrEqual(cw!);
  await expect(page.locator("main h1"), `${label}: one h1`).toHaveCount(1);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    for (const e of document.querySelectorAll("main a, main button, main label:has(input[type=checkbox])")) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.height < 44 || r.width < 44) out.push(`${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small, `${label}: targets below 44px`).toEqual([]);
}

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
