import { describe, expect, it } from "vitest";
import { assertFixtureModeAllowed, isFixtureModeEnabled } from "@/server/runtime-mode";

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
