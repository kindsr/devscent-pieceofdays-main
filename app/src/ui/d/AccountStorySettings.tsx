"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { saveStorySettingsAction, type StorySettingsError } from "@/app/actions/story";

/*
 * AI 하루 이야기 동의(PLAN_ai-story-live-generation §5). 수동·자동은 따로 명시 동의하며 둘 다 기본 꺼짐이다.
 * 저장할 때마다 서버의 동의 epoch가 바뀌어, 저장 전에 만든 요청은 보내거나 저장하지 않는다.
 */
export function AccountStorySettings({ initialManual, initialAuto, reflectionTime }: {
  initialManual: boolean;
  initialAuto: boolean;
  reflectionTime: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [manual, setManual] = useState(initialManual);
  const [auto, setAuto] = useState(initialAuto);
  const [live, setLive] = useState("");
  const [error, setError] = useState<StorySettingsError | null>(null);

  useEffect(() => {
    if (!pending) busy.current = false;
  }, [pending]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setLive("");
    startTransition(async () => {
      try {
        const result = await saveStorySettingsAction({ manual, auto });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setManual(result.value.manualEnabled);
        setAuto(result.value.autoEnabled);
        setLive("AI 이야기 설정을 저장했어요.");
        startTransition(() => router.refresh());
      } catch {
        setError("unavailable");
      }
    });
  }

  const message = error === "not_signed_in" ? "다시 로그인해 주세요. 고르던 설정은 그대로 두었어요."
    : error === "forbidden" ? "요청을 확인할 수 없어요. 화면을 다시 열고 시도해 주세요."
    : "저장을 확인하지 못했어요. 고르던 설정은 그대로 두었어요. 잠시 뒤 다시 저장해 주세요.";

  return (
    <section className="settings" id="story-ai" aria-labelledby="story-ai-h">
      <h2 id="story-ai-h">AI 하루 이야기</h2>
      <p className="hint" id="story-ai-notice">
        켜면 그날의 메모 원문과 사진을 512px로 줄인 사본이 이야기를 만들기 위해 Anthropic의 Claude API로 전송돼요.
        끄면 그 뒤로는 새로 보내지 않지만, 이미 보낸 자료는 회수할 수 없어요.
      </p>
      <form onSubmit={save}>
        <label className="auth-check">
          <input
            type="checkbox"
            name="story-manual"
            checked={manual}
            disabled={pending}
            aria-describedby="story-ai-notice"
            onChange={(e) => { setManual(e.target.checked); setError(null); setLive(""); }}
          />
          직접 만들기 허용
        </label>
        <label className="auth-check">
          <input
            type="checkbox"
            name="story-auto"
            checked={auto}
            disabled={pending || reflectionTime === null}
            aria-describedby="story-ai-notice"
            onChange={(e) => { setAuto(e.target.checked); setError(null); setLive(""); }}
          />
          {`회고 시간(현재 ${reflectionTime ?? "--:--"})에 자동으로 만들기`}
        </label>
        <div className="row">
          <button className="btn-ghost" type="submit" disabled={pending}>저장</button>
        </div>
      </form>
      {error ? (
        <div className="diary-error">
          <p className="err" role="alert">{message}</p>
          {error === "not_signed_in" ? <Link className="text-btn" href="/login?returnTo=%2Fsettings">로그인</Link> : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite">{pending ? "저장 중…" : live}</p>
    </section>
  );
}
