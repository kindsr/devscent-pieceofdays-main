import Link from "next/link";
import { cookies } from "next/headers";
import { readAuth } from "@/server/auth/http";
import { readRecovery, recoveryCookieOptions } from "@/server/auth/recovery-cookie";
import { AUTH_TEXT } from "@/shared/auth-messages";

export const dynamic = "force-dynamic";

/** 복구 확인(PLAN_mvp-oidc-integration §6.3·§8). 유효한 복구 증명(정확한 이름의 쿠키)이 있을 때만 복구 form을 보인다. */
export default async function RestorePage() {
  const auth = readAuth();
  const head = (
    <header className="board-head">
      <h1 tabIndex={-1}>{AUTH_TEXT.restoreTitle}</h1>
    </header>
  );
  if (!auth.ok) {
    return (
      <>
        {head}
        <section className="notice" aria-labelledby="nc-h">
          <h2 id="nc-h">{AUTH_TEXT.unavailable}</h2>
        </section>
      </>
    );
  }
  const name = recoveryCookieOptions(auth.value.session, new Date(0)).name;
  const proof = await readRecovery(auth.value.session, (await cookies()).get(name)?.value);
  if (!proof.ok) {
    return (
      <>
        {head}
        <section className="notice" aria-labelledby="rx-h">
          <h2 id="rx-h">{AUTH_TEXT.recoveryExpired}</h2>
          <div className="row">
            <Link className="text-btn" href="/login">
              {AUTH_TEXT.toLogin}
            </Link>
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      {head}
      <section className="notice" aria-labelledby="rs-h">
        <h2 id="rs-h">{AUTH_TEXT.restoreAsk}</h2>
        <div className="row">
          <form action="/auth/restore" method="post">
            <button type="submit" className="btn-main">
              {AUTH_TEXT.restoreYes}
            </button>
          </form>
          <form action="/auth/logout" method="post">
            <button type="submit" className="text-btn">
              {AUTH_TEXT.restoreNo}
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
