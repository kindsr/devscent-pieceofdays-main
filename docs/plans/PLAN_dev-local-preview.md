# PLAN — dev에서 먼저 쓰는 D 기록장

- 상태: 2026-11-04 사용자 요청 “개발에서라도 빨리 써보고 싶은데”에 따른 메인 우선순위 조정.
- 저장 방식 선택 질문은 열어 두었으며, 빠른 체험을 위한 임시 기본값은 브라우저 저장이다. 사용자 확정 정책으로 기록하지 않는다.
- 기준: `dev` `f5123937fceb2e867b443468ccde2e4566ad5bc3`. B2 인증 구현은 별도 Cloud 브랜치에서 계속한다.
- 목표: MVP 전체 완성을 기다리지 않고 개발 도메인에서 직접 작성한 기록을 새로고침 뒤에도 다시 연다.
- **진행(2026-11-04):** RED·GREEN 구현과 CI는 통과했다. **독립 GREEN 검토 진행 중, dev 통합·게시 전**이다(아래 실행 결과). 위 "기준"은 계획 작성 당시 값이다.

## 범위와 경로

개발 정적 이미지의 `/try/`에 D 테마 체험판을 추가하고 dev 첫 화면에서 바로 연결한다.
기존 `/design/` 시안·비교판·홍보영상과 실제 Next 앱의 인증·DB·배포 경계는 유지한다.

| 경로 | 변경 |
|---|---|
| `frontend/public/try/store.js` | 브라우저 저장·입력/문서 검증·날짜/글꼴·기록 CRUD·내보내기용 문서. ES module이며 현행 nginx MIME 매핑에 맞춰 `.js`를 사용한다 |
| `frontend/public/try/index.html`, `app.js`, `style.css` | D CSS 재사용, 빈 오늘·작성/수정/삭제·하루 한 줄·달력·설정·저장 오류 표시 |
| `frontend/public/index.html` | 체험판으로 들어가는 주 링크, 시안·영상 링크 유지 |
| `app/tests/unit/dev-preview.test.ts` | 저장 모듈 계약. 기존 단위 검사에 포함 |
| `app/tests/e2e-preview/preview.spec.ts`, `app/playwright.preview.config.ts` | 격리 정적 HTTP 서버와 실제 브라우저 사용자 흐름 |
| `.github/workflows/preview-validation.yml` | 기존 고정 checkout/setup-node·기존 app lock을 사용하는 별도 정적 체험판 브라우저 검사. Secrets·배포 권한 없음 |
| `README.md`, `CHANGELOG.md`, 본 계획 | 사용 주소·실행 결과·브라우저 저장의 한계 |

## 사용자 경험

- D 색·타입·조각 보드·달력·팝업 구조를 재사용한다. 비교용 리뷰 도구와 예시 기록은 체험판에 넣지 않는다.
- 실제 서울 날짜의 빈 기록장으로 시작한다. 오늘 추가, 조각 수정/삭제, 날짜별 다시 보기, 하루 한 줄, 고딕/명조/손글씨 선택을 제공한다.
- 삭제는 확인 후 반영한다. 글과 하루 한 줄은 공백 제거 후 1~300 코드포인트를 검사하고, 빈 한 줄은 지우기로 취급한다.
- 기록 글꼴은 D의 시스템 글꼴 스택만 사용하며 UI 글꼴과 배치를 바꾸지 않는다.
- “이 브라우저에 저장 · 계정 동기화 전”을 계속 표시한다. 저장 성공은 실제 저장소 쓰기가 성공한 뒤에만 알린다.
- 기록 JSON 내려받기와 명시적 확인을 거친 체험 기록 삭제를 제공한다. 다른 사이트 저장 항목을 지우지 않는다.
- 이미지 업로드·예시 사진·그리기·마켓·가짜 계정·가짜 감정덩어리 지급은 이번 범위에 넣지 않는다.

## 저장과 실패 처리

- 전용 `localStorage` 키 하나에 버전이 있는 JSON을 저장한다. 서버 전송·분석 수집·외부 라이브러리는 없다.
- 저장 문서는 읽을 때 검증하고, 파싱/형식 오류가 있으면 원본을 덮어쓰거나 자동 삭제하지 않는다.
- 저장 불가/용량 초과는 실패로 표시하고 입력 초안을 유지한다. 메모리 반영을 영구 저장 성공으로 표현하지 않는다.
- HTML은 사용자 입력을 escape하거나 `textContent`로 렌더한다. 저장된 문자열·hash도 신뢰하지 않는다.
- 다른 탭의 변경을 감지해 사용자가 오래된 화면에서 조용히 덮어쓰지 않게 안내한다. 서버 동기화나 다중 탭 원자성을 보장한다고 쓰지 않는다.
- 이 데이터는 실제 계정 DB와 자동 합쳐지지 않는다. 브라우저 데이터 삭제 시 사라지므로 내려받기 안내를 제공한다.

## 구현·검증 순서

1. RED: 위 시험 파일과 Playwright 설정만 추가한다. 신규 모듈 부재가 각 테스트의 정상 실패 이유인지 확인한다.
2. 독립 runner: 기존 단위 162·DB 138 유지, 저장 실패·손상 문서·XSS·날짜 전환·CRUD 기대값을 확인한다.
3. GREEN: 시험 변경 없이 체험판·진입 링크·검사 workflow만 구현한다. API/테스트 도우미 계약은 RED에서 고정한다.
4. 격리 Cloud/CI: 단위, 실제 Chromium 작성→새로고침→수정→달력→재방문→삭제, 글꼴 유지·내려받기·저장 오류·키보드·375/768/1440 검증.
5. 메인 수락 후 dev에 통합하고 기존 자동배포로 게시한다. HTTPS·정확 SHA·체험판 자산과 동작을 확인한다.

## 운영·롤백

- 기존 정적 Dockerfile의 `COPY public`만 사용하므로 배포 프로그램·Compose·키·포트·DB·공용 nginx 변경이 없다.
- 이번 결과는 개발 도메인에만 반영한다. 운영 main 승격은 하지 않는다.
- 실패 시 직전 검증 정적 이미지로 복귀한다. 체험판을 되돌려도 사용자의 브라우저 저장 키를 삭제하거나 재해석하지 않는다.
- Next 앱의 실제 Google·Kakao 인증/계정 저장은 기존 B2 이후 순서로 연결한다. 체험판 공개를 MVP 완료로 표시하지 않는다.

## 실행 결과 (2026-11-04, 검토 중)

이 절은 실행 기록이다. 위 범위·사용자 경험·저장·운영 계약은 바꾸지 않았다.

- **RED(PR42):** 최종 BASE `4efa55836cba03b79964149e1f9b2bb3119dde10`, HEAD `02358bec365c48df349f4036e8b046e1757d4b2b`. 시험 3파일(`tests/unit/dev-preview.test.ts`, `tests/e2e-preview/preview.spec.ts`, `playwright.preview.config.ts`)만, 메인 RED gate 통과, 독립 PASS(P0·P1·P2 없음).
  - [CI 41791303869](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41791303869): 단위 18 실패·178 통과(전체 196), DB 165. [root 41791303797](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41791303797) 통과. 같은 시험 blob의 독립 E2E는 대조 1 통과·`/try/` 404로 9 실패였다.
  - R1 보완은 좁은 범위였다: 옛 글 부재 검사, 손상 문서 읽기 전용 허용, 날짜 제목 명시, 브라우저 시계 기대 일치.
- **GREEN(PR43):** `2f3e61b7417237aaf267a433e13dde247211d236`(브랜치 `claude/dev-preview-green-g0sym2`). 제품 6파일만: `frontend/public/try/{store.js,app.js,index.html,style.css}`, `frontend/public/index.html`, `.github/workflows/preview-validation.yml`. 시험 변경 0, 기존 Next 앱·D 원본·공용 sample·Dockerfile·Compose 변경 0. 메인 GREEN gate(시험 0·제품 6)·`diff --check` 0, 메인이 코드 전체를 읽었다.
  - 전용 `localStorage` 키 하나의 버전 JSON. 쓰기마다 최신 문서를 다시 읽고, `setItem` 성공 뒤에만 성공을 알린다. 실패하면 초안을 유지한다. 손상된 원문은 덮어쓰지 않고 내려받을 수 있다. 다른 키는 지우지 않는다. 다른 탭의 변경을 알리지만 탭 간 원자적 동기화는 보장하지 않는다.
  - D `style.css`를 그대로 불러오고 최소 CSS만 더했다. 사용자 글은 `textContent`로 렌더한다. 서버 전송·추적·실계정·감정덩어리·예시 기록·이미지·펜·마켓은 없다.
  - dev 첫 화면의 주 링크는 `/try/`이고 `/design/`·`/promo/` 링크와 `noindex`는 유지한다.
- **CI(exact GREEN):**
  - [app 41793116422](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41793116422): Node 24.22.2·26.13.0 각각 단위 196(B2 178 + 체험판 18)·빌드 경계 4·운영 경계 6·기존 E2E 12·lint·typecheck·build, PG 18.6 DB 165
  - [root 41793116522](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41793116522) 42·Compose, PR deploy는 정상 skip
  - [preview 41793116570](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41793116570): Node 26 JS 구문·저장 단위 18·실제 브라우저 10 passed(4.6s). 기존 E2E 12와 섞지 않는다. 메인이 원문 로그에서 10 passed를 직접 확인했다.
- **상태:** 독립 GREEN 검토 **진행 중**, dev 통합·게시 전. 실제 게시·HTTPS·실기기 브라우저 확인은 메인이 통합 뒤 한다.
- **브라우저 저장 한계:** 같은 브라우저에만 남고 브라우저 데이터 삭제 시 사라진다. 기기 동기화·실계정 자동 병합은 없다. 체험판을 Next 앱이나 MVP 완료로 표시하지 않는다.
- **미실행(이 기록 작성자):** 코드·브라우저·DB 시험, 서버, 설치, FullCheck. 실행 근거는 위 CI와 메인 확인이다.
