import Link from "next/link";
import { getViewer } from "@/server/context";
import { AUTH_TEXT } from "@/shared/auth-messages";
import { FontSettings } from "@/ui/d/FontSettings";
import { TrialLinks } from "@/ui/d/TrialLinks";

// 계정 영역은 요청 사용자에 따라 다르므로 정적 생성·공용 캐시를 쓰지 않는다.
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const viewer = await getViewer();
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
      <FontSettings />
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
