"use client";

import { useRef, useState, type FormEvent } from "react";
import { AUTH_TEXT, PROVIDER_BUTTONS } from "@/shared/auth-messages";

type Provider = keyof typeof PROVIDER_BUTTONS;

/** 이동 중 상태를 그리고 알린 뒤 실제 제출까지 두는 짧은 간격(ms). aria-live 문구가 문서가 바뀌기 전에 전달되게 한다. */
const ANNOUNCE_BEFORE_SUBMIT_MS = 300;

/**
 * D 로그인 화면의 공급자 버튼(공식 에셋 그대로, D 인증 아트보드). 각 버튼은 POST /auth/{p}/start form이다.
 * JS가 없으면 그대로 native POST(303)다. JS가 있으면 첫 제출을 잠시 붙잡아 모든 버튼을 aria-disabled로 바꾸고
 * 버튼 밖 상태 문구 "이동 중…"을 보인 다음, 같은 form을 native로 제출한다(form.submit: 제출 이벤트를 다시 내지 않는다).
 * 그 사이와 그 뒤의 다른 제출은 막는다. 공급자 레이블·로고·색은 바꾸지 않는다.
 */
export function AuthProviderForms({ providers, returnTo }: { providers: readonly Provider[]; returnTo: string }) {
  const busy = useRef(false);
  const [moving, setMoving] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setMoving(true);
    const form = e.currentTarget;
    window.setTimeout(() => form.submit(), ANNOUNCE_BEFORE_SUBMIT_MS);
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
