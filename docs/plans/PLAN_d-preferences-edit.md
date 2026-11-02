# PLAN — D 선택 확정·개별 조각 수정·기록 글꼴 설정 (정적 프로토타입)

- 상태: 구현 중(Cloud 작업 브랜치 → base `dev` Draft PR). 기준 `dev` `cb52350`.
- 범위: 사용자가 고른 **시안 D의 동작 아트보드 확장**이다. 앱 스택 선택·실제 앱 MVP 구현이 아니다.

## 1. 사용자 확정(2026-11-02, 메인 전달)

- D(C 구성 + A 색) UI/UX·테마를 기본으로 개발한다.
- 개별 조각 수정 기능이 필요하다.
- 사용자가 설정에서 기록 글꼴을 고른다.
- MVP = 기록 CRUD + 개인용 하루 꾸미기 기본(글꼴·간단한 그리기·안전 영역 배치). 마켓·구매·제작자 정산은 후속.
- 첫 로그인 감정 덩어리 10, 디자인 구매 1은 **계획 요건**이다. 이 시안에 로그인·잔액·거래를 흉내 내지 않는다.
- 최신 카피: "개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays".
- 미정 유지: 공유 범위, AI 스토리 방식, 언어·앱 스택.

## 2. 파일 변경 경계

| 파일 | 변경 |
|---|---|
| `docs/plans/PLAN_d-preferences-edit.md` | 신규(이 문서) |
| `docs/design/README.md` | 신규: D 선택 핸드오프(토큰·기하·타입·상태·한계, 화면 목록) |
| `docs/PRD.md` | 최신 카피·확정 요건 반영, 미정 유지, 구조 권고 분리 |
| `docs/design/concepts/d-warm-pieces/**` | 조각별 "수정", `#settings` 기록 글꼴 |
| `docs/design/concepts/shared/review.js` | 안별 추가 화면 등록 `POD.addView` 1개(다른 안 영향 없음) |
| `docs/design/concepts/index.html`, `README.md`, `docs/product/05_DESIGN_PROMPTS.md` | D 선택 완료 표시만. A/B/C 원본·추천 문구 보존 |
| `frontend/public/design/**` | 정본 byte-for-byte 사본 |

변경 금지: README·AGENTS·CLAUDE·CHANGELOG·opshelper·Compose·Dockerfile·CI·다른 설계 문서·영상.

## 3. 동작 설계

- **수정:** 각 조각에 `수정` 버튼(44px). 기존 작성 대화상자를 수정 상태로 연다(제목 "조각 고치기", 버튼 "고치기", 시각은 그 조각의 시각).
  글·이미지를 미리 채우고, 제출 시 같은 조각의 `text`·`img`만 바꾼다. 시각·개수·순서 불변. 빈 글은 오류·`aria-invalid`·포커스.
  취소/Esc는 데이터를 바꾸지 않고, 추가 중이던 초안을 되돌려 놓는다. 닫힌 뒤 포커스는 그 조각의 `수정` 버튼으로.
  오늘·지난 날(모아보기 펼침) 모두 수정. 삭제는 범위 밖.
- **기록 글꼴:** `#settings` 화면에 라디오 3개(고딕 기본·명조·손글씨, 모두 시스템 글꼴 스택), 샘플 문장 미리보기, 기본값 복원.
  `html[data-record-font]` → `--font-record`를 조각 글·하루 한 줄·편집 본문에만 적용. nav·버튼·제목·기하는 그대로.
  상태는 페이지 메모리에만 있고 새로고침하면 고딕으로 돌아간다(브라우저 저장·외부 폰트·네트워크 없음).
- 그리기 편집기·안전 영역 배치는 이번에 구현하지 않고 `docs/design/README.md` 후속 항목으로 연결한다.

## 4. 검증

- `git diff --check`, `node --check`, 정본↔사본 `diff -r`·sha256 비교, symlink 없음.
- Playwright(Chromium): D 375·768·1440 수평 넘침 없음; 수정→반영/취소/Esc 원복/지난 날 수정/개수·시각 유지/공백 오류/`<script>` 입력 escape;
  글꼴 3종 전환 시 조각 글 font-family 변경·nav/버튼 font 고정; 키보드 Tab으로 수정 버튼 도달; 비교판 embed에서 부모 포커스 회귀 없음.
- 한계: Cloud VM 글꼴은 사용자 기기와 다르다(손글씨 미설치 시 고딕 대체). 실제 기기 확인은 메인/사용자가 dev 도메인에서 한다.
