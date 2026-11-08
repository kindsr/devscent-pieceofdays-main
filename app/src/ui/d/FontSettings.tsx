"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DEFAULT_FONT_KEY, FONT_KEYS, FONT_LABELS, parseFontKey, type FontKey } from "@/shared/fonts";
import { AccountFontSettings } from "./AccountFontSettings";

/** D 설정 · 기록 글꼴. F1: 이 화면 메모리(html 속성)에만 적용한다. 계정 저장은 F3 이후. */
function applyFont(key: FontKey) {
  if (key === DEFAULT_FONT_KEY) document.documentElement.removeAttribute("data-record-font");
  else document.documentElement.setAttribute("data-record-font", key);
}

export function FontSettings({ mode = "fixture", initialFont = DEFAULT_FONT_KEY }: { mode?: "fixture" | "account"; initialFont?: FontKey }) {
  return mode === "account" ? <AccountFontSettings initialFont={initialFont} /> : <FixtureFontSettings />;
}

function FixtureFontSettings() {
  const [font, setFont] = useState<FontKey>(DEFAULT_FONT_KEY);
  const [live, setLive] = useState("");

  useEffect(() => {
    // 같은 탭에서 이미 바꾼 값(클라이언트 이동 동안 유지되는 html 속성)을 읽는다. 허용 목록 밖 값은 기본으로 본다.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 외부(DOM) 값과 한 번 동기화
    setFont(parseFontKey(document.documentElement.getAttribute("data-record-font")) ?? DEFAULT_FONT_KEY);
  }, []);

  function choose(value: string, reset = false) {
    const key = parseFontKey(value);
    if (!key) return;
    setFont(key);
    applyFont(key);
    setLive(
      reset
        ? "기록 글꼴을 기본값 고딕으로 되돌렸어요."
        : `기록 글꼴을 ${FONT_LABELS[key].name}(으)로 바꿨어요. 이 화면 메모리에만 유지되고 새로고침하면 고딕으로 돌아갑니다.`,
    );
  }

  return (
    <section className="settings" aria-labelledby="font-h">
      <h2 id="font-h">기록 글꼴</h2>
      <p className="hint">조각 글·하루 한 줄·쓰는 칸에만 적용돼요. 메뉴·버튼·제목 글꼴과 화면 배치는 그대로예요.</p>
      <fieldset className="font-pick">
        <legend className="sr-only">기록 글꼴 고르기</legend>
        {FONT_KEYS.map((k) => (
          <label className="font-opt" key={k}>
            <input type="radio" name="record-font" value={k} checked={font === k} onChange={(e) => choose(e.target.value)} />
            <span className="font-name">{FONT_LABELS[k].name}</span>
            <span className="font-desc">{FONT_LABELS[k].desc}</span>
            <span className="font-eg" data-f={k} aria-hidden="true">
              가나다 하루의 조각
            </span>
          </label>
        ))}
      </fieldset>
      <div className="font-preview">
        <p className="lbl">미리보기</p>
        <div className="note y sample">
          <time className="hand">12:15</time>
          <p>동네 국숫집 줄이 생각보다 짧았다. 멸치 국물 한 그릇에 몸이 풀렸다.</p>
        </div>
      </div>
      <div className="row">
        <button className="btn-ghost" type="button" onClick={() => choose(DEFAULT_FONT_KEY, true)}>
          기본값(고딕)으로 되돌리기
        </button>
        <Link className="text-btn" href="/">
          오늘로 돌아가기
        </Link>
      </div>
      <p className="hint">앱 골격이라 이 화면 메모리에만 유지돼요. 새로고침하면 고딕으로 돌아가고 기기·계정에 저장되지 않아요.</p>
      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </section>
  );
}
