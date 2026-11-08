# pieceofdays app (F1 화면·F2 DB·F3 도메인·F4 인증 기반)

2026-11-08 현재 서버 준비: [실제 C1 게시](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42484654242)와 같은 SHA의 [필수 앱 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42484654196)를 확인했다. 게시 이미지의 익명 pull·소스 라벨·manifest/config 연결을 대조했고, 그 이미지로 실제 dev DB migration 0001·0002와 앱 역할 TCP 접속·DDL/원장 변경 거부를 확인했다. 검토된 helper 설치·두 환경 probe도 완료했다. 아래 각 단계의 기록은 작성 당시 상태다. 현재 남은 연결은 OAuth 키·dev 콜백 승인과 [C2 전환](https://github.com/kindsr/devscent-pieceofdays-main/pull/72)이며, 사용자에게 제공하는 사이트는 아직 정적 체험판이다.

2026-11-08 F6a2: [PR65](https://github.com/kindsr/devscent-pieceofdays-main/pull/65) exact `03b4182`의 독립 검토 PASS와 [실제 조합 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42479241084)를 수락했다. 같은 불변 앱 이미지 ID로 기존 이미지6·프런트14·원문 preview10을 skip0으로 통과했다. 실제 nginx/Next의 정적 응답·Host/Origin·콜백 헤더/로그·장애·브라우저 기록 보존을 확인했다. 별도 observer로 query 수신 바이트를 대조하며 실제 OAuth 성공 증거로 세지 않는다. registry 게시·실제 게이트웨이 설정·서비스 DB·앱 전환은 아직 없다.

2026-11-08 S3b: 검증한 계정 문맥을 PG 기록장 화면에 연결했다([PR64](https://github.com/kindsr/devscent-pieceofdays-main/pull/64)). 조각 작성·수정·삭제, 조각이 없어도 쓰는 하루 한 줄, 날짜별 보기, 계정 글꼴 저장을 기존 Server Actions로 호출한다. 서버 자료만 화면에 전달하고 사용자 식별자·저장소는 React props에 넣지 않는다. 충돌·통신 실패에는 초안을 보존하고 자동 재시도하지 않는다. 삭제된 한 줄의 반복 재조회 회귀를 [PR66](https://github.com/kindsr/devscent-pieceofdays-main/pull/66)에서 먼저 확인해 수정했다. 제품 `573afd1`의 독립 검토 PASS와 [앱 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42479020099)(Node24/26 각각 단위265·빌드 경계7·운영12·fixture12, DB178, 인증·기록33), [이미지 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42479019998) 6/6·skip0을 수락했다. 계정 화면 합성 PNG15와 프런트 조합은 후속 PR65·67에서 확인했다. 서비스 DB·실제 OAuth·개발 앱 배포는 아직 남아 있다.

2026-11-05 F6a1: 격리 CI에서 빌드하는 standalone 앱 이미지와 기동 시 모드 검사 wrapper, `/healthz`·`/healthz/ready`, 최대 5개·연결 대기 5초·idle 10초의 앱 Pool 설정을 추가했다([PR58](https://github.com/kindsr/devscent-pieceofdays-main/pull/58)). 원본 제품 `dbaf8c2`는 [실제 이미지 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41960545128) 6/6과 독립 검토 PASS를 통과했다. 같은 이미지의 PG18 migration·app role readiness도 확인했다. 이미지는 CI 로컬에서만 만들며 아직 registry 게시·프런트 조합·서버 설치·앱 배포는 하지 않았다. B4 통합 뒤 최종 CI 결과는 PR58에 기록한다.

2026-11-05 B4: 인증 route 5개와 D 로그인·탈퇴·복구 화면, 설정의 계정 영역을 구현했다([PR57](https://github.com/kindsr/devscent-pieceofdays-main/pull/57), 제품 `cdf4edd`). route는 기존 B2 처리 함수와 쿠키 설정을 그대로 사용한다. `POD_WITHDRAWAL_ENABLED=1`일 때만 탈퇴 요청을 허용하며 기본은 닫힘이다. 복구는 이 설정과 독립이다. JS 없이도 공급자 form은 POST·303으로 동작한다. 계정 사용자는 아직 기록 연결 전 안내를 보며 S3b에서 저장 화면을 연결한다. 실제 공급자 자격·서비스 DB·개발 앱 배포는 미설정이다. 최종 통합 SHA의 CI·독립 검토 결과는 PR57에 기록한다.

2026-11-05 S3a: `src/app/actions/diary.ts`의 기록 작성·수정·삭제·하루 한 줄·글꼴 저장 액션을 검증했다. config → 명시 Origin → `getViewer()` → 입력 형태 → 기존 F3 순서이며, 예상 밖 오류는 원문 없이 `unavailable`이다. 화면에서 아직 호출하지 않아 실제 저장 UI가 켜진 것은 아니다. [PR52](https://github.com/kindsr/devscent-pieceofdays-main/pull/52) exact `24721ae`의 CI·독립 PASS: Node24/26 단위223·빌드 경계4·운영 경계6·E2E12, PG18 DB178(신규8), 배포 계약42. [연결 계약](../docs/plans/PLAN_dev-diary-actions.md)을 따른다.

Next.js App Router 앱 골격과 PostgreSQL 18 스키마·마이그레이션 실행기, 첫 로그인 지급·기록 CRUD·개인 꾸미기 버전·기록 글꼴 저장 코어, 인증 HTTP·계정 기록 화면을 구현했다. 실제 공급자 로그인 활성화·서비스 DB·앱 배포·이미지 저장소는 후속이다. 첫 지급은 B2의 성공 콜백에서 호출하며 실제 공급자 검증은 B5다. MVP 완료가 아니다.
루트 `frontend/`(정적 nginx 이미지)와 별개이며, **현재 dev 정적 배포(`dev.pieceofdays.com`)에 자동으로 포함되지 않는다**.
앱 배포 전환은 PLAN_mvp-foundation F6(메인 주도)에서 따로 정한다.

- 계획: [PLAN_mvp-foundation](../docs/plans/PLAN_mvp-foundation.md) · 버전: [00_TECH_STACK_DECISION §2.1](../docs/product/00_TECH_STACK_DECISION.md)
- 디자인 정본: [D 핸드오프](../docs/design/README.md), [D 아트보드](../docs/design/concepts/d-warm-pieces/)

## 구성

| 경로 | 내용 |
|---|---|
| `src/app/` | 경로: `/` 오늘, `/days` 모아보기, `/days/[date]` 특정 날, `/settings` 기록 글꼴·계정, `/login`·`/account/withdraw`·`/account/restore` 인증 화면, `/auth/` 인증 route 5개, `/dev/konva-smoke` 시험 fixture |
| `src/app/actions/diary.ts` | S3a Server Actions 5개: config·Origin·요청 사용자 확인 뒤 기존 F3 쓰기 호출. S3b 계정 화면이 직접 호출한다 |
| `src/ui/d/` | D 화면 컴포넌트(상단, 조각 보드·하루 한 줄·작성/수정 팝업, 달력, 글꼴 설정). 스타일은 `src/app/globals.css`(D `style.css`에서 옮김) |
| `src/ui/decorate/` | Konva 클라이언트 전용 모듈. 지금은 호환 스모크만 있고 꾸미기 편집기 UI는 없다(별도 아트보드 필요) |
| `src/server/runtime-mode.ts` | 로컬 고정 사용자 모드 판정과 운영 거부, 고정 사용자+실제 인증 동시 사용·운영 단계 mock issuer 거부. 원본 순수 검사를 `next.config.ts`와 standalone `runtime-startup.mjs`가 호출 |
| `src/server/auth/` | 세션 codec(F4a), 인증 설정·공급자 목록(`config.ts`), 로그인 진행·복구 쿠키 codec, returnTo 허용 목록(F4 B1), OIDC 어댑터·처리 함수(B2), HTTP 응답·쿠키 변환(`http.ts`, B4). 인증 route에서 호출한다 |
| `src/server/context.ts` | 요청별 viewer·기록 문맥. 세션·계정 활성 상태·세대를 확인한 계정에 본인 PG 저장소를 제공한다. page의 일반 서버 함수에서 읽고 JSX에는 화면 자료만 전달한다 |
| `src/server/diary/` | 읽기·쓰기 port(`store.ts`)와 PG CRUD 구현, 메모리 구현·예시 기록(로컬·시험 전용) |
| `src/server/account/`, `src/server/credit/` | identity별 계정 해석·첫 성공 로그인 10개 1회 지급·잔액 조회, 글꼴·디자인 적용 설정. B2/B4 성공 콜백 연결, 실제 공급자 검증은 후속 |
| `src/server/decoration/` | 본인 소유 개인 디자인 버전의 저장·목록·읽기 |
| `src/server/db/`, `migrations/` | 앱 Pool·트랜잭션, SQL 정책 검사·migration 실행기와 8개 테이블·권한·원장 보호 |
| `src/shared/` | UI 공유 타입, 글꼴 허용 목록, 날짜 파싱·서울 날짜/시각, 꾸미기 manifest 검증·렌더용 필터 |
| `tests/unit/`, `tests/db/`, `tests/e2e/`, `tests/e2e-auth/`, `tests/prod/` | Vitest 단위·일회용 PG18 통합 시험 / fixture E2E / 실제 mock OIDC·PG18 인증 E2E / 운영 모드 경계 smoke |
| `Dockerfile`, `runtime-startup.mjs`, `tests/image-contract.test.mjs` | F6a1 앱 이미지·기동 wrapper·실제 이미지 6개 검사. 전용 일회용 PG18과 Docker가 있는 격리 CI에서만 실행 |
| `tests/unit/dev-preview.test.ts`, `tests/e2e-preview/`, `playwright.preview.config.ts` | `app/` 밖 정적 체험판(`frontend/public/try/`)의 저장 모듈·브라우저 시험. 이 앱의 코드가 아니다(아래 체험판 절) |
| `docs/screenshots/` | F1 확인 스크린샷(로컬 고정 사용자 모드, 375/768/1440) |

## 실행 모드

| 모드 | 조건 | 화면 |
|---|---|---|
| 기본(운영 빌드 포함) | fixture·인증 설정 없음 | 오늘·모아보기는 "아직 준비 중" 안내. 설정에는 저장 글꼴 편집기가 없다. `/dev/konva-smoke`는 404 |
| 로컬 고정 사용자 | `POD_LOCAL_FIXTURE=1` + `next dev`(development) 또는 test | D 예시 기록(실제 사용자 기록 아님)을 메모리에서 읽기만 한다 |
| 인증 설정·검증 세션 | 유효한 인증 설정 + 요청 세션 | active·현재 세대이면 본인 PG 기록장과 저장 글꼴을 읽고 쓴다. 세션 거부는 서버가 아는 경로를 `returnTo`로 `/login`에 보낸다. DB 읽기 실패는 실패 안내이며 빈 자료·예시 기록으로 대신하지 않는다. 실제 서비스 사용은 F6 전환 뒤다 |

- `POD_LOCAL_FIXTURE=1`이 켜진 채 `next build`/`next start`(운영 단계)를 실행하면 `next.config.ts`에서 **시작을 거부**한다. 값은 비우거나 정확히 `1`만 허용한다.
- 로컬 고정 사용자 모드의 작성·수정·한 줄은 **그 화면의 브라우저 메모리에만** 반영된다. **새로고침하거나 다른 화면으로 이동하면 사라진다.** 실제 계정 모드는 서버 저장 성공 뒤 canonical 자료를 다시 읽으며, 통신 오류만으로 저장 성공·실패를 단정하거나 자동 재시도하지 않는다.
- 로컬 고정 사용자 모드의 글꼴은 새로고침하면 고딕으로 돌아간다. 실제 계정의 글꼴은 서버 성공 뒤 적용하고 새로고침·다른 기기의 같은 계정에서 유지한다.
- 추가 팝업은 주소 `#write`와 맞물린다. 브라우저 뒤로 가기로 `#write`를 벗어나면 닫히고, 앞으로 가기로 돌아오면 입력 중이던 초안과 함께 다시 열린다.
- 서버 코드는 헤더·URL·폼의 사용자 ID를 인증으로 쓰지 않는다. B3의 `getViewer`는 검증한 세션의 `userId`·`gen`만으로 계정 상태를 확인한다. 세션 발급 HTTP route와 실제 로그인은 B4·B5에서 연결한다.

## 명령

Node 26.13.0(`.nvmrc`) 기준, 24.22.2도 확인했다. `.npmrc`의 `engine-strict`로 범위 밖 Node에서는 설치가 실패한다.

```bash
cd app
npm ci
npm ls --all            # peer 경고 없음 확인
npm run lint            # ESLint, 경고 0
npm run typecheck       # next typegen && tsc --noEmit
npm test                # Vitest 단위(경계) 시험
npm run build           # next build (고정 사용자 모드 없이)
npx playwright install chromium   # 브라우저가 없을 때만
npm run test:e2e        # next dev + POD_LOCAL_FIXTURE=1로 띄워 E2E (127.0.0.1:3100)
npm run test:prod-smoke # 빌드 뒤: next start를 127.0.0.1:3200에서 플래그 없이 띄워 운영 경계 확인, 3201에서 플래그=1 시작 거부(exit 1) 확인
POD_LOCAL_FIXTURE=1 npm run dev   # 로컬에서 예시 기록으로 보기
```

`SCREENSHOT_DIR=<dir> npm run test:e2e`이면 화면별 375/768/1440 스크린샷을 남긴다.
CI는 `.github/workflows/app-validation.yml`(app 변경 PR·push, Node 26/24, Secrets·배포 권한 없음)이다.

## PostgreSQL 스키마·시험 (F2)

`npm run test:db`는 실행 전용 PostgreSQL 18에서 환경·마이그레이션·권한·데이터 제약과 도메인 저장 함수를 검증한다. `0001_init`에는 사용자·기록·설정·개인 디자인·감정덩어리 원장 등 8개 테이블이 있다. 기록 PG 구현은 F3 slice ②에서 검증했으며 실제 로그인·화면 연결은 F4·F5다. CI의 `db` job은 고정 digest의 공식 PostgreSQL 18 서비스 컨테이너를 사용하며, 실제 서비스 DB에 연결하지 않는다.

실행기는 `npm run db:migrate -- status`·`up`을 제공한다. 접속에는 별도로 준비된 migrator role의 `POD_MIGRATE_DATABASE_URL`과 `pod_meta.db_environment`가 필요하다. role 생성·실서버 프로비저닝은 실행기가 하지 않는다. 파일은 BOM 없는 UTF-8·LF의 번호별 up/down 쌍이며, 적용된 up 파일의 수정·누락은 체크섬 검사로 거부한다. down은 다른 writer가 없는 빈 CI DB 리허설에서만 허용한다. [계약·보호 조건](../docs/plans/PLAN_mvp-database.md)을 먼저 확인한다.

로컬에서는 [일회용 컨테이너 준비](../docs/plans/PLAN_mvp-database.md)의 환경을 먼저 마련한다. 아래 URL은 그 컨테이너의 가짜 값이다(`app/`에서 실행).

```bash
POD_TEST_DB_DISPOSABLE=1 POD_TEST_ADMIN_URL=postgres://postgres:ci-only-not-a-secret@127.0.0.1:55432/postgres npm run test:db
```

전체 검사는 저장소 루트에서 `POD_FULL_CHECK_ISOLATED=1`, `POD_TEST_DB_DISPOSABLE=1`, `POD_TEST_ADMIN_URL`을 지정하고 `bash app/tests/full-check.sh`로 실행한다. **격리된 Cloud/CI/개발 PC 전용이며 공유 운영 서버에서 실행하지 않는다.** 조건이 없으면 시험을 시작하지 않는다. DB 시험을 먼저 통과한 뒤 배포·앱 검사를 순차 실행한다. 플래그는 격리 환경이라는 운영 전제를 명시하는 것이며 머신 격리를 자동 보장하지 않는다.

bootstrap 당시 Cloud VM의 native PostgreSQL 실험은 보조 근거다. [F2 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41522328270)에서 DB 57개, Node 24·26 각각 단위 71개·운영 경계 6개·E2E 12개가 통과했다. FullCheck 스크립트 자체의 전체 실행은 별도로 검증하지 않았다.

## 첫 로그인 지급 코어 (F3 slice ①)

`completeSuccessfulLogin(db, identity)`는 계정 해석·원장·잔액·첫 로그인 시각을 한 트랜잭션에서 처리한다. 생성 경합의 패자는 전체를 롤백한 뒤 새 트랜잭션에서 한 번 재시도한다. 지급은 계정 잠금과 canonical 사용자별 원장 키로 한 번만 반영된다. `getBalance`는 읽기 전용이고, `getAppDb`는 `POD_DATABASE_URL`로 지연 생성한다. 현재 앱 경로에서 이 함수들을 호출하지 않는다.

[F3 slice ① CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41530631065): 단위 81·DB 69개, Node 24·26 각각 운영 경계 6·E2E 12개 통과. 8개 실제 app 연결에서 1회 지급, 새/기존 계정의 실패 롤백·재호출, 원장 합계와 잔액 일치를 검증했다. UI 공유 타입을 분리하고 UI·shared의 직접 server import를 lint로 막으며 Konva 제한을 유지한다. 실제 인증·세션은 미연결이고 전이 import 전체 보장은 F4/F5에서 강화한다.

## 기록 저장 코어 (F3 slice ②)

`createPgDiaryStore(db, { now })`는 조각·하루 정리의 읽기·작성·수정·삭제를 제공한다. 소유자 조건과 기대 버전으로 타인 접근·낡은 수정 요청을 거부하며, 본문은 앞뒤 공백을 제거한 뒤 코드포인트 수로 검사한다. 시각·날짜는 작성 때 고정하고 수정 때 유지한다. 서울 날짜는 명시한 IANA 시간대로 계산하며, 읽은 시각은 PG의 `time_zone` 변환을 따른다. 이미지 값은 `null`이다.

[F3 slice ② CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41538131128): 단위 83·DB 88개, Node 24·26 각각 운영 경계 6·E2E 12개 통과. 두 app 연결의 버전 경합, 한 줄 생성·삭제 조건, 소유권, 검증 실패 시 SQL 미실행, 1960·1988년 서울 시간대 이력까지 확인했다. 현재 화면은 이 저장 모듈을 호출하지 않는다.

## 개인 꾸미기·설정 저장 코어 (F3 slice ③)

`validateManifest`는 D의 슬롯·토큰·좌표와 64 KiB·획·점 수 상한을 검사한다. 장식 asset 허용 목록은 기본 빈 목록이며 펜만 쓴 manifest는 허용한다. 렌더용 필터는 원문 크기를 먼저 검사하고, 모르는 슬롯·형식이 정상인 목록 밖 asset만 제외한다. 알려진 항목의 형식 오류나 남은 항목의 상한 초과는 기본 D로 돌아가게 한다. 실제 clip·그리기 편집기·스티커 registry는 F5다.

개인 버전은 검증 후 매번 새 private 행으로 저장하고 본인만 조회·적용할 수 있다. 글꼴 저장과 디자인 적용은 각자 담당 열만 바꾸므로 동시에 호출해도 서로의 값을 덮어쓰지 않는다. 저장과 적용은 별도 함수이며 화면에서의 조율은 후속이다.

[최종 F3 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41548015623): 단위 103·DB 99개, Node 24·26 각각 운영 경계 6·E2E 12개 통과. 개인 버전 권한·목록·기본값·동시 설정 저장과 비정상 배열 입력을 Result로 거부하는 회귀를 확인했다. 각 TDD 구간·독립 검토·미실행 범위는 [F3 계획](../docs/plans/PLAN_mvp-domain-storage.md)에 기록한다.

## 세션 기반 (F4a)

`iron-session` 9.0.1을 고정하고 `src/server/auth/session.ts`에 설정 검증·7일 봉인/읽기·쿠키 속성·Origin 대조를 구현했다. payload는 `v`·`userId`·`gen`·`iat`·`exp` 5개 키다. 서버 모듈에는 `server-only` 경계를 적용하고 F2 migration CLI와 `runtime-mode.ts`는 제외했다.

[F4a CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41663957968): Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·운영 경계 6·E2E 12개, DB 99개 통과. 빌드 경계는 기준 사본과 실제 auth 서버 import의 빌드 성공, 클라이언트 직접·전이 import 거부를 임시 사본에서 확인한다. 독립 Cloud runner도 같은 GREEN 커밋 `96bcf8c`의 단위 122·경계 4개를 통과했다.

격리 Cloud·CI·개발 PC에서만 경계를 따로 실행한다: `POD_FULL_CHECK_ISOLATED=1 node --test app/tests/auth-build-boundary.test.mjs`(저장소 루트). 이 `node:test` harness는 현재 FullCheck 스크립트와 별도로 CI에서 실행한다. F4a 시점에는 실제 OAuth·요청별 DB 상태/세대 대조·복구 쿠키·탈퇴·삭제가 없었다(당시 기준). 현재 상태는 아래 L1·L2 절을 본다. 후속 계약은 [인증 계획](../docs/plans/PLAN_mvp-authentication.md)과 [계정 수명주기 계획](../docs/plans/PLAN_account-lifecycle.md)을 따른다.

## 계정 수명주기 스키마 (F4 L1)

`migrations/0002_account_lifecycle`이 다음을 추가한다. 실행기는 파일마다 트랜잭션을 나누므로 0002가 실패하면 0002만 롤백된다.

- 스키마: `users`의 상태·탈퇴 시각·삭제 기한·세션 세대 열과 일관성 제약, app의 해당 열 UPDATE 권한
- 원장 보호: UPDATE·TRUNCATE는 계속 거부한다. DELETE는 owner와 같은 사용자를 가리키는 트랜잭션 표시(GUC)가 있을 때만 허용한다
- 삭제 함수 2개: PUBLIC 실행 권한 회수, 전용 purge role만 실행
- 되돌리기: 빈 CI DB 전용 down
- 시험 하네스: purge role과 meta `purge_role`을 준비한다

[PR33 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41679894578)(코드 `0876c4b`):

- DB 119개(PG18.6 + Node 26)
- Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·운영 경계 6·E2E 12
- [root 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41679894597) 42

**독립 SQL 검토 PASS(P0·P1·P2 없음)를 수락해 dev에 통합했다.** 탈퇴·복구 도메인은 아래 L2에서 검증했다. 아직 없는 것:

- 실제 OAuth·복구 쿠키·화면
- 서비스 DB·운영 role·삭제 실행 주기

## 계정 탈퇴·복구 도메인 (F4 L2)

`src/server/account/lifecycle.ts`(신규)와 `login.ts` 변경(PR35 GREEN `ba2b167`):

- `verifyActiveAccount`: 잠금 없는 SELECT 한 번으로 active + 현재 세대(`::bigint` 비교)일 때만 true
- `requestWithdrawal`: users 행을 잠근 뒤 DB `clock_timestamp()`로 정확히 720시간 기한을 기록하고 세대를 올린다. 중복 요청은 기한·세대가 그대로이고, 응답에 세대를 담지 않는다
- `restoreAccount`: 기한은 DB 안에서 비교한다. 같은 canonical user·잔액·원장·`first_login_at`을 유지하고 다시 지급하지 않는다
- `completeSuccessfulLogin`: `active`·`pending_deletion`·`purge_due` 결과. 탈퇴 대기·기한 지남은 쓰기 0. identity를 읽은 뒤 purge가 커밋되면 같은 트랜잭션에서 `purge_due`(자동 재시도 없음)

[PR35 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41691842663):

- DB 138개(PG18.6 + Node 26, 9개 파일, skip 0)
- Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·운영 경계 6·E2E 12
- [root 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41691842754) 42

**독립 GREEN 검토 PASS(P0·P1·P2 없음)를 수락해 dev에 통합했다.** 이 함수를 부르는 실제 OAuth·HTTP route·요청별 DAL 검사·복구 쿠키·화면·삭제 실행 주기·서비스 DB는 아직 없다. "즉시 차단"은 DAL이 연결된 뒤 탈퇴 커밋 이후의 새 요청에 적용된다. 아직 사용자 기능으로 켜진 것은 아니다.

## OIDC 패키지 준비 (F4 B0)

`openid-client` 6.8.9(전이 `jose` 6.2.15·`oauth4webapi` 3.8.8)를 고정하고 독립 검토를 수락해 dev에 통합했다. B0 실행 당시 제품 호출부는 0개였다(B1 시점까지 같음). 현재는 B2의 `auth/oidc.ts`가 import한다. 실제 로그인은 아직 꺼져 있다(아래 B2 절). 설치·import·CI 결과는 [OIDC 연결 계획](../docs/plans/PLAN_mvp-oidc-integration.md) §15에 있다.

## 인증 모드·설정·쿠키 codec (F4 B1)

[OIDC 연결 계획](../docs/plans/PLAN_mvp-oidc-integration.md) §4·§5의 계약을 제품 7파일로 구현했다(PR39 GREEN `25365e7`, +350/−1). 기존 `session.ts`·SQL·package·CI는 바꾸지 않았다.

- `runtime-mode.ts`: `authModeProblem`·`assertAuthModeAllowed`(순수 Node, 기존 export 2개 그대로). `next.config.ts`가 모든 phase에서 호출해 고정 사용자와 실제 인증의 동시 설정, 운영 build·server·export 단계의 mock issuer를 거부한다.
- `auth/config.ts`: `loadAuthConfig`. 계획 판정 순서(0a → 8)대로 공급자 목록·자격·세션 설정·mock 형식을 검사하고, issuer는 고정 상수, redirect는 `/auth/<공급자>/callback`이다.
- `auth/flow-cookie.ts`·`auth/recovery-cookie.ts`·`auth/cookie-util.ts`: 로그인 진행 쿠키(정확히 10키)·복구 쿠키(정확히 6키)의 형식 전용 검사, 앱 기준 10분과 iron `ttl` 600, 쿠키 이름·속성 분기. 공급자·issuer와 현재 설정의 대조는 B2 처리 함수 몫이라 codec에 넣지 않았다.
- `auth/return-to.ts`: 로그인 뒤 이동 경로 정확 허용 목록(`/`, `/days`, `/days/YYYY-MM-DD`, `/settings`).

검증:

- RED(PR38 `1a8c4a2`, 시험 6파일만): 신규 40 사례 중 39는 기능 부재로 실패, 기존 122 + 순수 import 양성 1 = 123 통과(skip 0). 메인 RED gate 통과. RED 단계에서 build 이후 단계(빌드 경계·운영 경계·E2E)는 실행되지 않았다(통과로 세지 않음). DB 138·root 42는 통과.
- GREEN: 시험 변경 0·제품 7파일만, 메인 GREEN gate·`diff --check` 통과.
- [GREEN CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41709783372): Node 24.22.2·26.13.0 각각 단위 162(14파일, skip 0)·빌드 경계 4·운영 경계 6·E2E 12·lint·typecheck·build, DB 138(9파일, skip 0, PG 18.6 + Node 26). [root 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41709783621) 42·Compose 통과.
- exact GREEN의 독립 검토 PASS(P0·P1·P2 없음)를 메인이 수락했다. 독립 runner가 Node 26에서 단위 162·lint·typecheck를 직접 재현했고(Node 24는 CI 근거), iron 자체 TTL 경과 child 시험이 처음 실제로 실행되어 앱 시계 만료와 iron TTL 경과(`invalid`)가 구분됨을 확인했다.

명령(격리 Cloud·CI·개발 PC): `npm --prefix app test -- tests/unit/runtime-mode.test.ts tests/unit/auth-config.test.ts tests/unit/auth-flow-cookie.test.ts tests/unit/auth-recovery-cookie.test.ts tests/unit/return-to.test.ts`(저장소 루트).

**독립 검토를 수락해 dev에 통합했다.** B1 실행 당시에는 이 모듈을 쓰는 OAuth discovery·토큰 교환·처리 함수(B2), 요청별 DAL(B3), HTTP route·D 인증 화면(B4), 실제 공급자 검증(B5)이 없었다(B2 현황은 아래 절). 실제 로그인은 꺼져 있고 화면 PG 저장(F5)·서비스 DB·앱 배포(F6)도 없다. 로그인 정책(공급자 둘 다·첫 로그인 10개·30일 복구)은 바뀌지 않았다.

## OIDC 어댑터·인증 처리 함수 (F4 B2)

[OIDC 연결 계획](../docs/plans/PLAN_mvp-oidc-integration.md) §6의 계약을 제품 2파일로 구현했다(PR41 GREEN `db5d213`, +309). 시험·기존 source·config·SQL·package·CI·문서는 바꾸지 않았다.

- `auth/oidc.ts`(`beginLogin`·`finishLogin`): `openid-client` 6.8.9가 discovery·인가 요청·code 교환·ID Token 검증을 한다. `ClientSecretPost`, PKCE S256·state·nonce, `idTokenExpected`, ID Token 서명 검증(`enableNonRepudiationChecks`)을 항상 켜고, mock issuer일 때만 `allowInsecureRequests`를 더한다. discovery 결과는 issuer·client ID·secret·mock 여부 4종을 키로 프로세스 메모리에 두고 실패한 Promise는 지운다. callback query는 모든 항목을 그대로 덧붙여 중복을 보존한다. 취소는 vendor가 검증한 `access_denied`만이다. `sub`만 돌려주고 token·오류 원문은 저장·로그하지 않는다.
- `auth/handlers.ts`(`handleStart`·`handleCallback`·`handleLogout`·`handleWithdraw`·`handleRestore`): Next 타입 없이 status·Location·쿠키 효과만 돌려준다. 설정 오류 503과 Origin 검사가 먼저이고, F3 `completeSuccessfulLogin`·L2 `requestWithdrawal`·`restoreAccount`를 호출한다. COMMIT 뒤 봉인 실패에도 원장을 되돌리거나 다시 지급하지 않는다. 검증 전 callback 실패는 기존 세션·복구 쿠키를 유지하고, 탈퇴 DB 실패는 세션을 유지하며, 복구는 증명 검사 뒤 복구 쿠키를 소비하고 세대를 검사한다.

검증:

- RED(PR40 `eb7fa37`, 신규 시험 3파일: `tests/support/mock-oidc-issuer.ts`·`tests/unit/auth-oidc.test.ts`·`tests/db/f4-auth-handlers.test.ts`): 단위 11 실패·167 통과(기존 162 + mock·vendor 대조 5), DB 26 실패·139 통과(기존 138 + 실패 주입 대조 1). 제품 모듈 부재만 유효한 RED였고 메인 RED gate를 통과했다. RED 단계의 build 이후 단계(빌드 경계·운영 경계·E2E)는 실행되지 않았다(통과로 세지 않음).
- GREEN: 시험 변경 0·제품 2파일만, 메인 GREEN gate·`diff --check` 통과.
- [GREEN CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41787888546): Node 24.22.2·26.13.0 각각 단위 178(15파일, skip 0)·빌드 경계 4·운영 경계 6·E2E 12·lint·typecheck·build, DB 165(10파일, skip 0, PG 18.6 + Node 26. `f4-auth-handlers` 27 = 대조 1 + 처리 함수 26, 기존 138 유지). [root 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41787888296) 42·Compose 통과.
- exact GREEN의 독립 검토 PASS(P0·P1·P2 없음)를 메인이 수락했다. 독립 runner가 Node 26에서 단위 178·lint·typecheck를 직접 재현했고, Node 24·DB는 CI 근거다.
- 참고: 빈 `sub`는 vendor가 먼저 거부해 `failed` 응답이 된다. 서명이 정상인 256자 `sub`로 도메인 `invalid_identity` 경로를 확인했다.

명령(격리 Cloud·CI·개발 PC, 저장소 루트): `npm --prefix app test -- tests/unit/auth-oidc.test.ts`, DB는 일회용 PG18에서 `npm --prefix app run test:db -- tests/db/f4-auth-handlers.test.ts`.

**독립 검토를 수락해 dev에 통합했다.** B2 통합 당시에는 처리 함수를 시험에서만 호출했고 요청별 DAL도 없었다(현재 B3는 아래 절). B4는 발급 HTTP route·D 인증 화면을 연결했다(상단 현황). 실제 공급자 검증(B5)·서비스 DB·앱 배포(F6) 전이라 서비스 로그인은 아직 꺼져 있다. 화면 PG 저장(F5)도 후속이다. 로그인 정책(공급자 둘 다·첫 로그인 10개·30일 복구, 계정 연결 미정)은 바뀌지 않았다.

## 요청별 viewer·DAL (F4 B3)

[OIDC 연결 계획](../docs/plans/PLAN_mvp-oidc-integration.md) §7·§18을 제품 6파일로 구현했다(PR45 GREEN `7acef57`, +115/−15). **CI·독립 검토 PASS를 메인이 수락했다.** 최종 dev 통합·배포 결과는 [PR45](https://github.com/kindsr/devscent-pieceofdays-main/pull/45)에 기록한다.

- `getViewer`는 fixture/auth 충돌을 먼저 거부하고, 매 요청의 설정·정확한 이름의 세션 쿠키·계정 active와 현재 세대를 차례로 확인한다. 무효 세션은 `signed_out`, DB 실패는 `unavailable:db_unavailable`이다.
- 실제 `react`의 `cache`로 한 요청 렌더 안에서만 결과를 공유한다. 모듈 전역에는 고정 예시 store만 두고 실제 사용자 정보는 보관하지 않는다. 각 page가 직접 `getDiaryContext`를 await하며 layout 결과는 상단 표시에만 쓴다.
- B3 당시 async 기록 문맥은 실제 사용자에게 `{kind:"signed_in"}`만 줬다. S3b 이후에는 검증한 계정의 PG 문맥을 일반 서버 함수에서만 쓰고 화면 자료 DTO를 넘긴다. 위의 현재 실행 모드와 S3b 계약이 현재 동작이다.
- RED PR44 `bccb7f7`: 시험 2파일, 신규 unit 10·DB 5가 기능 부재로 실패하고 기존 unit 196·DB 165는 통과했다. 요청별 관찰 카운터 누적을 RED에서 고쳤고, [독립 RED PASS](https://github.com/kindsr/devscent-pieceofdays-main/pull/44#pullrequestreview-5771019879)를 수락했다. GREEN은 시험 변경 0이며 메인 GREEN gate·diffcheck 통과다.
- [GREEN CI 41859926510](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41859926510): Node 24.22.2·26.13.0 각각 단위 206(17파일)·빌드 경계 4·운영 경계 6·E2E 12·lint·typecheck·build, PG18.6 DB 170(11파일)이 skip 0으로 통과했다. [root 41859926273](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41859926273) 42·Compose도 통과했다. PR의 deploy job은 정상 skip이다.
- [작성자 완료 보고](https://github.com/kindsr/devscent-pieceofdays-main/pull/45#issuecomment-6635090669): Cloud Node26에서 unit 206·lint·typecheck·build 직접 통과, clean·정확 원격 일치·수정 중지. 화면은 scratch의 문맥 입력만 `signed_in`으로 바꾸고 실제 page·TopBar·CSS를 정적 렌더해 375/768/1440 총 9장을 직접 봤다(가로 넘침·작성 버튼 없음). 실제 Next 요청·로그인·redirect·배포 화면을 확인한 것은 아니다.
- [독립 GREEN PASS](https://github.com/kindsr/devscent-pieceofdays-main/pull/45#pullrequestreview-5771337007)(P0·P1 없음)를 메인이 수락했다. runner는 Node26 대상 10·전체 206 unit·lint·typecheck를 직접 재현했고, Node24·DB·build·prod·E2E는 CI 원문으로 확인했다. 실제 React cache·설치본 요청 dispatcher·사용자 전역 정보 부재·page별 await를 읽어 RED의 cache 후속 확인을 마쳤다. 정보성 P2는 B4의 `/login` route와 실제 URL 위조 요청 검사이며, B3 상태에서 서비스 인증 env를 켜지 않는다.
- 시험의 React 요청 번호 memo는 실제 서버 렌더 격리의 실행 증거와 구분한다. 실제 `?userId=` HTTP 요청 무시·Cache-Control·auth E2E는 B4 후속 검사다. 세션 발급 route·실로그인·PG 기록 연결·서비스 DB·Next 배포는 이번에 켜지 않는다.

명령(격리 Cloud·CI·개발 PC, 저장소 루트): `npm --prefix app test -- tests/unit/request-context.test.ts`, DB는 일회용 PG18에서 `npm --prefix app run test:db -- tests/db/f4-dal.test.ts`.

## 개발 체험판 `/try/`와의 관계

`frontend/public/try/`의 정적 체험판은 **이 Next 앱과 별개**다([계획](../docs/plans/PLAN_dev-local-preview.md)). 기존 정적 이미지가 제공하는 D 화면이며 기록을 브라우저의 전용 저장 항목 하나에만 둔다. 이 앱의 로그인·세션·PG 저장·고정 사용자 모드와 연결되지 않는다.

- 현재 서비스에는 실제 로그인·Next 앱 배포(F6)·서비스 DB가 없다. 소스의 계정 기록 화면은 PG 저장에 연결됐지만 정적 `/try/`와 별개다. `POD_LOCAL_FIXTURE`는 여전히 개발·시험 전용이고 운영에서 거부된다. 체험판 기록을 계정으로 자동으로 옮기지 않는다.
- 체험판 시험은 기존 app lock의 Vitest·Playwright만 빌려 쓴다. 단위 시험 `tests/unit/dev-preview.test.ts`(18)는 기존 `npm test`에 포함된다. 체험판 통합 당시에는 단위 196개(B2 178 + 18)였고 B3의 신규 시험은 위 절에서 구분한다. 브라우저 시험은 기존 E2E 12와 섞지 않는다.
- 명령(격리 Cloud·CI·개발 PC만, `app/`에서): `npx vitest run tests/unit/dev-preview.test.ts`, `POD_FULL_CHECK_ISOLATED=1 npx playwright test -c playwright.preview.config.ts`. 설정은 플래그가 없으면 시작을 거부하고, `frontend/public`을 Python 표준 정적 서버로 `127.0.0.1:3400`에만 연다. 공유 서버에서 실행하지 않는다.
- CI는 별도 workflow `.github/workflows/preview-validation.yml`(Secrets·배포 권한 없음)이다. GREEN `2f3e61b`의 [preview CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41793116570)에서 구문 검사·저장 단위 18·브라우저 10이 통과했다. [app CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41793116422)에서는 Node 24·26 각각 단위 196·빌드 경계 4·운영 경계 6·E2E 12·lint·typecheck·build, DB 165가 통과했다.
- 독립 GREEN 검토 PASS(P0·P1 없음, 선택 P2 3건)를 수락했다. dev 자동배포·실제 게시 검증은 [PR43](https://github.com/kindsr/devscent-pieceofdays-main/pull/43)에 기록한다.

## 한계 (제품 구현)

- 계정 화면의 PG 저장 연결은 S3b에서 검증했으며 실제 공급자 로그인·서비스 DB·개발 앱 배포·버킷은 미완료다. 실제 사용자가 로그인해 저장할 수 있다는 뜻이 아니다. 계정 조각 삭제는 구현했고 하루 꾸미기 편집기는 없다.
- 로컬 고정 사용자 모드의 기록 변경만 화면 이동·새로고침으로 초기화된다. 실제 계정 모드는 서버에 저장한다(위 실행 모드 참고).
- Konva는 스티커 1개 끌기·펜 획 1개 스모크만 확인했다(`/dev/konva-smoke`, 시험 전용).
- 글꼴은 시스템 글꼴 스택만 쓴다(동봉·라이선스 확인은 F5). 시험 VM에는 한국어 명조·손글씨 글꼴이 없어 글꼴 차이는 속성 값으로만 확인했다.
- 예시 모드의 날짜는 2026-11-02로 고정돼 있다. 실제 계정 화면·PG 저장 모듈은 서버의 `Asia/Seoul` 날짜를 사용하고 사용자별 시간대는 미정이다.
- ESLint 9.39.5는 npm에서 지원 종료(deprecated) 표시가 있다. eslint-config-next가 쓰는 플러그인(react, jsx-a11y, import)의 peer 범위가 ESLint 10을 포함하지 않아 peer 무경고를 지키려고 9를 유지했다. 개발 전용 lint 도구 체인에 minimatch moderate 권고 16건이 있고 런타임 의존성 감사(`npm audit --omit=dev`)는 0건이다.
