# PLAN — F4b/c Google·Kakao 실제 로그인·복구·탈퇴·요청별 DAL 연결 (R1)

- **상태:** R1 계획을 독립 재검토 후 **메인이 수락해 dev에 통합했다**. R0(`195ccba`)의 P1 2·P2 7건을 해소했고, exact R1 `5b305125a3e50b82fb1dc1882febb9788b72cc68`은 독립 PASS(P0·P1 없음)를 받았다. 비차단 P2 2건(discovery 캐시 키·Windows 파일 줄바꿈)은 메인이 아래 §6.1·부록 A에 반영했다. 기술 결정은 §13을 따른다.
  - 이 문서만으로는 다음 어느 것도 바꾸지 않았다: 제품 코드, 시험, SQL, 설정, 패키지, workflow, 서버, 실계정, DB, OAuth 콘솔.
  - 실제 로그인을 시도하지 않았고 패키지를 설치하지 않았다.
  - 이 문서는 실제 코드 실행이나 서버 활성화 권한을 늘리지 않는다.
- **BASE:** `dev` `eaf9d4f468f6d652317ed3447b6eb8121ef42bed`.
  - 포함된 것: F4a codec `96bcf8c`, L1 `0876c4b`, L2 GREEN `ba2b1679a8ca7dae63cc5da314a04ef081f040ac`, RED `d534628`, 문서 `ba150c7`, 메인 상태 갱신.
  - L2 GREEN은 CI 41691842663·41691842754와 독립 PASS를 거쳐 메인이 수락했다.
  - BASE 통합 CI 41694696601·41694696623 success, dev 컨테이너·HTTPS·SHA `eaf`, pending 없음은 **메인이 확인했다.** 작성자는 직접 실행하거나 확인하지 않았다.
- **선행 계약:**
  - [PLAN_mvp-authentication](PLAN_mvp-authentication.md) R4: §2~§5, §7, §9, §10
  - [PLAN_account-lifecycle](PLAN_account-lifecycle.md) R6: §2~§4, §7, §9
  - [DATA_CONTRACT](../product/DATA_CONTRACT.md), [디자인 핸드오프](../design/README.md)
  - 이 문서는 위 계약을 구현 단위로 구체화한다. 새 정책이나 스택 전환이 아니다.
- **표기:**
  - **[확정]** 사용자 확정
  - **[메인]** 메인이 정했거나 수락한 기술 계약. 2026-11-03 R1 결정은 §13에 모은다
  - **[사실]** 코드·공식 원문에서 직접 확인
  - **[추론]** 작성자 판단
  - **[미정]** 미결정
  - **[미확인]** 확인하지 못함

## 0. 고정 전제 (재질문·조용한 변경 금지)

| 구분 | 내용 |
|---|---|
| [확정] | Google·Kakao 로그인 둘 다(**최종 출시는 둘 다 필수**), 탈퇴 → 30일 복구 → 삭제, D 테마·현재 화면 구조, canonical 계정당 첫 성공 로그인 10개 1회 |
| [미정] 사용자 | 공급자 간 계정 연결. **단독 canonical 계정 흐름의 선행 조건이 아니다.** email 자동 연결·잔액 병합은 없다 |
| [메인] 기술 | `openid-client` **6.8.9**(B0에서 설치), `iron-session` 9.0.1(설치됨), Next 16.4.3, Node 24.22.2·26.13.0, PG 18.6. 새 프레임워크·세션 DB·Redis·schema 없음 |
| [메인] 프로토콜 | PKCE S256·state·nonce·issuer·redirect 검증. scope `openid`만. token·email 저장 안 함. code·cookie·secret 로그 금지. issuer 고정 허용 목록. 토큰 검증은 vendor에 위임하고 앱은 JWT를 직접 파싱하지 않는다. **ID Token 서명은 `enableNonRepudiationChecks`로 vendor가 필수 검증한다**(§6.1) |
| [메인] 재생(R4 §3) | 짧은 수명의 브라우저 결합 봉인 flow 쿠키 + callback 응답에서 삭제 + 공급자 code 일회성 + F3 멱등. **서버 측 원자적 state 소비 저장소는 추가하지 않는다** |
| [메인] 세션 | F4a 공개 API 재사용: payload 정확히 5키, 절대 7일, HTTPS일 때 `__Host-`, 명시 Origin. cfg·env 검증을 약화하지 않는다 |
| [메인] 복구 | lifecycle §3·§9 그대로. fresh OAuth 뒤 `pending_deletion` 결과의 userId·gen으로만 발급, 정확히 6키, `purpose:"account_recovery"`, 10분, 일반 세션으로 읽지 않음, 철회된 세션이나 withdraw 응답으로 증명을 만들지 않음, restore는 POST·Origin·증명 검증, 기한 만료 거부, 재지급 0 |
| [메인] 결과 분기 | `LoginOutcome` union 그대로. `active`만 일반 세션, `pending_deletion`은 세션 없이 복구 확인으로, `purge_due`는 복구 불가·세션 없음·같은 요청 자동 재시도 없음. 첫 지급은 검증된 OAuth와 `completeSuccessfulLogin` COMMIT 때 함께 켜진다 |
| [메인] DAL | 매 요청 `verifyActiveAccount(userId, gen)`. 미활성·없음·불일치는 "로그인 필요". 입력 userId는 신뢰하지 않는다. 탈퇴 커밋 뒤 새 요청을 차단하며 진행 중 요청의 취소는 보장하지 않는다 |
| [메인] 배포 경계 | dev는 정적 D다. Next 앱과 서비스 DB는 F6 전 미배포다. 격리 mock 시험 통과 ≠ 실제 Google·Kakao 로그인 검증 ≠ 실도메인 게시. F6 배포 프로그램·인프라를 편의상 완화하지 않는다 |

## 1. 현재 코드 사실 (BASE `eaf9d4f`)과 갭

**[사실] 이미 있는 모듈:**

| 파일 | 공개 API |
|---|---|
| `server/auth/session.ts` | `SessionConfig{secrets,baseUrl,secureCookies,now}`, `loadSessionConfig(env, nodeEnv)`, `sealSession`, `readSession`, `sessionCookieOptions`, `assertSameOrigin` |
| `server/account/login.ts` | `completeSuccessfulLogin(db, {provider, subject}) → Result<LoginOutcome, "invalid_identity">` |
| `server/account/lifecycle.ts` | `SessionSubject`, `verifyActiveAccount`, `requestWithdrawal`(gen 반환 없음), `restoreAccount` |
| `server/db/pool.ts` | `getAppDb()`: `POD_DATABASE_URL`로 지연 생성하고, 없으면 throw |
| `server/context.ts` | **동기** `getDiaryContext()`. fixture가 아니면 `unavailable` |
| `shared/diary.ts` | `DiaryContext = fixture \| unavailable` |
| `server/runtime-mode.ts` | `server-only` 없는 순수 Node 모듈. `isFixtureModeEnabled(env)`, `assertFixtureModeAllowed(phase, env)`. `next.config.ts`가 모든 phase에서 호출한다 |

- **[사실] 호출 지점:** `getDiaryContext()`를 부르는 곳은 `app/layout.tsx`, `app/page.tsx`, `app/days/page.tsx`, `app/days/[date]/page.tsx`다. `/settings`는 클라이언트 `FontSettings`만 쓴다(메모리).
- **[사실] 경로:** `/`, `/days`, `/days/[date]`, `/settings`, `/dev/konva-smoke`(시험 fixture, 운영 404).
- **[사실] 기준선:**
  - Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·prod 6·E2E 12
  - DB 138(PG18.6·Node 26), root 42
- **[사실] TEST_PATTERNS:** `tests/* .claude/tdd.conf app/tests/* app/vitest*.ts app/playwright*.ts`
- **갭:**
  - `openid-client`가 없다. 공급자 설정·flow/복구 쿠키·returnTo 검사·5개 route·요청별 DAL·async context·로그인 관련 화면도 없다.
  - mock OIDC issuer와 인증 E2E가 없다.

## 2. 목표·비목표·의존성

- **목표:**
  - OIDC 로그인 → `completeSuccessfulLogin` → 결과별 쿠키
  - 매 요청 DAL
  - 탈퇴·복구·로그아웃 POST
  - D 상태 화면
  - 격리 mock 시험
  - 실제 공급자 검증 절차
- **비목표:**
  - 화면의 PG 기록 읽기·쓰기(F5). F5 전 로그인 사용자는 "기록 연결 전" 안내를 본다(§7).
  - 공급자 간 계정 연결
  - purge 주기·백업·SLA·서비스 DB·실도메인(F6)
  - 사진·AI·공유
  - 개인정보 보관 정책 신설
- **의존성:**
  - R1의 독립 재검토·메인 수락
  - B0 배정. 기존 기술 수락 범위라 사용자에게 같은 라이브러리를 다시 묻지 않는다
  - 실제 로그인은 사용자의 콘솔 설정(부록 A)과 B5

## 3. slice 순서·소유·활성화 경계

| slice | 소유(RED는 TEST_PATTERNS 안, GREEN은 그 밖) | 내용 | 활성화 경계 |
|---|---|---|---|
| **B0 패키지** | `app/package.json`, `app/package-lock.json` | `openid-client` **6.8.9 exact 추가만**. Node 24·26에서 `npm ci`·`npm ls --all`·기존 회귀 통과. **R1 수락 뒤 메인이 배정한다** | 호출부 없음 |
| **B1 모드·설정·codec** | RED: `app/tests/unit/runtime-mode.test.ts`(사례 추가), `auth-config.test.ts`, `auth-flow-cookie.test.ts`, `auth-recovery-cookie.test.ts`, `return-to.test.ts`<br>GREEN: `app/src/server/runtime-mode.ts`, `next.config.ts`, `app/src/server/auth/{config,flow-cookie,recovery-cookie,return-to,cookie-util}.ts` | §4·§5 | route 없음 → 발급 경로 없음 |
| **B2 OIDC·처리 함수** | RED: `app/tests/support/mock-oidc-issuer.ts`, `app/tests/unit/auth-oidc.test.ts`, `app/tests/db/f4-auth-handlers.test.ts`<br>GREEN: `app/src/server/auth/{oidc,handlers}.ts` | §6. Next 타입 없는 `HandlerResult` | **route 파일 없음**. 시험만 호출 |
| **B3 요청 context·DAL** | RED: `app/tests/unit/request-context.test.ts`, `app/tests/db/f4-dal.test.ts`, 기존 E2E·prod 기대 유지 확인<br>GREEN: `app/src/server/context.ts`, `app/src/shared/diary.ts`, page 3개·layout | §7 async 전환 | 세션 발급 route가 없어 `user`에는 시험으로만 도달. env 없는 운영 기본은 지금의 "준비 중" |
| **B4-d D 상태 아트보드** | 별도 D 상태 아트보드 담당(메인 후속 배정): `docs/design/concepts/d-warm-pieces/` source 먼저. dev 게시 사본(`frontend/public/design/…`)은 그 단계에서 메인이 명시적으로 배정한다 | §8 화면. **착수 전에 공급자 브랜드 공식 규정을 확인** | 문서·시안만 |
| **B4 활성화** | RED: `app/tests/e2e-auth/*.spec.ts`, `app/playwright.auth.config.ts`, `app/tests/prod/prod-boundary.spec.ts`(사례 추가), `app/tests/auth-build-boundary.test.mjs`(사례 추가)<br>GREEN: route 5개(§6.3), page 3개, `src/ui/d/*` 신규, `settings/page.tsx`, `TopBar.tsx`, `src/shared/auth-messages.ts`, `.github/workflows/app-validation.yml`(auth-e2e job) | route·화면·E2E를 **한 PR에서** 켠다 | `POD_AUTH_PROVIDERS`가 설정된 환경에서만 동작한다. 실로그인과 첫 지급이 동시에 켜진다 |
| **B5 실제 공급자 검증** | 사용자·메인(credential). 저장소 변경 없음 | 부록 A → §10 | 개발 PC localhost 격리 preflight에서만 |
| **F6** | 메인 | 서비스 DB·실도메인 redirect·운영 env·공유 dev/운영 활성화 | 범위 밖 |

- **진행 규칙:** 각 slice는 RED → 독립 runner → GREEN(시험 변경 0) → 독립 검토 → 메인 통합 순이다. 기존 기준선을 유지하고, 신규 시험 수는 잠그지 않는다.
- **부분 연결 금지:**
  - B1~B3은 세션·복구 쿠키를 발급하는 HTTP 경로를 만들지 않는다.
  - 지급의 새 호출자는 B2 `handleCallback` 하나이고, B4 route만 그것을 노출한다. B4를 revert하면 route와 버튼이 함께 사라진다.
- **공급자 순서 [메인]:**
  - 개발·시험·실검증은 Google 단독으로 먼저 진행해도 된다.
  - **최종 출시(F6 gate)는 Google+Kakao 둘 다** 켜져 있어야 한다.
  - Kakao를 조용히 끄거나 제품에서 빼지 않는다.

## 4. 실행 모드·설정·env

### 4.1 env (이름만, 값은 문서·로그에 쓰지 않는다)

| env | 상태 | 형식 |
|---|---|---|
| `POD_AUTH_SESSION_SECRETS` | 기존(F4a §5.2) | **JSON 번호 맵** `{"1":"<32자 이상>"}`. `loadSessionConfig`가 그대로 검사한다 |
| `POD_AUTH_BASE_URL` | 기존 | `loadSessionConfig` 그대로 |
| `POD_AUTH_PROVIDERS` | 신규 [메인] | 정확히 `^(google\|kakao)(,(google\|kakao))*$`, 중복 없음. 순서 = 버튼 순서. 공백·빈 항목·대문자·모르는 이름은 오류다 |
| `POD_AUTH_GOOGLE_CLIENT_ID`·`_SECRET`, `POD_AUTH_KAKAO_CLIENT_ID`·`_SECRET` | 기존 이름(R4 §7) | 목록에 있는 공급자는 둘 다 필수다. 비어 있지 않아야 하고, 앞뒤 공백·제어문자(U+0000–U+001F, U+007F)가 있으면 변형 없이 거부한다. 길이 하한은 두지 않는다 |
| `POD_DATABASE_URL` | 기존 | `getAppDb()` 지연 연결 |
| `POD_AUTH_MOCK_OIDC_ISSUER` | 신규 [메인], 시험 전용 | 정확히 `http://127.0.0.1:<port>`(port 1–65535 10진, 끝 슬래시·path·query·userinfo 없음). 원문 문자열이 `new URL(v).origin`과 같아야 한다 |
| `POD_LOCAL_FIXTURE` | 기존 | 비어 있거나 정확히 `1` |

"비어 있음(blank)"은 값이 없거나 trim 결과가 빈 문자열이라는 뜻이다.

### 4.2 순수 모드 검사 — `runtime-mode.ts` [메인]

`server-only`·iron·pg·auth 모듈을 직접 또는 전이로 import하지 않는다(현행과 같음).

```ts
type ModeEnv = { readonly NODE_ENV?: string; readonly POD_LOCAL_FIXTURE?: string;
                 readonly POD_AUTH_PROVIDERS?: string; readonly POD_AUTH_MOCK_OIDC_ISSUER?: string };
// 기존 export 2개(isFixtureModeEnabled, assertFixtureModeAllowed)는 서명·동작 그대로
export function authModeProblem(env: ModeEnv, nodeEnv: string | undefined): "fixture_with_auth" | "mock_outside_dev" | null;
export function assertAuthModeAllowed(phase: string | null, env: ModeEnv): void;   // next.config는 모든 phase에서 호출
```

| 순서 | `authModeProblem` 조건 | 반환 |
|---|---|---|
| 1 | `POD_LOCAL_FIXTURE`가 정확히 `"1"`이고 `POD_AUTH_PROVIDERS`가 non-blank(형식과 무관) | `fixture_with_auth` |
| 2 | `POD_AUTH_MOCK_OIDC_ISSUER`가 non-blank이고 `nodeEnv`가 정확히 `development`·`test`가 아님 | `mock_outside_dev` |
| 3 | 그 밖 | `null` |

`assertAuthModeAllowed(phase, env)`는 아래 순서로 throw한다.
1. `authModeProblem(env, env.NODE_ENV) === "fixture_with_auth"`이면 **모든 phase에서** throw한다(`phase === null`, 즉 요청 시점 포함).
2. `phase`가 `phase-production-build`·`phase-production-server`·`phase-export`이고 MOCK이 non-blank이면 throw한다. PROVIDERS·SessionConfig 설정 유무와 무관하다.
3. `phase !== null`이고 결과가 `mock_outside_dev`이면 throw한다.

`next.config.ts`는 기존 `assertFixtureModeAllowed(phase, env)` 뒤에 `assertAuthModeAllowed(phase, env)`를 한 줄 추가한다.

### 4.3 `loadAuthConfig` 판정 (위에서부터)

```ts
// app/src/server/auth/config.ts  (import "server-only")
export const PROVIDER_IDS: readonly ["google", "kakao"];
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const PROVIDER_ISSUERS: Readonly<Record<ProviderId, string>>;   // google "https://accounts.google.com", kakao "https://kauth.kakao.com"
export type ProviderConfig = Readonly<{ id: ProviderId; issuer: URL; clientId: string; clientSecret: string; redirectUri: URL; insecureMock: boolean }>;
export type AuthConfig = Readonly<{ session: SessionConfig; enabled: readonly ProviderId[]; providers: Readonly<Partial<Record<ProviderId, ProviderConfig>>> }>;
export type AuthR = Result<AuthConfig, "auth_not_configured" | "invalid_config">;
export function loadAuthConfig(env: Record<string, string | undefined>, nodeEnv: string | undefined): AuthR;  // fixture_with_auth만 throw
```

| 순서 | 조건 | 결과 |
|---|---|---|
| 0a | `authModeProblem(env, nodeEnv) === "fixture_with_auth"` | **throw**(설정 오류. Result가 아니다) |
| 0b | `… === "mock_outside_dev"` | `invalid_config` |
| 1 | PROVIDERS blank | `auth_not_configured` |
| 2 | `loadSessionConfig` → `auth_not_configured` | `auth_not_configured` |
| 3 | `loadSessionConfig` → `invalid_config`(운영의 http·loopback base 포함) | `invalid_config` |
| 4 | PROVIDERS가 §4.1 형식에 맞지 않거나 중복 | `invalid_config` |
| 5 | 목록 공급자의 ID·SECRET 누락·형식 오류 | `invalid_config`(부분 활성화 없음) |
| 6 | 목록 밖 공급자의 ID·SECRET | 읽지 않고 무시 |
| 7 | MOCK non-blank(이때 nodeEnv는 development·test)인데 §4.1 형식이 아님 | `invalid_config` |
| 8 | 통과 | `ok`. issuer는 `new URL(PROVIDER_ISSUERS[id])`, MOCK이면 `new URL(MOCK + "/" + id)`이고 `insecureMock = true`. `redirectUri = new URL("/auth/" + id + "/callback", session.baseUrl)` |

**시점별 결과 [메인]:**

| 상황 | 시작(`next.config`) | `loadAuthConfig` | 요청(viewer·handler) |
|---|---|---|---|
| fixture + PROVIDERS non-blank | 모든 phase에서 throw | throw | throw → 500(시작 거부가 먼저라 정상 운영에서는 도달하지 않음) |
| MOCK + production phase | throw | `invalid_config`(nodeEnv production) | — |
| MOCK + 운영 nodeEnv(phase 없음, 예: 시험) | — | `invalid_config` | viewer `unavailable` / handler 503 |
| MOCK 형식 오류(development·test) | 통과 | `invalid_config` | `unavailable` / 503 |
| PROVIDERS blank | 통과 | `auth_not_configured` | `unavailable` / 503 |
| fixture만 | 기존 규칙 | `auth_not_configured` | fixture |

- **[사실] issuer 상수:** 2026-11-03 discovery로 확인했다(§11). 운영에서 env로 바꿀 수 없다.
- **판정 시점:** build는 비밀 없이 성공한다(R4 §7). 공급자 자격 검사는 요청 시점에 한다.

## 5. 쿠키 3종과 codec

| 쿠키 | 이름(secure / 개발 http) | payload(정확한 키) | 수명 | 발급 | 삭제 |
|---|---|---|---|---|---|
| 세션 [메인 F4a] | `__Host-pod_session` / `pod_session` | `v,userId,gen,iat,exp`(5) | 절대 7일 | callback `active`, restore 성공 | §6.3 표 |
| 복구 [메인 lifecycle §3] | `__Host-pod_recovery` / `pod_recovery` | `purpose,v,userId,gen,iat,exp`(6) | 봉인 시 `exp = iat + 600_000`, iron `ttl: 600` 명시 | callback `pending_deletion`에서만 | §6.3 표 |
| flow [메인] | `__Host-pod_oauth` / `pod_oauth` | `purpose,v,provider,issuer,state,nonce,codeVerifier,returnTo,iat,exp`(10) | 봉인 시 `exp = iat + 600_000`, iron `ttl: 600` | start 성공(덮어쓰기, 한 번에 하나) | cfg가 있는 callback의 모든 응답 |

- **공통 속성:** `HttpOnly`, `Path=/`, `SameSite=Lax`, Domain 없음. `secure = cfg.secureCookies`. 이름 분기는 `sessionCookieOptions` 규칙과 같다.
- **삭제:** 같은 이름·`Path=/`·secure 값에 빈 값, `Max-Age=0`, `Expires=Thu, 01 Jan 1970 00:00:00 GMT`.
- **Lax와 callback:** 공급자에서 돌아오는 요청은 최상위 GET 이동이라 Lax 쿠키가 전송된다. `response_mode`는 `query`만 쓴다 [추론, RFC 6265bis].
- **봉인 키:** 세 쿠키 모두 `cfg.secrets`(번호 맵)를 쓴다. 새 비밀 env는 없다.
  - [사실] iron은 가장 큰 번호의 키로 봉인한다.
  - 목적 분리는 `purpose`와 정확한 키 수로 한다. `readSession`은 정확히 5키만 받는다.
- **재사용:** 세션은 `sealSession`·`readSession`·`sessionCookieOptions`·`assertSameOrigin`만 쓴다(복제·변경 금지).
- **최초 iat 연장 없음:** DAL·화면 요청에서 다시 봉인하지 않는다. 새 세션은 callback `active`·restore 성공에서만 만든다.

```ts
// app/src/server/auth/flow-cookie.ts  (import "server-only") — SessionConfig만 받고 형식만 검사한다
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

**`readFlow` 판정 순서 (형식만) [메인]:**

1. `sealed`가 `undefined`나 `""`이면 `missing`(unseal 전).
2. `unsealData(sealed, { password: cfg.secrets })`가 실패하거나 객체가 아니면 `invalid`. raw reason은 쓰지 않는다.
3. 키가 정확히 10개이고 이름이 표와 같지 않으면 `invalid`.
4. 아래 하나라도 어긋나면 `invalid`.
   - `purpose === "oauth_flow"`, `v === 1`
   - `provider`가 `PROVIDER_IDS` 중 하나
   - **issuer 형식(정책 하나로 고정):** string, 256자 이하. `u = new URL(issuer)`가 성공하고 **`u.href === issuer`**(WHATWG 정규화 문자열과 정확히 같음)이며 username·password·search·hash가 비어 있다. 그리고 다음 중 하나다.
     - `u.protocol === "https:"`
     - `u.protocol === "http:"`이고 `u.hostname === "127.0.0.1"`이고 `u.port !== ""`
     - 이 단계는 형식만 본다. 운영에서 http를 허용할지, 현재 설정과 같은지는 판정하지 않는다(§6.3 callback ④).
   - `state`·`nonce`·`codeVerifier`가 각각 `^[A-Za-z0-9_-]{43}$`
   - `parseReturnTo(returnTo) === returnTo`
   - `iat`·`exp`가 안전한 비음수 정수이고 `exp > iat`, `exp − iat ≤ 600_000`, `iat ≤ cfg.now().getTime()`
5. `exp ≤ cfg.now().getTime()`이면 `expired`, 아니면 `ok`.

- `sealFlow`는 4단계와 같은 형식 검사를 통과하지 못하면 throw한다. `iat = cfg.now().getTime()`, `exp = iat + 600_000`이다.
- 호출자는 issuer로 **`ProviderConfig.issuer.href`**를 넣는다. 예: Google `https://accounts.google.com/`(끝 슬래시 포함), mock `http://127.0.0.1:<port>/google`.
- **`readRecovery` 순서:** 같은 방식으로 6키, `purpose === "account_recovery"`, `v === 1`, `isUuid(userId)`, `Number.isSafeInteger(gen) && gen > 0`, 시각 규칙(600_000) → `missing`/`invalid`/`expired`/`ok`.

**returnTo 허용 목록 [메인, 현행 경로와 대조]:**

```ts
// app/src/server/auth/return-to.ts  (import "server-only")
export function parseReturnTo(raw: unknown): string | null;   // 허용값만 그대로 돌려준다
```

| 입력 | 결과 |
|---|---|
| `/`, `/days`, `/settings` | 그대로 |
| `/days/YYYY-MM-DD`(`parseLocalDate` 통과) | 그대로 |
| `/login`, `/auth/…`, `/account/…`, `/dev/…`, `//x`, `/\x`, `https://…`, `/days/2026-02-30`, 끝 슬래시, query·hash, `%` 포함, 길이 > 64, string이 아님 | `null` → 호출자는 `/` |

- 정확 일치와 정규식만 쓴다.
- 내부 Location은 항상 `new URL(path, cfg.session.baseUrl)`이다. **Host·`X-Forwarded-*`·`request.url`로 redirect를 만들지 않는다.**

## 6. OIDC 어댑터·처리 함수·route

### 6.1 openid-client 6.8.9 사용 [사실 = 패키지 원문]

- **discovery:** `discovery(cfg.issuer, clientId, clientSecret, ClientSecretPost(clientSecret), { execute })`.
  - `execute`는 **항상 `[enableNonRepudiationChecks]`**이고, `insecureMock`이면 `[allowInsecureRequests, enableNonRepudiationChecks]`다 [메인].
  - Issuer URL을 넘기면 vendor가 `issuer` 일치를 검사한다. well-known URL은 넘기지 않는다.
  - Configuration Promise는 `issuer.href`·`clientId`·`clientSecret`·`insecureMock` 조합별로 프로세스 메모리에 둔다. 공급자 id만으로 공유하지 않으며, 캐시 키·비밀값을 로그나 보고로 출력하지 않는다. 실패한 Promise는 캐시하지 않는다. U5는 사례마다 별도 mock issuer 포트를 사용해 성공·실패 설정이 섞이지 않게 한다.
- **[사실] 서명:**
  - 기본값에서는 token endpoint ID Token의 JWS를 검증하지 않는다(TLS로 issuer를 대신 확인).
  - `enableNonRepudiationChecks`를 켜면 `jwks_uri`의 키로 JWS를 검증하고 HS* 알고리즘을 거부한다. 이것으로 R4 §4의 서명 검증과 위조 서명 음성 시험을 vendor의 실제 검증으로 충족한다.
  - 이 옵션·PKCE를 끄거나 issuer 정규화 같은 우회를 새로 만드는 일은 **없다**.
- **client 인증:** 두 공급자 모두 `ClientSecretPost`를 쓴다(Kakao는 post만 광고).
- **start:** `randomPKCECodeVerifier()`, `calculatePKCECodeChallenge(v)`, `randomState()`, `randomNonce()`를 만든다. 그리고 `buildAuthorizationUrl(config, { redirect_uri: redirectUri.href, scope: "openid", response_type: "code", code_challenge, code_challenge_method: "S256", state, nonce })`. 다른 매개변수는 없다.
- **callback `currentUrl` 조립 [메인]:**
  - `const u = new URL(provider.redirectUri.href)`로 시작한다.
  - 들어온 query의 **모든 entry를 순서대로 `u.searchParams.append(k, v)`**한다. `set`이나 중복 제거를 쓰지 않는다. 그래야 vendor가 중복 `state`·`code`·`iss`를 거부한다([사실] `getURLSearchParameter`는 같은 이름이 2개 이상이면 throw).
  - `request.url`의 host·path는 쓰지 않는다. [사실] vendor는 `currentUrl`에서 query를 뺀 값을 token 요청 `redirect_uri`로 보낸다.
- **grant:** `authorizationCodeGrant(config, u, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true })`.
  - [사실] 인가 응답은 `iss`(Google 메타데이터 true → 필수) → `state` → `error` 순서로 검사한다. **이 순서는 완화하지 않는다.**
  - ID Token은 `aud`·`exp`·`iat`·`iss`·`sub`의 존재, `iss` 일치, `aud`, `nonce`, 서명(위 옵션)을 검사한다.
  - PKCE 대조는 공급자 token endpoint가 한다.
- **결과:** `tokens.claims()?.sub`만 읽는다. token·ID Token 원문은 저장·전달·로그하지 않는다. userinfo는 호출하지 않는다.
- **로그:** vendor 오류 객체(`cause`·`parameters`·`claims`·`body`)를 통째로 남기지 않는다. `{ provider, stage, name, code }`만 남긴다.

```ts
// app/src/server/auth/oidc.ts  (import "server-only")
export function beginLogin(p: ProviderConfig, session: SessionConfig, returnTo: string):
  Promise<Result<{ authorizeUrl: URL; flow: { value: string; expiresAt: Date } }, "provider_unavailable">>;   // discovery 실패
export function finishLogin(p: ProviderConfig, flow: FlowInput, query: URLSearchParams):
  Promise<Result<{ subject: string }, "provider_unavailable" | "cancelled" | "rejected">>;
// provider_unavailable = discovery 실패, cancelled = vendor가 iss·state를 통과시킨 뒤의 error=access_denied, rejected = 그 밖 모든 검증·교환 실패
```

### 6.2 처리 함수 (Next 타입 없음) [메인]

```ts
// app/src/server/auth/handlers.ts  (import "server-only")
export type CookieEffect =
  | { op: "set"; name: string; value: string; options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } }
  | { op: "delete"; name: string; secure: boolean };
export type HandlerResult =
  | { status: 303; location: URL; cookies: CookieEffect[] }          // 내부: new URL(path, cfg.session.baseUrl), start 성공만 공급자 authorize URL
  | { status: 403 | 404 | 503; cookies: CookieEffect[] };           // Location 없음
export function handleStart(auth: AuthR, provider: string, origin: string | null, form: FormData): Promise<HandlerResult>;
export function handleCallback(auth: AuthR, getDb: () => Db, provider: string, query: URLSearchParams, cookies: { flow?: string }): Promise<HandlerResult>;
export function handleLogout(auth: AuthR, origin: string | null): HandlerResult;
export function handleWithdraw(auth: AuthR, getDb: () => Db, origin: string | null, form: FormData, cookies: { session?: string }): Promise<HandlerResult>;
export function handleRestore(auth: AuthR, getDb: () => Db, origin: string | null, cookies: { recovery?: string }): Promise<HandlerResult>;
```

- **공통 첫 단계:** `auth.ok === false`이면 모든 함수가 **즉시 `{ status: 503, cookies: [] }`**를 돌려준다.
  - Location·쿠키·DB 변화가 없다. cfg가 없으므로 Origin 검사, 쿠키 이름, redirect를 만들지 않는다.
  - Host·`request.url`로 대신 만들지 않는다.
  - `/login` GET 화면의 "로그인 준비 중"은 page가 viewer 상태로 보여 준다(§7).
- **두 번째 단계:** cfg가 있을 때만 POST 함수에서 `assertSameOrigin(cfg.session, origin)`을 검사한다. 실패하면 `{403, []}`(쿠키·DB 변화 0). 그다음 provider·form·증명 순서로 검사한다.
- `getDb`가 throw(미설정)하거나 쿼리·연결이 실패하면 "DB 실패"로 묶는다. 처리는 표의 503 행을 따른다.
- **route 어댑터(B4):**
  - `HandlerResult`를 `NextResponse`로 옮긴다. 303은 `Location`, 403·404·503은 Location 없이 아래 고정 본문을 보낸다.
  - `Content-Type: text/plain; charset=utf-8`과 `Cache-Control: no-store`를 붙인다. callback 응답에는 `Referrer-Policy: no-referrer`도 붙인다.
  - 고정 본문: 403 "요청을 확인할 수 없어요.", 404 "찾을 수 없어요.", 503 "지금은 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요."
  - 입력 값을 응답에 반영하지 않는다. Node.js runtime(route 기본값)을 쓴다.

### 6.3 HTTP 표 [메인]

- **query 허용 목록:** `error ∈ {cancelled, failed, expired, purge_due}`, `notice ∈ {signed_out, withdrawn}`. 화면은 키로 고정 문구만 보여 준다.
- **쿠키 약어:** F=flow, S=세션, R=복구. `+`는 set, `−`는 delete, `·`는 변화 없음.

**`/auth/{p}/start` — POST (form: `returnTo`)**

| 순서·조건 | status·Location | 쿠키 | DB |
|---|---|---|---|
| auth err | 503 | · | 0 |
| Origin 누락·불일치 | 403 | · | 0 |
| `p`가 `enabled`에 없음(모르는 문자열 포함) | 404 | · | 0 |
| discovery 실패 | 503 | · | 0 |
| 성공(`returnTo`는 `parseReturnTo ?? "/"`) | 303 공급자 authorize URL | F+ | 0 |

**`/auth/{p}/callback` — GET**

- **flow 삭제 규칙:** cfg가 있으면 응답마다 F−를 한다. 이름을 알고, 재사용할 수 없게 하기 위해서다.
- **fresh OAuth 검증 전의 실패에서는 S·R을 건드리지 않는다.** 실패한 callback으로 사용자를 로그아웃시키는 우회를 막는다.
- S·R의 교체·삭제는 검증된 `active`·`pending_deletion`·`purge_due` 결과에서만 한다.

| 순서·조건 | status·Location | 쿠키 | DB |
|---|---|---|---|
| ① auth err | 503 | ·(flow 이름도 알 수 없음) | 0 |
| ② `p`가 `enabled`에 없음 | 404 | F− | 0 |
| ③ `readFlow` → `missing`·`invalid`·`expired`(구조 불량 포함) | 303 `/login?error=expired` | F− | 0 |
| ④ `flow.provider !== p` 또는 `flow.issuer !== cfg.providers[p].issuer.href`(설정 바인딩 불일치) | 303 `/login?error=failed` | F− | 0 |
| ⑤ `finishLogin` → `provider_unavailable` | 503 | F− | 0 |
| ⑤ → `cancelled` | 303 `/login?error=cancelled` | F− | 0 |
| ⑤ → `rejected`(state·nonce·iss·aud·서명·PKCE·중복 매개변수·교환 실패 등) | 303 `/login?error=failed` | F− | 0 |
| ⑥ DB 실패(`getDb` throw, 연결·쿼리 실패) | 503 | F− | 트랜잭션은 자체 계약대로 rollback. COMMIT 여부가 불명확하면 재로그인으로 멱등 회복(보상 지급·원장 되돌리기 없음) |
| ⑦ `invalid_identity` | 303 `/login?error=failed` | F− | 0 |
| ⑧ `active` → `sealSession` 성공 | 303 `returnTo` | F− S+ R− | 계정·지급 COMMIT(F3 멱등) |
| ⑧ `active` → `sealSession` throw | 503 | F− S− R− | COMMIT 그대로(원장 되돌리기 없음). 재로그인하면 같은 userId·`granted=false` |
| ⑧ `pending_deletion` → `sealRecovery` 성공 | 303 `/account/restore` | F− S− R+ | 0 |
| ⑧ `pending_deletion` → `sealRecovery` throw | 503 | F− S− R− | 0 |
| ⑧ `purge_due`(재시도 없음) | 303 `/login?error=purge_due` | F− S− R− | 0 |

**`/auth/logout` — POST**

| 조건 | status·Location | 쿠키 | DB |
|---|---|---|---|
| auth err | 503 | · | 0 |
| Origin 실패 | 403 | · | 0 |
| 성공(세션이 없어도) | 303 `/login?notice=signed_out` | S− R− | 0 |

**`/auth/withdraw` — POST (form: `confirm=withdraw`)**

| 조건 | status·Location | 쿠키 | DB |
|---|---|---|---|
| auth err | 503 | · | 0 |
| Origin 실패 | 403 | · | 0 |
| `confirm`이 정확히 `withdraw`가 아님 | 303 `/account/withdraw` | · | 0 |
| `readSession`이 ok가 아님 | 303 `/login` | S− | 0 |
| DB 실패 | 503 | **·(S 유지 → 재시도 가능)** | rollback |
| `requestWithdrawal` ok(`changed` 무관) | 303 `/login?notice=withdrawn` | S− | 첫 요청: pending·gen+1 / 중복: 불변 |
| `stale_session`·`not_found` | 303 `/login?notice=signed_out` | S− | 0 |

**`/auth/restore` — POST.** Origin 거부를 빼고, **증명 검사 이후의 모든 성공·실패(DB 실패 포함)에서 R−**를 한다.

| 조건 | status·Location | 쿠키 | DB |
|---|---|---|---|
| auth err | 503 | · | 0 |
| Origin 실패 | 403 | · | 0 |
| `readRecovery`가 ok가 아님 | 303 `/login?error=expired` | R− | 0 |
| DB 실패 | 503 | R− | rollback. fresh OAuth로 새 증명을 받아 재시도할 수 있다 |
| `restoreAccount` ok `{gen}` → `sealSession` 성공 | 303 `/` | R− S+ | active·gen+1, 지급 없음 |
| `restoreAccount` ok → `sealSession` throw | 503 | R− S− | COMMIT 그대로(active·gen+1, 잔액·원장 불변). 새 로그인으로 회복 |
| `expired` | 303 `/login?error=purge_due` | R− | 0 |
| `stale_proof`·`not_found` | 303 `/login?error=expired` | R− | 0 |
| `not_pending`(다른 탭에서 이미 복구, **세션 발급 안 함**) | 303 `/login` | R− | 0 |

**page (GET, Server Component — 쿠키 쓰기 불가 [사실])**

| 경로 | 동작 |
|---|---|
| `/login` | fixture면 `/`로 `redirect`. viewer `user`면 `redirect("/")`(307). `unavailable`이면 "로그인 준비 중". 그 밖에는 `enabled` 공급자 form(POST start, hidden `returnTo = parseReturnTo(query) ?? "/"`)과 query 허용 목록 문구 |
| `/account/withdraw` | viewer `user`만 설명과 확인 form(`confirm=withdraw` 체크). 그 밖에는 `redirect("/login?returnTo=/settings")` |
| `/account/restore` | `readRecovery`가 ok면 "계정 복구하기"(POST restore)와 "복구하지 않기"(POST logout). 아니면 "확인 시간이 지났어요"와 `/login` 링크. auth err면 "준비 중" |

- **mix-up 방어:**
  - 공급자별 callback 경로
  - flow에 봉인한 provider·`issuer.href`를 현재 enabled 설정과 정확히 비교(④)
  - vendor `iss` 검사: Google은 인가 응답 `iss` 필수와 ID Token, Kakao는 ID Token만

### 6.4 재생·동시성 경계 (R4 §3 그대로)

| 상황 | 결과 | 근거 |
|---|---|---|
| 성공 뒤 같은 URL 재요청(F 삭제됨) | ③ `expired`, DB 0 | 브라우저 쿠키 삭제 |
| 삭제 전 같은 code·F로 동시 callback 2건, 또는 복사한 쿠키+URL 재생 | 앱 state 대조를 둘 다 통과할 수 있다. 공급자가 재교환을 거부할 수 있다 [미확인]. 둘 다 통과해도 같은 userId·지급 1회 | 공급자 code 일회성 + F3 멱등. **앱 서버의 state 재사용 거부는 보장하지 않는다** |
| 탭 2개에서 start | 나중 F가 덮어쓴다 → 먼저 시작한 callback은 `failed`(state 불일치) 또는 `expired` | F 하나 |
| 로그인 vs 탈퇴 | 행 잠금으로 직렬화. 옛 gen 세션은 다음 요청 DAL에서 거부 | L2 |
| Set-Cookie 유실 | 지급은 COMMIT된 채 남는다. 재로그인하면 `granted=false` | R4 §2 |

## 7. 요청 context·DAL (B3)

```ts
// app/src/shared/diary.ts  (UI 공유, server import 없음)
export type DiaryContext =
  | { kind: "fixture"; userId: string; store: DiaryStore; today: string }   // 기존 그대로
  | { kind: "signed_in" } | { kind: "signed_out" } | { kind: "unavailable" };

// app/src/server/context.ts  (import "server-only")
export type RequestViewer =
  | { kind: "fixture" }
  | { kind: "user"; userId: string; gen: number }
  | { kind: "signed_out" }
  | { kind: "unavailable"; reason: "auth_not_configured" | "invalid_config" | "db_unavailable" };
export const getViewer: () => Promise<RequestViewer>;   // React cache: 한 요청 렌더 안에서만 memo
export async function getDiaryContext(): Promise<DiaryContext>;
```

**`getViewer` 순서 [메인]:**
1. `assertAuthModeAllowed(null, process.env)`: fixture+PROVIDERS면 throw한다. **fixture를 반환하기 전에 충돌 검사를 먼저 한다.**
2. `isFixtureModeEnabled(process.env)`이면 `fixture`. 운영 nodeEnv에서는 기존대로 throw한다. fixture userId `local-fixture-user`는 UUID가 아니라 PG 함수가 SQL 전에 거부하고, 메모리 store만 쓴다.
3. `loadAuthConfig(process.env, process.env.NODE_ENV)`가 err이면 `unavailable`(그 reason).
4. `(await cookies()).get(sessionCookieOptions(cfg.session, now).name)` → `readSession`. 다른 이름으로 fallback하지 않는다.
5. ok가 아니면 `signed_out`(`missing`·`invalid`·`expired`를 같게 처리).
6. `getAppDb()` → `verifyActiveAccount`가 throw하면 `unavailable:db_unavailable`. 접근을 허용하지 않고 "로그인 필요"로 위장하지도 않는다.
7. false면 `signed_out`, true면 `user`.

- **필요 입력 확인:** 위 단계가 읽는 것은 `process.env`의 §4.1 키와 요청 쿠키뿐이다. 모두 이 API 안에서 얻는다.
- **격리:**
  - React `cache`(요청 단위)에만 memo하고, 모듈 전역에 사용자 정보를 두지 않는다.
  - `force-dynamic`을 유지하고 `"use cache"`·정적 생성을 쓰지 않는다.
  - 동적 응답의 `Cache-Control`은 P1에서 확인한다 [미확인].
- **layout [사실, Next 인증 가이드]:** layout은 Partial Rendering으로 이동마다 다시 렌더되지 않는다. 그래서 layout viewer는 TopBar 표시에만 쓰고, 각 page·route가 따로 확인한다.

| 파일 | 변경 |
|---|---|
| `app/layout.tsx` | async, `await getDiaryContext()`. `canWrite = kind === "fixture"`(지금과 같음). TopBar에 `viewer` 종류 전달 |
| `app/page.tsx`, `days/page.tsx`, `days/[date]/page.tsx` | `await`. `fixture`는 지금과 같음. `unavailable`은 `NotConnected`(prod smoke 유지). `signed_out`은 `redirect("/login?returnTo=<서버가 아는 경로>")`. `signed_in`은 "로그인됐어요, 기록 연결 전" 안내 |
| `settings/page.tsx` | viewer별 계정 영역(로그아웃 form·탈퇴 링크 / 로그인 링크 / fixture 안내). `FontSettings`는 메모리 그대로 |
| `ui/d/DaysView.tsx` | 타입 그대로 |

- **[메인] F5 전 signed_in:**
  - "기록 연결 전" 안내만 보인다. PG 읽기·쓰기를 F4 범위에 추가하지 않는다.
  - 메모리 작성 UI(조각 추가 등)는 fixture에서만 보인다. 실제 저장처럼 보이지 않게 한다.
- **잔액 표시:** [미정] 표시 시점. 표시하지 않는다.

## 8. D 화면 상태 (B4-d → B4)

- [사실] D 핸드오프 §1은 로그인 관련 화면을 **아트보드 없음**으로 기록한다. 아래 표는 **설계 미확인**이다.
- D 전역 테마·구조를 유지하고, 새 색·레이아웃·3안 재선택은 없다.
- 기존 토큰과 클래스(`.board-head`, `.notice`, `.btn-main`·`.btn-add` 계열, `.btn-sub`, `.text-btn`, `.settings`)를 쓴다.

| 화면 | 기반 | 고정 문구(한국어) | 트리거 |
|---|---|---|---|
| 로그인 | `board-head` + `notice` + 공급자 버튼(세로, ≥ 44px) | "pieceofdays에 로그인", "Google로 계속하기", "카카오로 계속하기" | `/login` |
| 준비 중 | `NotConnected` 변형 | "로그인을 준비하고 있어요" | viewer `unavailable` |
| 취소 | `notice` | "로그인을 취소했어요. 다시 시도할 수 있어요." | `error=cancelled` |
| 실패 | `notice` + 오류색 테두리 | "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요." | `failed` |
| 시간 지남 | `notice` | "확인 시간이 지났어요. 처음부터 다시 로그인해 주세요." | `expired` |
| 복구 불가 | `notice` | "복구 기간이 지나 이 계정을 되돌릴 수 없어요." | `purge_due` |
| 로그아웃·탈퇴 완료 | `notice`(`aria-live=polite`) | "로그아웃했어요" / "탈퇴를 요청했어요. 30일 안에 다시 로그인하면 복구할 수 있어요." | `notice=…` |
| 탈퇴 확인 | `settings` 섹션 + 확인 체크 + `btn-sub` | "탈퇴하면 바로 로그아웃되고 30일 뒤 기록과 감정덩어리가 삭제돼요" | `/account/withdraw` |
| 복구 확인 | `notice` + `btn-main` + `text-btn` | "탈퇴를 요청한 계정이에요. 복구할까요?" | `/account/restore` |
| 복구 시간 지남 | `notice` | "확인 시간이 지났어요. 다시 로그인하면 복구할 수 있어요." | 복구 쿠키 무효 |
| 로그인됨·기록 연결 전 | `NotConnected` 변형 | "로그인됐어요. 기록 쓰기·불러오기는 다음 단계에서 연결돼요." | `signed_in` |
| 설정 › 계정 | `settings` 섹션 | 로그아웃, "계정 탈퇴" | `user` |
| 503 고정 본문 | text/plain(디자인 밖) | §6.2 | 처리 불가 |

- **로딩:** 제출 뒤 버튼에 `aria-disabled`와 "이동 중…"을 표시한다. JS가 없어도 POST·303으로 동작한다.
- **접근성:** 전환 시 `h1`(tabIndex −1)에 포커스한다. 오류는 `role="status"`·`aria-live`로 알린다. Tab으로 모두 닿고 `:focus-visible` 3px로 표시한다. 대비 AA는 기존 토큰 조합만 쓴다.
- **i18n:** 키 → 문구 표 하나(`src/shared/auth-messages.ts`)로 모은다. 다국어는 [미정]이다.
- **반응형:** 375/768/1440 수평 넘침 없음.
- **[메인] 공급자 브랜드:**
  - B4-d 착수 전에 Google·Kakao의 공식 로그인 버튼 규정을 확인한다.
  - 공급자 버튼에 한정한 필수 공식 에셋·색만 D 아트보드에 넣고, 나머지는 D 전역 토큰을 유지한다.
  - 이 확인을 위한 별도 사용자 승인 흐름은 두지 않는다.
- **B4-d 완료 조건:** source 아트보드의 375/768/1440 스크린샷을 메인이 확인한 뒤 B4 UI GREEN을 시작한다.

## 9. 시험 계획 (RED가 그대로 쓰는 사례)

**mock OIDC issuer (`app/tests/support/mock-oidc-issuer.ts`)** — 검증을 건너뛰지 않는 issuer

- **listen:** `node:http`, `127.0.0.1:<임의 포트>`만. issuer는 `/google`·`/kakao`.
- **discovery 모양:**
  - google: `authorization_response_iss_parameter_supported: true`, S256, post·basic
  - kakao: iss 매개변수 항목 없음, S256, `client_secret_post`만, pairwise
- **서명:** `node:crypto` RS256 키·JWKS. 시험 코드만 서명하고, 제품 코드는 JWT를 만들거나 파싱하지 않는다.
- **token endpoint가 실제로 거부하는 것:** client_secret 불일치, `redirect_uri` 불일치, code 재사용·만료, PKCE 불일치·누락.
- **고장 스위치:**
  - ID Token: `iss`·`aud`·`nonce` 변조, 다른 키 서명, `alg:none`·HS256, `exp` 과거, `id_token` 누락
  - callback: `iss` 불일치·누락(google), `error=access_denied`(state·iss 포함 / 누락)
  - code 재사용 허용 모드

**시험 이음새 (제품 DI 추가 없음):**
- `AuthConfig`·`SessionConfig`는 plain readonly 객체라 시험이 직접 만든다.
- **seal 실패 주입:** `secrets: {1: <32자+>, 2: <31자>}`인 cfg를 쓰면 iron이 가장 큰 번호(2)로 봉인하다 throw한다. 키 1로 미리 봉인한 flow·recovery는 같은 맵으로 읽힌다(F4a spike [사실]).
- **DB 실패 주입:** `getDb: () => { throw … }`(미설정), 닫힌 loopback 포트를 가리키는 `pg.Pool`(연결 실패).

| ID | 위치·명령 | 사례 → 기대 |
|---|---|---|
| U1a | `tests/unit/runtime-mode.test.ts` / `npm --prefix app test -- tests/unit/runtime-mode.test.ts` | 기존 사례 유지.<br>`authModeProblem` §4.2 표: fixture + `"google"`·`" "`(blank → null)·`"Google"`(형식 오류라도 non-blank → conflict), MOCK + production·undefined·"" nodeEnv → `mock_outside_dev`.<br>`assertAuthModeAllowed`: 모든 phase(+`null`)에서 fixture conflict throw / production 3 phase에서 MOCK만 있어도(PROVIDERS·SESSION 없음) throw / `phase-development-server` + MOCK + NODE_ENV development 통과.<br>import 그래프에 `server-only`·iron·pg 없음 |
| U1b | `tests/unit/auth-config.test.ts` | §4.3 각 행과 **우선순위**:<br>• MOCK + 운영 nodeEnv + PROVIDERS 없음 → `invalid_config`(1행보다 0b가 먼저)<br>• fixture + PROVIDERS + session invalid → throw(0a 먼저)<br>• fixture + malformed PROVIDERS → throw<br>• blank·`"google,"`·`"google,google"`·`"google, kakao"`·`"GOOGLE"`·`"naver"` → 1행 또는 4행<br>• 부분 자격 → `invalid_config`, 목록 밖 자격 무시, 제어문자·앞뒤 공백<br>• MOCK 형식(`localhost`·끝 슬래시·path·port 없음) → `invalid_config`<br>• issuer·redirectUri 값, `insecureMock` |
| U2 | `tests/unit/auth-flow-cookie.test.ts` | **형식 검사만**: 왕복, 10키 정확(추가·누락), purpose·v, provider enum, issuer 형식(https ok, `http://127.0.0.1:1/x` ok, `http://localhost:1` invalid, `https://a.b`(href≠원문) invalid, userinfo·query invalid), base64url 43자(42·44·`+`·`=`), returnTo 무효, `exp−1ms` ok / `exp` expired, 미래 iat, 수명 > 600_000, 세션·복구 봉인값 → invalid, 이름·속성 분기, child 프로세스 가짜 `Date.now`로 iron ttl 600 경과 → invalid, `sealFlow` 형식 위반 throw |
| U3 | `tests/unit/auth-recovery-cookie.test.ts` | 6키·purpose·`exp = iat + 600_000`·ttl 600, 비UUID·gen 위반 throw, `readSession(복구값)` invalid, `readRecovery(세션값)` invalid, 이름·속성 |
| U4 | `tests/unit/return-to.test.ts` | §5 표 전부 |
| U5 | `tests/unit/auth-oidc.test.ts`(mock, DB 없음) | • authorize URL 매개변수 정확(그 밖 0)<br>• 성공 → `{subject}`<br>• **위조 서명·alg none·HS256 → rejected**(NonRepudiation)<br>• state·nonce·iss(param·claim)·aud·만료·id_token 누락·PKCE 불일치 → rejected<br>• **중복 `state`·`code`·`iss` → rejected**<br>• iss·state를 통과한 `access_denied` → cancelled<br>• state 틀린 error → rejected, google iss 누락 error → rejected<br>• discovery 실패 → provider_unavailable<br>• token 요청 `redirect_uri`가 설정값(요청 host와 무관)<br>• 로그에 code·state·nonce·verifier·secret·sub 문자열 없음 |
| D1 | `tests/db/f4-auth-handlers.test.ts` / `npm --prefix app run test:db -- tests/db/f4-auth-handlers.test.ts` | **callback 표 전 행**:<br>• ① auth err 503·쿠키 0<br>• ② 404·F−만<br>• ③ 무효·만료 flow<br>• ④ google 경로에 kakao flow, mock issuer A로 봉인 → 설정 B → 둘 다 `failed`·F−만<br>• ⑤ 각 결과에서 기존 S·R 유지<br>• ⑥ DB 실패 503·F−·세션 0<br>• ⑧ 신규 active(원장 1·잔액 10·gen 1), 재로그인 granted false, active seal 실패 503·F− S− R−·원장 유지, pending R+·S−·원장·`first_login_at` 불변, pending seal 실패 503·쓰기 0, purge_due<br>• **같은 code 동시 2건**(일회성 mock) → 세션 1·원장 1, 재사용 허용 mock → 같은 userId·원장 1<br>• 성공 뒤 F 없이 재요청 → expired·DB 0<br>start 표 전 행. logout 표 전 행 |
| D2 | 같은 파일 | withdraw 표 전 행: auth err 503, Origin 누락·불일치·`"null"` 403·DB 불변, confirm 없음, 세션 무효, **DB 실패 → 503·S 유지·DB 불변**, 성공 pending·gen+1·S−, 중복 불변, stale |
| D3 | 같은 파일 | restore 표 전 행: auth err, Origin 403(R 유지), 증명 무효 R−, **DB 실패 503·R−·세션 0**, 성공 S+·gen+1·잔액·원장 불변, **성공 뒤 seal 실패 503·R− S−·DB active·gen+1 유지**, 옛 proof(복구 → 재탈퇴 뒤) stale, expired(owner가 기한을 과거로) `purge_due`·R−, not_pending 세션 0·R−, 세션 값을 recovery 자리에 넣음 → expired |
| D4 | `tests/db/f4-dal.test.ts` | getViewer 순서: fixture+PROVIDERS throw(fixture 반환 전), 옛 gen·pending·없음·int4 초과 gen → signed_out, DB 실패 → unavailable, A 세션으로 B 접근 불가(userId 질의·헤더 무시), 탈퇴 커밋 뒤 새 요청 차단 |
| E1 | `tests/e2e-auth/*.spec.ts` + `playwright.auth.config.ts`(127.0.0.1:3300, `next dev`, mock, globalSetup이 `tests/db/helpers.ts`로 일회용 PG·migrate). `POD_FULL_CHECK_ISOLATED=1`에서 `npx playwright test -c playwright.auth.config.ts`(app) | Google·Kakao 각각 성공, 취소, state 변조, F 삭제 뒤 재요청, 성공 URL 재요청, returnTo `/days/…` 유지·`//evil` → `/`, 로그아웃, 탈퇴 → 재로그인 → 복구 / 복구하지 않기, 키보드만, 375/768/1440, 실패 callback 뒤에도 로그인 유지 |
| P1 | `tests/prod/prod-boundary.spec.ts`(사례 추가) | 기존 6 유지 / `next start` + MOCK(PROVIDERS 없음 포함) → 시작 거부 / `next start` + fixture + PROVIDERS → 거부 / 운영 + http base + PROVIDERS → `/login` "준비 중"·POST start 503·Location 없음 / 위조 `x-user-id`·`?userId=` 무시 / 동적 응답 Cache-Control |
| B1 | `tests/auth-build-boundary.test.mjs`(사례 추가) | client가 `server/auth/{config,flow-cookie,recovery-cookie,return-to,oidc,handlers}`·`server/context`를 직접 또는 shared 전이로 import하면 build 실패 |

- **정상 RED:** 각 `it`에서 동적 import한 신규 모듈이 없을 때만이다. 타입·설정·환경 오류는 RED가 아니다.
- **GREEN:** 시험 변경 0. CI는 mock만 쓰고 실제 Google·Kakao를 호출하지 않는다.
- **CI(B4 GREEN):** `db` job과 같은 PG18.6 서비스의 `auth-e2e` job(Node 26, Secrets 없음, `ci-only-*` 가짜 값). 기존 job은 바꾸지 않는다.

## 10. 실제 공급자 검증 (B5, credential 필요 — 지금 실행하지 않음)

**Kakao PKCE 근거 (2026-11-03 재조회):**
- [사실] discovery는 `code_challenge_methods_supported: ["S256"]`이다.
- [사실] REST 문서 discovery 표 설명: "PKCE … S256으로 고정".
- [사실] 같은 문서의 **인가 요청 쿼리 표**와 **토큰 요청 본문 표**에는 `code_challenge`·`code_verifier`가 **없다**.
- 근거는 이전과 실질적으로 같다(광고 있음, 매개변수 표 없음). 실제 수락·강제는 미검증이다.
- [사실] Kakao 인가 응답 매개변수는 code·error·error_description·state이고, iss 매개변수는 없다. OIDC 앱은 scope에 `openid`가 필수이고 client secret이 기본 활성화다.

**preflight 범위 [메인]:**
- 아래 검증은 **개발 PC localhost 격리 preflight의 `.env.local`**에서만 한다.
- 거기서는 `POD_AUTH_PROVIDERS=kakao`(또는 `google`, `google,kakao`)를 허용한다.
- 공유 dev·운영·공개 활성화는 결과를 확인한 뒤 F6 범위에서 한다. 코드에 임의 우회 flag나 새 권한 저장소를 넣지 않는다.
- Google 단독 개발·실검증을 먼저 하는 것은 메인이 이미 허용했다. 최종 출시는 둘 다 필수다.

**순서(각 공급자, 사용자 또는 메인이 실행):**
1. 부록 A로 개발 앱을 설정한다.
2. 로컬 앱으로 정상 로그인 → `sub`로 계정이 생기면 성공이다.
3. **음성 1:** 새 code로 token 요청에 틀린 `code_verifier`를 보낸다 → 거부가 기대값이다.
4. **음성 2:** 새 code로 `code_verifier` 없이 token을 요청한다 → 거부가 기대값이다.
   - 3·4는 앱 밖 일회성 스크립트로 한다. 비밀값을 저장소에 남기지 않는다.
   - 결과는 HTTP status·오류 코드만 기록하고 code·token은 기록하지 않는다.
5. **취소 응답 형식 [미확인]:** 동의 화면에서 취소했을 때 Google 응답에 `iss`가, Kakao 응답에 `state`가 오는지 본다.
   - 누락·불일치면 vendor 순서(iss → state → error)대로 `failed`가 된다. 검증된 `access_denied`만 `cancelled`다.
   - UX를 맞추려고 검증 순서를 완화하지 않는다.
6. **Google `iss` [미확인]:** 공식 문서상 `https://accounts.google.com` 또는 `accounts.google.com`일 수 있다. 접두가 없으면 vendor 정확 일치에서 실패한다. 정규화 우회는 만들지 않는다.
7. **scope `openid`만으로 동의·`sub`를 받는지 [미확인]:** 공식 예시는 `openid email`이다.
8. **stop 조건:** 아래 경우 즉시 멈추고, 메인에 근거(status·오류 코드·문서)를 보고한다.
   - 2가 `code_challenge` 때문에 실패한다.
   - 3·4가 **성공**한다(PKCE 무시).
   - 6이 실패한다.
   - PKCE를 끄거나 Kakao를 제품에서 빼는 일은 조용히 하지 않는다.

| credential 없이 계속 가능 | credential·콘솔 필요 |
|---|---|
| B0~B4 전부(모드·config·codec·mock·handler·DAL·UI·E2E·CI) | B5 실로그인, PKCE 수락·강제, 취소 응답 형식, Google `iss`·scope, 공급자 code 재사용 거부, F6 실도메인 redirect 등록 |

## 11. 공식 1차 자료 (2026-11-03 조회, R1에서 추가 조회 없음)

| 자료 | URL | 확인 내용 |
|---|---|---|
| npm `openid-client` 6.8.9 | https://registry.npmjs.org/openid-client/6.8.9 | 게시 2026-11-02, latest 6.8.9, deps `jose ^6.2.15`·`oauth4webapi ^3.8.8`, engines 없음, ESM |
| openid-client 6.8.9 tarball | https://registry.npmjs.org/openid-client/-/openid-client-6.8.9.tgz | `discovery`(issuer 일치)·`ClientSecretPost`·`buildAuthorizationUrl`·`authorizationCodeGrant`·PKCE·random*·`allowInsecureRequests`·`enableNonRepudiationChecks`(기본 서명 미검증), `redirect_uri = currentUrl` − query |
| oauth4webapi 3.8.8 | https://registry.npmjs.org/oauth4webapi/-/oauth4webapi-3.8.8.tgz | `validateAuthResponse` 순서 iss → state → error, 중복 매개변수 throw, ID Token claim 검사. B0 lock의 실제 버전은 3.8.8(§15) |
| Google discovery | https://accounts.google.com/.well-known/openid-configuration | issuer, S256·plain, `authorization_response_iss_parameter_supported:true`, post·basic, public, RS256 (Last-Modified 2026-03-17) |
| Google OIDC | https://developers.google.com/identity/openid-connect/openid-connect | redirect_uri 정확 일치, state·nonce, `iss` 두 형식, `sub` 불변·최대 255 (Last updated 2026-10-29 UTC) |
| Kakao discovery | https://kauth.kakao.com/.well-known/openid-configuration | issuer, S256, post만, pairwise, RS256, query만, iss 매개변수 항목 없음 |
| Kakao REST API | https://developers.kakao.com/docs/ko/kakaologin/rest-api | §10 표 대조, scope `openid` 필수, client secret 기본 활성화, 취소 `error=access_denied` |
| Kakao 설정·이해 | https://developers.kakao.com/docs/ko/kakaologin/prerequisite , https://developers.kakao.com/docs/ko/kakaologin/common | 사용 설정·redirect URI 필수, OIDC 설정 |
| Next.js(사이트 Latest v16.4.5, 앱 16.4.3) | https://nextjs.org/docs/app/api-reference/functions/cookies , https://nextjs.org/docs/app/api-reference/functions/headers , https://nextjs.org/docs/app/api-reference/file-conventions/route , https://nextjs.org/docs/app/api-reference/functions/redirect , https://nextjs.org/docs/app/guides/authentication , https://nextjs.org/docs/app/guides/data-security | `cookies()` async, Server Component 쓰기 불가, DAL `server-only`·React `cache`, layout Partial Rendering, Server Actions Origin, `redirect` 307/303. 16.4.3과의 차이는 [미확인] |

- **미조회:** openid-client GitHub HEAD 문서(패키지 원문으로 대체), 공급자 버튼 브랜드 가이드(B4-d 착수 전에 확인), 콘솔 실화면.

## 12. 롤백·확장/수축·관찰·범위 밖

- **스키마:** 추가 없음 → expand·contract 없음. 0001·0002 그대로다.
- **롤백:**
  - B4를 revert하거나 `POD_AUTH_PROVIDERS`를 제거하면 `auth_not_configured`가 되어 "준비 중"으로 돌아간다.
  - 지급 원장은 되돌리지 않는다.
  - 발급된 세션을 무효화하려면 키 교체(F6 런북)나 사용자별 gen 증가를 쓴다.
  - 정적 dev·운영에는 영향이 없다.
- **관찰:**
  - `auth.start`·`auth.callback`·`auth.withdraw`·`auth.restore`의 `{provider, result, stage}`만 남긴다.
  - code·state·nonce·verifier·token·cookie·secret·sub·userId·email은 남기지 않는다.
  - 지표·보관 기간은 [미정] (F6)이며 값을 만들지 않는다.
- **F6:** 서비스 DB·운영 env·실도메인 redirect·HTTPS·신뢰 프록시·purge·백업. F6 프로그램을 완화하지 않는다.
- **범위 밖:** 계정 연결 [미정], 재지급 방지 식별자 보관 [미정], 사진·AI·공유, 개인정보·SLA 정책.
- **미실행:** npm 설치, 코드·DB·E2E 시험, 서비스 기동, 실로그인, 콘솔 작업.

## 13. 메인 구현 결정 (2026-11-03)과 잔여 미확인

**메인 결정** (기술 선택이며 사용자 제품 정책이 아님. 이 범위의 실행은 기존 승인 범위라 사람의 재승인을 새 선행 조건으로 만들지 않는다):

1. **`POD_AUTH_PROVIDERS`(§4):** 목록 방식, enabled 공급자는 완전히 설정돼야 함, 모르는 이름·중복 거부, 목록 밖 자격 무시, fixture와 실제 auth 동시 사용 금지. 개발·시험·Google 실검증을 먼저 해도 되며, 최종 출시는 Google+Kakao 둘 다다.
2. **flow 쿠키:** 목적 분리 10키·10분, POST start, 명시 Origin(§5·§6.3). R4 §2 도식은 POST·303으로 맞췄다.
3. **`enableNonRepudiationChecks` 필수**(§6.1). 옵션 끄기·PKCE 끄기·정규화 우회는 없다.
4. **F5 전 `signed_in`은 "기록 연결 전" 안내**(§7). PG 읽기·쓰기를 F4에 추가하지 않고, fixture UI를 실제 저장처럼 보이게 하지 않는다.
5. **B4-d는 별도 D 상태 아트보드 담당에 후속 배정.** source 먼저, dev 게시 사본은 그 단계에서 메인이 명시적으로 배정한다. D 전역 테마·구조는 유지한다.
6. **공급자 브랜드 공식 규정은 B4-d 착수 전에 확인.** 버튼 한정 필수 에셋·색만 넣고 나머지는 D 토큰을 쓴다. 별도 사용자 승인 흐름은 없다.

- **B0:** R1 독립 검토·메인 수락 뒤 배정한다. 같은 라이브러리를 사용자에게 다시 묻지 않는다.
- **유지되는 기존 정책:** scope `openid`, 서버 state 저장소 없음, 세션 5키·7일, 복구 6키·10분, 양쪽 로그인, 계정 연결 [미정].

**잔여 [미확인] (모두 B5 또는 B4-d에서 확인):**
- Kakao PKCE 실제 수락·강제
- 취소 응답의 `iss`·`state` 포함 여부
- Google ID Token `iss` 형식
- scope `openid` 단독 동작
- 공급자 code 재교환 거부
- 공급자 버튼 브랜드 규정
- Next 16.4.3과 문서의 차이
- 동적 응답 Cache-Control

## 14. R0 검토 대응표

| 지적 | 대응 위치 |
|---|---|
| P1-1 `readFlow`가 설정 issuer를 판정할 수 없음 | §5 형식 전용 판정 순서·issuer href 정책, §6.3 callback ③·④ 분리, §9 U2 → D1 이동 |
| P1-2 auth err 때 Location·Origin·쿠키 | §6.2 `HandlerResult` union·공통 첫 단계 503, §6.3 각 표 첫 행, `/login` 상태 |
| P2-1 실패 매트릭스 | §6.3 callback ⑥·⑧ seal 실패, withdraw DB 실패 S 유지, restore 전 분기 R−, 검증 전 실패는 S·R 불변, §9 D1~D3 |
| P2-2 판정 순서·시작 검사 | §4.2 순수 함수, §4.3 0a·0b 행·시점 표, §7 getViewer 1단계, §9 U1a·U1b |
| P2-3 비밀값 형식 | 부록 A |
| P2-4 B5 순환 | §3 B5, §10 preflight 범위, 부록 A |
| P2-5 중복 query | §6.1 `append` 규칙, §9 U5 |
| P2-6 취소 응답 | §6.1 순서 유지, §10 5번 |
| P2-7 R4 정합 | [PLAN_mvp-authentication](PLAN_mvp-authentication.md) §2 도식 POST·303과 진행 메모, §13 |

- **R1 수락(메인):** `F4_OIDC_INTEGRATION_PLAN_R1_REVIEW_COMPLETE`의 PASS(P0·P1 없음)를 수락했다. 비차단 P2-A는 §6.1의 설정별 캐시 키로, P2-B는 부록 A의 저장소 루트·파일 끝 개행 처리로 보완했다. 문서 diff·상대 링크를 확인했으며 코드·DB·실로그인 시험은 이 계획 단계에서 실행하지 않았다.

## 15. B0 패키지 준비 실행 결과 (2026-11-03)

이 계획 수립 단계(§12 "미실행")와 별개로, B0에서 실제로 설치하고 검사한 결과다. 공개 API·쿠키·모드·오류·표·정책 계약은 바꾸지 않았다. 독립 검토와 메인 통합은 아직 진행 전이다.

- **변경:** `app/package.json`의 dependencies에 `openid-client: "6.8.9"`(exact) 1줄을 추가했다. `app/package-lock.json`에는 아래 3개 항목과 루트 의존성 1줄만 추가됐다. 기존 직접 의존성 업그레이드·범위 변경·overrides는 없다.

  | 패키지 | lock 버전 | integrity(registry `dist.integrity`와 일치) |
  |---|---|---|
  | `openid-client` | 6.8.9 (deps `jose ^6.2.15`, `oauth4webapi ^3.8.8`) | `sha512-6mXMRNJxDOf6BflEWLXul1UwzLFz++9Ofz1PYwPwwsJsyXBsbfkO+Jo255SW1qnFNLYz4EJWHz42X4OJJrya/g==` |
  | `jose` | 6.2.15 | `sha512-qdF6ewcZARtef63fJ9AKKZPgxw+t7USH6HLXYcD4CrdmSvDp79rpJSPFEKc90QBeGS63u1KQtN2MZQHC0yDIzA==` |
  | `oauth4webapi` | 3.8.8 | `sha512-8N28E+a/oxfXWBgOMt+ZP/JUf/XR+IFbvkAEPP3gznXOMv9BpAAwiIj0TFNz3tGTPc0ZQ8zmWBNgN1nAys0gng==` |

  `resolved`는 모두 `https://registry.npmjs.org/…` tarball이며 계획(§11)의 범위와 같다.
- **Cloud 실행(Node 26.13.0·npm 11.20.0):** `npm install --save-exact openid-client@6.8.9`(`--force`·`--legacy-peer-deps` 없음, 3개 추가), `npm --prefix app ci`, `npm --prefix app ls --all`(invalid·extraneous·필수 UNMET 0), lint, typecheck, `npm --prefix app test`(단위 122, skip 0)가 모두 exit 0이었다.
- **실제 import(Node 26.13.0·24.22.2 각 1회, 시험·CI 변경 없음):** `discovery`·`ClientSecretPost`·`authorizationCodeGrant`·`buildAuthorizationUrl`·`enableNonRepudiationChecks`·`randomPKCECodeVerifier`·`calculatePKCECodeChallenge`·`randomState`·`randomNonce`·`allowInsecureRequests` 10개가 모두 `function`이었다. `typeof`만 읽었고 code·token·secret 생성이나 공급자 HTTP 호출은 하지 않았다.
- **CI([41702163333](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41702163333), 패키지 커밋 `7a4c373`):** Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·운영 경계 6·E2E 12, DB 138(PG 18.6 + Node 26)이 skip 0으로 통과했다. [root 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41702163653) 42·Compose도 통과했다.
- **미실행:** 제품 호출부는 0개다. 실제 OAuth discovery·토큰 교환·콘솔 작업·자격 증명, `.env*`, 로컬 DB(PG18 없음), Next 서버·브라우저·FullCheck는 실행하지 않았다. B1 이후 구현·시험은 아직 없다.

---

## 부록 A — Windows 세션용 OAuth 콘솔 설정 프롬프트 (초안)

> 이 문단은 사용자의 Windows PC Claude 세션에 붙여 넣는 용도다.
> - redirect URL은 **계획안**이다. 콘솔 메뉴 이름은 실화면을 조회하지 않은 안내 초안이다.
> - 실제 client ID·secret·token, 서버 내부 경로는 채팅·저장소·공개 문서·스크린샷에 남기지 않는다.
> - 이 계획 작업에서는 비밀값을 생성하거나 아래 명령을 실행하지 않았다.

```text
pieceofdays의 Google·Kakao OIDC 로그인용 개발 설정을 단계별로 안내해 줘. 너는 화면 안내와 파일 상태 확인만 한다.
[비밀값 원칙]
- client ID·secret·token·세션 키 값을 채팅으로 묻거나 받거나 출력하지 마. 화면 캡처를 공유할 때는 secret을 가리라고 알려 줘.
- 값은 개발 PC의 app\.env.local(저장소 .gitignore의 .env.* 규칙으로 커밋되지 않음)에 내가 직접 넣는다.
- 이미 있는 .env.local이나 기존 값은 덮어쓰지 말고, 키가 "있음/없음"과 형식이 맞는지만 값 없이 요약해 줘.
[환경 구분] (1) 로컬 개발 PC만 지금 설정한다. (2) dev(dev.pieceofdays.com)와 (3) 운영(pieceofdays.com)은 F6에서 메인이 진행하므로 메모만 한다.
[계획안 redirect URI, 정확한 문자열·끝 슬래시 없음]
  로컬: http://localhost:3000/auth/google/callback , http://localhost:3000/auth/kakao/callback
  dev(F6): https://dev.pieceofdays.com/auth/google/callback , https://dev.pieceofdays.com/auth/kakao/callback
  운영(F6): https://pieceofdays.com/auth/google/callback , https://pieceofdays.com/auth/kakao/callback
[Google — Google Cloud Console의 Google Auth Platform, 메뉴 이름은 화면에서 확인]
  1) 개발용 프로젝트 2) 브랜딩(앱 이름·지원 이메일), 대상(외부·테스트 모드·테스트 사용자에 내 계정)
  3) 클라이언트 → 웹 애플리케이션 → 승인된 리디렉션 URI에 로컬 URI 1개 4) scope는 openid만(email·profile 추가 안 함)
  5) .env.local에 POD_AUTH_GOOGLE_CLIENT_ID / POD_AUTH_GOOGLE_CLIENT_SECRET을 내가 직접 입력
[Kakao — Kakao Developers]
  1) 개발용 앱을 운영 앱과 분리해 만든다 2) [카카오 로그인] 사용 설정 ON, OpenID Connect 활성화
  3) REST API 키의 리다이렉트 URI에 로컬 URI 등록 4) 클라이언트 시크릿 ON(기본) 확인
  5) 동의항목은 최소. 꼭 필요한 항목이 있는지는 화면에서 확인해 알려 줘
  6) .env.local에 POD_AUTH_KAKAO_CLIENT_ID(REST API 키) / POD_AUTH_KAKAO_CLIENT_SECRET을 내가 직접 입력
[공통 .env.local 키]
  POD_AUTH_BASE_URL=http://localhost:3000
  POD_AUTH_SESSION_SECRETS는 JSON 번호 맵이다. 형식: POD_AUTH_SESSION_SECRETS='{"1":"[32자 이상 무작위 값]"}'
    (단순 무작위 문자열만 넣으면 설정 오류다. 작은따옴표로 감싸는 dotenv 표기는 계획상 추론이며 첫 실행 때 확인한다)
    저장소 루트에서 실행하는 PowerShell 예시(값은 출력하지 않고 파일에만 쓰며 기존 키가 있으면 변경하지 않음):
      $p = Join-Path (Get-Location).Path "app\.env.local"
      if ((Test-Path $p) -and (Select-String -Path $p -Pattern '^POD_AUTH_SESSION_SECRETS=' -Quiet)) { "이미 있음(변경 안 함)" }
      else { $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
             $s = [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
             if (Test-Path $p) { $tail = [System.IO.File]::ReadAllBytes($p)
               if (($tail.Length -gt 0) -and ($tail[-1] -ne 10) -and ($tail[-1] -ne 13)) {
                 [System.IO.File]::AppendAllText($p, [Environment]::NewLine, [System.Text.Encoding]::ASCII) }
               Remove-Variable tail }
             Add-Content -Path $p -Encoding ascii -Value ("POD_AUTH_SESSION_SECRETS='{`"1`":`"" + $s + "`"}'")
             Remove-Variable b, s; "추가함(값은 출력하지 않음)" }
  POD_AUTH_PROVIDERS: 이 PC의 격리 preflight에서는 google, kakao, google,kakao 중 검증할 대상을 넣는다
    (Kakao PKCE 확인을 위해 kakao 허용). 공유 dev·운영 활성화는 F6에서 메인이 한다.
  POD_DATABASE_URL: 이 PC의 로컬 개발 DB 연결(값은 출력하지 않음).
끝나면 설정한 항목을 값 없이 체크리스트로 요약해 줘. 실제 로그인과 PKCE 음성 확인(계획 §10)은 메인 안내가 있을 때만 진행한다.
```

| 구분 | 출시 필수 | credential 없이 진행 가능 |
|---|---|---|
| 콘솔 설정, Kakao·Google PKCE 수락·강제, 취소 응답·`iss`·scope 확인, 실로그인 | 예 | 아니오 |
| 모드·config·codec·mock issuer·handler·DAL·UI·E2E·CI | 예 | **예** |
