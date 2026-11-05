"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AUTH_TEXT } from "@/shared/auth-messages";

/**
 * 탈퇴 확인 form 안의 체크·버튼(D 인증 아트보드: 확인 전에는 탈퇴 버튼 비활성).
 * JS가 없으면 버튼은 그대로이고 체크박스의 required가 native 제출을 막는다. JS가 붙으면 체크 전까지 버튼을 disabled로 둔다.
 */
export function WithdrawConfirm() {
  const [enhanced, setEnhanced] = useState(false);
  const [checked, setChecked] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 하이드레이션 뒤에만 점진 향상을 켠다
  useEffect(() => setEnhanced(true), []);
  return (
    <>
      <label className="auth-check">
        <input
          type="checkbox"
          name="confirm"
          value="withdraw"
          required
          aria-describedby="wd-warn"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        {AUTH_TEXT.withdrawCheck}
      </label>
      <div className="row">
        <button type="submit" className="btn-ghost auth-danger" disabled={enhanced && !checked}>
          {AUTH_TEXT.withdrawSubmit}
        </button>
        <Link className="text-btn" href="/settings">
          {AUTH_TEXT.cancel}
        </Link>
      </div>
    </>
  );
}
