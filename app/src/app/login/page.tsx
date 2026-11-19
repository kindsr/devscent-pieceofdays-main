import { redirect } from "next/navigation";
import { readAuth } from "@/server/auth/http";
import { parseReturnTo } from "@/server/auth/return-to";
import { getViewer } from "@/server/context";
import { AUTH_TEXT, LOGIN_ERRORS, LOGIN_NOTICES, allowListed } from "@/shared/auth-messages";
import { AuthProviderForms } from "@/ui/d/AuthProviderForms";
import { TrialLinks } from "@/ui/d/TrialLinks";

export const dynamic = "force-dynamic";

/** D 로그인 화면(PLAN_mvp-oidc-integration §8). 안내 문구는 허용 목록의 키로만 고르고 query 값을 쓰지 않는다. */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const viewer = await getViewer();
  if (viewer.kind === "user") redirect("/");

  const auth = viewer.kind === "signed_out" ? readAuth() : null;
  const providers = auth?.ok ? auth.value.enabled : [];
  const returnTo = parseReturnTo(sp.returnTo) ?? "/";
  const error = allowListed(LOGIN_ERRORS, sp.error);
  const notice = allowListed(LOGIN_NOTICES, sp.notice);

  return (
    <div className="auth-page">
      <header className="board-head">
        <h1 tabIndex={-1}>{AUTH_TEXT.loginTitle}</h1>
      </header>
      <p className="auth-lead">사진과 메모로 하루를 남기고 돌아보는 기록장이에요.</p>
      <div className="auth-body">
        {error ? (
          <section className="notice is-error" role="status" aria-live="polite">
            <p className="auth-msg">{error}</p>
          </section>
        ) : null}
        {notice ? (
          <section className="notice" role="status" aria-live="polite">
            <p className="auth-msg">{notice}</p>
          </section>
        ) : null}
        {providers.length > 0 ? (
          <AuthProviderForms providers={providers} returnTo={returnTo} />
        ) : (
          <section className="notice" aria-labelledby="nc-h">
            <h2 id="nc-h">{AUTH_TEXT.unavailable}</h2>
          </section>
        )}
        <TrialLinks />
      </div>
    </div>
  );
}
