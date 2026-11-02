# pieceofdays app (F1 골격)

Next.js App Router 앱 골격이다. **실제 로그인·영구 저장·DB·이미지 저장소·감정덩어리 원장은 없다**(F2 이후). MVP 완료가 아니다.
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
| `src/shared/` | 글꼴 허용 목록, 날짜 파싱 |
| `tests/unit/`, `tests/e2e/`, `tests/prod/` | Vitest 경계 시험 / Playwright E2E(로컬 고정 사용자) / 운영 모드 경계 smoke(`playwright.prod.config.ts`) |
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

## 한계 (F1)

- 로그인·DB(PostgreSQL 18)·버킷·원장·첫 로그인 지급 없음. 조각 삭제·하루 꾸미기 편집기 없음.
- 기록 변경은 화면 이동·새로고침으로 초기화된다(위 실행 모드 참고). F1에서는 영구 저장이나 클라이언트 전역 store를 추가하지 않는다.
- Konva는 스티커 1개 끌기·펜 획 1개 스모크만 확인했다(`/dev/konva-smoke`, 시험 전용).
- 글꼴은 시스템 글꼴 스택만 쓴다(동봉·라이선스 확인은 F5). 시험 VM에는 한국어 명조·손글씨 글꼴이 없어 글꼴 차이는 속성 값으로만 확인했다.
- 날짜 기준은 예시 기록의 날짜(2026-11-02)로 고정돼 있다. 실제 시간대 정책은 F3.
- ESLint 9.39.5는 npm에서 지원 종료(deprecated) 표시가 있다. eslint-config-next가 쓰는 플러그인(react, jsx-a11y, import)의 peer 범위가 ESLint 10을 포함하지 않아 peer 무경고를 지키려고 9를 유지했다. 개발 전용 lint 도구 체인에 minimatch moderate 권고 16건이 있고 런타임 의존성 감사(`npm audit --omit=dev`)는 0건이다.
