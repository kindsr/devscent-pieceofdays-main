"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PHOTO_INPUT_MAX_BYTES } from "@/shared/photos";

/** File은 작성 초안 소유자가 유지한다. URL은 미리보기가 살아 있는 동안만 유지한다. */
export function PhotoInput({ file, onChange, enabled, disabled }: {
  file: File | null;
  onChange: (file: File | null) => void;
  enabled: boolean;
  disabled: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- File 미리보기 URL의 생성/해제를 같은 수명으로 묶는다.
    setPreview(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);
  const invalid = file && (file.size > PHOTO_INPUT_MAX_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type));
  return (
    <div className="photo-input">
      <label className="lbl" htmlFor={id}>사진 1장</label>
      <input ref={input} id={id} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || !enabled}
        aria-describedby={`${id}-hint`} aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
      <p className="hint" id={`${id}-hint`}>{enabled
        ? "선택 사항이에요. JPEG·PNG·WebP, 최대 8MiB. HEIC는 지원하지 않아요."
        : "사진 저장을 준비 중이에요. 지금은 메모로 남길 수 있어요."}</p>
      {file ? <>
        <p className="photo-filename">{file.name}</p>
        {invalid ? <p className="err" role="alert">8MiB 이하의 JPEG·PNG·WebP 사진을 골라 주세요. HEIC는 지원하지 않아요.</p> : null}
        {/* 브라우저의 일시적인 blob URL은 공용 이미지 최적화로 보내지 않는다. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && !invalid ? <img className="photo-preview" src={preview} alt="선택한 사진 미리보기" /> : null}
        <button className="text-btn" type="button" disabled={disabled} onClick={() => {
          if (input.current) input.current.value = "";
          onChange(null);
        }}>사진 선택 취소</button>
      </> : null}
    </div>
  );
}
