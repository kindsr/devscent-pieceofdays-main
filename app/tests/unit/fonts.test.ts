import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_KEY, FONT_KEYS, parseFontKey } from "@/shared/fonts";

// 기록 글꼴은 허용 목록(고딕 기본/명조/손글씨)만 받는다. 목록 밖 값은 거부한다.
describe("parseFontKey", () => {
  it("accepts exactly the D handoff allowlist", () => {
    expect([...FONT_KEYS]).toEqual(["gothic", "serif", "hand"]);
    for (const k of FONT_KEYS) expect(parseFontKey(k)).toBe(k);
  });

  it("defaults to gothic", () => {
    expect(DEFAULT_FONT_KEY).toBe("gothic");
  });

  it("rejects keys outside the allowlist, including near misses and prototype keys", () => {
    for (const v of ["Gothic", " serif", "mono", "", "__proto__", "constructor", "toString", "hand;"]) {
      expect(parseFontKey(v)).toBeNull();
    }
  });

  it("rejects non-string input", () => {
    for (const v of [null, undefined, 1, {}, ["gothic"]]) expect(parseFontKey(v)).toBeNull();
  });
});
