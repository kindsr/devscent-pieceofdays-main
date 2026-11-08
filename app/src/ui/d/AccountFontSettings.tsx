"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { setFontAction, type ActionError } from "@/app/actions/diary";
import { DEFAULT_FONT_KEY, FONT_KEYS, FONT_LABELS, type FontKey } from "@/shared/fonts";

/** 계정 글꼴은 서버 성공 뒤에만 선택과 DOM을 바꾼다. */
export function AccountFontSettings({ initialFont }: { initialFont: FontKey }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [live, setLive] = useState("");
  const [error, setError] = useState<ActionError | null>(null);

  useEffect(() => {
    if (!pending) busy.current = false;
  }, [pending]);

  function choose(key: FontKey) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setLive("");
    startTransition(async () => {
      try {
        const result = await setFontAction(key);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (result.value === DEFAULT_FONT_KEY) document.documentElement.removeAttribute("data-record-font");
        else document.documentElement.setAttribute("data-record-font", result.value);
        setLive("기록 글꼴을 저장했어요.");
        startTransition(() => router.refresh());
      } catch {
        setError("unavailable");
      }
    });
  }

  const message = error === "not_signed_in" ? "다시 로그인해 주세요. 쓰던 글은 그대로 두었어요."
    : error === "forbidden" ? "요청을 확인할 수 없어요. 화면을 다시 열고 시도해 주세요."
    : error === "invalid_font" ? "글꼴을 다시 골라 주세요."
    : error === "not_found" ? "기록을 찾을 수 없어요. 다시 불러와 주세요."
    : "저장을 확인하지 못했어요. 쓰던 글은 그대로 두었어요. 다시 불러와 확인해 주세요.";

  return (
    <section className="settings" aria-labelledby="font-h">
      <h2 id="font-h">기록 글꼴</h2>
      <p className="hint">조각 글·하루 한 줄·쓰는 칸에만 적용돼요. 메뉴·버튼·제목 글꼴과 화면 배치는 그대로예요.</p>
      <fieldset className="font-pick" disabled={pending}>
        <legend className="sr-only">기록 글꼴 고르기</legend>
        {FONT_KEYS.map((k) => (
          <label className="font-opt" key={k}>
            <input type="radio" name="record-font" value={k} checked={initialFont === k} onChange={() => choose(k)} />
            <span className="font-name">{FONT_LABELS[k].name}</span>
            <span className="font-desc">{FONT_LABELS[k].desc}</span>
            <span className="font-eg" data-f={k} aria-hidden="true">가나다 하루의 조각</span>
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
        <button className="btn-ghost" type="button" disabled={pending} onClick={() => choose(DEFAULT_FONT_KEY)}>기본값(고딕)으로 되돌리기</button>
        <Link className="text-btn" href="/">오늘로 돌아가기</Link>
      </div>
      <p className="hint">계정에 저장돼 다른 기기에서도 같은 글꼴로 보여요.</p>
      {error ? (
        <div className="diary-error">
          <p className="err" role="alert">{message}</p>
          {error === "not_signed_in" ? <Link className="text-btn" href="/login?returnTo=%2Fsettings">로그인</Link> : (
            <button className="text-btn" type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>다시 불러오기</button>
          )}
        </div>
      ) : null}
      <p role="status" aria-live="polite">{pending ? "저장 중…" : live}</p>
    </section>
  );
}
