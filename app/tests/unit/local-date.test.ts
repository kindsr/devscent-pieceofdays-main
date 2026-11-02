import { describe, expect, it } from "vitest";
import { parseLocalDate } from "@/shared/local-date";

// URL 경로의 날짜(/days/[date])는 실제 달력 날짜인 YYYY-MM-DD만 받는다.
describe("parseLocalDate", () => {
  it("accepts real calendar dates", () => {
    expect(parseLocalDate("2026-11-02")).toBe("2026-11-02");
    expect(parseLocalDate("2028-02-29")).toBe("2028-02-29");
  });

  it("rejects impossible dates", () => {
    for (const v of ["2026-11-31", "2026-02-29", "2026-13-01", "2026-00-10", "2026-11-00"]) {
      expect(parseLocalDate(v)).toBeNull();
    }
  });

  it("rejects other shapes", () => {
    for (const v of ["2026-1-2", "20261102", "2026-11-02T00:00", " 2026-11-02", "../2026-11-02", "", "0000-01-01"]) {
      expect(parseLocalDate(v)).toBeNull();
    }
  });
});
