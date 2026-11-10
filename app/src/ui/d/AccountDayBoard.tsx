"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { createMomentAction, updateMomentAction, deleteMomentAction, saveSummaryAction, type ActionError, type ActionResult } from "@/app/actions/diary";
import type { DiaryMoment } from "@/shared/diary";
import { dateLabel } from "@/shared/local-date";
import type { DayBoardProps } from "./DayBoard";
import { PhotoInput } from "./PhotoInput";

type Compose = { mode: "add" } | { mode: "edit" | "delete"; id: string; version: number; time: string };
type SummaryDraft = { date: string; text: string; version: number | null; missing?: boolean };
type Latest = { text: string; missing: boolean };
const NOTE = ["y", "m", "p"] as const;
const PHOTO_FAILURE = "사진 저장을 확인하지 못했어요. 고른 사진과 메모는 그대로 두었어요. 다시 시도해 주세요.";
const ERRORS: Record<ActionError, string> = {
  forbidden: "요청을 확인할 수 없어요. 화면을 다시 열고 시도해 주세요.",
  not_signed_in: "다시 로그인해 주세요. 쓰던 글은 그대로 두었어요.",
  unavailable: "저장을 확인하지 못했어요. 쓰던 글은 그대로 두었어요. 다시 불러와 확인해 주세요.",
  conflict: "다른 곳에서 기록이 바뀌었어요. 쓰던 글은 그대로 두었어요.",
  not_found: "기록을 찾을 수 없어요. 다시 불러와 주세요.",
  invalid_body: "300자 이하로 적어 주세요.",
  invalid_date: "기록할 날짜를 확인해 주세요.",
  invalid_version: "기록을 다시 불러와 주세요.",
  invalid_font: "글꼴을 다시 골라 주세요.",
  invalid_reflection_time: "회고할 시간을 다시 골라 주세요.",
};

/** 목록·한 줄은 최신 서버 props만 사용한다. 로컬에는 열린 초안과 편집 시작 시 기대 버전만 둔다. */
export function AccountDayBoard({ day, isToday, sub, showSettingsLink = false, headingLevel = 1, photosEnabled = false }: DayBoardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const reloadRequested = useRef(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [text, setText] = useState("");
  const addDraft = useRef("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoFailure, setPhotoFailure] = useState("");
  const photoRequestId = useRef<string | null>(null);
  const savedPhoto = useRef<{ id: string; version: number } | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<SummaryDraft | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [validation, setValidation] = useState("");
  const [latest, setLatest] = useState<Latest | null>(null);
  const [lastNewId, setLastNewId] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null>(null);
  const label = dateLabel(day.date);
  const H = headingLevel === 1 ? "h1" : "h2";

  const openAdd = useCallback(() => {
    if (!isToday || busy.current) return;
    setCompose({ mode: "add" });
    setText(addDraft.current);
    setError(null);
    setPhotoFailure("");
    setValidation("");
    setLatest(null);
  }, [isToday]);

  useEffect(() => {
    if (!isToday) return;
    const sync = () => {
      if (location.hash === "#write") openAdd();
      else if (!busy.current) setCompose((c) => c?.mode === "add" ? null : c);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [isToday, openAdd]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (compose && dlg && !dlg.open) {
      dlg.showModal();
      if (compose.mode !== "delete") textRef.current?.focus();
    }
    if (!compose && focusAfter.current) {
      if (focusAfter.current === "heading") headingRef.current?.focus();
      else document.querySelector<HTMLElement>(focusAfter.current)?.focus();
      focusAfter.current = null;
    }
  }, [compose]);

  useEffect(() => {
    if (pending) return;
    busy.current = false;
    const saved = savedPhoto.current;
    if (saved) {
      savedPhoto.current = null;
      if (day.moments.some((moment) => moment.id === saved.id && moment.photo)) {
        setLastNewId(saved.id);
        addDraft.current = "";
        photoRequestId.current = null;
        setText("");
        setPhotoFile(null);
        setCompose(null);
        clearWriteHash();
        focusAfter.current = "heading";
        setLive("조각을 저장했어요.");
      } else {
        setPhotoFailure(PHOTO_FAILURE);
      }
    }
    if (!reloadRequested.current) return;
    reloadRequested.current = false;
    // 사용자 재조회가 끝났을 때만 서버 버전을 채택한다. 자동 props 갱신은 열린 기대 버전을 바꾸지 않는다.
    if (compose && compose.mode !== "add") {
      const current = day.moments.find((m) => m.id === compose.id);
      setLatest({ text: current?.text ?? "이 조각은 지워졌어요. 초안은 복사할 수 있어요.", missing: !current });
      if (current) setCompose({ ...compose, version: current.version });
    } else if (summaryDraft) {
      // 삭제를 확인한 초안은 닫을 때까지 잠근다. 재생성된 행도 이 초안으로 덮어쓰지 않는다.
      const missing = summaryDraft.missing || (summaryDraft.version !== null && day.summaryVersion === null);
      setLatest({ text: day.summary || "저장된 한 줄이 없어요.", missing });
      setSummaryDraft({ ...summaryDraft, version: day.summaryVersion, missing });
    }
  }, [pending, day, compose, summaryDraft]);

  function resetError() {
    setError(null);
    setPhotoFailure("");
    setValidation("");
    setLatest(null);
    setLive("");
  }

  function openMoment(moment: DiaryMoment, mode: "edit" | "delete") {
    if (busy.current) return;
    setCompose({ mode, id: moment.id, version: moment.version, time: moment.time });
    setText(moment.text);
    resetError();
  }

  function clearWriteHash() {
    if (location.hash === "#write") history.replaceState(null, "", location.pathname + location.search);
  }

  function cancel() {
    if (busy.current) return;
    if (compose?.mode === "add") clearWriteHash();
    else if (compose) {
      focusAfter.current = `[data-${compose.mode === "edit" ? "edit" : "delete"}="${compose.id}"]`;
    }
    setCompose(null);
    resetError();
  }

  function validate(body: string, required: boolean): boolean {
    const message = required && !body.trim() ? "메모를 한 줄 적어 주세요."
      : Array.from(body.trim()).length > 300 ? "300자 이하로 적어 주세요." : "";
    setValidation(message);
    if (message) (compose ? textRef : summaryRef).current?.focus();
    return !message;
  }

  function run<T>(action: () => Promise<ActionResult<T>>, success: (value: T) => void) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setValidation("");
    setLive("");
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        success(result.value);
        startTransition(() => router.refresh());
      } catch {
        setError("unavailable");
      }
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!compose || busy.current || latest?.missing) return;
    if (compose.mode === "delete") {
      run(() => deleteMomentAction(compose.id, compose.version), () => {
        focusAfter.current = "heading";
        setCompose(null);
        setLive("조각을 지웠어요.");
      });
    } else if (validate(text, true)) {
      if (compose.mode === "edit") {
        run(() => updateMomentAction(compose.id, compose.version, text), () => {
          focusAfter.current = `[data-edit="${compose.id}"]`;
          setCompose(null);
          setText(addDraft.current);
          setLive("조각을 고쳤어요.");
        });
      } else {
        if (photoFile) {
          submitPhoto(photoFile);
          return;
        }
        run(() => createMomentAction(text), (value) => {
          setLastNewId(value.id);
          addDraft.current = "";
          setText("");
          setCompose(null);
          clearWriteHash();
          focusAfter.current = "heading";
          setLive("조각을 저장했어요.");
        });
      }
    }
  }

  function submitPhoto(file: File) {
    if (!photosEnabled || busy.current) return;
    busy.current = true;
    setError(null);
    setPhotoFailure("");
    setValidation("");
    setLive("");
    const requestId = photoRequestId.current ?? crypto.randomUUID();
    photoRequestId.current = requestId;
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set("photo", file);
        form.set("memo", text);
        form.set("requestId", requestId);
        const response = await fetch("/photos/upload", { method: "POST", body: form, credentials: "same-origin", cache: "no-store", redirect: "error" });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("value" in result)
          || !result.value || typeof result.value !== "object" || !("id" in result.value) || typeof result.value.id !== "string"
          || !("version" in result.value) || !Number.isSafeInteger(result.value.version)) {
          setPhotoFailure(PHOTO_FAILURE);
          return;
        }
        savedPhoto.current = { id: result.value.id, version: result.value.version as number };
        startTransition(() => router.refresh());
      } catch {
        setPhotoFailure(PHOTO_FAILURE);
      }
    });
  }

  function submitSummary(e: FormEvent) {
    e.preventDefault();
    if (!summaryDraft || busy.current || summaryDraft.missing || !validate(summaryDraft.text, false)) return;
    run(() => saveSummaryAction(summaryDraft.date, summaryDraft.version, summaryDraft.text), () => {
      setLive(summaryDraft.text.trim() ? "한 줄을 저장했어요." : "한 줄을 지웠어요.");
      setSummaryDraft(null);
      focusAfter.current = "heading";
      headingRef.current?.focus();
    });
  }

  function reload() {
    if (busy.current) return;
    busy.current = true;
    reloadRequested.current = true;
    startTransition(() => router.refresh());
  }

  const errorContent = validation || photoFailure || error ? (
    <div className="diary-error">
      <p className="err" role="alert" id={`account-error-${day.date}`}>{validation || photoFailure || (error && ERRORS[error])}</p>
      {error === "not_signed_in" ? <Link className="text-btn" href="/login">로그인</Link> : null}
      {error && ["conflict", "unavailable", "not_found", "invalid_version"].includes(error) ? (
        <button className="text-btn" type="button" disabled={pending} onClick={reload}>다시 불러오기</button>
      ) : null}
    </div>
  ) : null;
  const latestContent = latest ? (
    <section className="diary-latest" aria-labelledby={`latest-h-${day.date}`}>
      <h3 id={`latest-h-${day.date}`}>서버의 최신 글</h3>
      <p>{latest.text}</p>
    </section>
  ) : null;
  const summary = (
    <section className="oneline" aria-labelledby={`ol-h-${day.date}`}>
      <h2 id={`ol-h-${day.date}`}>{isToday ? "오늘을 한 줄로" : "그날 한 줄"}</h2>
      {summaryDraft ? (
        <form onSubmit={submitSummary}>
          <label className="sr-only" htmlFor={`summary-${day.date}`}>하루 한 줄</label>
          <textarea ref={summaryRef} id={`summary-${day.date}`} rows={3} autoFocus value={summaryDraft.text} disabled={pending}
            aria-invalid={!!validation || undefined} aria-describedby={errorContent ? `account-error-${day.date}` : undefined}
            onChange={(e) => setSummaryDraft({ ...summaryDraft, text: e.target.value })} />
          {!compose ? <>{errorContent}{latestContent}</> : null}
          <div className="row">
            <button className="btn-main" type="submit" disabled={pending || !!summaryDraft.missing}>저장</button>
            <button className="btn-ghost" type="button" disabled={pending} onClick={() => {
              if (busy.current) return;
              setSummaryDraft(null);
              resetError();
            }}>취소</button>
          </div>
        </form>
      ) : (
        <>
          {day.summary ? <p>{day.summary}</p> : <p className="hint">조각을 다 모았다면 하루를 한 줄로 묶어 보세요.</p>}
          <button className="text-btn" type="button" disabled={pending} onClick={() => {
            if (busy.current) return;
            setSummaryDraft({ date: day.date, text: day.summary, version: day.summaryVersion });
            resetError();
          }}>{day.summary ? "고쳐 쓰기" : "한 줄 쓰기"}</button>
        </>
      )}
    </section>
  );

  return (
    <div className="account-board">
      <header className="board-head">
        <H ref={headingRef} tabIndex={-1} id={headingLevel === 2 ? "picked-h" : undefined}>
          {label}의 조각<span className="count">{day.moments.length}<span className="sr-only">개</span></span>
        </H>
        {sub ? <p className="sub">{sub}</p> : null}
        {showSettingsLink ? <Link className="text-btn set-link" href="/settings">기록 글꼴 설정</Link> : null}
      </header>
      {day.moments.length === 0 ? (
        <>
          <section className="first" aria-labelledby="f-h">
            <svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><path d="M28 6 L33 22 L50 22 L36 32 L41 49 L28 39 L15 49 L20 32 L6 22 L23 22 Z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" /></svg>
            <h2 id="f-h">첫 조각을 붙여 보세요</h2>
            <p>메모 한 줄로 첫 조각을 붙여 보세요.</p>
            {isToday ? <a className="btn-main" href="#write" aria-disabled={pending} onClick={(e) => { if (busy.current) e.preventDefault(); }}>첫 조각 붙이기</a> : null}
          </section>
          {summary}
        </>
      ) : (
        <div className="with-side">
          {summary}
          <ul className="pieces" aria-label={`${label}의 조각`}>
            {day.moments.map((p, i) => (
              <li key={p.id} className={`piece ${p.photo ? "photo" : `note ${NOTE[i % NOTE.length]}`}${p.id === lastNewId ? " is-new" : ""}`}>
                {/* 비공개 경로를 공용 이미지 최적화/캐시에 보내지 않는다. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.photo ? <img src={p.photo.src} width={p.photo.width} height={p.photo.height} alt="조각 사진" /> : null}
                <div className="piece-meta">
                  <time>{p.time}</time>
                  <button className="piece-edit" type="button" disabled={pending} data-edit={p.id} aria-label={`${label} ${p.time} 조각 수정`} onClick={() => openMoment(p, "edit")}>수정</button>
                </div>
                <p>{p.text}</p>
                <button className="piece-edit piece-delete" type="button" disabled={pending} data-delete={p.id} aria-label={`${label} ${p.time} 조각 삭제`} onClick={() => openMoment(p, "delete")}>삭제</button>
              </li>
            ))}
            {isToday ? <li className="piece"><a className="add-tile" href="#write" aria-disabled={pending} onClick={(e) => { if (busy.current) e.preventDefault(); }}><span className="plus" aria-hidden="true">+</span>조각 추가</a></li> : null}
          </ul>
        </div>
      )}
      {compose ? (
        <dialog ref={dialogRef} className="pop" aria-labelledby={`compose-h-${day.date}`} onCancel={(e) => { e.preventDefault(); cancel(); }}>
          <form onSubmit={submit} noValidate>
            <h2 id={`compose-h-${day.date}`}>
              <span>{compose.mode === "delete" ? "조각 지우기" : compose.mode === "edit" ? "조각 고치기" : "조각 붙이기"}</span>
              {compose.mode === "edit" ? <small className="hand">{compose.time}</small> : null}
            </h2>
            {compose.mode === "delete" ? <p>이 조각을 지울까요? 지운 뒤에는 되돌릴 수 없어요.</p> : (
              <>
                <label className="lbl" htmlFor={`compose-text-${day.date}`}>메모</label>
                <textarea ref={textRef} id={`compose-text-${day.date}`} rows={3} required disabled={pending} value={text}
                  aria-invalid={!!validation || undefined} aria-describedby={errorContent ? `account-error-${day.date}` : undefined}
                  placeholder="짧게 한 줄이면 충분해요" onChange={(e) => {
                    setText(e.target.value);
                    if (compose.mode === "add") {
                      addDraft.current = e.target.value;
                      photoRequestId.current = null;
                    }
                  }} />
                {compose.mode === "add" ? <PhotoInput file={photoFile} enabled={photosEnabled} disabled={pending} onChange={(file) => {
                  setPhotoFile(file);
                  photoRequestId.current = null;
                  setPhotoFailure("");
                }} /> : null}
              </>
            )}
            {errorContent}
            {latestContent}
            <p role="status" aria-live="polite">{pending ? "저장 중…" : ""}</p>
            <div className="pop-actions">
              <button className="btn-ghost" type="button" disabled={pending} onClick={cancel}>{compose.mode === "delete" ? "취소" : "닫기"}</button>
              <button className="btn-main" type="submit" disabled={pending || !!latest?.missing}>{pending && compose.mode === "add" && photoFile ? "저장 중…" : compose.mode === "delete" ? "지우기" : compose.mode === "edit" ? "고치기" : "저장"}</button>
            </div>
          </form>
        </dialog>
      ) : null}
      {!compose ? <p role="status" aria-live="polite">{pending ? "저장 중…" : live}</p> : null}
    </div>
  );
}
