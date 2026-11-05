import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/server/context";
import { AUTH_TEXT } from "@/shared/auth-messages";

export const dynamic = "force-dynamic";

/** 탈퇴 확인(PLAN_mvp-oidc-integration §8). 탈퇴 gate가 닫혀 있으면 viewer를 보기 전에 설정으로 보낸다. */
export default async function WithdrawPage() {
  if (process.env.POD_WITHDRAWAL_ENABLED !== "1") redirect("/settings?notice=withdrawal_unavailable");
  const viewer = await getViewer();
  if (viewer.kind !== "user") redirect(`/login?returnTo=${encodeURIComponent("/settings")}`);

  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>{AUTH_TEXT.withdrawTitle}</h1>
      </header>
      <section className="settings" aria-labelledby="wd-h">
        <h2 id="wd-h">{AUTH_TEXT.withdrawHeading}</h2>
        <p id="wd-warn" className="auth-warn">
          {AUTH_TEXT.withdrawWarn}
        </p>
        <form action="/auth/withdraw" method="post" className="settings">
          <label className="auth-check">
            <input type="checkbox" name="confirm" value="withdraw" required aria-describedby="wd-warn" />
            {AUTH_TEXT.withdrawCheck}
          </label>
          <div className="row">
            <button type="submit" className="btn-ghost auth-danger">
              {AUTH_TEXT.withdrawSubmit}
            </button>
            <Link className="text-btn" href="/settings">
              {AUTH_TEXT.cancel}
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
