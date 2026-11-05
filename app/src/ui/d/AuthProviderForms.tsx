"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AUTH_TEXT, PROVIDER_BUTTONS } from "@/shared/auth-messages";

type Provider = keyof typeof PROVIDER_BUTTONS;

/**
 * D 로그인 화면의 공급자 버튼(공식 에셋 그대로, D 인증 아트보드). 각 버튼은 POST /auth/{p}/start form이다.
 * JS가 없으면 그대로 POST(303)한다. JS가 있으면 첫 제출 뒤 모든 버튼을 aria-disabled로 바꾸고 버튼 밖 상태 문구만 보이며,
 * 두 번째 제출은 막는다. 공급자 레이블·로고·색은 바꾸지 않는다.
 * 뒤로 가기로 bfcache에서 되살아난 화면은 이동 중 상태를 풀어 다시 고를 수 있게 한다.
 */
export function AuthProviderForms({ providers, returnTo }: { providers: readonly Provider[]; returnTo: string }) {
  const busy = useRef(false);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      busy.current = false;
      setMoving(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (busy.current) {
      e.preventDefault();
      return;
    }
    busy.current = true;
    setMoving(true);
  }

  return (
    <>
      <div className="auth-providers" role="group" aria-label={AUTH_TEXT.providersLabel}>
        {providers.map((p) => {
          const b = PROVIDER_BUTTONS[p];
          return (
            <form key={p} action={`/auth/${p}/start`} method="post" onSubmit={onSubmit}>
              <input type="hidden" name="returnTo" value={returnTo} />
              <button type="submit" className={`auth-pbtn auth-${p}`} aria-disabled={moving ? "true" : undefined}>
                {/* 공식 승인 에셋을 그대로 보인다(next/image 변환 없음). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={b.src} alt={b.alt} lang={b.lang} width={b.width} height={b.height} />
                {b.extra ? <span className="sr-only">{b.extra}</span> : null}
              </button>
            </form>
          );
        })}
      </div>
      <p className="auth-status" role="status" aria-live="polite">
        {moving ? AUTH_TEXT.moving : ""}
      </p>
    </>
  );
}
