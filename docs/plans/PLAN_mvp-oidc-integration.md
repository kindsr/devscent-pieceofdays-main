# PLAN — F4b/c Google·Kakao 실제 로그인·복구·탈퇴·요청별 DAL 연결 (초안 R0)

- **상태:** 독립 검토와 메인 수락 전의 **계획 초안**이다. 확정 계약이 아니다. 이 문서만으로 제품 코드·시험·SQL·설정·패키지·workflow·서버·실계정·DB·OAuth 콘솔을 바꾸지 않았다. 실제 로그인을 시도하지 않았고 패키지도 설치하지 않았다.
- **BASE:** `dev` `eaf9d4f468f6d652317ed3447b6eb8121ef42bed`.
  - 포함된 것: F4a codec `96bcf8c`, L1 `0876c4b`, L2 GREEN `ba2b1679a8ca7dae63cc5da314a04ef081f040ac`, RED `d534628`, 문서 `ba150c7`과 메인 상태 갱신.
  - 메인 수락 근거: L2 GREEN은 CI 41691842663·41691842754와 독립 PASS(P0·P1·P2 없음)를 거쳐 수락됐다.
  - **eaf9d4f의 통합 CI는 작성자가 직접 확인하지 않았다.** 완료로 단정하지 않는다.
- **선행 계약:**
  - [PLAN_mvp-authentication](PLAN_mvp-authentication.md) R4: §2~§5, §7, §9, §10
  - [PLAN_account-lifecycle](PLAN_account-lifecycle.md) R6: §2~§4, §7, §9
  - [DATA_CONTRACT](../product/DATA_CONTRACT.md), [디자인 핸드오프](../design/README.md)
  - 이 문서는 위 계약을 구현 단위로 구체화할 뿐이다. 새 기술 선택이나 정책 변경이 아니다.
- **표기:**
  - **[확정]** 사용자가 확정한 것
  - **[메인]** 메인이 정했거나 이미 수락한 계약
  - **[사실]** 코드나 공식 원문에서 직접 확인한 것
  - **[추론]** 작성자의 판단
  - **[제안]** 이 계획이 새로 내놓는 구현 값. 검토·메인 수락이 필요하다
  - **[미정]** 아직 결정되지 않은 것
  - **[미확인]** 확인하지 못한 것

## 0. 고정 전제 (재질문·조용한 변경 금지)

| 구분 | 내용 |
|---|---|
| [확정] | Google·Kakao 로그인 둘 다. 탈퇴 → 30일 복구 → 삭제. D 테마와 현재 화면 구조. canonical 계정당 첫 성공 로그인에 10개를 1회 지급 |
| [미정] 사용자 | 공급자 간 계정 연결. **단독 canonical 계정 흐름의 선행 조건이 아니다.** email 자동 연결·잔액 병합은 하지 않는다 |
| [메인] 기술 | `openid-client` **6.8.9**(F4b에서 설치), `iron-session` 9.0.1(설치됨), Next 16.4.3, Node 24.22.2·26.13.0, PG 18.6. 새 프레임워크·세션 DB·Redis·schema는 필요 없다 |
| [메인] 프로토콜 | PKCE S256·state·nonce·issuer·redirect를 검증한다. scope는 `openid`만 쓴다. token·email은 저장하지 않는다. code·cookie·secret은 로그에 남기지 않는다. issuer는 고정 허용 목록이다. 토큰 검증은 vendor에 맡기고 앱이 JWT를 직접 파싱하지 않는다 |
| [메인] 재생(R4 §3) | 짧은 수명의 브라우저 결합 봉인 flow 쿠키 + callback 응답에서 삭제 + 공급자 code 일회성 + F3 멱등. **서버 측 원자적 state 소비 저장소는 추가하지 않는다** |
| [메인] 세션 | F4a 공개 API를 그대로 재사용한다: payload 정확히 5키, 절대 7일, HTTPS일 때 `__Host-` 이름, 명시 Origin 검사. cfg·env 검증 계약을 약화하지 않는다 |
| [메인] 복구 | lifecycle §3·§9: fresh OAuth 검증 뒤 `pending_deletion` 결과의 userId·gen으로만 발급한다. 정확히 6키, `purpose:"account_recovery"`, 10분. 일반 세션으로 읽지 않는다. 철회된 일반 세션이나 withdraw 응답으로 증명을 만들지 않는다. restore는 POST·Origin·증명 검증을 거친다. 기한 만료는 거부하고 재지급은 0이다 |
| [메인] 결과 분기 | `LoginOutcome` union을 그대로 쓴다. `active`만 일반 세션을 받는다. `pending_deletion`은 세션 없이 복구 확인으로 간다. `purge_due`는 복구 불가·세션 없음이고 같은 요청에서 자동 재시도하지 않는다. 첫 지급은 검증된 OAuth와 `completeSuccessfulLogin` COMMIT 때 함께 켜진다 |
| [메인] DAL | 매 요청 `verifyActiveAccount(userId, gen)`. 미활성·없음·불일치는 "로그인 필요"다. 입력으로 받은 userId는 신뢰하지 않는다. 탈퇴 커밋 뒤의 새 요청만 차단하며, 이미 진행 중인 요청의 취소는 보장하지 않는다 |
| [메인] 배포 경계 | dev는 정적 D 시안이다. Next 앱과 서비스 DB는 F6 전까지 배포되지 않는다. 격리된 mock 시험 통과, 실제 Google·Kakao 로그인 검증, 실제 도메인 게시는 서로 다른 단계로 구분한다. F6 배포 프로그램·인프라를 편의상 완화하지 않는다 |

## 1. 현재 코드 사실 (BASE `eaf9d4f`)과 갭

**[사실] 있는 것:**

| 파일 | 공개 API |
|---|---|
| `server/auth/session.ts` | `SessionConfig`, `loadSessionConfig(env, nodeEnv)`, `sealSession`, `readSession`, `sessionCookieOptions`, `assertSameOrigin` |
| `server/account/login.ts` | `completeSuccessfulLogin(db, {provider, subject}) → Result<LoginOutcome, "invalid_identity">`. `provider` 형식은 `^[a-z][a-z0-9_-]{0,31}$` |
| `server/account/lifecycle.ts` | `SessionSubject`, `verifyActiveAccount`, `requestWithdrawal`(gen을 반환하지 않음), `restoreAccount` |
| `server/db/pool.ts` | `getAppDb()`: `POD_DATABASE_URL`로 지연 생성, 없으면 throw. `withTransaction` |
| `server/context.ts` | **동기** `getDiaryContext(): DiaryContext`. fixture가 아니면 `{kind:"unavailable"}` |
| `shared/diary.ts` | `DiaryContext = fixture \| unavailable` |
| `server/runtime-mode.ts` | `POD_LOCAL_FIXTURE`. 운영 단계에서 거부한다. `next.config.ts`가 순수 Node 경로로 호출한다 |

- **[사실] 호출 지점:**
  - `getDiaryContext()`는 `app/layout.tsx`(TopBar `canWrite`), `app/page.tsx`, `app/days/page.tsx`, `app/days/[date]/page.tsx`에서 부른다.
  - `/settings`는 클라이언트 `FontSettings`만 쓴다(메모리 전용).
  - UI는 `TopBar`, `NotConnected`, `DayBoard`, `DaysView`, `MonthCalendar`, `FontSettings`다.
- **[사실] 경로:** `/`, `/days`, `/days/[date]`, `/settings`, `/dev/konva-smoke`(시험 fixture, 운영 404).
- **[사실] 시험 기준선:**
  - 단위 122, 빌드 경계 4, prod 6, E2E 12. 모두 Node 24.22.2·26.13.0 matrix다.
  - DB 138(PG18.6 + Node 26), root 42.
  - E2E는 `next dev` + `POD_LOCAL_FIXTURE=1`(127.0.0.1:3100)이고, prod smoke는 `next start`(127.0.0.1:3200, 3201)다.
- **[사실] `.claude/tdd.conf` TEST_PATTERNS:** `tests/* .claude/tdd.conf app/tests/* app/vitest*.ts app/playwright*.ts`.

**갭 (이번 계획 범위):**
- `openid-client` 미설치. 공급자 설정·flow 쿠키·복구 쿠키·returnTo 검사·callback·start·logout·withdraw·restore route가 없다.
- 요청별 세션 읽기와 DAL이 없다. `getDiaryContext`가 동기다.
- 로그인·확인·탈퇴·복구·오류 화면이 없다. mock OIDC issuer와 인증 E2E도 없다.

## 2. 목표·비목표·의존성

- **목표:**
  1. Google·Kakao OIDC 로그인 → `completeSuccessfulLogin` → 결과별 세션·복구 쿠키.
  2. 요청별 DAL(`verifyActiveAccount`).
  3. 탈퇴·복구·로그아웃 POST.
  4. D 화면 상태.
  5. 격리 mock issuer 기반 시험.
  6. 실제 공급자 검증 절차 문서화.
- **비목표:**
  - 화면의 PG 기록 읽기·쓰기 연결(F5). 이번 범위의 로그인 사용자 화면 처리는 §7 제안을 본다.
  - 공급자 간 계정 연결.
  - purge 실행 주기·백업·SLA(F6).
  - 사진·AI·공유.
  - 서비스 DB 프로비저닝·실도메인 배포(F6).
  - 개인정보 보관 정책 신설.
- **의존성:**
  - 이 계획의 독립 검토와 메인 수락.
  - B0 패키지 설치 승인.
  - Kakao 활성화는 §9의 실제 PKCE 수락 검증을 통과해야 한다.
  - 실제 로그인은 사용자의 콘솔 설정이 끝나야 한다(부록 A).

## 3. slice 순서·소유·활성화 경계

| slice | 소유(RED: TEST_PATTERNS 안 / GREEN: 그 밖) | 내용 | 활성화 경계 |
|---|---|---|---|
| **B0 패키지** | `app/package.json`, `app/package-lock.json` | `openid-client` **6.8.9 exact 추가만** 한다. Node 24·26에서 `npm ci`·`npm ls --all`·기존 회귀를 통과해야 한다. 제품 코드는 없다 | 호출부 없음 |
| **B1 codec·설정** | RED `app/tests/unit/auth-config.test.ts`·`auth-flow-cookie.test.ts`·`auth-recovery-cookie.test.ts`·`return-to.test.ts` / GREEN `app/src/server/auth/{config,flow-cookie,recovery-cookie,return-to,cookie-util}.ts`, `server/runtime-mode.ts`(mock·fixture 거부 추가), `next.config.ts`(호출 1줄) | §4·§5의 env 판정, 쿠키 3종 목적 분리, returnTo 허용 목록 | route 없음 → 발급 경로 없음 |
| **B2 OIDC·처리 함수** | RED `app/tests/support/mock-oidc-issuer.ts`, `app/tests/unit/auth-oidc.test.ts`, `app/tests/db/f4-auth-handlers.test.ts` / GREEN `app/src/server/auth/{oidc,handlers}.ts` | openid-client 어댑터와 start·callback·logout·withdraw·restore 처리 함수(Next 타입 없는 `HandlerResult`) | **route 파일 없음.** 시험만 호출한다 → 실제 요청으로 세션·지급이 생기지 않는다 |
| **B3 요청 context·DAL** | RED `app/tests/unit/request-context.test.ts`, `app/tests/db/f4-dal.test.ts`, 기존 `e2e`·`prod` 기대값 유지 확인 / GREEN `app/src/server/context.ts`, `shared/diary.ts`, 4개 page·layout의 `await` 전환 | 동기 → async, fixture·user·signed_out·unavailable 구분 | 세션 발급 route가 없어 `user`에 도달하는 경로는 시험뿐이다. 운영 기본(env 없음)은 지금과 같은 "준비 중" |
| **B4-d 상태 화면 설계 검증** | 디자인 담당(별도 배정): `docs/design/concepts/d-warm-pieces/`에 상태 아트보드 추가. 게시 사본 갱신 여부는 메인이 정한다 | §8의 화면을 D 토큰·컴포넌트로 375/768/1440 확인 | 문서·시안만 |
| **B4 활성화** | RED `app/tests/e2e-auth/*.spec.ts`, `app/playwright.auth.config.ts`, `app/tests/prod/prod-boundary.spec.ts`(사례 추가), `app/tests/auth-build-boundary.test.mjs`(신규 모듈 사례) / GREEN `app/src/app/auth/[provider]/{start,callback}/route.ts`, `app/src/app/auth/{logout,withdraw,restore}/route.ts`, `app/src/app/{login,account/withdraw,account/restore}/page.tsx`, `src/ui/d/*` 신규 컴포넌트, `settings/page.tsx`, `TopBar.tsx`, `.github/workflows/app-validation.yml`(auth E2E job) | route·화면·E2E를 **한 PR에서** 켠다 | `POD_AUTH_PROVIDERS`가 설정된 환경에서만 로그인 버튼과 route가 동작한다. 실제 로그인과 첫 지급이 동시에 켜진다 |
| **B5 실제 공급자 검증** | 사용자·메인(credential 필요). 저장소 변경 없음, 결과는 문서 | 부록 A 콘솔 설정 → §9 절차 → 개발 PC localhost 실로그인 | Kakao는 B5 통과 전까지 `POD_AUTH_PROVIDERS`에 넣지 않는다 |
| **F6** | 메인 | 서비스 DB·실도메인 redirect·운영 env·배포 | 범위 밖 |

- 각 slice는 RED → 독립 runner → GREEN(시험 변경 0) → 독립 검토 → 메인 통합 순서를 따른다.
- 단계마다 기존 기준선(단위 122·빌드 경계 4·prod 6·E2E 12·DB 138·root 42)을 유지한다. 신규 시험 수는 잠그지 않는다.
- **부분 연결 금지 [제안]:**
  - B2·B3에서는 세션·복구 쿠키를 발급하는 HTTP 경로를 만들지 않는다.
  - 지급 함수의 새 호출자는 B2 `handleCallback` 하나뿐이고, 그 호출자는 B4 route만 쓴다.
  - B4 PR이 되돌려지면 route와 버튼이 함께 사라진다.

## 4. 설정·env (이름만, 값은 문서·로그에 쓰지 않는다)

| env | 상태 | 형식·검증 |
|---|---|---|
| `POD_AUTH_SESSION_SECRETS`, `POD_AUTH_BASE_URL` | 기존(F4a §5.2) | `loadSessionConfig`를 **그대로** 호출한다. 실패 코드도 그대로 전달한다 |
| `POD_AUTH_PROVIDERS` | **신규 [제안]** | 쉼표 목록이고 각 항목은 `google` 또는 `kakao`다. 순서는 화면 버튼 순서다. 공백 없음, 중복 거부, 빈 항목 거부 |
| `POD_AUTH_GOOGLE_CLIENT_ID`·`_SECRET`, `POD_AUTH_KAKAO_CLIENT_ID`·`_SECRET` | 기존 이름(R4 §7) | `PROVIDERS`에 있는 공급자는 둘 다 필수다. trim 후 비어 있지 않고, 앞뒤 공백·제어문자가 없어야 한다(변형하지 않고 거부). 길이 하한은 vendor 형식을 모르므로 만들지 않는다 [제안] |
| `POD_DATABASE_URL` | 기존 | `getAppDb()`의 지연 연결. 없거나 연결에 실패하면 "사용 불가"이고 세션을 발급하지 않는다 |
| `POD_AUTH_MOCK_OIDC_ISSUER` | **신규, 시험 전용 [제안]** | `nodeEnv`가 정확히 `development`·`test`이고 값이 정확히 `http://127.0.0.1:<port>`(path·userinfo·query 없음)일 때만 받는다. 이때 각 공급자 issuer를 `<값>/google`·`<값>/kakao`로 바꾸고 그 설정에만 `allowInsecureRequests`를 적용한다 |
| `POD_LOCAL_FIXTURE` | 기존 | fixture 사용자(개발·시험 전용) |

**`loadAuthConfig(env, nodeEnv)` 판정 (위에서부터) [제안]:**

| 순서 | 조건 | 결과 |
|---|---|---|
| 1 | `POD_AUTH_PROVIDERS`가 없거나 trim 후 빈 문자열 | `auth_not_configured`(로그인 숨김, 지금 운영 기본과 같음) |
| 2 | `loadSessionConfig`가 `auth_not_configured` | `auth_not_configured` |
| 3 | `loadSessionConfig`가 `invalid_config`(운영의 http·loopback base 포함) | `invalid_config` |
| 4 | PROVIDERS의 형식 오류·모르는 이름·중복 | `invalid_config` |
| 5 | 목록에 있는 공급자의 ID·SECRET이 없거나 형식 오류 | `invalid_config`(부분 활성화 없음, 전체 fail closed) |
| 6 | 목록에 없는 공급자의 ID·SECRET이 있음 | 무시한다(읽지 않음). Kakao 검증 전 사전 배치를 허용한다 |
| 7 | MOCK이 있는데 nodeEnv가 development·test가 아니거나 형식이 다름 | `invalid_config` |
| 8 | `POD_LOCAL_FIXTURE=1`과 PROVIDERS가 함께 있음 | **throw**(시작 거부). 예시 사용자와 실제 사용자를 섞지 않는다 |
| 9 | 통과 | `ok`: issuer는 아래 상수(또는 개발·시험 MOCK), `redirectUri = new URL("/auth/<id>/callback", session.baseUrl)` |

- **issuer 허용 목록 상수 [메인·사실]:**
  - `google` → `https://accounts.google.com`
  - `kakao` → `https://kauth.kakao.com`
  - 두 값은 2026-11-03 discovery에서 확인했다(§11). 운영에서 env로 바꾸는 경로는 없다.
- **운영 단계 거부 [제안]:**
  - `runtime-mode.ts`에 `assertAuthModeAllowed(phase, env)`를 추가한다. 순수 Node 경로이고 `server-only`는 없다.
  - `next.config.ts`가 이를 호출한다. `phase-production-build`·`phase-production-server`·`phase-export`에서 `POD_AUTH_MOCK_OIDC_ISSUER`가 있으면 throw한다(fixture 거부와 같은 방식).
- **판정 시점:** build는 비밀 없이 성공한다. 검사는 요청 시점에 한다(R4 §7). 단, 7·8행과 운영 단계의 MOCK 거부는 시작 시점에도 확인한다.

```ts
// app/src/server/auth/config.ts  (import "server-only")
export type ProviderId = "google" | "kakao";
export const PROVIDER_ISSUERS: Readonly<Record<ProviderId, string>>;
export type ProviderConfig = Readonly<{ id: ProviderId; issuer: URL; clientId: string; clientSecret: string; redirectUri: URL; insecureMock: boolean }>;
export type AuthConfig = Readonly<{ session: SessionConfig; enabled: readonly ProviderId[]; providers: Readonly<Partial<Record<ProviderId, ProviderConfig>>> }>;
export function loadAuthConfig(env: Record<string, string | undefined>, nodeEnv: string | undefined):
  Result<AuthConfig, "auth_not_configured" | "invalid_config">;
```

## 5. 쿠키 3종과 목적 분리

| 쿠키 | 이름(secure / 개발 http) | payload(정확한 키) | 수명 | 발급 | 삭제 |
|---|---|---|---|---|---|
| 세션 [메인 F4a] | `__Host-pod_session` / `pod_session` | `{v,userId,gen,iat,exp}` 5키 | 절대 7일 | callback `active`, restore 성공 | logout, withdraw, callback의 pending·purge_due, restore 성공 직전(새 값으로 교체) |
| 복구 [메인 lifecycle §3] | `__Host-pod_recovery` / `pod_recovery` | `{purpose:"account_recovery",v:1,userId,gen,iat,exp}` 6키 | **≤ 10분**: iron `ttl: 600` 명시 + 자체 `exp−iat ≤ 600_000` | callback `pending_deletion`에서만 | restore(성공·실패 모두), logout, callback `active`·`purge_due` |
| flow [제안] | `__Host-pod_oauth` / `pod_oauth` | `{purpose:"oauth_flow",v:1,provider,issuer,state,nonce,codeVerifier,returnTo,iat,exp}` 10키 | **≤ 10분 [제안]**: iron `ttl: 600` + `exp−iat ≤ 600_000` | start(덮어쓰기, 한 번에 하나) | **callback 응답에서 항상**(성공·실패·취소). 다음 start에서 덮어쓴다 |

- **공통 속성:** `HttpOnly`, `Path=/`, `SameSite=Lax`, Domain 없음. Secure 여부는 `cfg.secureCookies`를 따른다.
  - 이름 분기는 `sessionCookieOptions`의 규칙과 같다. `__Host-`는 Secure와 `Path=/`가 필수다.
  - 삭제는 같은 이름·속성에 빈 값, `Max-Age=0`, `Expires=1970`을 쓴다.
- **SameSite=Lax와 callback:** 공급자에서 돌아오는 요청은 최상위 GET 이동이므로 Lax 쿠키가 전송된다. `response_mode`는 `query`만 쓴다(form_post 미사용) [추론, RFC 6265bis Lax 규칙].
- **봉인 키:** 세 쿠키 모두 `POD_AUTH_SESSION_SECRETS` 번호 키 맵을 쓴다. 새 비밀 env는 없다. 목적 분리는 `purpose`·정확한 키 수로 한다.
  - 일반 세션 5키는 복구·flow reader에서 `invalid`다.
  - 복구 6키·flow 10키는 `readSession`에서 `invalid`다([사실] `readSession`은 정확히 5키만 받는다).
- **재사용 규칙:**
  - 세션 봉인·읽기·이름은 `sealSession`·`readSession`·`sessionCookieOptions`만 쓴다. 복제하거나 바꾸지 않는다.
  - 새 codec은 F4a의 판정 원칙을 따른다: `missing`은 사전 판정, iron 실패와 `{}`는 `invalid`, raw reason은 쓰지 않음, 자체 `exp`와 `cfg.now()`, 미래 `iat`는 `invalid`. 코드는 별도 모듈이다.
- **최초 iat 연장 없음:** DAL·화면 요청에서 세션을 다시 봉인하지 않는다(sliding 없음). 새 세션은 새 인증 사건(callback `active`, restore 성공)에서만 만든다.

```ts
// app/src/server/auth/flow-cookie.ts  (import "server-only")
export type FlowInput = { provider: ProviderId; issuer: string; state: string; nonce: string; codeVerifier: string; returnTo: string };
export function sealFlow(cfg: SessionConfig, f: FlowInput): Promise<{ value: string; expiresAt: Date }>;   // 형식 위반은 throw
export function readFlow(cfg: SessionConfig, sealed: string | undefined):
  Promise<Result<FlowInput & { expiresAt: Date }, "missing" | "invalid" | "expired">>;
export function flowCookieOptions(cfg: SessionConfig, expiresAt: Date):
  { name: "__Host-pod_oauth" | "pod_oauth"; httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date };

// app/src/server/auth/recovery-cookie.ts  (import "server-only")
export function sealRecovery(cfg: SessionConfig, s: SessionSubject): Promise<{ value: string; expiresAt: Date }>;   // UUID·gen 위반은 throw
export function readRecovery(cfg: SessionConfig, sealed: string | undefined):
  Promise<Result<{ userId: string; gen: number; expiresAt: Date }, "missing" | "invalid" | "expired">>;
export function recoveryCookieOptions(cfg: SessionConfig, expiresAt: Date):
  { name: "__Host-pod_recovery" | "pod_recovery"; httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date };
```

- **flow 값 검사 [제안]:**
  - `provider`가 허용 목록에 있고, `issuer`가 그 공급자의 현재 설정 issuer 문자열과 같아야 한다.
  - `state`·`nonce`·`codeVerifier`는 base64url 43자다([사실] vendor `randomState`·`randomNonce`·`randomPKCECodeVerifier`는 32바이트를 base64url로 만든다).
  - `returnTo`는 아래 `parseReturnTo`를 통과해야 한다. 하나라도 어긋나면 `invalid`다.

**returnTo 허용 목록 [제안, 현행 경로와 대조]:**

```ts
// app/src/server/auth/return-to.ts  (import "server-only")
export function parseReturnTo(raw: unknown): "/" | "/days" | "/settings" | `/days/${string}` | null;
```

| 입력 | 결과 |
|---|---|
| `/`, `/days`, `/settings` | 그대로 |
| `/days/YYYY-MM-DD`(`parseLocalDate` 통과) | 그대로 |
| 그 밖: `/login`, `/auth/…`, `/account/…`, `/dev/…`, `//x`, `/\x`, `https://…`, `/days/2026-02-30`, 끝 슬래시, query·hash 포함, 퍼센트 인코딩, 64자 초과, 문자열이 아님 | `null` → 호출자가 `/`를 쓴다 |

- 정확 일치와 정규식만 쓴다. URL 파싱으로 "같은 origin"을 판단하지 않는다.
- 최종 Location은 항상 `new URL(returnTo, cfg.baseUrl)`이다. **요청 Host·`X-Forwarded-*`·`request.url`로 redirect를 만들지 않는다.**

## 6. OIDC 어댑터·처리 함수·route

### 6.1 openid-client 6.8.9 사용 [사실 = 패키지 원문 확인, §11]

- **discovery:** `discovery(issuerURL, clientId, clientSecret, ClientSecretPost(clientSecret), { execute })`.
  - Issuer Identifier를 넘기면 vendor가 메타데이터 `issuer` 일치를 검사한다. well-known URL을 직접 넘기면 이 검사가 꺼지므로 쓰지 않는다.
  - 공급자별로 Configuration Promise를 프로세스 메모리에 둔다. 사용자 정보가 없으므로 사용자 간 공유가 문제되지 않는다. 실패한 Promise는 캐시하지 않는다.
- **client 인증:** Kakao는 `client_secret_post`만 광고하고, Google은 post·basic을 광고한다. 둘 다 `ClientSecretPost`를 쓴다.
- **시작:**
  - `randomPKCECodeVerifier()`, `calculatePKCECodeChallenge(v)`, `randomState()`, `randomNonce()`.
  - `buildAuthorizationUrl(config, { redirect_uri, scope: "openid", response_type: "code", code_challenge, code_challenge_method: "S256", state, nonce })`.
  - `prompt` 등 추가 매개변수는 [미정]이며 이번에는 쓰지 않는다.
- **callback:** `authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true })`.
  - `currentUrl`은 `request.url`이 아니다. **설정된 `redirectUri`를 복사한 URL에 들어온 query만 옮겨 담는다.**
  - [사실] vendor는 `currentUrl`에서 query를 뺀 값을 토큰 요청의 `redirect_uri`로 보낸다. 그래서 Host 헤더가 redirect_uri에 섞이지 않게 해야 한다.
- **vendor가 검사하는 것 [사실]:**
  - 인가 응답 `validateAuthResponse`: `iss` 매개변수(메타데이터가 `authorization_response_iss_parameter_supported`면 필수, 있으면 일치) → `state` 정확 일치 → `error`.
  - **state를 error보다 먼저 검사한다.**
  - ID Token: `aud`·`exp`·`iat`·`iss`·`sub` 존재, `iss` 일치, `aud`에 client_id 포함(배열이면 `azp`), `nonce` 일치. `expectedNonce`를 주면 ID Token이 필수다.
  - PKCE 대조는 **공급자 token endpoint가** 한다.
- **[사실] 서명 검증 기본값 주의:**
  - openid-client 6.8.9는 token endpoint에서 TLS로 직접 받은 ID Token의 **JWS 서명을 기본으로 검증하지 않는다**(문서: TLS 서버 검증으로 issuer를 대신 확인한다).
  - R4 §4의 "서명 검증을 vendor에 위임"을 문자 그대로 지키려면 discovery `execute`에 **`enableNonRepudiationChecks`**를 넣어야 한다. 이 옵션에는 `jwks_uri`가 필요하며, 두 공급자 모두 jwks_uri가 있다.
  - **[제안]** 켠다. 앱은 JWT를 파싱하지 않고 `tokens.claims()`(vendor가 검증한 결과)에서 `sub`만 읽는다.
  - 메인이 끄기로 하면 R4 §4 문구를 따로 바꿔야 한다. 이 계획은 R4를 고치지 않는다.
- **mock만:** `execute`에 `allowInsecureRequests`를 넣는다. `insecureMock`이 true일 때만이다(§4 7행).
- **토큰 처리:** access·refresh token과 ID Token 원문은 저장·전달·로그하지 않는다. userinfo를 호출하지 않는다. `sub` 외 claim을 쓰지 않는다.
- **오류 로그:** vendor 오류 객체의 `cause`·`parameters`·`claims`·`body`에는 code·state·claim이 들어 있다. 오류 객체를 통째로 로그에 남기지 않는다. 기록은 `{ provider, stage, name, code }` 허용 목록 필드만 쓴다 [제안].

### 6.2 처리 함수 (Next 타입 없음 → 단위·DB 시험 가능) [제안]

```ts
// app/src/server/auth/handlers.ts  (import "server-only")
export type CookieEffect =
  | { op: "set"; name: string; value: string; options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } }
  | { op: "delete"; name: string; secure: boolean };
export type HandlerResult = { status: 303 | 403 | 404; location?: URL; cookies: CookieEffect[] };   // location은 cfg.baseUrl 기준 절대 URL
type AuthR = Result<AuthConfig, "auth_not_configured" | "invalid_config">;
export function handleStart(auth: AuthR, provider: string, origin: string | null, form: FormData): Promise<HandlerResult>;
export function handleCallback(auth: AuthR, getDb: () => Db, provider: string, query: URLSearchParams, cookies: { flow?: string }): Promise<HandlerResult>;
export function handleLogout(auth: AuthR, origin: string | null): HandlerResult;
export function handleWithdraw(auth: AuthR, getDb: () => Db, origin: string | null, form: FormData, cookies: { session?: string }): Promise<HandlerResult>;
export function handleRestore(auth: AuthR, getDb: () => Db, origin: string | null, cookies: { recovery?: string }): Promise<HandlerResult>;
```

- **route 파일(B4):** `HandlerResult`를 `NextResponse`(status, Location, `response.cookies.set`·`delete`)로 옮기기만 한다. 모든 응답에 `Cache-Control: no-store`를 붙이고, callback에는 `Referrer-Policy: no-referrer`도 붙인다 [제안].
- **runtime:** route handler 기본값인 Node.js runtime을 쓴다. `pg`가 Node 전용이다.

### 6.3 HTTP 표 [제안, 경로는 계획안]

오류·안내 값은 고정 허용 목록이다. `error ∈ {unavailable, cancelled, failed, expired, purge_due}`, `notice ∈ {signed_out, withdrawn}`. 화면은 이 키로 **고정 문구**만 보여 주며, 질의 문자열을 그대로 반영하지 않는다.

| 경로 | 메서드 | 조건·순서 | 응답 | 쿠키 | DB |
|---|---|---|---|---|---|
| `/login` | GET(page) | viewer가 `user`면 → `redirect("/")`(307). `unavailable`이면 "로그인 준비 중". 그 밖에는 `enabled` 공급자 버튼(form POST)과 `returnTo`(hidden, 서버에서 다시 검사) | 200 | 없음 | 없음 |
| `/auth/{p}/start` | POST | ① `assertSameOrigin` 실패 → **403** ② auth 미설정·invalid → 303 `/login?error=unavailable` ③ `p`가 `enabled`에 없음 → **404** ④ discovery 실패 → 303 `/login?error=unavailable` ⑤ 성공 | 303 → 공급자 authorize URL | ⑤에서만 flow set(덮어쓰기). ①~④는 변화 없음 | 없음 |
| `/auth/{p}/callback` | GET | ① auth 미설정 → 303 `/login?error=unavailable` ② `p` 미허용 → 404 ③ flow `missing`·`invalid`·`expired` → `expired` ④ flow.provider ≠ p 또는 flow.issuer ≠ 설정 issuer → `failed` ⑤ vendor 검증(state → error → code 교환 → ID Token). `error=access_denied` → `cancelled`, 그 밖 → `failed` ⑥ DB 미설정·연결·쿼리 실패 → `failed` ⑦ `invalid_identity` → `failed` ⑧ outcome 분기(아래) | 303 | **모든 분기에서 flow delete**(①·② 제외: cfg가 없으면 이름을 알 수 없다) | ⑧에서만 |
| ⑧ `active` | | `sealSession({userId,gen})` | 303 returnTo | session set, recovery delete | 계정·지급(F3 멱등) COMMIT |
| ⑧ `pending_deletion` | | `sealRecovery({userId,gen})` | 303 `/account/restore` | recovery set, session delete | **쓰기 0** |
| ⑧ `purge_due` | | 재시도 없음 | 303 `/login?error=purge_due` | session·recovery delete | 쓰기 0 |
| `/auth/logout` | POST | Origin 실패 → 403 | 303 `/login?notice=signed_out` | session·recovery delete | 없음 |
| `/account/withdraw` | GET(page) | viewer `user`만. 그 밖에는 `/login?returnTo=/settings` | 200: 설명 + 확인 form | 없음 | DAL SELECT |
| `/auth/withdraw` | POST | ① Origin 실패 → 403 ② form `confirm=withdraw`가 없음 → 303 `/account/withdraw` ③ `readSession`이 ok가 아님 → 303 `/login` ④ `requestWithdrawal` → ok(`changed` 무관) | 303 `/login?notice=withdrawn` | ③·④ 모두 session delete | ④: pending·gen+1(첫 요청), 중복은 불변 |
| ④ `stale_session`·`not_found` | | | 303 `/login?notice=signed_out` | session delete | 변화 없음 |
| `/account/restore` | GET(page) | recovery `readRecovery`가 ok면 확인 UI(복구 POST + 취소 = logout POST). 아니면 "확인 시간이 지났어요" + 다시 로그인 링크 | 200 | 없음(Server Component는 쿠키를 쓰지 못한다 [사실]) | 없음 |
| `/auth/restore` | POST | ① Origin 실패 → 403 ② recovery가 ok가 아님 → `expired` ③ `restoreAccount(db, proof)` | 아래 | **②·③ 모든 분기에서 recovery delete** | |
| ③ ok `{gen}` | | `sealSession({userId, gen})` | 303 `/` | session set | active·gen+1, 지급 없음 |
| ③ `expired` | | | 303 `/login?error=purge_due` | 없음 | 변화 없음 |
| ③ `stale_proof`·`not_found` | | | 303 `/login?error=expired` | | 변화 없음 |
| ③ `not_pending` | | 다른 탭에서 이미 복구됨. **세션을 발급하지 않는다** | 303 `/login` | | 변화 없음 |

- **403 응답:** 본문은 짧은 고정 문구다. 쿠키·DB 변화 없음. 시작 route는 POST만 export하므로 GET은 Next가 405로 처리한다 [추론, route 규약].
- **start를 POST로 하는 이유 [제안]:** cross-site GET으로 flow를 시작해 진행 중인 flow 쿠키를 덮어쓰는 것을 막는다. HTML form(JS 없이)으로 동작하고, 브라우저는 form POST에 `Origin`을 보낸다 [추론].
- **mix-up 방어:**
  - 공급자별 callback 경로
  - flow에 봉인한 provider·issuer
  - vendor `iss` 검사: Google은 인가 응답 `iss`가 필수(메타데이터 `true`), Kakao는 메타데이터에 이 항목이 없어 ID Token `iss`만 검사한다

### 6.4 재생·동시성 경계 (R4 §3을 그대로 기록)

| 상황 | 결과 | 보장 근거 |
|---|---|---|
| callback 성공 뒤 같은 URL 재요청(쿠키 삭제됨) | `expired`, DB 변화 없음 | 브라우저 쿠키 삭제 |
| 삭제 전 같은 code·쿠키로 동시 callback 2건, 또는 복사한 쿠키+URL 재생 | 앱 state 대조를 **둘 다 통과할 수 있다**. 같은 code 재교환은 공급자가 거부할 수 있다 [미확인: 실제 Google·Kakao 동작]. 둘 다 통과해도 같은 userId·지급 1회 | 공급자 code 일회성 + F3 멱등. **앱 서버의 state 재사용 거부는 보장하지 않는다** |
| 탭 두 개에서 로그인 시작 | 나중 start가 flow를 덮어쓴다 → 먼저 시작한 callback은 state 불일치(`failed`) 또는 `expired` | flow 쿠키 하나 |
| 로그인과 탈퇴 경합 | lifecycle §9: 행 잠금으로 직렬화. 로그인이 먼저면 옛 gen 세션이 나가지만 다음 요청 DAL에서 거부 | L2 |
| 세션 쿠키 Set-Cookie 실패(응답 유실) | 지급은 COMMIT된 채 남는다. 재로그인하면 `granted=false` | R4 §2 |

## 7. 요청 context·DAL (B3)

```ts
// app/src/shared/diary.ts  (UI 공유 타입, server import 없음)
export type DiaryContext =
  | { kind: "fixture"; userId: string; store: DiaryStore; today: string }   // 기존 그대로
  | { kind: "signed_in" }                                                     // 실제 사용자. F5 전에는 기록 store 없음
  | { kind: "signed_out" }
  | { kind: "unavailable" };

// app/src/server/context.ts  (import "server-only")
export type RequestViewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };
export const getViewer: () => Promise<RequestViewer>;          // React cache로 한 요청 렌더 안에서만 memo
export async function getDiaryContext(): Promise<DiaryContext>;
```

**`getViewer` 순서 [제안]:**
1. `isFixtureModeEnabled(process.env)`이면 `fixture`. 기존 개발·시험 전용이며 운영에서는 throw한다. fixture userId `local-fixture-user`는 UUID가 아니므로 PG 함수에 넘겨도 SQL 전에 거부된다 [사실 `isUuid`]. 메모리 store만 쓴다.
2. `loadAuthConfig`가 실패하면 `unavailable`(설정 미비·오류).
3. `(await cookies()).get(sessionCookieOptions(cfg, now).name)` → `readSession`. 다른 이름으로 fallback하지 않는다(R4 §5.3 (3)).
4. 결과가 ok가 아니면 `signed_out`. `missing`·`invalid`·`expired`를 같게 처리한다(R2 P2 (1)).
5. `getAppDb()` → `verifyActiveAccount`. throw(미설정·연결 실패)면 `unavailable:db_unavailable`. 접근을 허용하지 않고, "로그인 필요"로 위장하지도 않는다.
6. false면 `signed_out`. true면 `user`.

- **격리:**
  - viewer는 React `cache`(요청 단위)에만 memo한다. 모듈 전역에 사용자 정보를 두지 않는다.
  - user 화면은 `force-dynamic`을 유지한다. `cookies()` 사용으로도 동적이다.
  - `"use cache"`·정적 생성을 쓰지 않는다. 동적 응답의 `Cache-Control`이 private·no-store인지는 prod 시험으로 확인한다 [미확인].
- **layout 주의 [사실, Next 인증 가이드]:** layout은 Partial Rendering 때문에 이동할 때마다 다시 렌더되지 않는다. 그래서 `layout.tsx`의 viewer는 TopBar 표시(로그인 링크, 조각 추가 버튼)에만 쓰고, **각 page·route가 따로 `getViewer()`를 호출한다.**
- **호출 지점 영향:**

| 파일 | 변경 |
|---|---|
| `app/layout.tsx` | `async` + `await getDiaryContext()`. `canWrite = kind === "fixture"`(지금과 같음). TopBar에 `viewer: "fixture" \| "signed_in" \| "signed_out" \| "unavailable"` 전달 |
| `app/page.tsx`, `days/page.tsx`, `days/[date]/page.tsx` | `await`. `fixture` → 지금과 같음. `unavailable` → `NotConnected`(지금과 같음, prod smoke 유지). `signed_out` → `redirect("/login?returnTo=<그 경로>")`(경로는 서버가 아는 상수·검증된 날짜로 만든다). `signed_in` → §8의 "로그인됨, 기록 연결 전" 안내 |
| `settings/page.tsx` | 서버 page가 viewer에 따라 계정 영역(로그아웃 form, 탈퇴 링크 / 로그인 링크 / fixture 안내)을 붙인다. `FontSettings`는 메모리 그대로다(계정 저장은 F5) |
| `ui/d/DaysView.tsx` | 타입 `Extract<…, fixture>` 그대로 |

- **[제안·메인 결정 필요] 로그인 사용자의 기록 화면:** F5 전에는 기록 읽기·쓰기를 PG에 연결하지 않고 `signed_in` 안내를 보인다. 메모리 작성 UI를 보이지 않아 저장 성공처럼 보이지 않게 한다.
  - 대안: B4에서 `createPgDiaryStore`의 읽기(`getDay`·`listMonth`)만 연결하는 읽기 전용 화면. 범위·시험이 커지므로 기본안은 연결하지 않는 것이다.
- **잔액 표시:** [미정] (잔액 표시 시점). 화면에 표시하지 않는다.

## 8. D 화면 상태 (B4-d 설계 검증 → B4 구현)

[사실] D 핸드오프 §1은 "로그인·감정 덩어리…"를 **아트보드 없음**으로 기록한다. 아래는 **설계 미확인**이다. 새 색·레이아웃·3안 재선택 없이 D 토큰(`--bg/--surface/--ink/--muted/--accent/--focus`, 오류 `#8E2A12`)과 기존 클래스(`.board-head`, `.notice`, `.btn-main`·`.btn-add` 계열, `.text-btn`, `.settings`)만 쓴다.

| 화면 | 기반 컴포넌트·클래스 | 핵심 문구(한국어, 고정) [제안] | 상태 |
|---|---|---|---|
| 로그인 `/login` | `board-head` + `notice` 카드 + 공급자 버튼 2개(세로, 44px 이상) | "pieceofdays에 로그인", 공급자 버튼 "Google로 계속하기"·"카카오로 계속하기" | 버튼 모양은 §8 끝의 [미확인] 참고 |
| 로그인 준비 중 | `NotConnected` 변형 | "로그인을 준비하고 있어요" | 설정 미비·오류 |
| 취소 | `notice` | "로그인을 취소했어요. 다시 시도할 수 있어요." | `error=cancelled` |
| 실패 | `notice` + 오류 색 테두리 | "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요." | `failed` |
| 시간 지남 | `notice` | "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요." | `expired` |
| 복구 불가 | `notice` | "복구 기간이 지나 이 계정을 되돌릴 수 없어요." | `purge_due`. 새 가입 여부는 말하지 않는다 |
| 로그아웃·탈퇴 완료 | `notice`(`aria-live=polite`) | "로그아웃했어요" / "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요." | 날짜는 표시하지 않는다(복구 쿠키에 기한 키 없음) |
| 탈퇴 확인 `/account/withdraw` | `settings` 섹션 + 위험 동작은 `btn-sub` + 확인 체크 | "탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요" | 취소 링크는 `/settings`로 |
| 복구 확인 `/account/restore` | `notice` + `btn-main` "계정 복구하기" + `text-btn` "복구하지 않기"(logout POST) | "탈퇴를 요청한 계정이에요. 복구할까요?" | 유효한 복구 쿠키 |
| 복구 시간 지남 | `notice` | "확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요." | 복구 쿠키 없음·무효 |
| 로그인됨·기록 연결 전 | `NotConnected` 변형 | "로그인됐어요. 기록 쓰기·불러오기는 다음 단계에서 연결돼요." | §7 기본안 |
| 설정 › 계정 | `settings` 섹션 | 로그아웃 버튼, "계정 탈퇴" 링크 | user일 때만 |

- **로딩:** form 제출 뒤 버튼을 `aria-disabled`로 바꾸고 "이동 중…"을 표시한다. JS가 없어도 POST·303이 동작한다(점진적 향상).
- **접근성:**
  - 화면 전환 시 `h1`(tabIndex −1)에 포커스한다(현행 규칙).
  - 오류·안내는 `role="status"` 또는 `aria-live`로 알린다. 모든 동작은 Tab으로 닿고 `:focus-visible` 3px로 표시한다.
  - 대비 AA는 기존 토큰 조합만 쓴다.
- **i18n:** 한국어 고정 문구를 `src/shared/auth-messages.ts`의 키 → 문구 표 하나에 모은다 [제안]. 다국어는 [미정]이다.
- **반응형:** 375/768/1440에서 수평 넘침 없음을 E2E와 스크린샷으로 확인한다.
- **B4-d 완료 조건:** 위 화면을 D 시안에 상태 아트보드로 추가한다(정적 HTML, 저장 없음). 375/768/1440 스크린샷을 메인이 확인한 뒤에 B4 UI GREEN을 시작한다.
- **[미확인] 공급자 버튼 브랜드 규정:** Google·Kakao가 로그인 버튼 디자인 가이드를 두는지, D 토큰만으로 그 규정을 만족하는지 이번에 확인하지 않았다. 출시 전에 공식 가이드를 확인하고, 규정상 브랜드 색·로고가 필요하면 그 예외만 메인·사용자가 결정한다. D의 나머지 화면은 바꾸지 않는다.

## 9. 시험 계획 (RED가 그대로 쓸 수 있는 사례)

**mock OIDC issuer (`app/tests/support/mock-oidc-issuer.ts`, RED 소유) — 검증을 건너뛰지 않는 issuer:**
- `node:http`로 `127.0.0.1:<임의 포트>`에만 listen한다. issuer `/google`·`/kakao` 두 개.
- discovery 메타데이터 모양을 실제와 맞춘다:
  - google: `authorization_response_iss_parameter_supported: true`, S256, post·basic.
  - kakao: iss 매개변수 항목 없음, S256, `client_secret_post`만, `subject_types_supported:["pairwise"]`.
- RS256 키는 `node:crypto`로 만든다. JWKS를 제공하고 ID Token을 서명한다(시험 코드만 서명한다. 제품 코드는 JWT를 만들거나 파싱하지 않는다).
- token endpoint가 실제로 거부하는 것:
  - client_secret_post 불일치
  - authorize 때와 다른 `redirect_uri`
  - **code 재사용**(일회성)
  - code 만료
  - **PKCE S256 불일치·누락**
- 고장 스위치(사례별):
  - ID Token: `iss`·`aud`·`nonce` 변조, 다른 키로 서명, `alg:none`, 만료(`exp` 과거), `id_token` 누락
  - callback: `iss` 불일치, `error=access_denied`
  - 같은 code 재사용 허용 모드(공급자가 거부하지 않는 경우를 재현해 F3 멱등만으로 지급 1회임을 확인)

| ID | 위치·명령 | 사례 | 기대 |
|---|---|---|---|
| U1 | `tests/unit/auth-config.test.ts` / `npm --prefix app test -- tests/unit/auth-config.test.ts` | §4 표 각 행. 운영 nodeEnv의 MOCK·http base, fixture+PROVIDERS throw, 목록 밖 자격 무시, issuer 상수 | 표대로 |
| U2 | `tests/unit/auth-flow-cookie.test.ts` | 왕복, 정확히 10키, 추가·누락 키, provider·issuer 쌍 불일치, returnTo 무효, `exp−1ms` ok / `exp` expired, 미래 iat, 수명 > 600s, 세션·복구 봉인값 → invalid, 이름·속성 분기, child 프로세스 가짜 `Date.now`로 iron ttl 600 경과 → invalid | |
| U3 | `tests/unit/auth-recovery-cookie.test.ts` | 6키·purpose·10분(ttl 600 명시 확인), 비UUID·gen 위반 throw, `readSession(복구값)` → invalid, `readRecovery(세션값)` → invalid | |
| U4 | `tests/unit/return-to.test.ts` | §5 표 전부 | |
| U5 | `tests/unit/auth-oidc.test.ts`(mock issuer, DB 없음) | authorize URL에 `scope=openid`·S256·state·nonce·정확한 redirect_uri, 다른 매개변수 없음 / 성공 → `{provider, subject}` / state·nonce·iss(param·claim)·aud·서명·alg none·만료·id_token 누락·PKCE 불일치 → 실패 / `access_denied` → cancelled / state가 틀린 error 응답 → failed(state 우선) / 요청 Host가 달라도 token 요청 redirect_uri가 설정값 / 로그에 code·state·nonce·secret·sub 문자열 없음 | |
| D1 | `tests/db/f4-auth-handlers.test.ts` / `npm --prefix app run test:db -- tests/db/f4-auth-handlers.test.ts` | 신규 → session set·원장 1·잔액 10·gen 1 / 같은 identity 재로그인 → granted false·원장 1 / **같은 code 동시 callback 2건**(일회성 mock) → 세션 1·원장 1 / 재사용 허용 mock → 같은 userId·원장 1 / pending → recovery set·session 없음·원장·`first_login_at` 불변 / due → purge_due·새 user 없음·쿠키 없음 / flow 삭제 뒤 callback 재요청 → expired·DB 변화 없음 / 다른 provider 경로에 다른 flow → failed / DB 실패 주입 → failed·세션 없음 | |
| D2 | 같은 파일 | withdraw: Origin 누락·불일치 403·DB 불변 / confirm 없음 / 성공 → pending·gen+1·session delete / 중복 → 불변 / stale | |
| D3 | 같은 파일 | restore: 성공 → 세션 gen+1·잔액·원장 불변·recovery delete / **옛 proof(복구 → 재탈퇴 뒤)** → stale_proof·세션 없음 / owner가 기한을 과거로 → expired·세션 없음 / not_pending → 세션 없음 / Origin 403 / 일반 세션 쿠키를 recovery 자리에 넣음 → expired | |
| D4 | `tests/db/f4-dal.test.ts` | 옛 gen·pending·없음·int4 초과 gen → signed_out / DB 미설정 → unavailable / **A 세션으로 B 데이터 접근 불가**(userId 질의·헤더 무시) / 탈퇴 커밋 뒤 새 요청 차단 | |
| E1 | `tests/e2e-auth/*.spec.ts` + `playwright.auth.config.ts`(127.0.0.1:3300, `next dev`, mock issuer, globalSetup이 `tests/db/helpers.ts`로 일회용 PG 생성·migrate) / `POD_FULL_CHECK_ISOLATED=1`에서 `npx playwright test -c playwright.auth.config.ts` | Google·Kakao 각각 성공 → 로그인됨 화면, 취소, state 변조, 쿠키 삭제 뒤 재요청, 성공 URL 재요청, returnTo `/days/…` 유지·`//evil` → `/`, 로그아웃, 탈퇴 → 재로그인 → 복구 화면 → 복구 / 복구하지 않기, 키보드만으로 흐름, 375/768/1440 넘침 없음 | |
| P1 | `tests/prod/prod-boundary.spec.ts`(사례 추가) | 기존 6개 유지 / `next start` + MOCK → 시작 거부 / 운영 + http base → `/login`이 "준비 중"·start 303 unavailable / 위조 `x-user-id`·`?userId=` 무시 | |
| B1 | `tests/auth-build-boundary.test.mjs`(사례 추가) | client가 `server/auth/{config,flow-cookie,recovery-cookie,oidc,handlers}`·`server/context`를 직접 또는 shared 경유 전이로 import하면 build 실패 | |

- **실패 이유가 정상 RED인 경우:** 각 `it` 안에서 동적 import하는데 신규 모듈이 없을 때. 타입·설정·환경 오류는 RED가 아니다(F4a 관례).
- **GREEN:** 시험 파일 변경 0. 외부 네트워크 금지. CI는 mock만 쓰고 실제 Google·Kakao discovery를 호출하지 않는다. U1이 운영 issuer가 상수라는 것만 확인한다.
- **CI(B4 GREEN) [제안]:** 기존 `db` job과 같은 PG18.6 서비스를 쓰는 `auth-e2e` job을 추가한다(Node 26, Secrets 없음, 가짜 `ci-only-*` 값). 기존 app·db job은 바꾸지 않는다.

## 10. 실제 공급자 검증 (B5, credential 필요 — 지금 실행하지 않음)

**Kakao PKCE 근거 대조 (2026-11-03 재조회):**
- [사실] discovery `code_challenge_methods_supported: ["S256"]`.
- [사실] REST 문서 discovery 응답 표의 설명: "PKCE … code_challenge 매개 변수에 대한 code_verifier 인코딩에 지원되는 메서드, S256으로 고정".
- [사실] 같은 문서의 **인가 코드 요청 쿼리 표**(client_id·redirect_uri·response_type·scope·prompt·login_hint·service_terms·state·nonce)와 **토큰 요청 본문 표**(grant_type·client_id·redirect_uri·code·client_secret)에는 `code_challenge`·`code_verifier`가 **없다**.
- 결론: 근거는 이전과 실질적으로 같다(광고는 있고 매개변수 표에는 없음). **실제 수락·강제 여부는 미검증이다.**
- [사실] Kakao 인가 응답 매개변수는 code·error·error_description·state이고 `iss` 매개변수가 없다.
- [사실] OIDC 사용 앱은 scope에 `openid`를 반드시 포함해야 한다. client secret이 기본으로 활성화돼 있다.

**검증 순서(개발용 Kakao 앱, 개발 PC localhost, 사용자 또는 메인이 실행):**
1. 부록 A로 dev 앱을 설정한다: 카카오 로그인 ON, OIDC 활성화, redirect URI, client secret.
2. 앱을 `POD_AUTH_PROVIDERS=kakao`, 개발 http base로 실행해 정상 로그인한다. ID Token `sub`로 계정이 생기면 성공이다.
3. **음성 1:** 같은 방식으로 새 인가 code를 받은 뒤 token 요청에 틀린 `code_verifier`를 보낸다 → `invalid_grant` 등 **거부**가 기대값이다.
4. **음성 2:** 새 code에 대해 `code_verifier` 없이 token을 요청한다 → **거부**가 기대값이다.
   - 3·4는 앱 밖의 일회성 검증 스크립트로 한다. 저장소에 비밀값을 남기지 않는다.
   - 결과는 HTTP status와 오류 코드만 기록하고 code·token은 기록하지 않는다.
5. **stop 조건:**
   - 2가 `code_challenge` 때문에 실패하거나, 3·4가 **성공**하면(PKCE 무시) 즉시 멈추고 근거와 함께 메인에 보고한다.
   - **PKCE를 끄거나 Kakao를 범위에서 빼는 결정은 메인 몫이다.** 그 전에는 `kakao`를 `POD_AUTH_PROVIDERS`에 넣지 않는다.
   - Google만 활성화해 진행하는 것은 메인이 허용할 때만 한다.

**Google:**
- 같은 2·3·4를 1회 확인한다.
- [사실] 공식 문서는 ID Token `iss`가 "`https://accounts.google.com` 또는 `accounts.google.com`"이라고 한다. vendor는 discovery issuer와의 **정확 일치**를 요구한다. 접두 없는 값이 오면 로그인이 실패한다(fail closed).
- [미확인] 실제 값. 실패하면 앱에서 정규화로 우회하지 않고 메인에 보고한다.
- [미확인] scope `openid`만으로 동의·`sub`를 정상 받는지(공식 예시는 `openid email`). 2단계에서 확인한다.

**credential 없이 계속할 수 있는 것과 필요한 것:**

| 계속 가능 | credential·콘솔 필요 |
|---|---|
| B0~B4 전부(config·codec·mock·handler·DAL·UI·E2E·CI) | B5 실로그인, Kakao·Google PKCE 수락·강제 확인, 공급자 버튼 브랜드 확인, F6 실도메인 redirect 등록 |

## 11. 공식 1차 자료 (2026-11-03 조회)

| 자료 | URL | 확인 내용 | 구분 |
|---|---|---|---|
| npm registry `openid-client` 6.8.9 | https://registry.npmjs.org/openid-client/6.8.9 | 게시 2026-11-02T08:49:27Z, `latest`=6.8.9, deps `jose ^6.2.15`·`oauth4webapi ^3.8.8`, `engines` 없음, ESM | [사실] |
| openid-client 6.8.9 tarball `build/index.d.ts`·`index.js` | https://registry.npmjs.org/openid-client/-/openid-client-6.8.9.tgz | `discovery`·`ClientSecretPost`·`buildAuthorizationUrl`·`authorizationCodeGrant(checks)`·PKCE·`randomState`·`randomNonce`·`allowInsecureRequests`·`enableNonRepudiationChecks`(token endpoint ID Token 서명은 기본 미검증), `redirect_uri = currentUrl`에서 query 제거 | [사실] |
| oauth4webapi 3.8.8(현재 범위 해석값, lock은 B0에서 고정) | https://registry.npmjs.org/oauth4webapi/-/oauth4webapi-3.8.8.tgz | `validateAuthResponse` 순서(iss → state → error), ID Token 필수 claim·iss·aud·nonce | [사실]. B0 lock의 실제 버전은 [미확인] |
| Google discovery | https://accounts.google.com/.well-known/openid-configuration | issuer, endpoints, `code_challenge_methods_supported:[plain,S256]`, `authorization_response_iss_parameter_supported:true`, `token_endpoint_auth_methods_supported:[client_secret_post, client_secret_basic]`, `subject_types_supported:[public]`, RS256 | [사실] (응답 Last-Modified 2026-03-17) |
| Google OIDC 문서 | https://developers.google.com/identity/openid-connect/openid-connect | redirect_uri 정확 일치, state·nonce, `iss` 두 형식, `sub` 불변·최대 255 | [사실] (페이지 Last updated 2026-10-29 UTC) |
| Kakao discovery | https://kauth.kakao.com/.well-known/openid-configuration | issuer, endpoints, `code_challenge_methods_supported:[S256]`, `token_endpoint_auth_methods_supported:[client_secret_post]`, pairwise, RS256, `response_modes_supported:[query]`, iss 매개변수 항목 없음 | [사실] |
| Kakao 로그인 REST API | https://developers.kakao.com/docs/ko/kakaologin/rest-api | §10의 표 대조, scope `openid` 필수(OIDC), client secret 기본 활성화, 취소 시 `error=access_denied` | [사실] |
| Kakao 설정하기·이해하기 | https://developers.kakao.com/docs/ko/kakaologin/prerequisite , https://developers.kakao.com/docs/ko/kakaologin/common | 사용 설정·redirect URI 필수, OIDC는 필요 시 설정 | [사실] |
| Next.js 문서(사이트 Latest v16.4.5, 앱은 16.4.3 고정) | https://nextjs.org/docs/app/api-reference/functions/cookies , https://nextjs.org/docs/app/api-reference/functions/headers , https://nextjs.org/docs/app/api-reference/file-conventions/route , https://nextjs.org/docs/app/api-reference/functions/redirect , https://nextjs.org/docs/app/guides/authentication , https://nextjs.org/docs/app/guides/data-security | `cookies()` async, Server Component는 쓰기 불가, route handler·Server Function은 쓰기 가능, DAL `server-only`·React `cache`, layout Partial Rendering 주의, Server Actions Origin·Host 대조, `redirect` 307/303 | [사실]. 16.4.3 원문과의 차이는 [미확인] |

- 미조회: openid-client GitHub 저장소 HEAD 문서(패키지 원문으로 대신함), Google·Kakao 로그인 버튼 브랜드 가이드, 각 콘솔 화면.
- 이전 계획의 근거를 latest로 올리지 않았다. 버전은 R4 고정값 그대로다.

## 12. 롤백·확장/수축·관찰·범위 밖

- **스키마:** 추가 없음 → expand·contract 단계가 없다. 0001·0002 그대로다.
- **롤백:**
  - B4 PR을 revert하면 route·버튼이 사라진다. 또는 `POD_AUTH_PROVIDERS`를 제거하면 `auth_not_configured`가 되어 지금과 같은 "준비 중"으로 돌아간다.
  - 지급 원장은 되돌리지 않는다(R4 §10).
  - 이미 발급된 세션을 무효화하려면 `POD_AUTH_SESSION_SECRETS` 키 교체(F6 런북)나 사용자별 `gen` 증가(탈퇴·복구)를 쓴다.
  - 정적 dev·운영에는 영향이 없다(F6 전 미배포).
- **관찰 [제안]:**
  - 서버 로그에 `auth.start`·`auth.callback`·`auth.withdraw`·`auth.restore`의 `{provider, result, stage}`만 남긴다.
  - code·state·nonce·verifier·token·cookie·secret·sub·userId·email은 남기지 않는다.
  - 지표·보관 기간은 [미정] (F6)이다. 값을 만들지 않는다.
- **F6 경계:** 서비스 DB·운영 env·실도메인 redirect 등록·HTTPS·신뢰 프록시·purge 주기·백업은 F6(메인)이다. F6 배포 프로그램을 이 계획 때문에 완화하지 않는다.
- **범위 밖:** 공급자 간 계정 연결([미정]), 완전 삭제 뒤 재지급 방지 식별자 보관([미정]), 사진·AI·공유, 개인정보·SLA 정책.
- **미실행:** 이 문서 작성 중에 npm 설치·코드·DB 시험·서비스 기동·실제 로그인을 하지 않았다. eaf9d4f 통합 CI는 직접 확인하지 않았다.

## 13. 검토 요청 항목 (메인 결정 필요)

1. `POD_AUTH_PROVIDERS` 신규 env와 §4 판정표(부분 설정 전체 거부, 목록 밖 자격 무시, fixture 동시 설정 throw).
2. flow 쿠키 이름·10키·10분, start를 POST로 하는 것.
3. `enableNonRepudiationChecks`를 켜서 R4 §4의 vendor 서명 검증을 문자 그대로 충족하는 것.
4. 로그인 사용자 화면을 F5 전에는 "기록 연결 전" 안내로 둘지, 읽기 전용 PG로 둘지(§7).
5. B4-d 상태 아트보드 담당과 게시 사본 갱신 여부.
6. 공급자 버튼 브랜드 규정 확인 시점(§8).

---

## 부록 A — Windows 세션용 OAuth 콘솔 설정 프롬프트 (초안, 나중에 사용자에게 제공)

> 아래 문단을 사용자의 Windows PC Claude 세션에 붙여 넣는 용도다. **redirect URL은 계획안이며 이 계획이 수락된 뒤에만 유효하다.**
> 실제 client ID·secret·token, 서버 내부 경로를 채팅·저장소·공개 문서에 적지 않는다.

```text
pieceofdays의 Google·Kakao OIDC 로그인용 콘솔 설정을 단계별로 안내해 줘. 너는 화면 안내만 한다.
- 나에게 client ID·client secret·token 값을 채팅으로 묻거나 받지 마. 값은 내가 직접 개발 PC의 app/.env.local
  (저장소 .gitignore에 포함된 파일)에 입력한다. 화면 캡처를 공유할 때는 secret이 보이지 않게 가리라고 알려 줘.
- 환경을 섞지 않는다: (1) 로컬 개발(내 PC), (2) dev(dev.pieceofdays.com, 앱 배포 F6 전에는 등록만 보류 가능),
  (3) 운영(pieceofdays.com, F6에서 메인이 진행). 이번에는 (1)만 설정하고 (2)(3)은 메모만 한다.
- 계획안 redirect URI(정확한 문자열, 끝 슬래시 없음):
  로컬: http://localhost:3000/auth/google/callback , http://localhost:3000/auth/kakao/callback
  dev(F6 이후): https://dev.pieceofdays.com/auth/google/callback , https://dev.pieceofdays.com/auth/kakao/callback
  운영(F6 이후): https://pieceofdays.com/auth/google/callback , https://pieceofdays.com/auth/kakao/callback
Google(Google Cloud Console의 Google Auth Platform):
  1) 개발용 프로젝트를 선택·생성한다. 2) 브랜딩(앱 이름 pieceofdays, 지원 이메일)과 대상(외부, 테스트 모드, 테스트 사용자에 내 계정)을 설정한다.
  3) 클라이언트 → 웹 애플리케이션 → 승인된 리디렉션 URI에 로컬 URI 1개만 넣는다. 4) 데이터 액세스(scope)는 openid만 둔다(email·profile 추가 금지).
  5) client ID·secret은 .env.local의 POD_AUTH_GOOGLE_CLIENT_ID / POD_AUTH_GOOGLE_CLIENT_SECRET에 직접 입력한다.
Kakao(Kakao Developers):
  1) 개발용 앱을 따로 만든다(운영 앱과 분리, 운영 앱은 F6에서 고정). 2) [카카오 로그인] 사용 설정 ON, OpenID Connect 활성화.
  3) REST API 키의 리다이렉트 URI에 로컬 URI를 등록한다. 4) 클라이언트 시크릿 ON(기본값) 확인.
  5) 동의항목은 최소로 두고 닉네임·이메일 등 추가 항목을 필수로 켜지 않는다(꼭 필요한 항목이 있는지는 화면에서 확인해 알려 줘).
  6) REST API 키·시크릿은 .env.local의 POD_AUTH_KAKAO_CLIENT_ID / POD_AUTH_KAKAO_CLIENT_SECRET에 직접 입력한다.
공통: POD_AUTH_BASE_URL=http://localhost:3000, POD_AUTH_SESSION_SECRETS는 내가 32자 이상 무작위 값으로 직접 만든다.
POD_AUTH_PROVIDERS에는 우선 google만 넣는다. kakao는 PKCE 수락 검증(계획 §10)을 통과한 뒤에만 넣는다.
끝나면 어떤 항목을 설정했는지 값 없이 체크리스트로만 요약해 줘. 실제 로그인 시험은 메인 안내가 있을 때만 한다.
```

| 구분 | 출시 필수 | credential 없이 진행 가능 |
|---|---|---|
| 콘솔 설정(로컬·dev·운영), Kakao 실제 PKCE 수락·강제 확인, Google `iss`·scope 확인, 실로그인 | 예 | 아니오 |
| config·codec·mock issuer·handler·DAL·UI·E2E·CI | 예 | **예** |
