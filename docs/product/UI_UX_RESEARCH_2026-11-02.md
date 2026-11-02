# pieceofdays UI/UX 조사 (2026-11-02)

- **상태: 조사·잠정 추천.** 디자인 선택이나 `docs/design/` 정본이 아니다. 확정은 PRD·핵심 경험 확인 뒤 시안 3안 비교로 한다(공통 09 §2.4).
- 전제: PRD 없음. 준비중 안내문 "하루하루의 소중한 조각을 모아 기록하는 서비스."는 기록 서비스라는 것만 알려 준다.
  **개인 사진+짧은 글 기록**은 이 조사를 위한 가정이고, **감정 기록**은 레퍼런스에서 나온 추가 아이디어다. 사용자 답변 전이다.
- 범위: 공개 웹 페이지·원문 파일 읽기와 공개 스크린샷 관찰. 인증 앱 실제 사용, 외부 스타일·폰트 설치, 앱 구현은 하지 않았다.

## 1. 디자인 소스 두 곳의 성격

| 소스 | 종류 | 쓰는 법 |
|---|---|---|
| [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) | UI 디자인 시스템·화면 템플릿. 패키지마다 `DESIGN.md`(규칙)·`tokens.css`(값)·`components.html`(예시) | 시안의 팔레트·타입·카드/버튼 규칙 출발점, 모바일 화면 골격 |
| [Lemo Opuscar](https://lemomo-ai.github.io/lemo-opuscar/) ([repo](https://github.com/lemomo-ai/lemo-opuscar), MIT) | 코드로 만든 단편 영상의 스타일 프롬프트 66종(`styles/<slug>/STYLE.md` + 영상). UI 템플릿이 아님 | 빈 상태·온보딩·회고·공유 이미지의 무드·모션 보조. 앱 화면 전체 스타일로 쓰지 않음 |

### 1.1 Open Design 후보

순위는 소스가 매긴 것이 아니라 위 가정에 맞춘 메인(조사 조율) 판단이다.

| 순위 | 패키지(원문) | 방향 | 장점 | 비용·위험 |
|---|---|---|---|---|
| 1 | [Warm Editorial](https://github.com/nexu-io/open-design/tree/main/design-systems/warm-editorial) | 따뜻한 종이 바탕, 테라코타 강조, 세리프 제목, 그림자 최소, 반경 8~24px | 사진·짧은 글 모두 차분하게 담는 기본 기록 화면 | 문서와 토큰 값 불일치, 지정 글꼴(GT Sectra·Söhne)은 유료·라틴 |
| 2 | [kami](https://github.com/nexu-io/open-design/tree/main/design-systems/kami) | 양피지 바탕, 잉크 블루 단일 강조, 세리프 단일 굵기 | 긴 글·날짜별 다시 읽기(회상) 표면의 가독성 | 스스로 "modern app UI가 아님"이라 명시, 사진 피드·빠른 입력엔 약함 → **보조 표면** |
| 3 | [Doodle](https://github.com/nexu-io/open-design/tree/main/design-systems/doodle) | 크림 바탕, 손그림 선, 손글씨 글꼴 | 가볍고 놀이감 있는 대안 | 사진이 주인공인 화면·장기 기록의 차분함과 충돌, 토큰 글꼴이 Comic Sans |
| 골격 | [mobile-app 템플릿](https://github.com/nexu-io/open-design/tree/main/design-templates/mobile-app) | Feed·Detail·Onboarding·Profile·Form·Focus 화면 archetype | 세 방향을 같은 화면 구성으로 비교 | 스타일 없음, 디자인 시스템과 조합 필요 |

제외: [Paper](https://github.com/nexu-io/open-design/tree/main/design-systems/paper)는 규칙이 얇아 보조 참고만. 회사 이름 패키지(pinterest·airbnb 등)는 브랜드 모방 위험으로 제외.

### 1.2 Open Design 사용 제한

| 패키지 | `DESIGN.md` | `tokens.css`(예시 화면이 실제 사용) | 판정 |
|---|---|---|---|
| warm-editorial | `#FAF7F2`·`#C0512F`·보조 `#2F5B4F` | `#fbf6ee`·`#9b5b32`, Georgia·Inter | 불일치(방향만 일치) |
| kami | `#f5f4ed`·`#1B365D` | 같은 색, Charter 영문 스택만 | 색 일치, 한국어 스택 없음 |
| doodle | 주색 `#49B6E5` | `#fff8d7`·`#ff6b00` | 불일치 |

- 정확한 hex를 자동 채택하지 않는다. 확정 색·타입은 사용자 선택 뒤 `docs/design/README.md`에서 새로 정하고 WCAG AA 대비를 검사한다.
- kami의 CJK 설계는 중국어·일본어 대상이다. 한국어 글꼴·`word-break: keep-all`·행간은 따로 정하고 실제 렌더로 확인한다.
- 패키지 출처는 "OpenDesign curated bundled fixture"다. 규칙 문서를 정본처럼 인용하지 않는다.
- 저장소 라이선스(Open Design Apache-2.0, Lemo MIT)만 확인했다. 패키지별 원작자·서드파티 자산·폰트 라이선스는 확인하지 않았으며 채택 전에 확인해야 한다.

### 1.3 예시 화면 렌더 관찰 (메인 확인)

메인이 위 3종의 `components.html`과 `tokens.css`만 따로 받아 스크립트가 없음을 확인한 뒤 브라우저로 렌더해 보았다. 설치·clone·앱 구현은 하지 않았다.

| 원문 | 관찰 | 한계 |
|---|---|---|
| [warm-editorial/components.html](https://github.com/nexu-io/open-design/blob/main/design-systems/warm-editorial/components.html) | 토큰 값(따뜻한 크림·갈색 강조)으로 렌더 | 영문 샘플 |
| [kami/components.html](https://github.com/nexu-io/open-design/blob/main/design-systems/kami/components.html) | 양피지·잉크 블루 세리프 | 영문 샘플, 한국어 미검증 |
| [doodle/components.html](https://github.com/nexu-io/open-design/blob/main/design-systems/doodle/components.html) | 노랑 크림·주황 강조 손그림풍 | 영문 샘플 |

이 렌더는 패키지 예시 확인이며 pieceofdays 시안이나 한국어 검증이 아니다.

### 1.4 Lemo Opuscar 후보 (보조 용도)

| 스타일(원문) | 특징 | 추천 용도 |
|---|---|---|
| [Watercolor Brush](https://github.com/lemomo-ai/lemo-opuscar/blob/main/styles/watercolor/STYLE.md) | 따뜻한 섬유질 종이 한 장, 필드저널 수채 | 빈 상태·온보딩 |
| [Archive Light Table](https://github.com/lemomo-ai/lemo-opuscar/blob/main/styles/archive-lighttable/STYLE.md) | 백라이트 테이블·종이 톤·루페, 신호색 1개 | 회고(연말·월간 돌아보기) |
| [Risograph Print](https://github.com/lemomo-ai/lemo-opuscar/blob/main/styles/risograph/STYLE.md) | 오프화이트 종이+2~3 스폿 잉크, 오버프린트 | 월간 공유 이미지 시각 보조(본문 UI 비추) |
| [Paper-cut Lightbox](https://github.com/lemomo-ai/lemo-opuscar/blob/main/styles/paper-lantern/STYLE.md) (slug `paper-lantern`) | 종이층 명도 사다리, 강조색 1개 | 하루 마무리 모션 참고 |

"Paper Collage"라는 항목은 목록에 없다. 영상(mp4)은 시청하지 않았고 STYLE 원문과 목록 페이지 범위만 확인했다.

## 2. 제품 레퍼런스 (메인 실제 브라우저 확인)

| 제품·URL | 실제로 본 화면·한계 | 가져올 것 | 가져오지 않을 것 |
|---|---|---|---|
| Day One — [Calendar view](https://dayoneapp.com/features/calendar-view/), [Journal views (iOS)](https://dayoneapp.com/guides/tips-and-tutorials/journal-views-in-day-one-for-ios/) | 공개 제품 스크린샷의 calendar·list·media·map 보기와 공식 설명 | 날짜(달력)·목록·사진 모아보기로 같은 기록을 다시 보는 구조, 회상 동선 | 지도 등 보기 종류를 처음부터 모두 도입 |
| Daylio — [daylio.net](https://daylio.net/) | 공개 페이지의 기분 차트와 "기분·활동 2탭" 공식 설명. 인증 앱의 실제 입력은 시험하지 않음 | 낮은 입력 부담(탭 몇 번으로 감정 기록), 감정의 흐름 요약 | 차트·통계를 첫 화면 중심에 두는 구성 |
| Journey — [새 웹 경험 소개](https://blog.journey.cloud/unveiling-journeys-new-web-experience/) | 공개 제품 스크린샷의 사진 그리드·사이드바 | 데스크톱에서 날짜 탐색 사이드바+사진 그리드 | 반투명 효과·많은 메뉴 전부 |
| Are.na — [are.na](https://www.are.na/) | 공개 홈의 Capture·Arrange·Search·Connect와 사진·노트 블록 정리 설명. 공개 데모 영상이 placeholder로 렌더돼 앱 내부 UI는 확인하지 못함 | 사진·글을 "조각(블록)"으로 모아 묶는 개념 | 공개 네트워크·팔로우를 기본·강제로 두는 구조 |
| 1 Second Everyday — [Journal project 도움말](https://help.1se.co/en/articles/3404102-how-to-use-a-journal-project) | 공개 iOS/Android 달력 스크린샷, 하루 photo/video snippet 설명 | 하루 한 조각을 달력에 쌓는 리듬 | 영상 기록 강제 |

## 3. 잠정 추천안 — "차분한 종이 기록장" (권고·가설)

- 정보 구조: 달력과 날짜별 피드로 기록을 쌓고 다시 본다.
- 작성: 사진·한 줄·감정 중 원하는 것만 저장, 제목 필수 아님. 긴 글은 가능하되 상시 필수 아님.
- 공개 범위: 나만 보기를 기본으로 하고 공유는 별도 명시 동작(제품 요건 확정 후 결정).
- 화면: 모바일은 오늘·달력·돌아보기 + 작성 액션, 데스크톱은 날짜 탐색 + 콘텐츠 2단.
- 시각: Warm Editorial 방향을 기본, 긴 글·회상 표면은 kami식 가독성 보조. Lemo는 빈 상태(Watercolor)·회고(Archive)·월간 공유(Risograph) 보조.
- 지양: 연속 기록(streak) 압박, 미기록 날 빨간 표시, 과한 스크롤 애니메이션.
- 확인 예정: `prefers-reduced-motion`, 키보드 조작, 터치 대상 크기, 색 대비 AA, 한국어 실제 렌더.

## 4. 다음 단계

1. PRD와 사용자 핵심 경험(사진 중심인지 글 중심인지, 감정 기록 비중, 공유 여부)을 확인한다.
2. 같은 화면(오늘·작성·달력·회상, 모바일 포함)으로 서로 다른 시안 3안을 실제 아트보드로 그려 `docs/design/concepts/`에서 비교하고 사용자가 고른다.
3. 선택 뒤에만 `docs/design/README.md`에 확정 토큰·타입·핸드오프를 쓴다. 이 문서의 추천은 그 입력이며 선택 완료가 아니다.
