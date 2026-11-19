/**
 * 인증 화면 고정 문구(PLAN_mvp-oidc-integration §8, D 인증 아트보드). 서버 모듈을 import하지 않는다.
 * query 값은 이 표의 키와 정확히 같을 때만 문구로 바뀐다. query 문자열 자체는 화면에 쓰지 않는다.
 */

export const AUTH_TEXT = {
  loginTitle: "pieceofdays에 로그인",
  unavailable: "로그인을 준비하고 있어요",
  moving: "이동 중…",
  providersLabel: "로그인 방법",
  signedIn: "로그인됐어요",
  signedInBody: "기록 쓰기·불러오기는 다음 단계에서 연결돼요.",
  withdrawTitle: "계정 탈퇴",
  withdrawHeading: "탈퇴하기 전에 확인해 주세요",
  withdrawWarn: "탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요",
  withdrawCheck: "위 내용을 확인했어요",
  withdrawSubmit: "계정 탈퇴",
  withdrawUnavailable: "계정 탈퇴는 아직 준비 중이에요.",
  restoreTitle: "계정 복구",
  restoreAsk: "탈퇴를 요청한 계정이에요. 복구할까요?",
  restoreYes: "복구하기",
  restoreNo: "복구하지 않기",
  recoveryExpired: "확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요.",
  toLogin: "로그인 화면으로",
  accountTitle: "계정",
  accountSignedIn: "로그인되어 있어요.",
  logout: "로그아웃",
  login: "로그인",
  cancel: "취소",
  tryLink: "브라우저 기록장",
  statusLink: "개발 현황",
  tryNote: "체험판 기록은 이 브라우저에만 있고 계정으로 옮겨지지 않아요. 설정에서 내려받아 두세요.",
} as const;

/** /login?error=… (§6.3). error는 오류 테두리를 쓴다. */
export const LOGIN_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  cancelled: "로그인을 취소했어요. 다시 시도할 수 있어요.",
  failed: "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  expired: "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요.",
  purge_due: "복구 기간이 지나 이 계정을 되돌릴 수 없어요.",
});

/** /login?notice=… (§6.3). */
export const LOGIN_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  signed_out: "로그아웃했어요",
  withdrawn: "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요.",
});

/** 허용 목록의 자기 속성일 때만 문구를 돌려준다(배열·다른 형식·prototype 키는 null). */
export function allowListed(table: Readonly<Record<string, string>>, value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(table, value) ? (table[value] ?? null) : null;
}

/** 공급자 버튼(공식 에셋, public/auth/SOURCES.md). 보이는 글자를 접근 이름에 포함한다. */
export const PROVIDER_BUTTONS = {
  google: { src: "/auth/google/signin-light-rect-text@4x.png", alt: "Sign in with Google", lang: "en", extra: " (Google 계정으로 로그인)", width: 207, height: 46 },
  kakao: { src: "/auth/kakao/kakao_login_kr_medium.svg", alt: "카카오 로그인", lang: undefined, extra: "", width: 224, height: 46 },
} as const;
