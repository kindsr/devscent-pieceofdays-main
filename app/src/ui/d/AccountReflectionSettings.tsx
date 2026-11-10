"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { setReflectionTimeAction, type ActionError } from "@/app/actions/diary";
import { parseReflectionTime } from "@/shared/reflection-time";

export function AccountReflectionSettings({ initialTime }: { initialTime: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initialTime);
  const [loadedTime, setLoadedTime] = useState(initialTime);
  const [live, setLive] = useState("");
  const [error, setError] = useState<ActionError | null>(null);

  // 서버 재조회로 바뀐 값은 반영하되, 사용자가 수정 중인 초안은 보존한다.
  if (loadedTime !== initialTime) {
    setLoadedTime(initialTime);
    if (draft === loadedTime) setDraft(initialTime);
  }

  useEffect(() => {
    if (!pending) busy.current = false;
  }, [pending]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    setError(null);
    setLive("");
    const time = parseReflectionTime(draft);
    if (time === null) {
      setError("invalid_reflection_time");
      input.current?.focus();
      return;
    }
    busy.current = true;
    startTransition(async () => {
      try {
        const result = await setReflectionTimeAction(time);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setDraft(result.value);
        setLive("회고 시간을 저장했어요.");
        startTransition(() => router.refresh());
      } catch {
        setError("unavailable");
      }
    });
  }

  const message = error === "not_signed_in" ? "다시 로그인해 주세요. 고르던 시간은 그대로 두었어요."
    : error === "forbidden" ? "요청을 확인할 수 없어요. 화면을 다시 열고 시도해 주세요."
    : error === "invalid_reflection_time" ? "회고할 시간을 시와 분으로 골라 주세요."
    : "저장을 확인하지 못했어요. 고르던 시간은 그대로 두었어요. 잠시 뒤 다시 저장해 주세요.";

  return (
    <section className="settings reflection-settings" aria-labelledby="reflection-h">
      <h2 id="reflection-h">회고 시간</h2>
      <p className="hint">하루를 돌아볼 시간을 골라 주세요.</p>
      <form onSubmit={save}>
        <label htmlFor="reflection-time">매일 회고할 시간</label>
        <div className="row">
          <input
            ref={input}
            id="reflection-time"
            name="reflection-time"
            type="time"
            step="60"
            required
            value={draft}
            disabled={pending}
            aria-invalid={error === "invalid_reflection_time" || undefined}
            aria-describedby={`reflection-hint${error ? " reflection-error" : ""}`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
              setLive("");
            }}
          />
          <button className="btn-ghost" type="submit" disabled={pending}>저장</button>
        </div>
        <p className="hint" id="reflection-hint">한국 시간(Asia/Seoul) 기준 · 기본 저녁 8시</p>
      </form>
      <p className="hint">계정에 저장되어 PC와 휴대폰에서 같은 시간으로 보여요.</p>
      {error ? (
        <div className="diary-error">
          <p className="err" id="reflection-error" role="alert">{message}</p>
          {error === "not_signed_in" ? <Link className="text-btn" href="/login?returnTo=%2Fsettings">로그인</Link> : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite">{pending ? "저장 중…" : live}</p>
    </section>
  );
}
