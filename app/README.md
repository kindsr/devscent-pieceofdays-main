# pieceofdays app (F1 화면·F2 DB 기반)

Next.js App Router 앱 골격과 PostgreSQL 18 스키마·마이그레이션 실행기가 있다. **앱의 실제 DB 연결·로그인·영구 저장·이미지 저장소·첫 로그인 지급은 아직 구현 전**이다. MVP 완료가 아니다.
루트 `frontend/`(정적 nginx 이미지)와 별개이며, **현재 dev 정적 배포(`dev.pieceofdays.com`)에 자동으로 포함되지 않는다**.
앱 배포 전환은 PLAN_mvp-foundation F6(메인 주도)에서 따로 정한다.

- 계획: [PLAN_mvp-foundation](../docs/plans/PLAN_mvp-foundation.md) · 버전: [00_TECH_STACK_DECISION §2.1](../docs/product/00_TECH_STACK_DECISION.md)
- 디자인 정본: [D 핸드오프](../docs/design/README.md), [D 아트보드](../docs/design/concepts/d-warm-pieces/)

## 구성

| 경로 | 내용 |
|---|---|
| `src/app/` | 경로: `/` 오늘, `/days` 모아보기, `/days/[date]` 특정 날, `/settings` 기록 글꼴, `/dev/konva-smoke` 시험 fixture |
| `src/ui/d/` | D 화면 컴포넌트(상단, 조각 보드·하루 한 줄·작성/수정 팝업, 달력, 글꼴 설정). 스타일은 `src/app/globals.css`(D `style.css`에서 옮김) |
| `src/ui/decorate/` | Konva 클라이언트 전용 모듈. 지금은 호환 스모크만 있고 꾸미기 편집기 UI는 없다(별도 아트보드 필요) |
| `src/server/runtime-mode.ts` | 로컬 고정 사용자 모드 판정과 운영 거부 |
| `src/server/context.ts` | 요청의 기록 문맥. 고정 사용자 모드가 아니면 "연결 안 됨" |
| `src/server/diary/` | 저장 port(`store.ts`)와 메모리 구현·예시 기록(로컬·시험 전용) |
| `src/server/db/`, `migrations/` | SQL 정책 검사·체크섬·잠금 기반 실행기와 `0001_init`의 8개 테이블·권한·원장 보호 |
| `src/shared/` | 글꼴 허용 목록, 날짜 파싱 |
| `tests/unit/`, `tests/db/`, `tests/e2e/`, `tests/prod/` | Vitest 단위·일회용 PG18 통합 시험 / Playwright E2E / 운영 모드 경계 smoke |
| `docs/screenshots/` | F1 확인 스크린샷(로컬 고정 사용자 모드, 375/768/1440) |

## 실행 모드

| 모드 | 조건 | 화면 |
|---|---|---|
| 기본(운영 빌드 포함) | `POD_LOCAL_FIXTURE` 없음 | 오늘·모아보기는 "아직 준비 중" 안내. 설정은 화면 메모리에서만 동작. `/dev/konva-smoke`는 404 |
| 로컬 고정 사용자 | `POD_LOCAL_FIXTURE=1` + `next dev`(development) 또는 test | D 예시 기록(실제 사용자 기록 아님)을 메모리에서 읽기만 한다 |

- `POD_LOCAL_FIXTURE=1`이 켜진 채 `next build`/`next start`(운영 단계)를 실행하면 `next.config.ts`에서 **시작을 거부**한다. 값은 비우거나 정확히 `1`만 허용한다.
- 작성·수정·한 줄은 **그 화면의 브라우저 메모리에만** 반영되고 서버로 보내지 않는다. 영구 저장도 화면 간 공유 상태도 없어서 **새로고침하거나 다른 화면(오늘↔모아보기·특정 날)으로 이동하면 사라진다.** 완료 안내도 그렇게 알린다.
- 기록 글꼴은 계정·기기에 저장되지 않고 새로고침하면 고딕으로 돌아간다.
- 추가 팝업은 주소 `#write`와 맞물린다. 브라우저 뒤로 가기로 `#write`를 벗어나면 닫히고, 앞으로 가기로 돌아오면 입력 중이던 초안과 함께 다시 열린다.
- 서버 코드는 헤더·URL·폼의 사용자 ID를 인증으로 쓰지 않는다. 세션 → `userId`는 F4에서 실제 로그인과 함께 만든다.

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

`npm run test:db`는 실행 전용 PostgreSQL 18에서 환경·마이그레이션·권한·데이터 제약을 검증한다. `0001_init`에는 사용자·기록·설정·개인 디자인·감정덩어리 원장 등 8개 테이블이 있다. 앱의 PG 저장 구현과 실제 로그인 지급은 F3·F4다. CI의 `db` job은 고정 digest의 공식 PostgreSQL 18 서비스 컨테이너를 사용하며, 실제 서비스 DB에 연결하지 않는다.

실행기는 `npm run db:migrate -- status`·`up`을 제공한다. 접속에는 별도로 준비된 migrator role의 `POD_MIGRATE_DATABASE_URL`과 `pod_meta.db_environment`가 필요하다. role 생성·실서버 프로비저닝은 실행기가 하지 않는다. 파일은 BOM 없는 UTF-8·LF의 번호별 up/down 쌍이며, 적용된 up 파일의 수정·누락은 체크섬 검사로 거부한다. down은 다른 writer가 없는 빈 CI DB 리허설에서만 허용한다. [계약·보호 조건](../docs/plans/PLAN_mvp-database.md)을 먼저 확인한다.

로컬에서는 [일회용 컨테이너 준비](../docs/plans/PLAN_mvp-database.md)의 환경을 먼저 마련한다. 아래 URL은 그 컨테이너의 가짜 값이다(`app/`에서 실행).

```bash
POD_TEST_DB_DISPOSABLE=1 POD_TEST_ADMIN_URL=postgres://postgres:ci-only-not-a-secret@127.0.0.1:55432/postgres npm run test:db
```

전체 검사는 저장소 루트에서 `POD_FULL_CHECK_ISOLATED=1`, `POD_TEST_DB_DISPOSABLE=1`, `POD_TEST_ADMIN_URL`을 지정하고 `bash app/tests/full-check.sh`로 실행한다. **격리된 Cloud/CI/개발 PC 전용이며 공유 운영 서버에서 실행하지 않는다.** 조건이 없으면 시험을 시작하지 않는다. DB 시험을 먼저 통과한 뒤 배포·앱 검사를 순차 실행한다. 플래그는 격리 환경이라는 운영 전제를 명시하는 것이며 머신 격리를 자동 보장하지 않는다.

bootstrap 당시 Cloud VM의 native PostgreSQL 실험은 보조 근거다. 공식 수락 근거인 [최종 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41522328270)에서 DB 57개, Node 24·26 각각 단위 71개·운영 경계 6개·E2E 12개가 통과했다. FullCheck 스크립트 자체의 전체 실행은 별도로 검증하지 않았다.

## 한계 (제품 구현)

- 로그인·앱의 PG 저장 연결·버킷·첫 로그인 지급 트랜잭션 없음. 원장 테이블·제약·권한만 F2에 있으며 지급 동작은 F3·F4다. 조각 삭제·하루 꾸미기 편집기는 아직 없다.
- 기록 변경은 화면 이동·새로고침으로 초기화된다(위 실행 모드 참고). F1에서는 영구 저장이나 클라이언트 전역 store를 추가하지 않는다.
- Konva는 스티커 1개 끌기·펜 획 1개 스모크만 확인했다(`/dev/konva-smoke`, 시험 전용).
- 글꼴은 시스템 글꼴 스택만 쓴다(동봉·라이선스 확인은 F5). 시험 VM에는 한국어 명조·손글씨 글꼴이 없어 글꼴 차이는 속성 값으로만 확인했다.
- 날짜 기준은 예시 기록의 날짜(2026-11-02)로 고정돼 있다. 실제 시간대 정책은 F3.
- ESLint 9.39.5는 npm에서 지원 종료(deprecated) 표시가 있다. eslint-config-next가 쓰는 플러그인(react, jsx-a11y, import)의 peer 범위가 ESLint 10을 포함하지 않아 peer 무경고를 지키려고 9를 유지했다. 개발 전용 lint 도구 체인에 minimatch moderate 권고 16건이 있고 런타임 의존성 감사(`npm audit --omit=dev`)는 0건이다.
