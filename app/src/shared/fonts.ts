/** 기록 글꼴 허용 목록(디자인 핸드오프 §4). 기록 본문에만 적용한다. */
export const FONT_KEYS = ["gothic", "serif", "hand"] as const;
export type FontKey = (typeof FONT_KEYS)[number];
export const DEFAULT_FONT_KEY: FontKey = "gothic";

export const FONT_LABELS: Record<FontKey, { name: string; desc: string }> = {
  gothic: { name: "고딕", desc: "기본 · D 화면과 같은 글꼴" },
  serif: { name: "명조", desc: "책처럼 차분하게" },
  hand: { name: "손글씨", desc: "손글씨 글꼴이 없는 기기는 고딕으로 보여요" },
};

export function parseFontKey(value: unknown): FontKey | null {
  return typeof value === "string" && (FONT_KEYS as readonly string[]).includes(value) ? (value as FontKey) : null;
}
