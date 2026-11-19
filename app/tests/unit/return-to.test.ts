// F4 B1 RED — 로그인 뒤 이동 경로 허용 목록(PLAN_mvp-oidc-integration §5 표, §9 U4).
// 대상 app/src/server/auth/return-to.ts는 각 it 안에서 동적 import한다. 날짜 해석은 기존 parseLocalDate가 맡으므로
// 그 회귀를 다시 복제하지 않고 연결 경계 사례만 쓴다.
import { describe, expect, it } from "vitest";
import { RETURN_TO_MODULE, loadModule } from "./auth-b1-support";

type ReturnToApi = { parseReturnTo: (raw: unknown) => string | null };
const load = () => loadModule<ReturnToApi>(RETURN_TO_MODULE, { parseReturnTo: "function" });

describe("parseReturnTo", () => {
  it("returns allowed internal paths unchanged: /, /days, /settings and /days/<real YYYY-MM-DD>", async () => {
    const m = await load();
    for (const p of ["/", "/days", "/settings", "/days/2026-11-03", "/days/2028-02-29", "/days/2026-12-31"]) {
      expect(m.parseReturnTo(p), p).toBe(p);
    }
  });

  it("rejects auth/account/dev/login paths, protocol-relative or backslash paths and absolute URLs", async () => {
    const m = await load();
    for (const p of [
      "/login",
      "/auth",
      "/auth/google/callback",
      "/account",
      "/account/restore",
      "/dev",
      "/dev/konva-smoke",
      "//evil.example",
      "//evil.example/days",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example/",
      "http://pieceofdays.example/days",
      "javascript:alert(1)",
      "days",
      "",
      " /",
      "/ ",
    ]) {
      expect(m.parseReturnTo(p), JSON.stringify(p)).toBeNull();
    }
  });

  it("rejects invalid dates, trailing slashes, query/hash, percent-encoding, other casing and overlong strings", async () => {
    const m = await load();
    for (const p of [
      "/days/2026-02-30",
      "/days/2026-13-01",
      "/days/26-11-03",
      "/days/2026-11-3",
      "/days/",
      "/settings/",
      "/days/2026-11-03/",
      "/?x=1",
      "/days?x=1",
      "/days#top",
      "/settings#a",
      "/%64ays",
      "/days/2026%2D11-03",
      "/DAYS",
      "/Settings",
      `/days/2026-11-03${"x".repeat(60)}`,
      `/${"a".repeat(64)}`,
    ]) {
      expect(m.parseReturnTo(p), JSON.stringify(p.slice(0, 30))).toBeNull();
    }
  });

  it("returns null for non-string input", async () => {
    const m = await load();
    for (const v of [undefined, null, 1, true, ["/"], { path: "/" }, new String("/")]) {
      expect(m.parseReturnTo(v), String(v)).toBeNull();
    }
  });
});
