"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  STORY_MAX,
  type StoryEditActionError,
  type StoryEditActionResult,
  type StoryRegenerationActionError,
  type StoryRegenerationActionResult,
} from "@/shared/stories";

/*
 * AI 하루 이야기 직접 수정·재생성 확인(PLAN_story-edit-regenerate §3, docs/design/story §8). 서버 모듈을 import하지 않고
 * 페이지가 bind한 action을 props로만 받는다. 본문은 React text로만 렌더한다.
 * - 수정: 지금 본문 전체가 든 ‘이야기 내용’ textarea. 글자 수는 codepoint(UTF-16 maxLength로 자르지 않는다).
 *   저장 중 중복 0, 오류·충돌이면 입력을 그대로 두고 자동 새로고침·초안 폐기 0. 성공 때만 닫고 새로고침한다.
 * - 재생성: 명시 확인 단계 뒤 queued job 1건만 맡긴다. 성공 뒤에만 새로고침하고, 새 글을 저절로 보여 주는 연출은 없다.
 * - 편집·확인을 연 시점의 version(편집은 본문도)을 고정해 요청·같은 내용 판정에 쓴다. 그 뒤 RSC로 새 version이 와도
 *   따라가지 않으므로 오래된 초안·확인은 서버 conflict로 거부되고 초안은 남는다(같은 날은 DailyStory가 key={date}로 유지).
 */

const EDIT_TEXT: Record<StoryEditActionError, string> = {
  conflict: "다른 곳에서 이야기가 바뀌었어요. 고친 글을 복사한 뒤 다시 불러와 주세요.",
  busy: "AI가 새 이야기를 만드는 중이라 지금은 저장할 수 없어요. 고친 글을 복사한 뒤 잠시 뒤 다시 불러와 주세요.",
  invalid_body: "이야기는 1~2000자로 써 주세요. 보이지 않는 제어 문자는 넣을 수 없어요.",
  not_signed_in: "로그인이 끝났어요. 고친 글을 복사한 뒤 다시 로그인해 주세요.",
  forbidden: "요청을 확인할 수 없어요. 고친 글을 복사한 뒤 화면을 다시 열어 주세요.",
  invalid_date: "날짜를 확인하지 못했어요. 고친 글을 복사한 뒤 다시 불러와 주세요.",
  unavailable: "저장을 확인하지 못했어요. 고친 글은 그대로 있어요. 잠시 뒤 다시 저장해 주세요.",
};
const REGEN_TEXT: Partial<Record<StoryRegenerationActionError, string>> = {
  conflict: "이야기나 조각이 바뀌었어요. 다시 불러온 뒤 확인해 주세요.",
  busy: "이미 이야기를 만드는 중이에요. 잠시 뒤 새로고침해서 확인해 주세요.",
  already_current: "이 이야기는 이미 다시 만들고 있거나 만들었어요. 새로고침해서 확인해 주세요.",
  limited: "오늘은 더 만들 수 없어요. 직접 만들기는 하루 3번까지예요.",
  consent_missing: "AI 이야기 설정에서 직접 만들기를 켜야 다시 만들 수 있어요.",
  not_signed_in: "로그인이 끝났어요. 다시 로그인해 주세요.",
};
const REGEN_FALLBACK = "지금은 다시 만들지 못했어요. 이야기와 조각은 그대로예요.";
/** 다시 불러오기 안내가 필요한 오류(입력은 그대로 두고 사용자가 누를 때만 다시 불러온다). */
const RELOAD_ERRORS: readonly StoryEditActionError[] = ["conflict", "busy", "invalid_date", "forbidden"];

const codepoints = (s: string) => Array.from(s).length;

export function StoryControls({ date, version, body, busy, canRegenerate, editAction, regenerateAction }: {
  date: string;
  version: number;
  body: string;
  /** 그날 job이 queued/running이면 수정 진입을 막는다. */
  busy: boolean;
  /** current + 조각 있음 + 직접 만들기 가능(ready 또는 재시도 가능한 실패)일 때만 true. */
  canRegenerate: boolean;
  editAction?: (input: { expectedVersion: number; body: string }) => Promise<StoryEditActionResult>;
  regenerateAction?: (expectedVersion: number) => Promise<StoryRegenerationActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const [mode, setMode] = useState<"read" | "edit" | "confirm">("read");
  const [text, setText] = useState(body);
  const [base, setBase] = useState<{ version: number; body: string }>({ version, body });
  const [confirmVersion, setConfirmVersion] = useState(version);
  const [editError, setEditError] = useState<StoryEditActionError | null>(null);
  const [regenError, setRegenError] = useState<StoryRegenerationActionError | null>(null);
  const focusNext = useRef<"edit" | "text" | "confirm" | "regen" | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const regenRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);
  // 누른 버튼이 사라지는 전환에서만 다음 대상으로 포커스를 옮긴다.
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    const node = target === "text" ? textRef.current : target === "confirm" ? confirmRef.current
      : target === "regen" ? regenRef.current : target === "edit" ? editRef.current : null;
    node?.focus();
  }, [mode]);

  function go(next: "read" | "edit" | "confirm", focus: "edit" | "text" | "confirm" | "regen") {
    focusNext.current = focus;
    setMode(next);
  }
  function openEdit() {
    if (busy || pending) return;
    setText(body);
    setBase({ version, body });
    setEditError(null);
    go("edit", "text");
  }
  function cancelEdit() {
    if (pending) return;
    setEditError(null);
    go("read", "edit");
  }
  function save() {
    if (!editAction || inFlight.current) return;
    const length = codepoints(text.trim());
    if (length < 1 || length > STORY_MAX) {
      setEditError("invalid_body");
      return;
    }
    if (text.trim() === base.body) {
      setEditError(null);
      go("read", "edit");
      return;
    }
    inFlight.current = true;
    setEditError(null);
    startTransition(async () => {
      try {
        const result = await editAction({ expectedVersion: base.version, body: text });
        if (!result.ok) {
          setEditError(result.error);
          return;
        }
        go("read", "edit");
        if (!result.value.unchanged) startTransition(() => router.refresh());
      } catch {
        setEditError("unavailable");
      }
    });
  }
  function regenerate() {
    if (!regenerateAction || inFlight.current) return;
    inFlight.current = true;
    setRegenError(null);
    startTransition(async () => {
      try {
        const result = await regenerateAction(confirmVersion);
        if (!result.ok) {
          setRegenError(result.error);
          return;
        }
        go("read", "edit");
        startTransition(() => router.refresh());
      } catch {
        setRegenError("unavailable");
      }
    });
  }

  if (mode === "edit") {
    const length = codepoints(text.trim());
    const invalid = length < 1 || length > STORY_MAX;
    const described = [`${id}-count`, editError ? `${id}-err` : null].filter(Boolean).join(" ");
    return (
      <div className="story-edit">
        <label className="lbl" htmlFor={`${id}-text`}>이야기 내용</label>
        <textarea
          ref={textRef}
          id={`${id}-text`}
          rows={10}
          value={text}
          readOnly={pending}
          aria-invalid={invalid || editError === "invalid_body" ? true : undefined}
          aria-describedby={described}
          onChange={(e) => { setText(e.target.value); if (editError === "invalid_body") setEditError(null); }}
        />
        <p className="hint" id={`${id}-count`}>{length} / {STORY_MAX}자</p>
        {editError ? <p className="err" role="alert" id={`${id}-err`}>{EDIT_TEXT[editError]}</p> : null}
        <div className="row">
          {editError === "conflict" ? null : (
            <button className="btn-main" type="button" onClick={save} disabled={pending}>저장</button>
          )}
          <button className="btn-ghost" type="button" onClick={cancelEdit} disabled={pending}>취소</button>
          {editError && RELOAD_ERRORS.includes(editError) ? <a className="text-btn" href={`/days/${date}`}>새로고침</a> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="story-body">{body}</p>
      {mode === "confirm" && regenerateAction ? (
        <div className="story-edit">
          <p id={`${id}-ask`}>지금 조각을 AI에 다시 보내 새 글을 만들어요. 직접 고친 글을 포함한 이전 글은 이력으로 남아요.</p>
          {regenError ? <p className="err" role="alert">{REGEN_TEXT[regenError] ?? REGEN_FALLBACK}</p> : null}
          <div className="row">
            <button ref={confirmRef} className="btn-main" type="button" onClick={regenerate} disabled={pending} aria-describedby={`${id}-ask`}>AI로 다시 만들기</button>
            <button className="btn-ghost" type="button" disabled={pending} onClick={() => { setRegenError(null); go("read", "regen"); }}>취소</button>
          </div>
        </div>
      ) : (
        <div className="row story-controls">
          {editAction ? (
            <button
              ref={editRef}
              className="btn-ghost"
              type="button"
              onClick={openEdit}
              disabled={busy}
              aria-describedby={busy ? `${id}-busy` : undefined}
            >
              이야기 수정
            </button>
          ) : null}
          {regenerateAction && canRegenerate && !busy ? (
            <button ref={regenRef} className="btn-ghost" type="button" onClick={() => { setRegenError(null); setConfirmVersion(version); go("confirm", "confirm"); }}>다시 만들기</button>
          ) : null}
          {busy && editAction ? <p className="hint" id={`${id}-busy`}>AI가 새 이야기를 만드는 동안에는 고칠 수 없어요.</p> : null}
        </div>
      )}
    </>
  );
}
