"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DiaryDay, SampleImageKey } from "@/shared/diary";
import { dateLabel } from "@/shared/local-date";
import { SAMPLE_IMAGES } from "./sample-images";
import { AccountDayBoard } from "./AccountDayBoard";

/*
 * D 조각 보드 + 하루 한 줄 + 작성·수정 팝업(docs/design/concepts/d-warm-pieces/app.js 동작을 React로 옮김).
 * F1 범위: 변경은 이 화면 메모리에만 있다. 서버에 보내거나 저장하지 않으며, 저장됐다고 표시하지 않는다.
 */

const NOTE = ["y", "m", "p"] as const;
type Note = (typeof NOTE)[number];
type Piece = { key: string; time: string; text: string; image: SampleImageKey | null; note: Note };

// F1에는 영구 저장도 화면 간 공유 상태도 없다. 새로고침뿐 아니라 다른 화면으로 이동해도 사라진다.
const GONE = "저장되지 않아 새로고침하거나 다른 화면으로 이동하면 사라집니다.";
const NOT_SAVED = `이 화면에만 추가했어요. ${GONE}`;
const ADD_HINT = "앱 골격이라 이 화면에만 붙고 저장되지 않아요.";
const EDIT_HINT = "앱 골격이라 이 화면에만 고쳐지고 저장되지 않아요. 기록 시각은 그대로예요.";
const IMAGE_CHOICES: Array<[SampleImageKey | null, string]> = [
  [null, "없음"],
  ["window", SAMPLE_IMAGES.window.name],
  ["noodle", SAMPLE_IMAGES.noodle.name],
  ["ginkgo", SAMPLE_IMAGES.ginkgo.name],
];

/** 메모 색은 조각마다 처음에 고정한다(D: 메모 조각끼리 y→m→p, 사진 조각은 자기 위치 색을 미리 받음). */
function initialPieces(day: DiaryDay): Piece[] {
  let k = 0;
  return day.moments.map((m, i) => ({
    key: m.id,
    time: m.time,
    text: m.text,
    image: m.image,
    note: m.image ? NOTE[i % 3]! : NOTE[k++ % 3]!,
  }));
}

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type Compose = { mode: "add" } | { mode: "edit"; key: string };

export type DayBoardProps = {
  day: DiaryDay;
  isToday: boolean;
  sub: string;
  showSettingsLink?: boolean;
  headingLevel?: 1 | 2;
  photosEnabled?: boolean;
  /** 계정 보드의 날짜 머리 다음에 놓는 AI 하루 이야기 영역(서버에서 만든 화면). 예시 보드는 표시하지 않는다. */
  story?: ReactNode;
};

export function DayBoard({ mode = "fixture", ...props }: DayBoardProps & { mode?: "fixture" | "account" }) {
  return mode === "account" ? <AccountDayBoard {...props} /> : <FixtureDayBoard {...props} />;
}

function FixtureDayBoard({
  day,
  isToday,
  sub,
  showSettingsLink = false,
  headingLevel = 1,
}: {
  day: DiaryDay;
  isToday: boolean;
  sub: string;
  showSettingsLink?: boolean;
  headingLevel?: 1 | 2;
}) {
  const [pieces, setPieces] = useState<Piece[]>(() => initialPieces(day));
  const [summary, setSummary] = useState(day.summary);
  const [editingSummary, setEditingSummary] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [text, setText] = useState("");
  const [image, setImage] = useState<SampleImageKey | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [lastNewKey, setLastNewKey] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [composeTime, setComposeTime] = useState("");
  const addDraft = useRef<{ text: string; image: SampleImageKey | null } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusAfter = useRef<string | null>(null);
  const label = dateLabel(day.date);
  const H = headingLevel === 1 ? "h1" : "h2";

  const announce = useCallback((msg: string) => {
    setLive("");
    requestAnimationFrame(() => setLive(msg));
  }, []);

  const openAdd = useCallback(() => {
    if (!isToday) return;
    setCompose({ mode: "add" });
    setComposeTime(nowTime());
    setInvalid(false);
  }, [isToday]);

  // 상단 "조각 추가"(/#write)와 보드의 추가 칸은 해시로 팝업을 연다(D와 같은 주소).
  // 브라우저 뒤로 가기 등으로 #write를 벗어나면 추가 팝업을 닫는다. 입력 중인 초안(text·image)은 그대로 둔다.
  useEffect(() => {
    if (!isToday) return;
    const sync = () => {
      if (location.hash === "#write") openAdd();
      else setCompose((c) => (c?.mode === "add" ? null : c));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [isToday, openAdd]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (compose && !dlg.open) dlg.showModal();
    if (!compose && dlg.open) dlg.close();
    if (compose) textRef.current?.focus();
  }, [compose]);

  useEffect(() => {
    if (compose || !focusAfter.current) return;
    const el = document.querySelector<HTMLElement>(focusAfter.current);
    focusAfter.current = null;
    el?.focus();
  });

  function openEdit(p: Piece) {
    if (compose?.mode !== "edit") addDraft.current = { text, image };
    setCompose({ mode: "edit", key: p.key });
    setComposeTime(p.time);
    setText(p.text);
    setImage(p.image);
    setInvalid(false);
  }

  function endEdit() {
    const draft = addDraft.current;
    addDraft.current = null;
    setText(draft?.text ?? "");
    setImage(draft?.image ?? null);
    setInvalid(false);
  }

  function clearWriteHash() {
    if (location.hash === "#write") history.replaceState(null, "", location.pathname + location.search);
  }

  function cancel() {
    if (compose?.mode === "edit") {
      focusAfter.current = `[data-edit="${compose.key}"]`;
      setCompose(null);
      endEdit();
      announce("고치기를 취소했어요. 조각은 그대로예요.");
      return;
    }
    setCompose(null);
    setInvalid(false);
    clearWriteHash();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (!v) {
      setInvalid(true);
      textRef.current?.focus();
      announce("메모를 한 줄 적어 주세요.");
      return;
    }
    if (compose?.mode === "edit") {
      const key = compose.key;
      // 글·이미지만 바꾼다. 시각·순서·개수·색은 그대로.
      setPieces((ps) => ps.map((p) => (p.key === key ? { ...p, text: v, image } : p)));
      focusAfter.current = `[data-edit="${key}"]`;
      setCompose(null);
      endEdit();
      announce(`조각을 고쳤어요. 이 화면에만 반영되고 ${GONE}`);
      return;
    }
    const key = `new-${Date.now()}`;
    setPieces((ps) =>
      [...ps, { key, time: nowTime(), text: v, image, note: NOTE[ps.length % 3]! }].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)),
    );
    setLastNewKey(key);
    setText("");
    setImage(null);
    setCompose(null);
    clearWriteHash();
    announce(NOT_SAVED);
  }

  function submitSummary(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get("summary") ?? "").trim();
    setSummary(v);
    setEditingSummary(false);
    focusAfter.current = headingLevel === 2 ? "#picked-h" : "#view h1";
    announce(`한 줄을 이 화면에만 반영했어요. ${GONE}`);
  }

  const editing = compose?.mode === "edit";
  const head = (
    <header className="board-head">
      <H tabIndex={-1} id={headingLevel === 2 ? "picked-h" : undefined}>
        {label}의 조각
        <span className="count">
          {pieces.length}
          <span className="sr-only">개</span>
        </span>
      </H>
      {sub ? <p className="sub">{sub}</p> : null}
      {showSettingsLink ? (
        <Link className="text-btn set-link" href="/settings">
          기록 글꼴 설정
        </Link>
      ) : null}
    </header>
  );

  return (
    <>
      {head}
      {pieces.length === 0 ? (
        <section className="first" aria-labelledby="f-h">
          <svg viewBox="0 0 56 56" aria-hidden="true" focusable="false">
            <path d="M28 6 L33 22 L50 22 L36 32 L41 49 L28 39 L15 49 L20 32 L6 22 L23 22 Z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
          </svg>
          <h2 id="f-h">첫 조각을 붙여 보세요</h2>
          <p>사진 한 장이나 메모 한 줄이면 충분해요. 매일 채우지 않아도 괜찮아요.</p>
          {isToday ? (
            <a className="btn-main" href="#write">
              첫 조각 붙이기
            </a>
          ) : null}
        </section>
      ) : (
        <div className="with-side">
          {editingSummary && isToday ? (
            <section className="oneline">
              <form onSubmit={submitSummary}>
                <label className="hand" style={{ fontSize: 22, color: "var(--muted)" }} htmlFor="sum-text">
                  오늘을 한 줄로
                </label>
                <textarea id="sum-text" name="summary" rows={3} maxLength={300} defaultValue={summary} autoFocus />
                <p className="hint">앱 골격이라 이 화면에만 반영되고 저장되지 않아요.</p>
                <div className="row">
                  <button className="btn-main" type="submit">
                    반영
                  </button>
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => {
                      setEditingSummary(false);
                      focusAfter.current = "#sum-edit";
                    }}
                  >
                    취소
                  </button>
                </div>
              </form>
            </section>
          ) : summary || isToday ? (
            <section className="oneline" aria-labelledby={`ol-h-${day.date}`}>
              <h2 id={`ol-h-${day.date}`}>{isToday ? "오늘을 한 줄로" : "그날 한 줄"}</h2>
              {summary ? <p>{summary}</p> : <p style={{ color: "var(--muted)" }}>조각을 다 모았다면 하루를 한 줄로 묶어 보세요.</p>}
              {isToday ? (
                <button className="text-btn" type="button" id="sum-edit" onClick={() => setEditingSummary(true)}>
                  {summary ? "고쳐 쓰기" : "한 줄 쓰기"}
                </button>
              ) : null}
            </section>
          ) : null}
          <ul className="pieces" aria-label={`${label}의 조각`}>
            {pieces.map((p) => {
              const img = p.image ? SAMPLE_IMAGES[p.image] : null;
              const isNew = p.key === lastNewKey ? " is-new" : "";
              const meta = (
                <div className="piece-meta">
                  <time>{p.time}</time>
                  <button className="piece-edit" type="button" data-edit={p.key} aria-label={`${label} ${p.time} 조각 수정`} onClick={() => openEdit(p)}>
                    수정
                  </button>
                </div>
              );
              return img ? (
                <li key={p.key} className={`piece photo${isNew}`}>
                  {/* 앱 동봉 정적 SVG 예시라 next/image 최적화를 쓰지 않는다. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.src} alt={img.alt} width={400} height={300} />
                  <p className="tag">예시 이미지 · 직접 그린 그림</p>
                  {meta}
                  <p>{p.text}</p>
                </li>
              ) : (
                <li key={p.key} className={`piece note ${p.note}${isNew}`}>
                  {meta}
                  <p>{p.text}</p>
                </li>
              );
            })}
            {isToday ? (
              <li className="piece">
                <a className="add-tile" href="#write">
                  <span className="plus" aria-hidden="true">
                    +
                  </span>
                  조각 추가
                </a>
              </li>
            ) : null}
          </ul>
        </div>
      )}

      <dialog
        ref={dialogRef}
        className="pop"
        aria-labelledby={`compose-h-${day.date}`}
        onCancel={(e) => {
          e.preventDefault();
          cancel();
        }}
      >
        <form onSubmit={submit} noValidate>
          <h2 id={`compose-h-${day.date}`}>
            <span>{editing ? "조각 고치기" : "조각 붙이기"}</span> <small className="hand">{composeTime}</small>
          </h2>
          <label className="lbl" htmlFor={`compose-text-${day.date}`}>
            메모
          </label>
          <textarea
            ref={textRef}
            id={`compose-text-${day.date}`}
            rows={3}
            maxLength={300}
            required
            aria-invalid={invalid || undefined}
            aria-describedby={`compose-err-${day.date} compose-hint-${day.date}`}
            placeholder="짧게 한 줄이면 충분해요"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p id={`compose-err-${day.date}`} className="err" hidden={!invalid}>
            메모를 한 줄 적어 주세요.
          </p>
          <fieldset className="polas">
            <legend className="lbl">예시 이미지 (선택)</legend>
            <div className="pola-list">
              {IMAGE_CHOICES.map(([key, name]) => (
                <label className="pola" key={name}>
                  <input type="radio" name={`img-${day.date}`} value={key ?? ""} checked={image === key} onChange={() => setImage(key)} />
                  {key ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={SAMPLE_IMAGES[key].src} alt="" />
                  ) : (
                    <span className="blank" aria-hidden="true">
                      메모만
                    </span>
                  )}
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p id={`compose-hint-${day.date}`} className="hint">
            {editing ? EDIT_HINT : ADD_HINT}
          </p>
          <div className="pop-actions">
            <button type="button" className="btn-ghost" onClick={cancel}>
              닫기
            </button>
            <button type="submit" className="btn-main">
              {editing ? "고치기" : "붙이기"}
            </button>
          </div>
        </form>
      </dialog>
      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </>
  );
}
