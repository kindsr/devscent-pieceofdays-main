import Link from "next/link";
import { getViewer } from "@/server/context";
import { getPreferences } from "@/server/account/preferences.pg";
import { getAppDb } from "@/server/db/pool";
import type { FontKey } from "@/shared/fonts";
import { AUTH_TEXT } from "@/shared/auth-messages";
import { FontSettings } from "@/ui/d/FontSettings";
import { TrialLinks } from "@/ui/d/TrialLinks";

// 계정 영역은 요청 사용자에 따라 다르므로 정적 생성·공용 캐시를 쓰지 않는다.
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const viewer = await getViewer();
  let font: FontKey | null = null;
  if (viewer.kind === "user") {
    try {
      font = (await getPreferences(getAppDb(), viewer.userId)).fontKey;
    } catch {
      // 실패를 편집 가능한 기본값으로 대체하지 않는다.
    }
  }
  const withdrawEnabled = process.env.POD_WITHDRAWAL_ENABLED === "1";
  const withdrawUnavailable = !withdrawEnabled && sp.notice === "withdrawal_unavailable";
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>설정</h1>
        <p className="sub">나에게 맞게</p>
      </header>
      {withdrawUnavailable ? (
        <section className="notice" role="status" aria-live="polite">
          <p className="auth-msg">{AUTH_TEXT.withdrawUnavailable}</p>
        </section>
      ) : null}
      {viewer.kind === "fixture" ? <FontSettings /> : font ? <FontSettings mode="account" initialFont={font} /> : viewer.kind === "user" ? (
        <section className="notice" aria-labelledby="font-failed-h">
          <h2 id="font-failed-h">기록 글꼴을 불러오지 못했어요</h2>
          <p>잠시 뒤 다시 열어 주세요.</p>
        </section>
      ) : null}
      {viewer.kind === "user" ? (
        <section className="settings" aria-labelledby="acct-h">
          <h2 id="acct-h">{AUTH_TEXT.accountTitle}</h2>
          <p className="hint">{AUTH_TEXT.accountSignedIn}</p>
          <div className="row">
            <form action="/auth/logout" method="post">
              <button type="submit" className="btn-ghost">
                {AUTH_TEXT.logout}
              </button>
            </form>
            {withdrawEnabled ? (
              <Link className="text-btn" href="/account/withdraw">
                {AUTH_TEXT.withdrawSubmit}
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}
      {viewer.kind === "signed_out" ? (
        <section className="settings" aria-labelledby="acct-h">
          <h2 id="acct-h">{AUTH_TEXT.accountTitle}</h2>
          <div className="row">
            <Link className="text-btn" href={`/login?returnTo=${encodeURIComponent("/settings")}`}>
              {AUTH_TEXT.login}
            </Link>
          </div>
        </section>
      ) : null}
      <TrialLinks />
    </>
  );
}
