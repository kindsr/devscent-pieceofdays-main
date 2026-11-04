// F4 B2 RED 시험 전용 mock OIDC issuer(PLAN_mvp-oidc-integration §9). 제품 코드가 import하지 않는다.
//
// - node:http로 127.0.0.1의 임의 포트에만 listen한다. issuer는 `${origin}/google`·`${origin}/kakao`다.
// - discovery·authorize·token·JWKS endpoint를 실제 HTTP로 제공한다. 검증을 건너뛰지 않는 issuer다.
//   - google: authorization_response_iss_parameter_supported true, S256, client_secret_post·client_secret_basic
//   - kakao: iss 매개변수 항목 없음, S256, client_secret_post만, pairwise
// - ID Token은 node:crypto RS256 키로 이 시험 코드만 서명한다. 제품은 JWT를 만들거나 파싱하지 않는다(vendor가 검증).
// - token endpoint는 client_secret·redirect_uri·code 수명/재사용·PKCE 누락/불일치를 실제로 거부한다.
//   code 소비는 요청 본문을 다 읽은 뒤 await 없이 동기로 판정·표시해 동시 요청에서도 정확히 한 번만 성공한다.
//   allowCodeReuse는 동시 callback의 F3 멱등 검증용으로만 켠다.
// - 오류 응답 error_description과 discovery 실패 본문에는 RAW_VENDOR_ERROR_MARKER를 넣는다(로그 누출 검사용).
// - 모든 값은 시험용 가짜 값이다. 실제 공급자·네트워크에 연결하지 않는다.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";

export type MockProviderId = "google" | "kakao";
export const MOCK_PROVIDERS: readonly MockProviderId[] = ["google", "kakao"];

/** 오류 응답에 넣는 원문 표지. 제품 로그·결과에 나타나면 안 된다. */
export const RAW_VENDOR_ERROR_MARKER = "mock-raw-vendor-error-7f3c2a";
export const MOCK_KID = "mock-rs256-1";

export type IdTokenFault = "wrong_key" | "alg_none" | "hs256" | "iss" | "aud" | "nonce" | "exp_past" | "missing";
export type MockFaults = {
  /** discovery 문서 대신 503을 돌려준다. */
  discovery?: "error";
  /** token endpoint가 500 server_error를 돌려준다(교환 실패). */
  token?: "server_error";
  idToken?: IdTokenFault;
  /** 같은 code의 재교환을 허용한다(동시 callback의 F3 멱등 검증 전용). */
  allowCodeReuse?: boolean;
  /** 발급한 code의 수명(ms). 기본 60_000. */
  codeTtlMs?: number;
};

export type MockClient = { provider: MockProviderId; clientId: string; clientSecret: string; redirectUri: string };

export type AuthorizeRecord = { provider: MockProviderId; params: [string, string][] };
export type TokenOutcome =
  | "ok"
  | "unsupported_grant_type"
  | "invalid_client"
  | "basic_not_allowed"
  | "unknown_code"
  | "code_reused"
  | "code_expired"
  | "client_mismatch"
  | "redirect_mismatch"
  | "pkce_missing"
  | "pkce_mismatch"
  | "server_error";
export type TokenRecord = {
  provider: MockProviderId;
  authMethod: "post" | "basic" | "none";
  params: Record<string, string>;
  outcome: TokenOutcome;
  /** 성공 응답에 실은 원문(누출 검사용). */
  issued?: { accessToken: string; idToken?: string; subject: string };
};

export type AuthorizeOptions = {
  /** 이번 인가에서 로그인한 사용자 subject(기본: 사례별 무작위 값). */
  subject?: string;
  /** 사용자가 동의를 거부했다(error=access_denied). */
  deny?: boolean;
  /** 응답의 error 값(deny와 함께, 기본 access_denied). */
  error?: string;
  /** callback query의 iss 매개변수(google 기본 normal, kakao 기본 omit). */
  iss?: "normal" | "omit" | "wrong";
};

export type AuthorizeResult = { status: number; callback: URL; query: URLSearchParams; code?: string; subject: string };

export type MockIssuer = {
  origin: string;
  port: number;
  issuer(p: MockProviderId): string;
  endpoint(p: MockProviderId, name: "authorize" | "token" | "jwks"): string;
  faults: MockFaults;
  readonly authorizeRequests: AuthorizeRecord[];
  readonly tokenRequests: TokenRecord[];
  readonly discoveryRequests: MockProviderId[];
  readonly jwksRequests: MockProviderId[];
  /** 브라우저 대신 authorize URL을 실제 HTTP로 열고 302 Location(callback)을 돌려준다. */
  authorize(url: URL | string, opts?: AuthorizeOptions): Promise<AuthorizeResult>;
  /** 원문 표지 목록(code·token·secret·sub 등). 로그 누출 검사가 쓴다. */
  secrets(): string[];
  close(): Promise<void>;
};

type CodeEntry = {
  provider: MockProviderId;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  subject: string;
  expiresAt: number;
  used: boolean;
};

// ---------------------------------------------------------------- 키(프로세스당 한 번, 시험 전용)

let keys: { priv: KeyObject; pubJwk: Record<string, unknown>; wrong: KeyObject } | undefined;
function signingKeys() {
  if (!keys) {
    const main = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = main.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    keys = { priv: main.privateKey, pubJwk: jwk, wrong: other.privateKey };
  }
  return keys;
}

/** 이 issuer의 JWKS 공개 키(시험의 직접 서명 검증 대조용). */
export function mockPublicJwk(): Record<string, unknown> {
  return { ...signingKeys().pubJwk, kid: MOCK_KID, alg: "RS256", use: "sig" };
}

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const randomToken = (n = 32) => randomBytes(n).toString("base64url");

function makeIdToken(claims: Record<string, unknown>, fault: IdTokenFault | undefined, clientSecret: string): string {
  const k = signingKeys();
  if (fault === "alg_none") {
    return `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}.`;
  }
  if (fault === "hs256") {
    const input = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT", kid: MOCK_KID }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${createHmac("sha256", clientSecret).update(input).digest("base64url")}`;
  }
  const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: MOCK_KID }))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign("sha256", Buffer.from(input), fault === "wrong_key" ? k.wrong : k.priv);
  return `${input}.${b64u(sig)}`;
}

// ---------------------------------------------------------------- HTTP

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const openIssuers = new Set<MockIssuer>();

export type StartMockOptions = { clients: MockClient[]; faults?: MockFaults };

/** 새 mock issuer를 127.0.0.1 임의 포트에 띄운다. 사례마다 새로 띄우고 finally에서 close한다. */
export async function startMockIssuer(opts: StartMockOptions): Promise<MockIssuer> {
  signingKeys();
  const faults: MockFaults = { ...(opts.faults ?? {}) };
  const clients = opts.clients.map((c) => ({ ...c }));
  const codes = new Map<string, CodeEntry>();
  const authorizeRequests: AuthorizeRecord[] = [];
  const tokenRequests: TokenRecord[] = [];
  const discoveryRequests: MockProviderId[] = [];
  const jwksRequests: MockProviderId[] = [];
  const issued: string[] = [];
  let pending: AuthorizeOptions = {};
  let seq = 0;
  let origin = "";

  const issuerOf = (p: MockProviderId) => `${origin}/${p}`;
  const fail = (res: ServerResponse, status: number, error: string) =>
    send(res, status, { error, error_description: `${RAW_VENDOR_ERROR_MARKER}:${error}` });

  function discoveryDoc(p: MockProviderId): Record<string, unknown> {
    const iss = issuerOf(p);
    const base = {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      response_types_supported: ["code"],
      scopes_supported: ["openid"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    };
    return p === "google"
      ? {
          ...base,
          subject_types_supported: ["public"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          authorization_response_iss_parameter_supported: true,
        }
      : { ...base, subject_types_supported: ["pairwise"], token_endpoint_auth_methods_supported: ["client_secret_post"] };
  }

  function handleAuthorize(p: MockProviderId, url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    authorizeRequests.push({ provider: p, params: [...q.entries()] });
    const action = pending;
    pending = {};
    const one = (k: string) => (q.getAll(k).length === 1 ? q.get(k)! : undefined);
    const clientId = one("client_id");
    const client = clients.find((c) => c.provider === p && c.clientId === clientId);
    const redirectUri = one("redirect_uri");
    if (!client || redirectUri !== client.redirectUri) return send(res, 400, "mock authorize: unknown client or redirect_uri");
    const challenge = one("code_challenge");
    if (
      one("response_type") !== "code" ||
      one("scope") !== "openid" ||
      one("code_challenge_method") !== "S256" ||
      challenge === undefined ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      one("state") === undefined ||
      one("nonce") === undefined
    ) {
      return send(res, 400, "mock authorize: invalid authorization request");
    }
    const cb = new URL(client.redirectUri);
    const issMode = action.iss ?? (p === "google" ? "normal" : "omit");
    const addIss = () => {
      if (issMode === "normal") cb.searchParams.append("iss", issuerOf(p));
      if (issMode === "wrong") cb.searchParams.append("iss", `${origin}/other`);
    };
    if (action.deny) {
      cb.searchParams.append("error", action.error ?? "access_denied");
      cb.searchParams.append("state", one("state")!);
      addIss();
      return send(res, 302, "", { location: cb.href });
    }
    const code = randomToken();
    const subject = action.subject ?? `mock-${p}-sub-${++seq}-${randomToken(6)}`;
    codes.set(code, {
      provider: p,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      codeChallenge: challenge,
      nonce: one("nonce")!,
      subject,
      expiresAt: Date.now() + (faults.codeTtlMs ?? 60_000),
      used: false,
    });
    issued.push(code, subject);
    cb.searchParams.append("code", code);
    cb.searchParams.append("state", one("state")!);
    addIss();
    send(res, 302, "", { location: cb.href, "x-mock-subject": encodeURIComponent(subject) });
  }

  async function handleToken(p: MockProviderId, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(req));
    // ---- 여기부터 응답까지 await 없음: code 판정·소비가 동시 요청 사이에서 원자적이다.
    const params = Object.fromEntries(body.entries());
    const record: TokenRecord = { provider: p, authMethod: "none", params, outcome: "ok" };
    tokenRequests.push(record);
    const out = (status: number, outcome: TokenOutcome, error: string) => {
      record.outcome = outcome;
      fail(res, status, error);
    };
    if (faults.token === "server_error") return out(500, "server_error", "server_error");
    if (body.get("grant_type") !== "authorization_code") return out(400, "unsupported_grant_type", "unsupported_grant_type");

    let clientId = body.get("client_id") ?? undefined;
    let secret = body.get("client_secret") ?? undefined;
    const authz = req.headers.authorization;
    if (authz?.startsWith("Basic ")) {
      if (p !== "google") return out(401, "basic_not_allowed", "invalid_client");
      const [id, pw] = Buffer.from(authz.slice(6), "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(id ?? "");
      secret = decodeURIComponent(pw ?? "");
      record.authMethod = "basic";
    } else if (secret !== undefined) {
      record.authMethod = "post";
    }
    const client = clients.find((c) => c.provider === p && c.clientId === clientId);
    if (!client || secret === undefined || secret !== client.clientSecret) return out(401, "invalid_client", "invalid_client");

    const code = body.get("code") ?? "";
    const entry = codes.get(code);
    if (!entry || entry.provider !== p) return out(400, "unknown_code", "invalid_grant");
    if (entry.used && !faults.allowCodeReuse) return out(400, "code_reused", "invalid_grant");
    entry.used = true;
    if (Date.now() >= entry.expiresAt) return out(400, "code_expired", "invalid_grant");
    if (entry.clientId !== client.clientId) return out(400, "client_mismatch", "invalid_grant");
    if (body.get("redirect_uri") !== entry.redirectUri) return out(400, "redirect_mismatch", "invalid_grant");
    const verifier = body.get("code_verifier");
    if (verifier === null || verifier === "") return out(400, "pkce_missing", "invalid_grant");
    if (s256(verifier) !== entry.codeChallenge) return out(400, "pkce_mismatch", "invalid_grant");

    const now = Math.floor(Date.now() / 1000);
    const f = faults.idToken;
    const claims: Record<string, unknown> = {
      iss: f === "iss" ? `${origin}/other` : issuerOf(p),
      sub: entry.subject,
      aud: f === "aud" ? `${client.clientId}-other` : client.clientId,
      iat: f === "exp_past" ? now - 7200 : now,
      exp: f === "exp_past" ? now - 3600 : now + 300,
      nonce: f === "nonce" ? `${entry.nonce}x` : entry.nonce,
    };
    const accessToken = `mock-access-${randomToken()}`;
    const idToken = f === "missing" ? undefined : makeIdToken(claims, f, client.clientSecret);
    record.issued = { accessToken, idToken, subject: entry.subject };
    issued.push(accessToken, ...(idToken ? [idToken] : []));
    send(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid",
      ...(idToken ? { id_token: idToken } : {}),
    });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = /^\/(google|kakao)(\/.*)$/.exec(url.pathname);
    if (!m) return send(res, 404, "mock: not found");
    const p = m[1] as MockProviderId;
    const rest = m[2];
    if (rest === "/.well-known/openid-configuration" && req.method === "GET") {
      discoveryRequests.push(p);
      if (faults.discovery === "error") return send(res, 503, `${RAW_VENDOR_ERROR_MARKER}:discovery`);
      return send(res, 200, discoveryDoc(p));
    }
    if (rest === "/jwks" && req.method === "GET") {
      jwksRequests.push(p);
      return send(res, 200, { keys: [mockPublicJwk()] });
    }
    if (rest === "/authorize" && req.method === "GET") return handleAuthorize(p, url, res);
    if (rest === "/token" && req.method === "POST") {
      handleToken(p, req, res).catch(() => send(res, 500, "mock: token handler failed"));
      return;
    }
    send(res, 404, "mock: not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  let closed = false;

  const mock: MockIssuer = {
    origin,
    port,
    issuer: issuerOf,
    endpoint: (p, name) => `${issuerOf(p)}/${name}`,
    faults,
    authorizeRequests,
    tokenRequests,
    discoveryRequests,
    jwksRequests,
    async authorize(url, o = {}) {
      pending = o;
      const res = await fetch(url, { redirect: "manual" });
      await res.text();
      pending = {};
      const loc = res.headers.get("location");
      if (res.status !== 302 || loc === null) throw new Error(`mock authorize did not redirect (status ${res.status})`);
      const callback = new URL(loc);
      const subjectHeader = res.headers.get("x-mock-subject");
      return {
        status: res.status,
        callback,
        query: new URLSearchParams(callback.search),
        code: callback.searchParams.get("code") ?? undefined,
        subject: subjectHeader === null ? (o.subject ?? "") : decodeURIComponent(subjectHeader),
      };
    },
    secrets: () => [...issued, ...clients.map((c) => c.clientSecret), RAW_VENDOR_ERROR_MARKER],
    async close() {
      if (closed) return;
      closed = true;
      openIssuers.delete(mock);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  openIssuers.add(mock);
  return mock;
}

/** 열린 mock issuer를 모두 닫는다(afterAll 안전망). */
export async function closeAllMockIssuers(): Promise<void> {
  await Promise.all([...openIssuers].map((m) => m.close()));
}

/** 사례 안에서 mock을 띄우고 성공·실패와 무관하게 닫는다. */
export async function withMockIssuer<T>(opts: StartMockOptions, fn: (mock: MockIssuer) => Promise<T>): Promise<T> {
  const mock = await startMockIssuer(opts);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

// ---------------------------------------------------------------- 로그 capture

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** console 출력을 실제로 가로채 문자열로 모은다. restore 전까지 원래 출력으로 보내지 않는다. */
export function captureConsole(): { text(): string; restore(): void } {
  const lines: string[] = [];
  const originals = CONSOLE_METHODS.map((m) => [m, console[m]] as const);
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]) => {
      // inspect는 Error의 cause·URLSearchParams·중첩 객체 내용까지 펼친다(JSON.stringify가 숨기는 값 포함).
      for (const a of args) lines.push(typeof a === "string" ? a : inspect(a, { depth: 10, breakLength: Infinity }));
    };
  }
  return {
    text: () => lines.join("\n"),
    restore: () => {
      for (const [m, fn] of originals) console[m] = fn;
    },
  };
}
