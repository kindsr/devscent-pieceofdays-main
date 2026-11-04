// F4 B2 RED — OIDC 어댑터 계약(PLAN_mvp-oidc-integration §6.1, §9 U5). DB 없음.
//
// 대상: app/src/server/auth/oidc.ts(아직 없음)의 beginLogin·finishLogin. 각 it 안에서 동적 import한다.
// - 실제 openid-client·oauth4webapi·iron·flow codec을 쓴다(mock 없음). mock은 tests/support/mock-oidc-issuer.ts의 HTTP issuer뿐이다.
// - 사례(sub-case)마다 새 mock 포트를 띄워 제품 discovery 캐시가 서로 섞이지 않게 한다. 캐시 키 사례만 같은 issuer를 일부러 공유한다.
// - "mock·vendor 대조" describe는 제품 모듈 없이 mock 자체가 실제 vendor 검증을 통과·거부하는지 먼저 확인한다(제품 RED와 분리).
// - 전역 Date.now·process.env는 바꾸지 않는다. 설정은 loadAuthConfig(env 인자, "test")로 만든 plain 객체다.
import path from "node:path";
import { randomBytes, createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import * as client from "openid-client";
import { afterAll, describe, expect, it } from "vitest";
import { loadAuthConfig, type AuthConfig, type ProviderConfig, type ProviderId } from "@/server/auth/config";
import { readFlow, type FlowInput } from "@/server/auth/flow-cookie";
import type { SessionConfig } from "@/server/auth/session";
import { APP_DIR } from "./auth-b1-support";
import {
  RAW_VENDOR_ERROR_MARKER,
  captureConsole,
  closeAllMockIssuers,
  mockPublicJwk,
  s256,
  withMockIssuer,
  type IdTokenFault,
  type MockClient,
  type MockFaults,
  type MockIssuer,
  type MockProviderId,
} from "../support/mock-oidc-issuer";

const OIDC_MODULE = path.join(APP_DIR, "src", "server", "auth", "oidc.ts");
const CASE_TIMEOUT = 60_000;
const BASE = "https://pieceofdays.example";
const SESSION_KEY = "ci-only-b2-session-key-1-".padEnd(40, "x");

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type BeginLogin = (
  p: ProviderConfig,
  session: SessionConfig,
  returnTo: string,
) => Promise<Result<{ authorizeUrl: URL; flow: { value: string; expiresAt: Date } }, "provider_unavailable">>;
type FinishLogin = (
  p: ProviderConfig,
  flow: FlowInput,
  query: URLSearchParams,
) => Promise<Result<{ subject: string }, "provider_unavailable" | "cancelled" | "rejected">>;
type OidcApi = { beginLogin: BeginLogin; finishLogin: FinishLogin };

/** 제품 모듈을 동적으로 불러와 export 함수를 단언한다. 없으면 이 it만 실패한다(정상 RED). */
async function loadOidc(): Promise<OidcApi> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ OIDC_MODULE)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F4 B2 product module src/server/auth/oidc.ts could not be loaded (expected before GREEN): ${msg}`);
  }
  for (const name of ["beginLogin", "finishLogin"]) {
    expect(typeof mod[name], `src/server/auth/oidc.ts must export function ${name}`).toBe("function");
  }
  return mod as unknown as OidcApi;
}

afterAll(async () => {
  await closeAllMockIssuers();
});

// ---------------------------------------------------------------- 설정·흐름 보조(시험 전용)

const fake = (label: string) => `ci-only-${label}-${randomBytes(6).toString("hex")}`;

function clientsFor(base = BASE): MockClient[] {
  return (["google", "kakao"] as const).map((p) => ({
    provider: p,
    clientId: fake(`${p}-client`),
    clientSecret: fake(`${p}-secret`),
    redirectUri: new URL(`/auth/${p}/callback`, base).href,
  }));
}

/** 실제 loadAuthConfig로 mock issuer 설정을 만든다(env는 인자 객체, 전역 env 불변). */
function authFor(mock: MockIssuer, clients: MockClient[], base = BASE): AuthConfig {
  const g = clients.find((c) => c.provider === "google")!;
  const k = clients.find((c) => c.provider === "kakao")!;
  const r = loadAuthConfig(
    {
      POD_AUTH_SESSION_SECRETS: JSON.stringify({ 1: SESSION_KEY }),
      POD_AUTH_BASE_URL: base,
      POD_AUTH_PROVIDERS: "google,kakao",
      POD_AUTH_GOOGLE_CLIENT_ID: g.clientId,
      POD_AUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
      POD_AUTH_KAKAO_CLIENT_ID: k.clientId,
      POD_AUTH_KAKAO_CLIENT_SECRET: k.clientSecret,
      POD_AUTH_MOCK_OIDC_ISSUER: mock.origin,
    },
    "test",
  );
  if (!r.ok) throw new Error(`test auth config was rejected: ${r.error}`);
  return r.value;
}

type Setup = { mock: MockIssuer; auth: AuthConfig; clients: MockClient[]; p: ProviderConfig };

/** 사례마다 새 mock 포트 + 설정. fn이 끝나면 성공·실패와 무관하게 mock을 닫는다. */
async function withSetup<T>(provider: MockProviderId, fn: (s: Setup) => Promise<T>, faults: MockFaults = {}): Promise<T> {
  const clients = clientsFor();
  return withMockIssuer({ clients, faults }, async (mock) => {
    const auth = authFor(mock, clients);
    const p = auth.providers[provider as ProviderId];
    if (!p) throw new Error("provider missing from test config");
    return fn({ mock, auth, clients, p });
  });
}

type Begun = { url: URL; sealed: string; flow: FlowInput & { expiresAt: Date }; flowExpiresAt: Date };

async function begin(oidc: OidcApi, s: Setup, returnTo = "/", p = s.p): Promise<Begun> {
  const r = await oidc.beginLogin(p, s.auth.session, returnTo);
  expect(r, "beginLogin succeeds against the mock issuer").toMatchObject({ ok: true });
  if (!r.ok) throw new Error("beginLogin failed");
  const flow = await readFlow(s.auth.session, r.value.flow.value);
  expect(flow, "the returned flow cookie reads back with the real codec").toMatchObject({ ok: true });
  if (!flow.ok) throw new Error("flow unreadable");
  return { url: r.value.authorizeUrl, sealed: r.value.flow.value, flow: flow.value, flowExpiresAt: r.value.flow.expiresAt };
}

const REJECTED = { ok: false, error: "rejected" };
const CANCELLED = { ok: false, error: "cancelled" };
const UNAVAILABLE = { ok: false, error: "provider_unavailable" };
const otherToken = (t: string) => (t[0] === "A" ? "B" : "A") + t.slice(1);
const B64U43 = /^[A-Za-z0-9_-]{43}$/;

/** 같은 이름의 entry를 하나 더 붙인다(값 동일: 중복 자체만 거부 사유가 되게 한다). */
function withDuplicate(q: URLSearchParams, name: string): URLSearchParams {
  const out = new URLSearchParams(q);
  out.append(name, q.get(name)!);
  return out;
}

// ---------------------------------------------------------------- mock·vendor 대조(제품 모듈 없이)

const vendorConfig = (mock: MockIssuer, c: MockClient, opts: { nonRepudiation?: boolean } = { nonRepudiation: true }) =>
  client.discovery(new URL(mock.issuer(c.provider)), c.clientId, c.clientSecret, client.ClientSecretPost(c.clientSecret), {
    execute: opts.nonRepudiation ? [client.allowInsecureRequests, client.enableNonRepudiationChecks] : [client.allowInsecureRequests],
  });

/** vendor를 직접 써서 authorize → callback까지 진행한다(제품 대조 전 하네스 검증용). */
async function vendorAuthorize(mock: MockIssuer, c: MockClient, cfg: client.Configuration, subject?: string) {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: c.redirectUri,
    scope: "openid",
    response_type: "code",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const a = await mock.authorize(url, { subject });
  const current = new URL(c.redirectUri);
  for (const [k, v] of a.query) current.searchParams.append(k, v);
  return { verifier, state, nonce, current, a };
}

async function tokenPost(mock: MockIssuer, p: MockProviderId, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(mock.endpoint(p, "token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("mock issuer controls (real HTTP + vendor, no product module)", () => {
  it("discovery documents: google iss parameter + post/basic, kakao no iss entry + post only + pairwise; vendor discovery accepts both", async () => {
    await withMockIssuer({ clients: clientsFor() }, async (mock) => {
      const g = (await (await fetch(`${mock.issuer("google")}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
      expect(g).toMatchObject({
        issuer: mock.issuer("google"),
        authorization_response_iss_parameter_supported: true,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        jwks_uri: mock.endpoint("google", "jwks"),
      });
      const k = (await (await fetch(`${mock.issuer("kakao")}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
      expect(k).toMatchObject({
        issuer: mock.issuer("kakao"),
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        subject_types_supported: ["pairwise"],
      });
      expect(Object.hasOwn(k, "authorization_response_iss_parameter_supported")).toBe(false);
      for (const c of clientsFor()) {
        const cfg = await vendorConfig(mock, c);
        expect(cfg.serverMetadata().issuer).toBe(mock.issuer(c.provider));
      }
      // insecure 허용 없이는 vendor가 http issuer를 거부한다(제품의 insecureMock 분기 대조).
      const c0 = clientsFor()[0]!;
      await expect(
        client.discovery(new URL(mock.issuer("google")), c0.clientId, c0.clientSecret, client.ClientSecretPost(c0.clientSecret)),
      ).rejects.toThrow();
      mock.faults.discovery = "error";
      await expect(vendorConfig(mock, c0)).rejects.toThrow();
    });
  }, CASE_TIMEOUT);

  it("vendor end-to-end with enableNonRepudiationChecks succeeds for google and kakao; JWKS verifies the RS256 ID Token directly", async () => {
    const clients = clientsFor();
    await withMockIssuer({ clients }, async (mock) => {
      for (const c of clients) {
        const cfg = await vendorConfig(mock, c);
        const { verifier, state, nonce, current, a } = await vendorAuthorize(mock, c, cfg, `ctl-${c.provider}-sub`);
        expect(a.query.get("iss") !== null, `${c.provider} callback iss parameter`).toBe(c.provider === "google");
        const tokens = await client.authorizationCodeGrant(cfg, current, {
          pkceCodeVerifier: verifier,
          expectedState: state,
          expectedNonce: nonce,
          idTokenExpected: true,
        });
        expect(tokens.claims()?.sub).toBe(`ctl-${c.provider}-sub`);
        const rec = mock.tokenRequests.at(-1)!;
        expect(rec).toMatchObject({ provider: c.provider, outcome: "ok", authMethod: "post" });
        expect(rec.params.redirect_uri).toBe(c.redirectUri);
        // JWKS 공개 키로 서명을 직접 검증한다(vendor와 독립된 대조).
        const jwks = (await (await fetch(mock.endpoint(c.provider, "jwks"))).json()) as { keys: JsonWebKey[] };
        expect(jwks.keys).toEqual([mockPublicJwk()]);
        const [h, pl, sig] = (tokens.id_token ?? "").split(".");
        const ok = cryptoVerify(
          "sha256",
          Buffer.from(`${h}.${pl}`),
          createPublicKey({ key: jwks.keys[0]!, format: "jwk" }),
          Buffer.from(sig ?? "", "base64url"),
        );
        expect(ok, "RS256 signature verifies with the JWKS key").toBe(true);
      }
    });
  }, CASE_TIMEOUT);

  it("token endpoint rejects wrong secret, kakao basic auth, redirect mismatch, missing/mismatched PKCE, reused/expired/unknown code; consumes a code exactly once under concurrency", async () => {
    const clients = clientsFor();
    const g = clients[0]!;
    const k = clients[1]!;
    await withMockIssuer({ clients }, async (mock) => {
      const cfgG = await vendorConfig(mock, g);
      const issue = async (c: MockClient, cfg: client.Configuration) => {
        const r = await vendorAuthorize(mock, c, cfg);
        return { code: r.a.code!, verifier: r.verifier };
      };
      const body = (c: MockClient, code: string, verifier: string | undefined, over: Record<string, string> = {}) => ({
        grant_type: "authorization_code",
        code,
        redirect_uri: c.redirectUri,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        ...(verifier === undefined ? {} : { code_verifier: verifier }),
        ...over,
      });
      const cases: [string, (code: string, v: string) => Promise<{ status: number }>, string][] = [
        ["wrong secret", (code, v) => tokenPost(mock, "google", body(g, code, v, { client_secret: `${g.clientSecret}x` })), "invalid_client"],
        ["redirect mismatch", (code, v) => tokenPost(mock, "google", body(g, code, v, { redirect_uri: `${BASE}/other` })), "redirect_mismatch"],
        ["pkce missing", (code) => tokenPost(mock, "google", body(g, code, undefined)), "pkce_missing"],
        ["pkce mismatch", (code, v) => tokenPost(mock, "google", body(g, code, otherToken(v))), "pkce_mismatch"],
        ["unknown code", (_code, v) => tokenPost(mock, "google", body(g, "unknown-code", v)), "unknown_code"],
      ];
      for (const [label, call, outcome] of cases) {
        const { code, verifier } = await issue(g, cfgG);
        const r = await call(code, verifier);
        expect(r.status, label).toBeGreaterThanOrEqual(400);
        expect(mock.tokenRequests.at(-1)?.outcome, label).toBe(outcome);
      }
      // 재사용: 정상 교환 뒤 같은 code
      const reuse = await issue(g, cfgG);
      expect((await tokenPost(mock, "google", body(g, reuse.code, reuse.verifier))).status).toBe(200);
      expect((await tokenPost(mock, "google", body(g, reuse.code, reuse.verifier))).status).toBe(400);
      expect(mock.tokenRequests.at(-1)?.outcome).toBe("code_reused");
      // 동시 2건: 정확히 하나만 200
      const race = await issue(g, cfgG);
      const both = await Promise.all([0, 1].map(() => tokenPost(mock, "google", body(g, race.code, race.verifier))));
      expect(both.map((b) => b.status).sort()).toEqual([200, 400]);
      // kakao는 basic 인증을 거부한다(post만 광고)
      const cfgK = await vendorConfig(mock, k);
      const kc = await issue(k, cfgK);
      const basic = `Basic ${Buffer.from(`${k.clientId}:${k.clientSecret}`).toString("base64")}`;
      const kb = body(k, kc.code, kc.verifier);
      delete (kb as Record<string, string>).client_secret;
      expect((await tokenPost(mock, "kakao", kb, { authorization: basic })).status).toBe(401);
      expect(mock.tokenRequests.at(-1)?.outcome).toBe("basic_not_allowed");
      // 만료
      mock.faults.codeTtlMs = 1;
      const exp = await issue(g, cfgG);
      await new Promise((r) => setTimeout(r, 25));
      expect((await tokenPost(mock, "google", body(g, exp.code, exp.verifier))).status).toBe(400);
      expect(mock.tokenRequests.at(-1)?.outcome).toBe("code_expired");
      // 재사용 허용 모드(동시 callback의 F3 멱등 검증 전용)
      mock.faults.codeTtlMs = undefined;
      mock.faults.allowCodeReuse = true;
      const again = await issue(g, cfgG);
      const twice = await Promise.all([0, 1].map(() => tokenPost(mock, "google", body(g, again.code, again.verifier))));
      expect(twice.map((b) => b.status)).toEqual([200, 200]);
      // 오류 응답 본문에는 원문 표지가 있다(로그 누출 검사의 근거)
      const raw = await tokenPost(mock, "google", body(g, "unknown-code", "x".repeat(43)));
      expect(String(raw.json.error_description)).toContain(RAW_VENDOR_ERROR_MARKER);
    });
  }, CASE_TIMEOUT);

  it("vendor rejects duplicate state/code/iss before any exchange and reports access_denied as an authorization error only after iss/state pass", async () => {
    const clients = clientsFor();
    const g = clients[0]!;
    await withMockIssuer({ clients }, async (mock) => {
      const cfg = await vendorConfig(mock, g);
      for (const name of ["state", "code", "iss"]) {
        const { verifier, state, nonce, current } = await vendorAuthorize(mock, g, cfg);
        current.searchParams.append(name, current.searchParams.get(name)!);
        await expect(
          client.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce }),
          `duplicate ${name}`,
        ).rejects.toThrow();
      }
      expect(mock.tokenRequests, "duplicates never reach the token endpoint").toHaveLength(0);
      const denied = async (opts: { iss?: "omit" }, tamperState: boolean) => {
        const verifier = client.randomPKCECodeVerifier();
        const state = client.randomState();
        const url = client.buildAuthorizationUrl(cfg, {
          redirect_uri: g.redirectUri,
          scope: "openid",
          code_challenge: await client.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          state,
          nonce: client.randomNonce(),
        });
        const a = await mock.authorize(url, { deny: true, ...opts });
        const current = new URL(g.redirectUri);
        for (const [k, v] of a.query) current.searchParams.append(k, tamperState && k === "state" ? otherToken(v) : v);
        try {
          await client.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: verifier, expectedState: state });
          return "accepted";
        } catch (err) {
          return err instanceof client.AuthorizationResponseError ? `authorization_error:${err.error}` : "other_error";
        }
      };
      expect(await denied({}, false)).toBe("authorization_error:access_denied");
      expect(await denied({}, true), "wrong state is checked before error").toBe("other_error");
      expect(await denied({ iss: "omit" }, false), "google iss is checked before error").toBe("other_error");
    });
  }, CASE_TIMEOUT);

  it("vendor rejects each ID Token fault; a wrong-key signature passes only without enableNonRepudiationChecks", async () => {
    const run = async (fault: IdTokenFault | undefined, nonRepudiation: boolean) => {
      const clients = clientsFor();
      const c = clients[0]!;
      return withMockIssuer({ clients, faults: { idToken: fault } }, async (mock) => {
        const cfg = await vendorConfig(mock, c, { nonRepudiation });
        const { verifier, state, nonce, current } = await vendorAuthorize(mock, c, cfg);
        try {
          await client.authorizationCodeGrant(cfg, current, {
            pkceCodeVerifier: verifier,
            expectedState: state,
            expectedNonce: nonce,
            idTokenExpected: true,
          });
          return "accepted";
        } catch {
          return "rejected";
        }
      });
    };
    expect(await run(undefined, true), "control: valid token").toBe("accepted");
    expect(await run("wrong_key", false), "wrong key without non-repudiation (vendor default)").toBe("accepted");
    expect(await run("wrong_key", true), "wrong key with non-repudiation").toBe("rejected");
    for (const f of ["alg_none", "hs256", "iss", "aud", "nonce", "exp_past", "missing"] as const) {
      expect(await run(f, true), f).toBe("rejected");
    }
  }, CASE_TIMEOUT);
});

// ---------------------------------------------------------------- 제품 계약 U5

describe("beginLogin (§6.1 start)", () => {
  it("builds the authorize URL with exactly the listed parameters and seals a flow bound to provider/issuer/returnTo/state/nonce/verifier", async () => {
    const oidc = await loadOidc();
    for (const provider of ["google", "kakao"] as const) {
      await withSetup(provider, async (s) => {
        const b = await begin(oidc, s, "/days/2026-11-03");
        expect(b.url.origin + b.url.pathname).toBe(s.mock.endpoint(provider, "authorize"));
        const entries = [...b.url.searchParams.entries()];
        const names = entries.map(([k]) => k).sort();
        expect(names, "parameter set (each exactly once)").toEqual(
          ["client_id", "code_challenge", "code_challenge_method", "nonce", "redirect_uri", "response_type", "scope", "state"].sort(),
        );
        const q = b.url.searchParams;
        expect(q.get("client_id")).toBe(s.p.clientId);
        expect(q.get("redirect_uri")).toBe(s.p.redirectUri.href);
        expect(q.get("scope")).toBe("openid");
        expect(q.get("response_type")).toBe("code");
        expect(q.get("code_challenge_method")).toBe("S256");
        for (const v of [q.get("state"), q.get("nonce"), b.flow.codeVerifier]) expect(v).toMatch(B64U43);
        expect(b.flow).toMatchObject({
          provider,
          issuer: s.p.issuer.href,
          state: q.get("state"),
          nonce: q.get("nonce"),
          returnTo: "/days/2026-11-03",
        });
        expect(q.get("code_challenge")).toBe(s256(b.flow.codeVerifier));
        expect(b.flowExpiresAt.getTime()).toBe(b.flow.expiresAt.getTime());
        // mock authorize endpoint도 이 요청을 유효하다고 받아들인다.
        const a = await s.mock.authorize(b.url);
        expect(a.code).toBeTypeOf("string");
      });
    }
    // 두 번 시작하면 state·nonce·verifier가 새로 만들어진다.
    await withSetup("google", async (s) => {
      const b1 = await begin(oidc, s);
      const b2 = await begin(oidc, s);
      expect(b2.flow.state).not.toBe(b1.flow.state);
      expect(b2.flow.nonce).not.toBe(b1.flow.nonce);
      expect(b2.flow.codeVerifier).not.toBe(b1.flow.codeVerifier);
    });
  }, CASE_TIMEOUT);

  it("discovery failure → provider_unavailable; a failed discovery is not cached (the same config succeeds after recovery)", async () => {
    const oidc = await loadOidc();
    await withSetup(
      "google",
      async (s) => {
        expect(await oidc.beginLogin(s.p, s.auth.session, "/")).toEqual(UNAVAILABLE);
        expect(s.mock.discoveryRequests.length).toBeGreaterThan(0);
        s.mock.faults.discovery = undefined;
        await begin(oidc, s);
      },
      { discovery: "error" },
    );
  }, CASE_TIMEOUT);
});

describe("finishLogin (§6.1 callback, real vendor validation)", () => {
  it("google and kakao success → exactly { subject }; token request uses the configured redirect_uri and client_secret_post", async () => {
    const oidc = await loadOidc();
    for (const provider of ["google", "kakao"] as const) {
      await withSetup(provider, async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url, { subject: `b2-${provider}-subject` });
        const r = await oidc.finishLogin(s.p, b.flow, a.query);
        expect(r).toEqual({ ok: true, value: { subject: `b2-${provider}-subject` } });
        const tok = s.mock.tokenRequests.filter((t) => t.outcome === "ok");
        expect(tok).toHaveLength(1);
        expect(tok[0]!.params.redirect_uri).toBe(s.p.redirectUri.href);
        expect(tok[0]!.authMethod).toBe("post");
        expect(tok[0]!.params.code_verifier).toBe(b.flow.codeVerifier);
        // ID Token 서명 검증을 위해 JWKS를 실제로 받아 갔다(enableNonRepudiationChecks).
        expect(s.mock.jwksRequests.length, "JWKS fetched for signature verification").toBeGreaterThan(0);
      });
    }
  }, CASE_TIMEOUT);

  it("forged signature (other key), alg none and HS256 → rejected", async () => {
    const oidc = await loadOidc();
    for (const fault of ["wrong_key", "alg_none", "hs256"] as const) {
      await withSetup(
        "google",
        async (s) => {
          const b = await begin(oidc, s);
          const a = await s.mock.authorize(b.url);
          expect(await oidc.finishLogin(s.p, b.flow, a.query), fault).toEqual(REJECTED);
          expect(s.mock.tokenRequests.map((t) => t.outcome), `${fault}: token exchange itself succeeded`).toEqual(["ok"]);
        },
        { idToken: fault },
      );
    }
  }, CASE_TIMEOUT);

  it("state (mismatch/missing), nonce, iss parameter (google wrong/missing, kakao wrong), iss/aud claims, past exp and missing id_token → rejected", async () => {
    const oidc = await loadOidc();
    // 응답 매개변수 사례: 교환 전에 vendor가 거부한다(token 요청 0).
    const queryCases: [MockProviderId, string, (q: URLSearchParams) => URLSearchParams, { iss?: "omit" | "wrong" }][] = [
      ["google", "state mismatch", (q) => {
        q.set("state", otherToken(q.get("state")!));
        return q;
      }, {}],
      ["google", "state missing", (q) => {
        q.delete("state");
        return q;
      }, {}],
      ["kakao", "state mismatch", (q) => {
        q.set("state", otherToken(q.get("state")!));
        return q;
      }, {}],
      ["google", "iss parameter wrong", (q) => q, { iss: "wrong" }],
      ["google", "iss parameter missing", (q) => q, { iss: "omit" }],
      ["kakao", "iss parameter wrong", (q) => q, { iss: "wrong" }],
    ];
    for (const [provider, label, edit, opts] of queryCases) {
      await withSetup(provider, async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url, opts);
        expect(await oidc.finishLogin(s.p, b.flow, edit(new URLSearchParams(a.query))), `${provider} ${label}`).toEqual(REJECTED);
        expect(s.mock.tokenRequests, `${provider} ${label}: no token exchange`).toHaveLength(0);
      });
    }
    // ID Token claim 사례: 교환은 성공하고 vendor claim 검증이 거부한다.
    for (const provider of ["google", "kakao"] as const) {
      for (const fault of ["nonce", "iss", "aud", "exp_past", "missing"] as const) {
        await withSetup(
          provider,
          async (s) => {
            const b = await begin(oidc, s);
            const a = await s.mock.authorize(b.url);
            expect(await oidc.finishLogin(s.p, b.flow, a.query), `${provider} ${fault}`).toEqual(REJECTED);
            expect(s.mock.tokenRequests.map((t) => t.outcome), `${provider} ${fault}: exchange reached`).toEqual(["ok"]);
          },
          { idToken: fault },
        );
      }
    }
  }, CASE_TIMEOUT);

  it("PKCE mismatch, reused code, expired code, wrong client secret, redirect mismatch and token server error → rejected at the token endpoint", async () => {
    const oidc = await loadOidc();
    await withSetup("google", async (s) => {
      const b = await begin(oidc, s);
      const a = await s.mock.authorize(b.url);
      const flow = { ...b.flow, codeVerifier: otherToken(b.flow.codeVerifier) };
      expect(await oidc.finishLogin(s.p, flow, a.query)).toEqual(REJECTED);
      expect(s.mock.tokenRequests.map((t) => t.outcome)).toEqual(["pkce_mismatch"]);
    });
    await withSetup("kakao", async (s) => {
      const b = await begin(oidc, s);
      const a = await s.mock.authorize(b.url);
      expect(await oidc.finishLogin(s.p, b.flow, a.query)).toMatchObject({ ok: true });
      expect(await oidc.finishLogin(s.p, b.flow, a.query), "same code again").toEqual(REJECTED);
      expect(s.mock.tokenRequests.map((t) => t.outcome)).toEqual(["ok", "code_reused"]);
    });
    await withSetup(
      "google",
      async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url);
        await new Promise((r) => setTimeout(r, 25));
        expect(await oidc.finishLogin(s.p, b.flow, a.query)).toEqual(REJECTED);
        expect(s.mock.tokenRequests.map((t) => t.outcome)).toEqual(["code_expired"]);
      },
      { codeTtlMs: 1 },
    );
    await withSetup("google", async (s) => {
      const b = await begin(oidc, s);
      const a = await s.mock.authorize(b.url);
      const wrongSecret: ProviderConfig = Object.freeze({ ...s.p, clientSecret: `${s.p.clientSecret}-wrong` });
      expect(await oidc.finishLogin(wrongSecret, b.flow, a.query)).toEqual(REJECTED);
      expect(s.mock.tokenRequests.map((t) => t.outcome)).toEqual(["invalid_client"]);
    });
    await withSetup("google", async (s) => {
      const b = await begin(oidc, s);
      const a = await s.mock.authorize(b.url);
      // 요청 host와 무관하게 설정 redirectUri가 token 요청 redirect_uri로 간다: 다른 설정 값이면 공급자가 거부한다.
      const otherRedirect: ProviderConfig = Object.freeze({ ...s.p, redirectUri: new URL("/auth/google/callback", "https://other.example") });
      expect(await oidc.finishLogin(otherRedirect, b.flow, a.query)).toEqual(REJECTED);
      expect(s.mock.tokenRequests.map((t) => [t.outcome, t.params.redirect_uri])).toEqual([
        ["redirect_mismatch", "https://other.example/auth/google/callback"],
      ]);
    });
    await withSetup(
      "google",
      async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url);
        expect(await oidc.finishLogin(s.p, b.flow, a.query)).toEqual(REJECTED);
        expect(s.mock.tokenRequests.map((t) => t.outcome)).toEqual(["server_error"]);
      },
      { token: "server_error" },
    );
  }, CASE_TIMEOUT);

  it("duplicate state, code or iss entries are preserved (append) so the vendor rejects them before any exchange", async () => {
    const oidc = await loadOidc();
    for (const name of ["state", "code", "iss"] as const) {
      await withSetup("google", async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url);
        expect(await oidc.finishLogin(s.p, b.flow, withDuplicate(a.query, name)), `duplicate ${name}`).toEqual(REJECTED);
        expect(s.mock.tokenRequests, `duplicate ${name}: no token exchange`).toHaveLength(0);
        // 대조: 같은 code·flow의 정상 query는 아직 성공한다(거부 사유가 중복 하나뿐임).
        expect(await oidc.finishLogin(s.p, b.flow, a.query), `control after duplicate ${name}`).toMatchObject({ ok: true });
      });
    }
  }, CASE_TIMEOUT);

  it("access_denied after valid iss/state → cancelled; wrong-state error, google missing-iss error and other errors → rejected", async () => {
    const oidc = await loadOidc();
    for (const provider of ["google", "kakao"] as const) {
      await withSetup(provider, async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url, { deny: true });
        expect(a.query.get("error")).toBe("access_denied");
        expect(await oidc.finishLogin(s.p, b.flow, a.query), `${provider} cancel`).toEqual(CANCELLED);
      });
    }
    const rejectedCases: [MockProviderId, string, { deny: true; error?: string; iss?: "omit" }, (q: URLSearchParams) => URLSearchParams][] = [
      ["google", "error with wrong state", { deny: true }, (q) => {
        q.set("state", otherToken(q.get("state")!));
        return q;
      }],
      ["kakao", "error with wrong state", { deny: true }, (q) => {
        q.set("state", otherToken(q.get("state")!));
        return q;
      }],
      ["google", "error without iss", { deny: true, iss: "omit" }, (q) => q],
      ["google", "server_error", { deny: true, error: "server_error" }, (q) => q],
    ];
    for (const [provider, label, opts, edit] of rejectedCases) {
      await withSetup(provider, async (s) => {
        const b = await begin(oidc, s);
        const a = await s.mock.authorize(b.url, opts);
        expect(await oidc.finishLogin(s.p, b.flow, edit(new URLSearchParams(a.query))), `${provider} ${label}`).toEqual(REJECTED);
      });
    }
  }, CASE_TIMEOUT);

  it("discovery failure at callback → provider_unavailable", async () => {
    const oidc = await loadOidc();
    await withSetup(
      "google",
      async (s) => {
        const flow: FlowInput = {
          provider: "google",
          issuer: s.p.issuer.href,
          state: client.randomState(),
          nonce: client.randomNonce(),
          codeVerifier: client.randomPKCECodeVerifier(),
          returnTo: "/",
        };
        const q = new URLSearchParams({ code: "unused", state: flow.state, iss: s.p.issuer.href });
        expect(await oidc.finishLogin(s.p, flow, q)).toEqual(UNAVAILABLE);
        expect(s.mock.tokenRequests).toHaveLength(0);
      },
      { discovery: "error" },
    );
  }, CASE_TIMEOUT);
});

describe("discovery configuration cache key (issuer.href · clientId · clientSecret · insecureMock)", () => {
  it("does not share a configuration across client id, client secret or insecureMock on the same issuer", async () => {
    const oidc = await loadOidc();
    const clients = clientsFor();
    const extra: MockClient = { ...clients[0]!, clientId: fake("google-client-b"), clientSecret: fake("google-secret-b") };
    await withMockIssuer({ clients: [...clients, extra] }, async (mock) => {
      const auth = authFor(mock, clients);
      const s: Setup = { mock, auth, clients, p: auth.providers.google! };
      // A로 먼저 discovery·로그인 성공
      const bA = await begin(oidc, s);
      expect(await oidc.finishLogin(s.p, bA.flow, (await mock.authorize(bA.url)).query)).toMatchObject({ ok: true });
      // B(clientId·secret 다름): authorize URL과 token 요청이 B 값이어야 한다
      const pB: ProviderConfig = Object.freeze({ ...s.p, clientId: extra.clientId, clientSecret: extra.clientSecret });
      const bB = await begin(oidc, s, "/", pB);
      expect(bB.url.searchParams.get("client_id")).toBe(extra.clientId);
      expect(await oidc.finishLogin(pB, bB.flow, (await mock.authorize(bB.url)).query)).toMatchObject({ ok: true });
      expect(mock.tokenRequests.at(-1)?.params).toMatchObject({ client_id: extra.clientId, client_secret: extra.clientSecret });
      // 같은 clientId·다른 secret: 공급자가 거부해야 한다(A 설정 재사용이면 통과해 버린다)
      const pWrong: ProviderConfig = Object.freeze({ ...s.p, clientSecret: `${s.p.clientSecret}-other` });
      const bW = await begin(oidc, s, "/", pWrong);
      expect(await oidc.finishLogin(pWrong, bW.flow, (await mock.authorize(bW.url)).query)).toEqual(REJECTED);
      expect(mock.tokenRequests.at(-1)?.outcome).toBe("invalid_client");
      // insecureMock false: http issuer는 vendor가 거부해야 한다(insecure 설정 재사용 금지)
      const pSecure: ProviderConfig = Object.freeze({ ...s.p, insecureMock: false });
      expect(await oidc.beginLogin(pSecure, auth.session, "/")).toEqual(UNAVAILABLE);
    });
  }, CASE_TIMEOUT);
});

describe("no secrets in logs (§6.1 log rule)", () => {
  it("success and failure paths leave no code/state/nonce/verifier/client secret/sub/token/raw vendor error text in console output", async () => {
    const oidc = await loadOidc();
    const leaked: string[] = [];
    const runCase = async (provider: MockProviderId, faults: MockFaults, opts: { deny?: boolean; tamper?: boolean } = {}) =>
      withSetup(
        provider,
        async (s) => {
          const cap = captureConsole();
          const markers: string[] = [];
          try {
            const b = await begin(oidc, s);
            markers.push(b.flow.state, b.flow.nonce, b.flow.codeVerifier, b.sealed);
            const a = await s.mock.authorize(b.url, { deny: opts.deny, subject: `b2-log-subject-${provider}-${randomBytes(4).toString("hex")}` });
            markers.push(a.subject);
            const q = new URLSearchParams(a.query);
            if (opts.tamper) q.set("state", otherToken(q.get("state")!));
            await oidc.finishLogin(s.p, b.flow, q);
            await oidc.finishLogin(s.p, b.flow, a.query); // 재사용 또는 재시도
          } finally {
            cap.restore();
          }
          const text = cap.text();
          for (const m of [...markers, ...s.mock.secrets(), s.p.clientSecret]) {
            if (m && text.includes(m)) leaked.push(`${provider}:${JSON.stringify(faults)}:${m.slice(0, 6)}…`);
          }
        },
        faults,
      );
    await runCase("google", {});
    await runCase("kakao", {});
    await runCase("google", { idToken: "wrong_key" });
    await runCase("google", { idToken: "aud" });
    await runCase("kakao", {}, { tamper: true });
    await runCase("google", {}, { deny: true });
    await runCase("google", { token: "server_error" });
    expect(leaked, "secret-like values in console output").toEqual([]);
  }, CASE_TIMEOUT);
});
