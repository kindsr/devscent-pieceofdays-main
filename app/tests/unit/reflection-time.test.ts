// PLAN_reflection-time-settings §2: 미구현은 import 오류 대신 공개 함수 단언으로 RED가 된다.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "./auth-b1-support";

const MODULE = path.join(APP_DIR, "src", "shared", "reflection-time.ts");
type ReflectionTime = { DEFAULT_REFLECTION_TIME: string; parseReflectionTime: (input: unknown) => string | null };

async function loadTime(): Promise<ReflectionTime> {
  let mod: Record<string, unknown> = {};
  try {
    mod = await import(/* @vite-ignore */ MODULE);
  } catch (err) {
    if (existsSync(MODULE)) throw err;
  }
  expect(typeof mod.parseReflectionTime, "shared/reflection-time.ts must export function parseReflectionTime").toBe("function");
  return mod as unknown as ReflectionTime;
}

describe("account reflection wall-clock time", () => {
  it("defaults to 20:00 (8pm)", async () => {
    expect((await loadTime()).DEFAULT_REFLECTION_TIME).toBe("20:00");
  });

  it("accepts every ASCII HH:mm minute from 00:00 through 23:59 unchanged", async () => {
    const { parseReflectionTime } = await loadTime();
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        expect(parseReflectionTime(time), time).toBe(time);
      }
    }
  });

  it("rejects out-of-range, padded, partial, seconds, Unicode and non-string inputs without coercion", async () => {
    const { parseReflectionTime } = await loadTime();
    const invalid: unknown[] = [
      "", "24:00", "23:60", "00:60", "99:99", "-1:00", "0:00", "20:0", "2000", "20.00",
      " 20:00", "20:00 ", "20:00\n", "20:00\r\n", "\t20:00", "20:00:00", "２０:００", "20：00", "20:00\0",
      undefined, null, 2000, Number.NaN, false, {}, ["20:00"], { toString: () => "20:00" },
    ];
    for (const value of invalid) expect(parseReflectionTime(value), String(value)).toBeNull();
  });
});
