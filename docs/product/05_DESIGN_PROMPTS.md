# 05 디자인 브리프·시안 프롬프트 — 초안 (선택 대기)

- 상태: **초안.** 시안 3안을 만든 지시와 근거를 남긴다. 선택·확정이 아니다. 확정은 사용자 선택 뒤 `docs/design/README.md`.
- 실제 시안: `docs/design/concepts/`(정본), 개발 도메인 `https://dev.pieceofdays.com/design/`(게시 사본).
- 흐름·샘플: [04_STORYBOARD.md](04_STORYBOARD.md). 레퍼런스·조사 한계: [UI/UX 조사](UI_UX_RESEARCH_2026-11-02.md).

## 1. 공통 브리프

- 제품: 순간을 기록하고 하루를 정리해 이야기로 쌓는 **개인 일기장**. 랜딩·대시보드가 아니다.
- 공통 화면: 오늘 / 기록 작성 / 날짜별 다시 보기 / 첫날 빈 상태 / 토큰 카드. 같은 샘플 하루.
- 금지: KPI·통계·가짜 수치, 과한 히어로, 영문 eyebrow, 글로우·그라데이션·glass, pill 남발, 장식용 애니메이션, streak 압박, 죽은 버튼, 가짜 저장/AI 성공.
- 접근성: `lang=ko`, 키보드 focus 표시, form label, `aria-live` 상태, 약 44px 터치 대상, WCAG AA 대비, `prefers-reduced-motion`, 375/768/1440px 수평 넘침 없음.
- 색·타입: 출처 패키지의 `DESIGN.md`·`tokens.css`가 서로 다르므로(조사 §1.2) hex를 복제하지 않고 새 임시 semantic 변수로 정한다.
- 한국어: 시스템 글꼴 스택, `word-break: keep-all`, 본문 행간 1.7 이상. kami의 중국어·일본어 설계를 한국어 검증으로 보지 않는다.

## 2. 3안 프롬프트

| 안 | 출발점 | 지시 | 형태 차이 |
|---|---|---|---|
| A 따뜻한 기록장 | [Warm Editorial](https://github.com/nexu-io/open-design/tree/main/design-systems/warm-editorial) | 따뜻한 종이, 절제된 테라코타, 명조 제목+고딕 본문. 사진과 짧은 글을 날짜별 편집 지면처럼 | 큰 날짜 마스트헤드, 사진 크게·글 짧게, 하단 탭 + 주 동작 버튼, 데스크톱 2단 지면 |
| B 차분한 일기장 | [kami](https://github.com/nexu-io/open-design/tree/main/design-systems/kami) | 정갈한 종이와 잉크, 명조 본문, 긴 글을 읽는 화면. 사진은 작게 | 날짜 인덱스(사이드바/목차), 좁은 본문 폭, 여백 시각 표기, 이전·다음 날 이동, 각진 모서리 |
| C 조각 모음 | [Doodle](https://github.com/nexu-io/open-design/tree/main/design-systems/doodle) | 산뜻한 스크랩북. 사진·메모 조각을 모으고 손그림 요소는 작게 | 2열 조각 격자, 메모 종이·테이프, 상단 세그먼트, 달력 칸에 조각 썸네일 |

메인 추천: **A(가설)** — 조사 문서 §3 잠정 추천의 기본 방향. 사진 비중·긴 글 비중에 대한 사용자 답(스토리보드 §4)에 따라 바뀔 수 있다.

## 3. 제품 레퍼런스(조사 문서에서 재사용, 메인 확인 범위 그대로)

| 레퍼런스 | 시안에 반영한 점 | 반영하지 않은 점 |
|---|---|---|
| [Day One 달력 보기](https://dayoneapp.com/features/calendar-view/) | 날짜로 같은 기록을 다시 보는 구조(A·B·C 다시 보기) | 지도 등 다양한 보기 |
| [Daylio](https://daylio.net/) | 낮은 입력 부담(작성은 글 한 칸 + 선택 이미지) | 기분 차트·통계 |
| [Journey 웹](https://blog.journey.cloud/unveiling-journeys-new-web-experience/) | 데스크톱 날짜 탐색 사이드바(B) | 반투명 효과·많은 메뉴 |
| [Are.na](https://www.are.na/) | 글·사진을 "조각"으로 모으는 개념(C) | 공개 네트워크·팔로우 |
| [1 Second Everyday 도움말](https://help.1se.co/en/articles/3404102-how-to-use-a-journal-project) | 달력 칸에 하루 조각을 쌓는 리듬(C 모아보기) | 영상 기록 강제 |

조사 한계(재사용): 인증 앱 실제 사용 없음, 패키지별 원작자·폰트 라이선스 미확인, Open Design 예시는 영문 샘플이고 한국어 미검증, Lemo 영상 미시청.
이 시안들은 위 제품의 화면·카피를 복제하지 않았다.

## 4. 미확정

- PRD §8 Q1~Q3(형식·하루 정리 방식·공유 범위) 답 전이다.
- 글꼴: 동봉하지 않음. 확정 시 OFL 한국어 글꼴(예: 명조·고딕 계열) 서브셋 동봉 여부를 따로 정한다.
- 토큰 값은 시안용 임시값이다. 대비는 시안 토큰 카드에 계산값을 적었다.
