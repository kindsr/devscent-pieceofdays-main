// F4 B1 RED 시험 전용 보조(PLAN_mvp-oidc-integration §4·§5·§9 U1a~U4). 제품 기능을 대신 구현하지 않는다.
// - 신규 제품 모듈은 각 it 안에서 절대경로로 동적 import하고 named export 존재를 단언한다(정적 import TS2307/TS2305 없음).
// - SessionConfig는 plain readonly 객체라 시험이 직접 만든다(§9 "시험 이음새"). 키·URL·ID는 모두 가짜 값이다.
// - raw iron TTL은 별도 child 프로세스에서만 가짜 Date.now로 관찰한다(메인 프로세스 시계·환경은 바꾸지 않는다).
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealData } from "iron-session";
import { expect } from "vitest";

export const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(APP_DIR, "src", "server");
export const RUNTIME_MODE_MODULE = path.join(SRC, "runtime-mode.ts");
export const AUTH_CONFIG_MODULE = path.join(SRC, "auth", "config.ts");
export const FLOW_COOKIE_MODULE = path.join(SRC, "auth", "flow-cookie.ts");
export const RECOVERY_COOKIE_MODULE = path.join(SRC, "auth", "recovery-cookie.ts");
export const RETURN_TO_MODULE = path.join(SRC, "auth", "return-to.ts");
export const SESSION_MODULE = path.join(SRC, "auth", "session.ts");
export const NOOP_MODULE = path.join(APP_DIR, "tests", "server-only-noop.ts");

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
export type SessionConfig = Readonly<{
  secrets: Readonly<Record<number, string>>;
  baseUrl: URL;
  secureCookies: boolean;
  now: () => Date;
}>;
export type CookieOptions = { name: string; httpOnly: boolean; secure: boolean; sameSite: string; path: string; expires: Date };

/** 모듈을 동적으로 불러와 이름 붙은 export가 있는지 단언한다. kinds는 export별 typeof 기대값. */
export async function loadModule<T>(file: string, kinds: Record<string, string>): Promise<T> {
  const rel = path.relative(APP_DIR, file);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`F4 B1 product module ${rel} could not be loaded (expected before GREEN): ${msg}`);
  }
  for (const [name, kind] of Object.entries(kinds)) {
    expect(typeof mod[name], `${rel} must export ${kind} ${name}`).toBe(kind);
  }
  return mod as unknown as T;
}

// ---------------------------------------------------------------- 가짜 값

export const key = (n: number) => `ci-only-b1-key-${n}-`.padEnd(40, "x"); // 40자, 가짜
export const USER = "0190f3a2-7c1e-7d4b-9a01-0123456789ab";
export const BASE = "https://pieceofdays.example";
export const DEV_BASE = "http://127.0.0.1:3300";
export const SEVEN_DAYS_MS = 604_800_000;
export const TEN_MIN_MS = 600_000;

/** 실제 현재 시각(초 단위 내림). iron 자체 TTL이 시험 도중 지나지 않게 실제 시각 근처를 쓴다. */
export const realNow = () => Math.floor(Date.now() / 1000) * 1000;

/** 시험용 SessionConfig(plain 객체). */
export function cfgOf(opts: { secrets?: Record<number, string>; base?: string; now?: number } = {}): SessionConfig {
  const baseUrl = new URL(opts.base ?? BASE);
  const t = opts.now ?? realNow();
  return Object.freeze({
    secrets: Object.freeze(opts.secrets ?? { 1: key(1) }),
    baseUrl,
    secureCookies: baseUrl.protocol === "https:",
    now: () => new Date(t),
  });
}

export const at = (cfg: SessionConfig, ms: number): SessionConfig => ({ ...cfg, now: () => new Date(ms) });

/** 같은 키 맵으로 실제 iron을 써서 임의 payload를 정상 봉인한다(내용만 계약 밖일 수 있다). */
export const forge = (cfg: SessionConfig, payload: unknown, ttl = 600) =>
  sealData(payload, { password: cfg.secrets as unknown as Record<string, string>, ttl });

/** 인증 영역 가운데 한 글자를 바꾼다(iron이 무시하는 끝 메타데이터를 건드리지 않는다). */
export function tamper(value: string): string {
  const mid = Math.floor(value.length / 2);
  return value.slice(0, mid) + (value[mid] === "a" ? "b" : "a") + value.slice(mid + 1);
}

export const INVALID = { ok: false, error: "invalid" };
export const EXPIRED = { ok: false, error: "expired" };
export const MISSING = { ok: false, error: "missing" };

// ---------------------------------------------------------------- child: iron 자체 TTL 관찰

export type RawTtlChildInput = {
  module: string;
  sealExport: string;
  readExport: string;
  /** seal 함수의 두 번째 인자(JSON). */
  sealArg: unknown;
  t0: number;
  /** 앱 시계(cfg.now). raw TTL 사례에서도 앱 기준 exp 전이다. */
  appLaterMs: number;
  /** 양성 대조: iron 시계가 이 시각일 때는 ok여야 한다. */
  rawWithinMs: number;
  /** iron 시계가 이 시각이면 iron 자체 TTL(+skew)이 지나 invalid여야 한다. */
  rawPassedMs: number;
};
export type RawTtlChildOut = { withinTtl?: unknown; rawTtlPassed?: unknown; error?: string; stderr?: string };

/**
 * 별도 Node 프로세스에서 Date.now만 가짜로 바꿔 iron 자체 TTL을 관찰한다.
 * 제품 모듈은 Node 자체 TS 실행으로 읽고, `server-only`·`@/`·확장자 없는 상대 경로만 resolve hook으로 맞춘다.
 */
export function runRawTtlChild(input: RawTtlChildInput): Promise<RawTtlChildOut> {
  const script = `
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const I = JSON.parse(process.env.POD_B1_CHILD_INPUT);
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: pathToFileURL(I.noop).href, shortCircuit: true };
    let target = null;
    if (specifier.startsWith("@/")) target = path.join(I.appDir, "src", specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:"))
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (target) for (const c of [target, target + ".ts", target + ".tsx", path.join(target, "index.ts")])
      if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
    return next(specifier, context);
  },
});
let fake = I.t0;
Date.now = () => fake;
try {
  const m = await import(pathToFileURL(I.module).href);
  const cfg = { secrets: { 1: I.key }, baseUrl: new URL(I.base), secureCookies: true, now: () => new Date(I.t0) };
  const sealed = await m[I.sealExport](cfg, I.sealArg);
  const appLater = { ...cfg, now: () => new Date(I.appLaterMs) };
  fake = I.rawWithinMs;
  const withinTtl = await m[I.readExport](appLater, sealed.value);
  fake = I.rawPassedMs;
  const rawTtlPassed = await m[I.readExport](appLater, sealed.value);
  process.stdout.write("POD_B1_CHILD=" + JSON.stringify({ withinTtl, rawTtlPassed }) + "\\n");
} catch (err) {
  process.stdout.write("POD_B1_CHILD=" + JSON.stringify({ error: String((err && err.stack) || err) }) + "\\n");
}
`;
  const payload = JSON.stringify({ ...input, appDir: APP_DIR, noop: NOOP_MODULE, key: key(1), base: BASE });
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: APP_DIR,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POD_B1_CHILD_INPUT: payload },
        timeout: 60_000,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith("POD_B1_CHILD="));
        if (!line) {
          resolve({ error: `no child result (${err ? String(err.message) : "exit 0"})`, stderr });
          return;
        }
        resolve({ ...(JSON.parse(line.slice("POD_B1_CHILD=".length)) as RawTtlChildOut), stderr });
      },
    );
  });
}
