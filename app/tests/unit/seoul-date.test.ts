// F3 slice ① RED — 서울 날짜·시각(PLAN_mvp-domain-storage §1, §5 seoul-date).
// seoulLocalDate(instant)·seoulTime(instant)는 기존 src/shared/local-date.ts의 새 export다.
// 정적 import는 TS2305를 내므로 각 it 안에서 절대경로를 동적 import하고 함수 존재를 먼저 단언한다.
// 계약 밖(Invalid Date 등) 동작은 추측해 시험하지 않는다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const LOCAL_DATE_MODULE = path.join(APP_DIR, "src", "shared", "local-date.ts");

type SeoulDate = {
  seoulLocalDate: (instant: Date) => string;
  seoulTime: (instant: Date) => string;
  parseLocalDate: (value: string) => string | null;
};

async function load(): Promise<SeoulDate> {
  const mod = (await import(/* @vite-ignore */ LOCAL_DATE_MODULE)) as Partial<SeoulDate>;
  // 기존 export(양성 제어)는 이미 있다.
  expect(typeof mod.parseLocalDate, "local-date.ts keeps parseLocalDate").toBe("function");
  expect(typeof mod.seoulLocalDate, "local-date.ts must export seoulLocalDate").toBe("function");
  expect(typeof mod.seoulTime, "local-date.ts must export seoulTime").toBe("function");
  return mod as SeoulDate;
}

const at = (iso: string) => new Date(iso);

describe("seoulLocalDate / seoulTime (IANA Asia/Seoul; UTC+9 since 1988, history before)", () => {
  it("midnight boundary: 14:59:59Z is the previous Seoul day, 15:00:00Z is the next", async () => {
    const { seoulLocalDate, seoulTime } = await load();
    expect(seoulLocalDate(at("2026-11-01T14:59:59Z"))).toBe("2026-11-01");
    expect(seoulTime(at("2026-11-01T14:59:59Z"))).toBe("23:59");
    expect(seoulLocalDate(at("2026-11-01T14:59:59.999Z"))).toBe("2026-11-01");
    expect(seoulLocalDate(at("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
    expect(seoulTime(at("2026-11-01T15:00:00Z"))).toBe("00:00");
  });

  it("month end and leap day", async () => {
    const { seoulLocalDate, parseLocalDate } = await load();
    const cases: [string, string][] = [
      ["2026-01-31T14:59:59Z", "2026-01-31"],
      ["2026-01-31T15:00:00Z", "2026-02-01"],
      ["2026-04-30T15:00:00Z", "2026-05-01"],
      ["2026-02-28T14:59:59Z", "2026-02-28"],
      ["2026-02-28T15:00:00Z", "2026-03-01"], // 평년: 2/29 없음
      ["2028-02-28T15:00:00Z", "2028-02-29"], // 윤년
      ["2028-02-29T14:59:59Z", "2028-02-29"],
      ["2028-02-29T15:00:00Z", "2028-03-01"],
    ];
    for (const [iso, want] of cases) {
      const got = seoulLocalDate(at(iso));
      expect(got, iso).toBe(want);
      expect(parseLocalDate(got), `${iso} → ${got} is a real YYYY-MM-DD`).toBe(got);
    }
  });

  it("year end", async () => {
    const { seoulLocalDate, seoulTime } = await load();
    expect(seoulLocalDate(at("2026-12-31T14:59:59Z"))).toBe("2026-12-31");
    expect(seoulLocalDate(at("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
    expect(seoulTime(at("2026-12-31T15:00:00Z"))).toBe("00:00");
    // UTC로는 이미 새해지만 서울은 그 이후다(UTC 새해 자정 = 서울 09:00).
    expect(seoulLocalDate(at("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
    expect(seoulTime(at("2027-01-01T00:00:00Z"))).toBe("09:00");
  });

  it("seoulTime is zero-padded 24h HH:MM with seconds dropped (not rounded)", async () => {
    const { seoulTime } = await load();
    const cases: [string, string][] = [
      ["2026-11-02T00:05:00Z", "09:05"],
      ["2026-11-02T00:00:59.999Z", "09:00"],
      ["2026-11-02T03:30:59Z", "12:30"],
      ["2026-11-02T04:07:00Z", "13:07"],
      ["2026-11-01T15:09:00Z", "00:09"],
      ["2026-11-01T23:59:00Z", "08:59"],
    ];
    for (const [iso, want] of cases) {
      const got = seoulTime(at(iso));
      expect(got, iso).toBe(want);
      expect(got).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });

  it("does not depend on the host process time zone", async () => {
    const { seoulLocalDate, seoulTime } = await load();
    const saved = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(seoulLocalDate(at("2026-11-01T14:59:59Z")), tz).toBe("2026-11-01");
        expect(seoulLocalDate(at("2026-11-01T15:00:00Z")), tz).toBe("2026-11-02");
        expect(seoulTime(at("2026-11-01T15:00:00Z")), tz).toBe("00:00");
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  // slice ② 보강(PLAN §5 ②): IANA tzdb Asia/Seoul 과거 이력. 고정 UTC+9로는 맞지 않는다.
  it("IANA history: 1988 Korean summer time (UTC+10) — 1988-08-01T14:30Z is 1988-08-02 00:30", async () => {
    const { seoulLocalDate, seoulTime } = await load();
    expect(seoulLocalDate(at("1988-08-01T14:30:00Z"))).toBe("1988-08-02");
    expect(seoulTime(at("1988-08-01T14:30:00Z"))).toBe("00:30");
  });

  it("IANA history: 1960 standard time UTC+8:30 — 1960-01-01T15:15Z is 1960-01-01 23:45", async () => {
    const { seoulLocalDate, seoulTime } = await load();
    expect(seoulLocalDate(at("1960-01-01T15:15:00Z"))).toBe("1960-01-01");
    expect(seoulTime(at("1960-01-01T15:15:00Z"))).toBe("23:45");
  });
});
