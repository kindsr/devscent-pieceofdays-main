# PLAN — MVP 기반 구축 (Next.js 앱·DB·인증 소유권·개인용 꾸미기 Lite)

- 상태: **계획.** 기준 `dev` `efe6b0f`. 사용자가 스택을 선택했으므로 프레임워크·패키지 설치는 허용된다(F1에서 §1.1 호환 확인 후 설치). 이 PR 시점에는 아직 설치·구현하지 않았다. 서버 DB·버킷 생성과 공용 서버 설정은 별도 의존성이다(§8).
- 골격의 가정: [01_PRD_ANALYSIS](../product/01_PRD_ANALYSIS.md) §2 — **비공개 기본, 하루 정리는 직접 작성(A), 짧은 글 중심.** PRD Q1~Q3 답을 기다리지 않고 이 가정을 드러낸 채 UI·도메인·저장 port 골격까지 만든다. 범위 정의는 [03_MVP](../product/03_MVP.md)에 있다.
- 근거: [00_TECH_STACK_DECISION](../product/00_TECH_STACK_DECISION.md)(사용자 선택, 2026-11-02), [PLAN_product-evolution](PLAN_product-evolution.md) 단계 1, [DECORATION_MARKET_ARCHITECTURE](../product/DECORATION_MARKET_ARCHITECTURE.md), [PRD 초안](../PRD.md).
- MVP 범위([확정]): 기록 CRUD(조각 수정 포함), 날짜별 보기, 사용자 폰트 선택, **개인용 하루 꾸미기 Lite**. **마켓·구매·정산은 MVP에서 제외**한다.
- 각 단계(F1~F6)는 별도 작업 브랜치와 PR로 진행한다. dev/main 반영과 배포는 메인이 통합할 때 한다.

## 1. 파일 경계 (첫 구현)

| 경로 | 내용 | 비고 |
|---|---|---|
| `app/` | Next.js 앱 전체(신규). 아래 하위 구조만 둔다 | 기존 `frontend/`·`deploy/`·`scripts/ops/`는 F6 전까지 건드리지 않는다 |
| `app/package.json`, lockfile, `tsconfig.json`, `next.config.ts` | 버전은 결정 기록 §2 기준으로 정확히 고정한다. 패키지 관리자는 npm(Node 동봉)을 권고한다 | |
| `app/src/app/` | 경로: 오늘, 모아보기·특정 날, 설정(폰트), 꾸미기 | D 화면 구조를 그대로 따른다 |
| `app/src/ui/d/` | D 컴포넌트·토큰. `docs/design/concepts/d-warm-pieces/`와 확정 핸드오프에서 옮긴다 | D 원본 파일은 수정하지 않는다 |
| `app/src/ui/decorate/` | Konva 편집기. **클라이언트 전용** | 서버 모듈에서 import하지 않는다 |
| `app/src/shared/manifest.ts` | manifest 스키마와 타입 1곳 | 서버 검증과 렌더러가 함께 쓴다 |
| `app/src/server/db.ts` | 연결과 트랜잭션 도우미 | |
| `app/src/server/{account,diary,decoration,credit}/` | 도메인 모듈 4개(마켓 없음). 각 모듈에 `store.ts`(port), `store.memory.ts`, `store.pg.ts` | 모든 함수는 `userId`를 첫 인자로 받는다 |
| `app/src/server/auth/` | 세션 → `userId` 해석 1곳 | 공급자 연동은 F4(G4 결정 후) |
| `app/migrations/` | 번호 붙은 SQL migration(up/down) | 도구는 F1에서 1개 고른다 |
| `app/tests/{unit,db,e2e}/` | 단위 / 실제 PostgreSQL 18 컨테이너 / 브라우저 | |
| `.github/workflows/` | 앱 검사 job 추가(F1, 메인 검토) | 배포 job·키는 바꾸지 않는다 |

**저장 port:** 도메인 모듈마다 작은 저장 인터페이스(`store.ts`)를 1개 두고, 구현은 2개만 둔다.
- 메모리 구현: UI 골격과 단위 테스트용.
- PostgreSQL 구현: F2 이후.

그 밖의 추상화(인증 공급자 계층, 범용 리포지토리, DI 컨테이너)는 만들지 않는다. 인증은 `세션 → userId` 함수 1개다.
로컬·테스트 전용 고정 사용자는 개발 환경 변수로만 켜진다. 운영 빌드에서 켜져 있으면 시작을 거부한다.

### 1.1 F1 첫 작업: 호환 버전 확인 (설치 전 관문)

2026-11-02 npm 메타데이터 기준이며, 설치 시점에 다시 확인해 정확한 버전으로 고정한다.

| 조합 | 확인 내용 |
|---|---|
| Node ↔ Next | next 16.4.4 `engines.node >=20.9.0` → Node 26 LTS를 기준으로 하고 24 LTS도 CI에서 함께 실행한다 |
| Next ↔ React | next 16.x peer `react`/`react-dom` `^18.2.0 \|\| ^19.0.0` → react·react-dom은 **같은 정확 버전** 19.3.x로 맞춘다(react-dom 19.3.1 peer `react ^19.3.1`) |
| React ↔ react-konva | react-konva 19.3.2 peer `react`/`react-dom ^19.3.0`. 내부 `react-reconciler 0.34.0` 고정. 공식 문서상 메이저 버전 일치 필요 |
| react-konva ↔ konva | peer `konva ^7.2.5 \|\| ^8.0.1 \|\| ^9 \|\| ^10` → konva 10.x. konva의 `canvas`/`skia-canvas` peer는 Node 렌더용이므로 설치하지 않는다(썸네일은 후속) |
| TypeScript | `typescript` 6.0.x(Next 최소 5.1, TS 7.0은 API 없음) |

통과 조건:
- `npm ls`에 peer 경고가 없다.
- `next build`가 성공한다.
- 편집기 페이지(클라이언트 전용 Konva)를 서버 렌더에서 import하지 않는다.
- Konva 스티커 1개 끌기와 펜 획 1개 스모크 E2E가 Node 26과 24 모두에서 통과한다.

실패하면 마지막으로 호환된 패치로 내리고 그 사유를 결정 기록에 추가한다.

## 2. 서버 처리(API) 경계

모든 처리는 세션에서 `userId`를 얻는 것으로 시작한다. 세션이 없으면 거부한다. SQL은 항상 `WHERE user_id = $userId`로 소유자를 제한한다.
다른 사용자의 ID를 넣으면 "없음"과 같은 응답을 준다(존재 여부를 드러내지 않음).

| 처리 | 입력 | 결과·규칙 |
|---|---|---|
| `createMoment` | 날짜, 글(최대 길이), (사진: Q1 결정 후) | 시각이 붙은 조각 |
| `updateMoment` / `deleteMoment` | 조각 ID, `version` | 낙관적 잠금. 버전이 다르면 충돌 응답 |
| `upsertDaySummary` | 날짜, 글 | 하루 1개(`UNIQUE(user_id, local_date)`) |
| `getDay` / `listMonth` | 날짜 / 연월 | 본인 기록만 |
| `setFont` | `font_key` | 허용 목록만 |
| `saveDesign` | manifest | 검증 → private `design_versions` 새 행 |
| `applyDesign` | 버전 ID 또는 `null` | 본인 버전만 적용, `null`이면 기본 D |
| `onSuccessfulLogin` | 인증 결과 | `users` 확보 + 첫 로그인 지급(§3), 한 트랜잭션 |

날짜 기준 시간대는 [미정]이다. 권고는 사용자 설정 시간대이며 기본값은 `Asia/Seoul`이다.

## 3. DB 경계 (MVP 스키마 초안)

| 테이블 | 핵심 열·제약 |
|---|---|
| `users` | `id`(canonical), `created_at`, `first_login_at` |
| `auth_identities` | `user_id` FK, `provider`, `subject`, `UNIQUE(provider, subject)`. 공급자 값은 G4 결정 후 정한다 |
| `preferences` | `user_id` PK, `font_key`, `applied_design_version_id` NULL 허용 |
| `diary_moments` | `id`, `user_id`, `local_date`, `occurred_at`, `body`, `version`, 인덱스 `(user_id, local_date)` |
| `day_summaries` | `UNIQUE(user_id, local_date)`, `body`, `version` |
| `design_versions` | `id`, `owner_id`, `manifest jsonb`, `visibility='private'`(MVP), `created_at` |
| `credit_accounts` | `user_id` PK, `balance integer CHECK (balance >= 0)` |
| `emotion_ledger` | `delta integer`, `reason`, `grant_key UNIQUE`, `ref_*`. 앱 계정에 UPDATE/DELETE 권한 없음 |
| (Q1 사진 포함 시) `moment_photos` | `object_key UNIQUE`, `owner_id`, `sha256`, `content_type`, `bytes` — 이미지 자체는 저장하지 않는다 |

첫 성공 로그인 지급([확정] 1회 10개):
- `onSuccessfulLogin` 트랜잭션 안에서 `grant_key='first_login:{user_id}'`를 `INSERT … ON CONFLICT DO NOTHING`으로 넣는다.
- 행이 들어간 경우에만 잔액을 +10 한다.
- 같은 사람이 여러 공급자로 로그인할 때 `user_id`를 연결하는 정책은 G4에서 정한다.

마켓 테이블(`design_listings`·`purchases`·`entitlements`)은 MVP에서 만들지 않는다. 구매 1개 정책은 [확정]이지만 구현은 후속이다.

## 4. 이미지 저장 경계

- MVP 꾸미기 Lite의 기본 스티커는 **앱에 동봉하는 정적 자산**이다(라이선스 확인분만). 따라서 버킷이 없어도 Lite가 동작한다.
- 버킷은 사진(Q1) 또는 본인 그림 업로드를 MVP에 넣을 때만 연결한다. 연결 방식:
  - 이 서비스 전용 비공개 버킷을 쓰고 dev와 prod를 분리한다.
  - 업로드는 서버에서 형식 확인과 재인코딩을 거친 뒤 저장한다.
  - 읽기는 소유권을 확인한 뒤 서명 URL이나 앱 경유로만 허용한다.
  - DB에는 객체 키·권한·해시만 둔다.
- 버킷 인스턴스와 자격 증명은 메인이 비공개 런북으로 준비한다 [미정].

## 5. TDD 필수 목록 (테스트를 먼저 쓴다)

1. **인증·소유권:** 처리마다 비로그인 거부, 타인 ID 접근 시 "없음" 응답. 표(§2)의 모든 행이 대상이다.
2. **첫 로그인 지급:** 실제 DB에서 병렬 연결로 `onSuccessfulLogin`을 동시에 N회 실행해도 원장 1행·잔액 10. 트랜잭션이 중간에 실패하면 둘 다 남지 않는다.
3. **원장 권한:** 테스트는 **운영 앱 실행 계정과 같은 권한(GRANT)을 migration으로 부여한 계정**으로 접속해 실행한다. 이 계정으로 `UPDATE`·`DELETE emotion_ledger`를 실행하면 권한 오류가 나야 한다. 잔액 사본은 `SUM(delta)`와 같아야 한다. 슈퍼유저나 마이그레이션 계정으로 대신 시험하지 않는다.
4. **낙관적 잠금:** 두 탭에서 같은 조각을 수정하면 하나는 충돌 응답을 받는다. 삭제된 조각을 수정하면 "없음" 응답이다.
5. **manifest 검증:** 범위 밖 좌표, 모르는 슬롯, 허용하지 않은 색·굵기, 획·점 수 상한, 남의 버전 적용.
6. **폰트 허용 목록:** 목록 밖 키는 거부한다. 꾸미기 적용으로 `font_key`가 바뀌지 않는다.
7. **렌더 fallback:** manifest나 에셋이 오류여도 기본 D로 렌더되고, 기록은 정상이다.
8. **migration:** 빈 DB에서 up → down → up이 성공하고, 스키마 비교 결과가 같다.

## 6. 단계별 진행과 검증

| 단계 | 내용 | 완료 검증 | 막는 결정 |
|---|---|---|---|
| F0 | 결정 기록과 이 계획(이 PR) | 문서 링크·요구 대조 | — |
| F1 | §1.1 호환 확인 → 설치·버전 고정. `app/` 골격, D 화면 골격(메모리 저장·고정 사용자), lint·typecheck·unit, CI 앱 검사 job | §1.1 통과. PR 검사 통과. 기존 `tests/` 배포 계약 테스트 통과. `frontend/`는 변경 없음 | 없음(PRD Q1~Q3는 가정으로 진행) |
| F2 | migration·DB 계정·권한(원장 테이블 포함), 실제 PG18 컨테이너 테스트 | §5-3(운영과 같은 권한의 계정으로 UPDATE/DELETE 차단)·8 통과. 로컬·CI 컨테이너만 쓰고 공용 서버 DB는 만들지 않는다 | — |
| F3 | 도메인 모듈(account·diary·decoration·credit) TDD, PostgreSQL 저장 구현. credit은 append-only grant 원장 최소형 | §5-2(병렬 연결 동시 지급 N회 → 1행·10)·§5-3 회귀·4·5·6 통과 | 시간대(권고값으로 진행 가능) |
| F4 | 실제 로그인 연동과 `onSuccessfulLogin`. **grant 원장과 첫 성공 로그인 10개 지급을 같은 PR에서 켠다**(로그인했는데 지급되지 않은 사용자가 생기지 않게) | §5-1 전체, §5-2, 실제 로그인 E2E | Google·카카오 확정(2026-11-03). 계정 연결 결정·탈퇴/복구 계약과 공급자 설정은 [인증 계획](PLAN_mvp-authentication.md)에서 진행 |
| F5 | D 화면 이식, 폰트 설정, 꾸미기 Lite(Konva), 사진(Q1 시) | E2E: 375/768/1440px, 키보드, 터치 펜, 실행 취소, 리셋, fallback, 대비 AA, D 기본과 시각 비교 | 폰트·스티커 라이선스(G5), Q1 |
| F6 | 앱 배포 전환(별도 계획 `PLAN_app-deployment`, 메인 주도) | §7의 조건 | dev/prod DB·버킷 준비, 배포 프로그램 검토 |

## 7. 기존 정적 배포와의 호환·전환·롤백

- 현행 배포 프로그램은 `frontend/`의 승인된 정적 nginx Dockerfile만 허용한다. 포트 80·고정 health만 허용하고 환경 변수와 비밀값 주입은 없다.
  따라서 **F1~F5는 배포에 영향이 없다.** dev 도메인은 계속 정적 페이지와 `/design/` 시안을 제공한다.
- F6 전환 조건(별도 계획에서 확정한다):
  - 메인이 설치본 배포 프로그램을 검토·갱신한다. 앱 이미지, 비밀값 주입, DB 네트워크를 허용하는 범위로 하며 다른 서비스·공용 nginx·TLS는 바꾸지 않는다.
  - dev와 prod에 전용 DB와 계정을 준비하고 백업 절차를 마련한다.
  - 계정 탈퇴 후 30일 복구·삭제 정책의 purge 실행 주기와 백업 만료·복원 시 삭제 재적용을 정한다([계정 수명주기 계획](PLAN_account-lifecycle.md)).
  - migration은 확장/수축(expand/contract) 방식으로 한다.
  - `/design/` 시안 게시 사본을 계속 제공할지 정한다.
- 롤백:
  - 앱 이미지 배포가 실패하면 직전 동결 이미지로 복귀한다. 첫 전환이라면 직전 정적 이미지로 복귀한다.
  - DB는 되돌리지 않고, 이전 앱과 호환되는 확장 단계에 머문다.
  - 원장 데이터는 롤백 때도 삭제하지 않는다.
- 운영(main) 전환은 dev에서 앱 운영을 검증한 뒤 사용자·메인이 따로 판단한다.

## 8. 미결정 의존성

| 항목 | 영향 | 담당 |
|---|---|---|
| G4 공급자는 Google·카카오 둘 다, 탈퇴는 30일 복구 뒤 삭제로 확정(2026-11-03). 공급자 간 계정 연결은 미정 | F4, 첫 로그인 지급·복구·삭제. 세부는 [인증 계획](PLAN_mvp-authentication.md) | 사용자·메인 |
| PRD Q1 사진 / Q2 AI / Q3 공유 | 골격은 가정으로 진행한다. 답에 따라 사진(버킷)·AI(외부 전송·동의)·공유(권한)를 추가한다 | 사용자 |
| DB 실행 형태: 기본 추천은 새 공유 PostgreSQL 18 안의 서비스·환경별 전용 DB(결정 기록 §3). 버킷 인스턴스. 실제 프로비저닝은 별도 운영 절차 | F6 | 메인(비공개 런북) |
| 허용 폰트 목록·기본 스티커 세트 라이선스(G5) | F5 | 메인·사용자 |
| 시간대 정책, 개인 버전 보관 개수, 잔액 표시 시점 | F3·F5 | 사용자(권고값으로 진행 가능) |
| 감정덩어리 현금화·정산, 창작자 +1 시점 | 후속 마켓 단계 | 사용자 |

## 9. 비목표

마켓·구매·정산 구현, 전문 드로잉 도구, 별도 백엔드 플랫폼(Python 서버·Redis·큐), 외부 AI 연동, 공용 서버 설정 변경, 서버 dev/prod DB·버킷 생성(메인 담당).

## 10. F1 실행 결과 (Claude Cloud 하위 구현, 작업 브랜치 `claude/nextjs-foundation-mvp-0p73cn`)

- 기준: `origin/dev` `e5ebd58`(통합 `c82c2d2` 포함). Draft PR로 반환하며 dev/main 반영·배포는 메인이 판단한다.
- **F1은 앱 골격이다.** 실제 로그인·영구 저장·DB·버킷·원장은 없고 MVP 완료가 아니다. 앱은 현재 dev 정적 배포에 포함되지 않는다.
- 버전: [00_TECH_STACK_DECISION §2.1](../product/00_TECH_STACK_DECISION.md). §1.1 통과 조건 확인 결과:
  - `npm ls --all` peer 문제 없음, `next build` 성공(Node 26.13.0·24.22.2).
  - Konva는 `src/ui/decorate/`의 클라이언트 모듈에서 `ssr: false`로만 불러온다. ESLint `no-restricted-imports`로 그 밖의 import를 막고, 서버 HTML에 캔버스가 없음을 E2E로 확인했다.
  - 스티커 1개 끌기·펜 획 1개 스모크 E2E가 Node 26·24 모두 통과(시험 fixture `/dev/konva-smoke`, 로컬 고정 사용자 모드 밖에서는 404).
- 만든 것: `app/` App Router 골격(오늘·모아보기·특정 날·작성/수정 팝업·기록 글꼴 설정, D 스타일 이식), diary 저장 port + 메모리 구현(읽기 전용), 로컬 고정 사용자 모드와 운영 거부, `.github/workflows/app-validation.yml`.
- 고른 도구: 단위 Vitest, E2E Playwright(§1의 migration 도구 선택은 DB를 다루는 F2로 미룬다).
- TDD: 경계 시험(고정 사용자 운영 거부, 글꼴 허용 목록, URL 날짜, 메모리 저장 소유자 제한)을 먼저 커밋해 RED(모듈 없음, exit 1)를 확인한 뒤 최소 구현으로 GREEN(20건).
- 검증 명령과 종료 코드(깨끗한 복사본, Node 26.13.0과 24.22.2 각각 같은 결과):
  `npm ci` 0 · `npm ls --all` 0 · `npm run lint` 0 · `npm run typecheck` 0 · `npm test` 0(20 passed) · `npm run build` 0 ·
  `POD_LOCAL_FIXTURE=1 npx next build` 1(의도한 거부) · `POD_LOCAL_FIXTURE=1 next start` 1(의도한 거부) · `npx playwright test` 0(9 passed).
  저장소 배포 계약 시험 `python3 -B -m unittest discover -s tests -p 'test_*.py'` 42 OK, `git diff --check` 0.
- 화면: 375/768/1440 수평 넘침 없음(E2E), 스크린샷 `app/docs/screenshots/`.
- 남은 것: F2(migration·PG18 컨테이너 시험), F3(도메인·PG 구현·시간대), F4(실제 로그인·첫 로그인 지급), F5(꾸미기 Lite 편집기·글꼴 동봉·조각 삭제), F6(배포 전환).

### 10.1 F1 통합 전 보완 (메인 배정, 같은 PR)

- 추가 팝업과 주소 `#write` 동기화: 뒤로 가기로 `#write`를 벗어나면 닫고, 앞으로 가기로 초안과 함께 다시 연다. E2E RED(뒤로 가기 후에도 팝업 보임) 확인 뒤 `DayBoard`만 최소 수정.
- 특정 날(제목 h2)에서 한 줄 반영 뒤 포커스를 `#picked-h`로 돌린다(RED: 포커스 없음 → GREEN).
- 완료 안내·README에 "새로고침하거나 다른 화면으로 이동하면 사라진다"를 명시하고 E2E로 확인. 영구 저장·클라이언트 전역 store는 추가하지 않는다.
- 운영 모드 경계 smoke(`app/playwright.prod.config.ts`, `app/tests/prod/`): 이미 만든 빌드를 `next start`로 127.0.0.1:3200에서 플래그 없이 띄워 `/`·`/days`·`/days/2026-11-02` 준비 중 안내·예시 기록 없음, `/dev/konva-smoke` 404, 위조 `x-user-id` 헤더·`userId` 질의값으로도 노출 없음을 확인한다. 127.0.0.1:3201에서 `POD_LOCAL_FIXTURE=1 next start`가 거부 메시지와 exit 1로 끝나는지 확인한다(플래그는 자식 프로세스 env에만). CI `app-validation`에 같은 단계를 추가했다. dev E2E(3100)와 순차 실행.
- 검증 결과는 PR 본문에 기록한다.

### 10.2 메인 통합 수락 (2026-11-02)

- 대상 `0ee8bfe`, 앱 CI run `41490019203`: Node 26·24 각각 단위 20개·운영 경계 6개·브라우저 12개 통과를 실제 로그로 대조했다. 배포 계약 검사 run `41490018256`도 통과했다.
- 독립 검토에서 재현한 뒤로가기 회귀는 위 수정과 회귀 시험으로 해소했다. 메인은 변경 범위·운영 차단·권한 없는 CI·D 스크린샷·문서 링크를 검토했다. 서버에서 Next 개발 서버를 실행하지 않았다.
- F2 데이터 계약·시험 계획은 [DATA_CONTRACT](../product/DATA_CONTRACT.md)·[PLAN_mvp-database](PLAN_mvp-database.md)를 따른다. 실제 DB 연결 모듈을 도입할 때 클라이언트 번들 유입 차단도 검증한다.

## 11. F4a 기반 진행 상태 (2026-11-03)

- F2 스키마·F3 저장 코어에 이어 F4a 세션 codec과 서버 전용 경계를 구현·독립 검증했다. [인증 계획 §13](PLAN_mvp-authentication.md)에 RED·GREEN과 실제 검증 범위를 기록한다.
- GREEN `96bcf8c`: Node 24·26 단위 122·빌드 경계 4·운영 경계 6·E2E 12, DB 99·배포 계약 42 통과. 실제 OAuth·요청별 DB 상태 대조·탈퇴·복구·삭제는 후속 F4 범위다.
- F4 L1(0002 계정 수명주기 schema·role): PR33 `0876c4b` CI에서 DB 119·독립 검토를 통과해 dev에 통합했다([계정 수명주기 계획](PLAN_account-lifecycle.md) §14). 서비스 DB 적용·운영 purge는 F6다.
- F4 L2(탈퇴·복구·상태별 로그인 도메인): PR35 GREEN `ba2b167` CI에서 DB 138과 독립 검토를 통과해 dev에 통합했다([계정 수명주기 계획](PLAN_account-lifecycle.md) §15). 실제 로그인 연결은 F4b/c다.
- 현재 dev는 정적 D 시안이며 Next 앱은 아직 배포되지 않았다. F6의 전용 DB·purge·백업·앱 배포 전환 조건을 유지한다.
