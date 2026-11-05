# PLAN — 개발 서버에서 실제 앱을 쓰기 (dev usable app)

- **상태:** 계획 초안이다(2026-11-05). 메인 검토·수락 전이다. 이 문서는 구현·배포를 하지 않았고 권한을 늘리지 않는다.
- **요청(2026-11-05):** "개발서버를 실제 사용가능하도록 해줘. 지금까지 개발된 내용확인하면서 진행가능하도록."
- **사용자 확인(2026-11-05):**
  - 범위: **실제 앱 + 로그인 + 서버 기록 저장**(아래 A).
  - OAuth: Google·Kakao 자격은 아직 준비되지 않았다. 메인이 비공개 콘솔 안내를 전달했고, 값은 문서·채팅에 두지 않는다.
  - dev 데이터: **C등급**(손실 허용, RTO 없음). 메인이 비공개 서비스 런북에 기록했다.
  - 이 확인은 계획 범위일 뿐이다. 실제 dev 앱 배포·로그인이 동작한다는 뜻이 아니며, 그 상태는 아래 게시 기준(§8)으로만 판정한다.
- **이전 해석(역사, 2026-11-05 확인 전):**
  - 메인은 A를 기본값으로 두고 사용자에게 선택을 물었다.
    - A: 실제 앱 + 로그인 + 서버 저장
    - B: `/try/` 브라우저 저장 기록장 + 현황 안내
  - B에 해당하는 것(`/try/` 유지, 현황 안내)은 A의 첫 단계(S0)로 이미 포함했다. 위 사용자 확인으로 A가 확정됐다.
- **BASE:** `dev` `e49b0c3ad79a32f16f8f33ca003aef9b57f43540`(작성자가 `git fetch`로 확인).
  - 메인 확인(작성자 미확인): 현재 dev 배포 = `e49b0c3`, prod = `02904ef`, dev 자동배포 41865852607·app 41865852663 success, dev `/`·`/try/` 200, dev·prod 컨테이너 healthy.
- **표기:** [사실] 코드·문서로 확인 / [메인] 메인 확인·결정 / [제안] 이 계획의 제안(검토 필요) / [미확인] / [미정]
- **근거:** [PLAN_mvp-foundation](PLAN_mvp-foundation.md) §5·§7, [PLAN_mvp-oidc-integration](PLAN_mvp-oidc-integration.md) §3·§6~§10·§13, [PLAN_mvp-domain-storage](PLAN_mvp-domain-storage.md), [PLAN_account-lifecycle](PLAN_account-lifecycle.md), [PLAN_dev-local-preview](PLAN_dev-local-preview.md), [PLAN_github-actions-deployment](PLAN_github-actions-deployment.md), [DATA_CONTRACT](../product/DATA_CONTRACT.md), [디자인 핸드오프](../design/README.md), [앱 문서](../../app/README.md).

## 1. 지금 쓸 수 있는 것과 아직 없는 것 [사실, BASE `e49b0c3`]

| 구분 | 상태 | 근거 |
|---|---|---|
| dev `/try/` 브라우저 저장 기록장 | **지금 사용 가능.** 조각 작성·수정·삭제, 하루 한 줄, 달력, 기록 글꼴, JSON 내려받기. 같은 브라우저에만 저장된다 | `frontend/public/try/`, 저장 키 1개 |
| dev `/design/`·`/promo/` | 시안·영상(메모리·예시) | `frontend/public/` |
| Next 앱 화면(`app/`) | **dev에 배포되지 않았다.** 현행 배포 프로그램은 정적 nginx 이미지만 허용한다 | `scripts/ops/deploy.py`(고정 Dockerfile·`--network=none` 빌드·포트 80·고정 health·env 없음) |
| 저장 도메인(F3) | 기록 CRUD·하루 한 줄·월 조회(`createPgDiaryStore`), 기록 글꼴(`getPreferences`·`setFontKey`), 첫 로그인 지급(`completeSuccessfulLogin`) | `app/src/server/diary/store.pg.ts` 등. **어느 화면에서도 호출하지 않는다** |
| 계정 수명주기(L1·L2) | 탈퇴·복구·활성 확인 함수 | `account/lifecycle.ts` |
| 인증(B1·B2) | 설정·쿠키 codec, OIDC 어댑터, 처리 함수 5개(`handleStart`·`handleCallback`·`handleLogout`·`handleWithdraw`·`handleRestore`) | `server/auth/*`. **HTTP route가 없어 시험에서만 호출된다** |
| 요청별 viewer·DAL(B3) | `getViewer()`가 세션 쿠키 → `verifyActiveAccount`로 `user`/`signed_out`/`unavailable` 판정. `getDiaryContext()`는 실제 계정에 `signed_in`(저장소 없음)을 준다 | `app/src/server/context.ts` |
| 로그인 화면·route | **없다.** 인증 env가 설정돼 `signed_out`이면 `/`가 `/login`으로 보내지만 `/login` page가 없다. env가 없으면 `unavailable` 안내를 보인다 | `app/src/app/` 목록: `days`·`dev`·`settings`·`page.tsx`·`layout.tsx` |
| 기록 화면의 서버 저장 | **없다.** `DayBoard`는 화면 메모리만 바꾸고 저장됐다고 하지 않는다. 로그인 사용자는 "기록 연결 전" 안내만 본다 | `ui/d/DayBoard.tsx`, `app/page.tsx` |
| 설정의 글꼴 저장·계정 영역 | **없다.** 글꼴은 화면 메모리만, 로그아웃·탈퇴 UI 없음 | `app/settings/page.tsx` |
| 서비스 DB·OAuth 자격·Next 이미지·purge 실행 | **없다**(F6) | foundation §7 |

**요약:** "실제로 쓸 수 있는 앱"까지 빠진 것은 ① 로그인 route·화면(B4), ② 실제 공급자 확인(B5), ③ 기록·한 줄·달력·글꼴의 서버 저장 연결(F5 최소), ④ dev 앱 배포·전용 DB·비밀값 주입(F6-dev)이다. 도메인 함수와 인증 처리 함수는 이미 있으므로 새로 설계하지 않고 **연결**한다.

## 2. 권장 경로와 의존 순서 [제안]

```
          ┌─ S1 B4-d 상태 아트보드 ─→ S2 B4 route·UI·mock E2E ─┐
병행 준비  ┤                                                   ├─→ S5 dev 게시(G2: Google 로그인) ─→ S6 dev 게시(G3: 첫 실제 기록)
          ├─ S3 F5-min 서버 저장 연결(서버 부분은 지금 시작 가능) ┘                                        └─→ S7 Kakao 켜기(B5 Kakao 통과 후)
          └─ S4 F6-dev 인프라(메인) + 사용자 콘솔(Google dev 클라이언트)  ── 병행
S0 현황안내는 위 준비와 병행하며 어느 기능의 선행 조건도 아니다.
```

| 단계 | 내용 | 선행 | 병행 가능 | 담당 |
|---|---|---|---|---|
| **S0 현황 안내** | `frontend/public/status/`(정적, noindex) 한 장: 기능별 "사용 가능 / 검토 중 / 아직 없음"과 링크. dev 첫 화면에서 연결 | 없음 | 모두 | 문서·정적 담당 + 메인 통합 |
| **S1 B4-d** | 로그인·안내·탈퇴·복구 상태 아트보드(공급자 버튼 공식 규정 반영, PR45 조사 댓글 참고) | 없음 | S3·S4 | D 아트보드 담당 |
| **S2 B4** | `/login`·`/account/withdraw`·`/account/restore` page, route 5개, 설정 › 계정, mock issuer Playwright E2E, auth-e2e CI job | S1 메인 확인 | S3 서버 부분·S4 | RED/GREEN Cloud |
| **S3 F5-min** | 로그인 사용자의 기록 CRUD·하루 한 줄·달력·글꼴을 PG에 연결(§4) | B3(완료). E2E는 S2의 mock 로그인 필요 | S1·S2·S4 | RED/GREEN Cloud |
| **S4 F6-dev 인프라** | Next 이미지·dev 전용 DB·비밀값 주입·health·복귀·purge 실행(§6) | 없음(설계는 지금 가능) | S1~S3 | **메인(서버)** |
| **S5 게시 G2** | dev에 Next 앱 + Google 로그인. 로그인하면 "기록 연결 전" 안내 | S2, S4, B5 Google, 사용자 콘솔 | — | 메인 |
| **S6 게시 G3** | 첫 실제 기록(서버 저장) | S3, S5 | — | 메인 |
| **S7 Kakao** | B5 Kakao PKCE 확인 뒤 `POD_AUTH_PROVIDERS`에 추가. **최종 출시 조건은 Google+Kakao 둘 다** | B5 Kakao | — | 사용자 콘솔 + 메인 |

- S5와 S6을 한 번에 게시해도 된다. 첫 실사용 목표는 기록이 실제로 남는 G3이며, G2는 중간 확인 단계다. S0은 G3의 선행 조건이 아니다.
- 사진·그리기·꾸미기 편집기·마켓·감정덩어리 사용은 첫 실제 기록의 선행 조건이 **아니다.**

## 3. 첫 사용자에게 필요한 최소 범위

- **포함:** Google 로그인(개발 단계, 기존 계획대로 먼저), 로그아웃, 오늘 조각 작성·수정·삭제(확인 후), 하루 한 줄, 달력·날짜별 다시 보기, 기록 글꼴 저장. 탈퇴 요청은 purge 실행 검증 뒤 G2b로 활성화하며, 복구는 기존 pending 계정을 막지 않도록 유지한다.
  - 첫 성공 로그인 10개 지급은 **세션 발급과 같은 검증된 성공 흐름**에서 이미 일어난다(`handleCallback` → `completeSuccessfulLogin`). 잔액 표시 시점은 [미정]이라 화면에 보이지 않는다.
- **제외:** 사진(실제 사용자에게 예시 이미지 선택도 보이지 않게 한다), 그리기·꾸미기, 마켓·구매, 공유·AI, 계정 연결, Kakao(S7 전).
- **차단 정보(값 없이 존재 여부만 메인이 확인):**
  1. Google dev OAuth 클라이언트(테스트 모드·테스트 사용자 등록, dev redirect URI) — 사용자 콘솔 작업
  2. dev 전용 PostgreSQL 18 DB와 app·owner·migrator·purge role, migration 적용 — 메인
  3. 세션 키(JSON 번호 맵)·DB URL·Google 자격의 dev 컨테이너 주입 경로 — 메인
  4. 개정된 dev 배포 프로그램 설치본 — 메인
  5. dev 접근 제한 방식이 OAuth callback·쿠키와 충돌하지 않는지 [미확인] — 메인

## 4. 코드 경계 (S2·S3) [제안]

**S2 B4**는 [OIDC 계획](PLAN_mvp-oidc-integration.md) §6.3·§7·§8·§9 그대로다. 새 계약을 만들지 않는다.

**S3 F5-min 연결:**

| 위치 | 변경 |
|---|---|
| `shared/diary.ts` `DiaryContext` | S3b에서 `{kind:"account"; userId:string; store:DiaryStore; today:LocalDate}`를 추가한다. fixture·unavailable·signed_out은 유지하고, `signed_in` 안내는 S3b 전까지 유지한다. 서버 문맥은 Client Component에 전달하지 않는다 |
| `server/context.ts` `getDiaryContext` | `user`일 때 `createPgDiaryStore(getAppDb())`와 서울 기준 오늘(`seoulLocalDate`)을 준다. userId는 `getViewer()`에서만 온다 |
| 쓰기 경로 | [S3a 고정 계약](PLAN_dev-diary-actions.md)의 Server Actions 5개. trusted config·명시 Origin 검사 뒤 매 호출 `getViewer()`로 `user`만 허용한다. 입력 userId는 받지 않으며 Next 내장 Origin/Host 검사도 유지한다. `allowedOrigins` 우회는 추가하지 않는다 |
| `ui/d/DayBoard.tsx` 등 | 실제 사용자 모드에서 작성·수정·삭제·한 줄이 서버 결과를 기다려 성공/실패를 표시한다. 버전 충돌(`conflict`)은 "다른 곳에서 바뀌었어요, 새로 불러오기"로 안내. 예시 이미지 선택은 fixture에서만. 삭제 확인 UI는 `/try/`의 D 확인 패턴을 재사용 |
| `settings/page.tsx`·layout | 계정 영역(S2)과 저장된 기록 글꼴을 서버에서 읽어 `data-record-font`로 적용 |

- 날짜·시간대는 기존 `Asia/Seoul` 계약 그대로다. 사용자별 시간대는 [미정].
- S3a는 새 액션 모듈·시험만 먼저 구현해 S2와 병행한다. S3b는 S2 통합 뒤 page/layout/settings/context를 연결해 같은 파일의 동시 수정을 피한다. 공개 입력·반환·날짜·갱신·오류 계약은 위 S3a 계획에서 메인이 고정하며 RED가 설계하지 않는다.
- **시험:** 단위(액션의 viewer 재검사·입력 거부), 실제 PG(본인 소유·타인 거부·버전 충돌·탈퇴 뒤 쓰기 거부), mock issuer E2E(로그인 → 작성 → 새로고침 유지 → 수정·삭제 → 달력 → 글꼴 유지, 375/768/1440·키보드). 기존 fixture E2E 12·prod 경계는 유지한다.
- **되돌리기:** S3 PR revert 시 로그인 사용자는 다시 "기록 연결 전"으로 돌아간다. 저장된 행은 DB에 남는다(삭제하지 않음).

## 5. 보안 경계 (가장하지 않기) [사실 + 제안]

- dev 서버도 **운영 빌드(`next build`·`next start`, NODE_ENV=production)**로 돈다. 그러면 기존 코드가 다음을 이미 거부한다 [사실]:
  - `POD_LOCAL_FIXTURE=1`(예시 사용자) — 운영 빌드·실행 시작 거부
  - `POD_AUTH_MOCK_OIDC_ISSUER` — 운영 phase 시작 거부
  - fixture + 실제 인증 동시 설정 — 모든 phase 거부
- **금지 [제안]:** "개발용 빠른 로그인", userId 질의·헤더·쿠키 주입, 고정 계정, mock issuer를 dev 도메인에 띄우는 것. 개발 도메인이라도 로그인은 실제 Google(뒤에 Kakao) OIDC뿐이다.
- 접근 확인은 매 page·action·route가 `getViewer()`로 한다(layout 표시는 보조).
- 비밀값은 서버 컨테이너 env로만 들어간다. 저장소·Cloud·PR·채팅·로그에 남기지 않는다.
- `next dev`·fixture·mock은 격리 Cloud·CI·개발 PC 시험에서만 쓴다.

## 6. F6-dev: 배포 허용 목록 검토와 메인 서버 작업

**[사실] 현재 배포 프로그램(`scripts/ops/deploy.py`)의 허용 범위:**
- 서비스 1개, 키 `image·build·container_name·restart·expose·healthcheck·networks·read_only·tmpfs·cap_drop·security_opt`만
- `expose: ["80"]`, 고정 health(`wget http://127.0.0.1:80/`), 외부 `edge` 네트워크만
- Dockerfile은 정확히 `FROM nginx:stable-alpine` + `COPY public/`이고, 신뢰 Dockerfile을 `--network=none`으로 빌드
- env·secret·DB 네트워크 없음

**필요한 변경 [제안, 설치본 변경은 메인]:**

| 항목 | 필요 | 비고 |
|---|---|---|
| Next 이미지 | Node 런타임 이미지(Next standalone 출력 등). `next.config.ts`에 출력 설정 추가는 코드 slice(F6-dev 앱 부분) | `--network=none` 빌드에서는 `npm ci`가 안 되므로, 의존성 포함 빌드 방식(사전 빌드 이미지 또는 허용된 레지스트리 접근)을 메인이 정한다 [미확인] |
| 정적 경로 유지 | 기존 nginx frontend를 앞에 유지해 `/try/`·`/design/`·`/promo/`·추가 시 `/status/`를 동일한 디렉터리 index·상대경로로 제공한다. `/`·인증·계정·Next 자산은 별도 Next 컨테이너로 프록시한다. 이 nginx 설정은 별도 dev-app 모드 소유다. Next 로그인 화면과 설정에 `/try/` 링크를 둔다 | Next public에 복사하는 것만으로 디렉터리 index를 보장하지 않는다. Next 이미지 전환 뒤에도 nginx 경유 preview E2E10·기존 localStorage 새로고침을 게시 조건으로 확인한다 |
| env 주입 | `POD_AUTH_SESSION_SECRETS`·`POD_AUTH_BASE_URL`·`POD_AUTH_PROVIDERS`·`POD_AUTH_GOOGLE_CLIENT_ID/SECRET`·`POD_DATABASE_URL`을 저장소 밖 런타임 파일에서 주입 | 현재 허용 목록에 없음 → 설치본 개정 |
| DB 네트워크 | 앱 컨테이너 → dev 전용 PG18만 | 다른 서비스 DB 접근 없음 |
| 포트·health | Next 포트와 health 방식 결정(예: 내부 포트 + DB 없이 200을 주는 경량 health 경로) | 현재 고정 `:80/` → 개정 필요 [미확인] |
| migration | 이미지 교체 **전에** 메인이 migrator로 `up`만 적용(확장 방식). 배포 프로그램은 migration을 실행하지 않는다 | foundation §7 |
| purge 실행 | 별도 purge role의 주기·재시도·감시·백업/복원 시 삭제 재적용을 F6-dev 계획에서 검토·실행 검증한 뒤 탈퇴를 G2b로 활성화한다 | 준비 전 `POD_WITHDRAWAL_ENABLED` 미설정: POST `/auth/withdraw`는 고정 503·쿠키0·DB쓰기0, GET `/account/withdraw`는 `/settings?notice=withdrawal_unavailable`로 redirect, 설정의 탈퇴 진입점 없음. restore는 유지한다. 값이 정확히 `1`일 때만 기존 B2 탈퇴 흐름을 허용한다. trusted env만 읽고 요청 입력으로 켜지지 않는다. S2 RED에 두 모드를 고정한다 |
| 복귀 | 실패 시 직전 이미지(첫 전환은 현재 정적 이미지)로 복귀. DB는 되돌리지 않는다 | 원장 삭제 없음 |
| 범위 밖 | 운영(main) 승격, 공용 nginx·TLS·다른 서비스 | 이번 계획 밖 |

## 7. `/try/` 브라우저 기록 보존과 전환

- `/try/`는 **같은 origin(`https://dev.pieceofdays.com`)·같은 경로**에 그대로 둔다. 저장 키는 바꾸지 않는다. 그래야 이미 쓴 기록이 계속 보인다.
- Next 앱은 그 저장 키를 읽거나 지우지 않는다. 로그아웃 응답 등에 `Clear-Site-Data`를 쓰지 않는다(쓰면 `/try/` 기록까지 지워진다) [제안].
- 공개 프록시의 Host·X-Forwarded-Host 전달, dev 접근 제한, Secure·Path=/·Domain 없는 `__Host-` 쿠키를 실제 URL에서 검증한다. 명시 Origin은 `POD_AUTH_BASE_URL`과 대조하고 프록시 문제를 wildcard `allowedOrigins`로 우회하지 않는다.
- 실제 계정과 **자동으로 합치지 않는다.** 로그인 화면·현황 안내에 "체험판 기록은 이 브라우저에만 있고 계정으로 옮겨지지 않아요. 설정에서 내려받아 두세요"를 표시한다.
- JSON 가져오기(명시적 이전)는 새 기능이라 이번 범위가 아니다. 필요하면 별도 계획으로 한다.

## 8. 중간 게시 기준과 개발 현황 안내

| 게시 | 조건 | 실제 URL에서 확인할 것 |
|---|---|---|
| **G0(지금)** | — | `/try/` 기록, `/status/` 현황 안내(S0 게시 후) |
| **G2** | S2 GREEN·독립 검토·CI(auth-e2e 포함), S4 완료, Google B5 통과, 사용자 콘솔 | `/login` → Google → 로그인 상태, 로그아웃, `/try/` HTTP200·자산·기존 브라우저 기록 유지. 미설정 탈퇴는 서버에서 거부 |
| **G2b** | purge 실행·재시도·감시·복원 시 삭제 재적용 검증 뒤 trusted env 활성화 | 탈퇴 요청·30일 내 복구, 기한 지난 전용 시험 계정의 purge. G3의 선행 조건은 아니다 |
| **G3** | S3 GREEN·검토·CI, G2 운영 확인 | 첫 실제 기록 작성 → 새로고침·다른 기기에서 보임, 수정·삭제, 달력, 글꼴 유지 |
| **G4** | B5 Kakao | Kakao 로그인 |

- **현황 안내 방식 [제안]:** `frontend/public/status/`의 정적 한 장. 각 게시 PR에서 메인이 갱신한다. 항목은 "사용 가능 / 검토 중 / 아직 없음"과 링크, 그리고 `/try/` 저장 한계다. Next 앱이 올라간 뒤에도 같은 경로로 제공한다.
- 게시마다 메인이 정확한 SHA·HTTPS·health·주요 흐름을 확인하고 현황을 갱신한다. 미완성 route·UI를 먼저 올려 사용자 확인을 새 관문으로 만들지 않는다.

## 9. 사용자에게 필요한 입력 (값은 채팅·Cloud로 받지 않는다)

| 입력 | 목적 | 시점 |
|---|---|---|
| 해석 A/B 답(선택 사항) | 명시 답변이 범위를 좁히면 따른다. 미응답은 A 준비를 계속하며 승인 관문으로 쓰지 않는다 | 지금 |
| Google dev OAuth 클라이언트 생성, dev redirect `https://dev.pieceofdays.com/auth/google/callback`(계획안) 등록, 테스트 사용자에 본인 계정 추가 | G2 로그인 | S5 전 |
| 클라이언트 ID·secret을 메인이 안내하는 서버 경로로 직접 전달(채팅 금지) | dev 컨테이너 주입 | S5 전 |
| Kakao 개발 앱·PKCE 확인 참여 | G4 | S7 전 |

[OIDC 계획](PLAN_mvp-oidc-integration.md) 부록 A의 콘솔 안내 프롬프트를 dev redirect 기준으로 쓴다.

## 10. 검증·되돌리기·미확인

- **검증:** 각 slice는 기존 RED → 독립 runner → GREEN → 독립 검토 → 메인 통합을 따른다. 게시 뒤 메인이 실제 URL·SHA·health를 확인한다.
- **되돌리기:** 앱 PR revert, `POD_AUTH_PROVIDERS` 제거(로그인 숨김), 직전 이미지 복귀. DB·원장은 지우지 않는다. `/try/` 키는 건드리지 않는다.
- **[미확인]:**
  - Next 이미지 빌드 방식과 `--network=none` 정책의 조화
  - dev 접근 제한과 OAuth callback·`__Host-` 쿠키의 호환
  - dev DB 백업 기대 수준
  - dev purge 실행 여부(§6)
  - Google·Kakao 실제 동작(OIDC 계획 §10)
- **이 작성자가 하지 않은 것:** 코드·시험·설치·서버·DB·콘솔·비밀값·FullCheck. Cloud에는 `_template`·`hc`·서버가 없어 읽거나 실행하지 않았다.

## 11. 메인 보완 (2026-11-05)

PR46 초안 d7db128의 독립 검토 P1 4건을 반영했다. 사용자 범위 선택은 선택 사항으로 유지하고, purge 준비 전 탈퇴를 route/page에서도 닫으며, S3a 공개 계약을 별도 계획으로 고정하고, 정적 경로는 nginx가 보존한다. 현행 정적 helper·production 경로의 허용 목록은 유지한다. F6-dev는 dev 키로만 호출 가능한 별도 엄격한 앱 경로로 설계하며, 고정 이미지 digest·저장소 밖 고정 env 경로/정확 키 목록·서비스 네트워크·고정 health·복귀를 검증한 뒤 메인이 설치본에 반영한다. source가 설치본을 자동 갱신하거나 임의 env/Compose·다른 DB·다른 서비스를 허용하지 않는다. 이미지 의존성 공급망·런타임 role/비밀값 경로·DB 백업 등급은 구체 F6-dev 계획과 운영 검토에서 마무리한다.
