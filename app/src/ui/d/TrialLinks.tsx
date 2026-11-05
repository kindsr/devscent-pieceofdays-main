import { AUTH_TEXT } from "@/shared/auth-messages";

/** 브라우저 기록장(/try/)·개발 현황(/status/) 안내. 정적 파일이라 Next Link가 아닌 일반 링크다. */
export function TrialLinks() {
  return (
    <section className="auth-trial">
      <p className="hint">{AUTH_TEXT.tryNote}</p>
      <div className="row">
        <a className="text-btn" href="/try/">
          {AUTH_TEXT.tryLink}
        </a>
        <a className="text-btn" href="/status/">
          {AUTH_TEXT.statusLink}
        </a>
      </div>
    </section>
  );
}
