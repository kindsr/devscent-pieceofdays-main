import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { assertFixtureModeAllowed, isFixtureModeEnabled } from "@/server/runtime-mode";
import { APP_DIR, RUNTIME_MODE_MODULE, loadModule } from "./auth-b1-support";

// 로컬·테스트 전용 고정 사용자(예시 데이터) 모드는 개발 환경 변수로만 켜지고, 운영 빌드·실행에서 켜져 있으면 거부한다.
const BUILD = "phase-production-build";
const SERVER = "phase-production-server";
const DEV = "phase-development-server";

describe("isFixtureModeEnabled", () => {
  it("is off when the flag is absent or empty", () => {
    expect(isFixtureModeEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isFixtureModeEnabled({ NODE_ENV: "development", POD_LOCAL_FIXTURE: "" })).toBe(false);
  });

  it("is on only for the exact value 1 in development or test", () => {
    expect(isFixtureModeEnabled({ NODE_ENV: "development", POD_LOCAL_FIXTURE: "1" })).toBe(true);
    expect(isFixtureModeEnabled({ NODE_ENV: "test", POD_LOCAL_FIXTURE: "1" })).toBe(true);
  });

  it("rejects ambiguous flag values instead of silently guessing", () => {
    for (const v of ["true", "yes", "0", " 1", "on"]) {
      expect(() => isFixtureModeEnabled({ NODE_ENV: "development", POD_LOCAL_FIXTURE: v })).toThrow(/POD_LOCAL_FIXTURE/);
    }
  });

  it("refuses to run with the flag on in a production runtime", () => {
    expect(() => isFixtureModeEnabled({ NODE_ENV: "production", POD_LOCAL_FIXTURE: "1" })).toThrow(/production/);
  });

  it("refuses when NODE_ENV is missing or unknown and the flag is on", () => {
    expect(() => isFixtureModeEnabled({ POD_LOCAL_FIXTURE: "1" })).toThrow();
    expect(() => isFixtureModeEnabled({ NODE_ENV: "staging", POD_LOCAL_FIXTURE: "1" })).toThrow();
  });

  it("stays off in production when the flag is absent", () => {
    expect(isFixtureModeEnabled({ NODE_ENV: "production" })).toBe(false);
  });
});

describe("assertFixtureModeAllowed (next.config phase guard)", () => {
  it("refuses production build and production server phases when the flag is on", () => {
    for (const phase of [BUILD, SERVER]) {
      expect(() => assertFixtureModeAllowed(phase, { NODE_ENV: "development", POD_LOCAL_FIXTURE: "1" })).toThrow(/production/);
    }
  });

  it("allows production phases when the flag is absent", () => {
    for (const phase of [BUILD, SERVER]) {
      expect(() => assertFixtureModeAllowed(phase, { NODE_ENV: "production" })).not.toThrow();
    }
  });

  it("allows the development server with the flag on", () => {
    expect(() => assertFixtureModeAllowed(DEV, { NODE_ENV: "development", POD_LOCAL_FIXTURE: "1" })).not.toThrow();
  });
});

// ================================================================ F4 B1 RED (PLAN_mvp-oidc-integration §4.2, §9 U1a)
// 새 export(authModeProblem·assertAuthModeAllowed)는 정적 import하지 않고 각 it 안에서 동적으로 읽는다(TS2305 방지).
// 위의 기존 9개 사례와 기대값은 바꾸지 않는다.
type ModeEnv = {
  readonly NODE_ENV?: string;
  readonly POD_LOCAL_FIXTURE?: string;
  readonly POD_AUTH_PROVIDERS?: string;
  readonly POD_AUTH_MOCK_OIDC_ISSUER?: string;
};
type AuthModeApi = {
  authModeProblem: (env: ModeEnv, nodeEnv: string | undefined) => "fixture_with_auth" | "mock_outside_dev" | null;
  assertAuthModeAllowed: (phase: string | null, env: ModeEnv) => void;
};
const loadAuthMode = () =>
  loadModule<AuthModeApi>(RUNTIME_MODE_MODULE, { authModeProblem: "function", assertAuthModeAllowed: "function" });

const EXPORT = "phase-export";
const MOCK = "http://127.0.0.1:4010";
const PRODUCTION_PHASES = [BUILD, SERVER, EXPORT];

describe("authModeProblem (§4.2 table, top to bottom)", () => {
  it("fixture exactly \"1\" + non-blank PROVIDERS (even malformed) → fixture_with_auth for every nodeEnv; it wins over MOCK", async () => {
    const m = await loadAuthMode();
    for (const nodeEnv of ["development", "test", "production", undefined, ""]) {
      for (const providers of ["google", "kakao,google", "Google", "naver", " google", "google,"]) {
        expect(m.authModeProblem({ POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: providers }, nodeEnv), `${providers} / ${nodeEnv}`).toBe(
          "fixture_with_auth",
        );
      }
      expect(
        m.authModeProblem({ POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google", POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, nodeEnv),
        `fixture beats mock / ${nodeEnv}`,
      ).toBe("fixture_with_auth");
    }
  });

  it("blank PROVIDERS or a fixture flag that is not \"1\" is not a conflict", async () => {
    const m = await loadAuthMode();
    for (const providers of [undefined, "", " ", "\t"]) {
      expect(m.authModeProblem({ POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: providers }, "development"), JSON.stringify(providers)).toBeNull();
    }
    for (const fixture of [undefined, ""]) {
      expect(m.authModeProblem({ POD_LOCAL_FIXTURE: fixture, POD_AUTH_PROVIDERS: "google" }, "development")).toBeNull();
    }
    expect(m.authModeProblem({}, "production")).toBeNull();
    expect(m.authModeProblem({ POD_AUTH_PROVIDERS: "google" }, "production")).toBeNull();
  });

  it("non-blank MOCK outside exactly development/test → mock_outside_dev; inside them → null (format is not checked here)", async () => {
    const m = await loadAuthMode();
    for (const nodeEnv of ["production", undefined, "", "staging", "Development", " test"]) {
      expect(m.authModeProblem({ POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, nodeEnv), String(nodeEnv)).toBe("mock_outside_dev");
      expect(m.authModeProblem({ POD_AUTH_MOCK_OIDC_ISSUER: "not a url" }, nodeEnv), `malformed / ${String(nodeEnv)}`).toBe(
        "mock_outside_dev",
      );
    }
    for (const nodeEnv of ["development", "test"]) {
      expect(m.authModeProblem({ POD_AUTH_MOCK_OIDC_ISSUER: MOCK, POD_AUTH_PROVIDERS: "google" }, nodeEnv)).toBeNull();
      expect(m.authModeProblem({ POD_AUTH_MOCK_OIDC_ISSUER: "not a url" }, nodeEnv)).toBeNull();
    }
    for (const blank of ["", " "]) expect(m.authModeProblem({ POD_AUTH_MOCK_OIDC_ISSUER: blank }, "production")).toBeNull();
    // fixture + blank PROVIDERS + MOCK(운영) → 2행
    expect(m.authModeProblem({ POD_LOCAL_FIXTURE: "1", POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, "production")).toBe("mock_outside_dev");
  });
});

describe("assertAuthModeAllowed (§4.2, every next.config phase and request time)", () => {
  it("fixture + PROVIDERS throws in every phase including null (request time)", async () => {
    const m = await loadAuthMode();
    const env = { NODE_ENV: "development", POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google" };
    for (const phase of [...PRODUCTION_PHASES, DEV, "phase-test", null]) {
      expect(() => m.assertAuthModeAllowed(phase, env), String(phase)).toThrow();
    }
  });

  it("production build/server/export with a non-blank MOCK throws regardless of NODE_ENV, PROVIDERS or session config", async () => {
    const m = await loadAuthMode();
    for (const phase of PRODUCTION_PHASES) {
      for (const env of [
        { POD_AUTH_MOCK_OIDC_ISSUER: MOCK },
        { NODE_ENV: "development", POD_AUTH_MOCK_OIDC_ISSUER: MOCK },
        { NODE_ENV: "test", POD_AUTH_MOCK_OIDC_ISSUER: MOCK, POD_AUTH_PROVIDERS: "google" },
        { NODE_ENV: "production", POD_AUTH_MOCK_OIDC_ISSUER: "garbage" },
      ]) {
        expect(() => m.assertAuthModeAllowed(phase, env), `${phase} ${JSON.stringify(env)}`).toThrow();
      }
    }
  });

  it("mock_outside_dev throws for any non-null phase; development/test dev server with MOCK passes; request time (null) does not throw for MOCK", async () => {
    const m = await loadAuthMode();
    expect(() => m.assertAuthModeAllowed(DEV, { NODE_ENV: "production", POD_AUTH_MOCK_OIDC_ISSUER: MOCK })).toThrow();
    expect(() => m.assertAuthModeAllowed(DEV, { POD_AUTH_MOCK_OIDC_ISSUER: MOCK })).toThrow();
    for (const nodeEnv of ["development", "test"]) {
      expect(() => m.assertAuthModeAllowed(DEV, { NODE_ENV: nodeEnv, POD_AUTH_MOCK_OIDC_ISSUER: MOCK, POD_AUTH_PROVIDERS: "google" })).not.toThrow();
    }
    expect(() => m.assertAuthModeAllowed(null, { NODE_ENV: "production", POD_AUTH_MOCK_OIDC_ISSUER: MOCK })).not.toThrow();
    // 평범한 운영·개발 설정은 통과
    for (const phase of [...PRODUCTION_PHASES, DEV, null]) {
      expect(() => m.assertAuthModeAllowed(phase, { NODE_ENV: "production", POD_AUTH_PROVIDERS: "google,kakao" }), String(phase)).not.toThrow();
      expect(() => m.assertAuthModeAllowed(phase, {}), String(phase)).not.toThrow();
    }
  });
});

describe("runtime-mode import graph stays pure Node (§4.2)", () => {
  // 양성 대조: 현재 코드에서도 이미 통과한다(기능 RED와 따로 센다).
  it("runtime-mode.ts does not import server-only, iron-session, pg or auth modules directly or transitively", () => {
    const seen = new Set<string>();
    const external: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
      for (const ref of info.importedFiles) {
        const spec = ref.fileName;
        let target: string | null = null;
        if (spec.startsWith("@/")) target = path.join(APP_DIR, "src", spec.slice(2));
        else if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
        if (target === null) {
          external.push(spec);
          continue;
        }
        const isFile = (c: string) => {
          try {
            return statSync(c).isFile();
          } catch {
            return false;
          }
        };
        const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(isFile);
        expect(resolved, `unresolved import ${spec} from ${path.relative(APP_DIR, file)}`).toBeDefined();
        expect(path.relative(APP_DIR, resolved!), "no auth module in the graph").not.toMatch(/^src[\\/]server[\\/]auth[\\/]/);
        visit(resolved!);
      }
    };
    visit(RUNTIME_MODE_MODULE);
    for (const spec of external) expect(spec, "forbidden external import").not.toMatch(/^(server-only|iron-session|pg)(\/|$)/);
  });
});

describe("next.config.ts calls the auth mode guard (§4.2: assertAuthModeAllowed after assertFixtureModeAllowed)", () => {
  type ConfigFn = (phase: string) => unknown;
  const loadNextConfig = async (): Promise<ConfigFn> => {
    const mod = (await import(/* @vite-ignore */ path.join(APP_DIR, "next.config.ts"))) as { default?: unknown };
    expect(typeof mod.default, "next.config.ts default export is a function").toBe("function");
    return mod.default as ConfigFn;
  };
  const CLEAR = { POD_LOCAL_FIXTURE: "", POD_AUTH_PROVIDERS: "", POD_AUTH_MOCK_OIDC_ISSUER: "" };
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    try {
      for (const [k, v] of Object.entries({ ...CLEAR, ...vars })) vi.stubEnv(k, v);
      await fn();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("refuses a production build with MOCK and a dev server with fixture + PROVIDERS; a plain dev server still returns the config", async () => {
    const config = await loadNextConfig();
    // 양성 대조(현재도 통과): 추가 플래그가 없으면 설정 객체를 돌려준다
    await withEnv({}, async () => {
      expect(config(DEV)).toMatchObject({ reactStrictMode: true });
    });
    await withEnv({ POD_AUTH_MOCK_OIDC_ISSUER: MOCK }, async () => {
      expect(() => config(BUILD), "production build + MOCK").toThrow();
    });
    await withEnv({ POD_LOCAL_FIXTURE: "1", POD_AUTH_PROVIDERS: "google" }, async () => {
      expect(() => config(DEV), "dev server + fixture + PROVIDERS").toThrow();
    });
  });
});
