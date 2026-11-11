# PLAN — AI 하루 이야기 S2 날짜 화면과 기기별 다시 읽기

- 2026-11-11, 사용자 ‘이어서 진행’의 제품 연결 단계. S1 저장 후보(PR87)의 검증된 GREEN을 먼저 수용한 뒤 이 단계 RED를 실제 실행한다. S1과 S2를 일반 사용자 AI 생성·정시 실행·dev 개통 완료로 세지 않는다.
- 시각 기준: [D 핸드오프](../design/README.md) + [이야기 아트보드](../design/story/index.html). 새 3안·팔레트·내비게이션을 만들지 않는다. 기존 조각 CRUD·글꼴·직접 쓴 하루 한 줄·사진은 보존한다.
- S2는 저장된 글을 읽는 기능이다. 외부 전송/키/live env/실제 생성 action/timer/서비스DB·dev 배포는 하지 않는다. 일반 호출은 S3의 동의·원자 예약·공유 비용 한도가 먼저다.

## 1. 사용자 흐름

1. 오늘과 선택한 날짜에서 날짜 머리 다음, 조각 목록 위의 전체 폭 영역에 ‘AI 하루 이야기’를 둔다. 본문 최대64ch·줄바꿈 보존·기록 글꼴, 모바일375/768/1440에 수평 넘침이 없어야 한다. 오늘 h1 아래는 h2, 선택 날짜 h2 아래는 h3다.
2. 실제 저장된 StoryRef의 본문/생성 시각을 표시하고 원본 조각·하루 한 줄과 구분한다. 이야기 편집/삭제 버튼은 추가하지 않는다. 원문은 React text로만 렌더해 HTML을 실행하지 않는다.
3. current는 저장된 글, outdated는 ‘이 이야기를 만든 뒤 조각이 바뀌었어요’와 같은 글을 유지한다. 입력이 없어도 이야기만 있으면 날짜 화면·달력에서 다시 열 수 있어야 한다. 삭제된 원본의 내용을 담은 이전 이야기가 남아 있음을 안내한다.
4. 이야기/입력이 모두 없으면 기존 빈 날 화면을 보존한다. 입력은 있는데 이야기가 없고 generation=unavailable이면 ‘AI 하루 이야기는 아직 준비 중이에요’처럼 실제 불가 상태만 표시하며 생성 버튼0이다. 기존 글이 있으면 generation=unavailable이어도 글을 숨기지 않는다.
5. 회고 시간은 계정의 실제 설정값(서울, 기본20:00)과 /settings 링크를 표시한다. 조회 실패를 기본20:00으로 꾸미지 않는다. 실패하면 설정 확인 링크를 표시하고 읽은 이야기는 보존한다.
6. fixture 모드에서는 이야기를 숨긴다. 계정 데이터 조회 실패는 고정 한국어 안내/새 요청을 하는 다시 불러오기 링크로 표시한다. raw DB/API 오류·stack·userId/gen/object key를 props/HTML/로그에 넣지 않는다.

## 2. 서버·접합 계약

- 신규 `app/src/server/stories/calendar.pg.ts`(server-only): `listStoryDates(db:Db,subject:SessionSubject,from:string,to:string)` → Promise<Result<string[],"invalid_date"|"not_signed_in">>. from 포함/to 제외의 실제 날짜 범위, from<to, 최대62일. subject UUID/양의 안전 정수 확인→범위→verifyActiveAccount→user/date로 제한한 DISTINCT local_date 오름차순. 잘못된 입력은 SQL0, 미래 범위는 허용한다. 예상 밖 DB 오류는 throw한다. 생성·쓰기는0이다.
- 신규 `app/src/server/stories/view-data.ts`는 페이지용 일반 서버 helper다. getViewer의 요청 사용자와 getAppDb를 사용하고 readStoryDay/getReflectionTime 결과를 화면 자료로 복사한다. getDiaryContext/Pool/subject 자체를 JSX props로 넘기지 않는다. 읽기 중 세션이 무효화되면 body를 표시하지 않고 기존 안전한 login returnTo 흐름을 따른다. 날짜와 고정 오류 상태 외 원문 오류0이다.
- `app/src/app/page.tsx`, `days/page.tsx`, `days/[date]/page.tsx`는 account 모드에서만 이야기/달력 날짜를 읽는다. 두 달의 범위는 기존 thisMonth/lastMonth와 같다. fixture는 story SQL0이다. 페이지 사용자 조회는 기존 cache된 getViewer를 재사용한다.
- `DayBoardProps`에 ReactNode story 슬롯을 두어 client AccountDayBoard의 날짜 header 다음에 렌더한다. server DailyStory를 슬롯으로 전달하고 client가 server 모듈을 import하지 않는다. FixtureDayBoard는 슬롯을 표시하지 않는다. DaysView는 선택 날짜에 같은 슬롯을 전달한다.
- `DaysView`/`MonthCalendar`에 storyDates(날짜 문자열만)를 전달한다. 조각/한 줄 없이 이야기만 있는 날짜도 링크·‘AI 하루 이야기’ 접근성 이름으로 선택할 수 있다. 선택한 날짜의 원본이0이어도 이야기 슬롯을 렌더한다. 원본이 있는 기존 링크 이름·덮개 이미지는 보존한다.
- 이야기 목록 조회 실패는 경고로 구분한다. 기존 달력/원본을 숨기거나 ‘기록 없음’으로 성공 처리하지 않는다. 선택한 이야기 조회 실패도 별도 고정 안내다.
- 신규 `app/src/ui/d/DailyStory.tsx`, `app/src/app/globals.css`의 story 규칙만 추가. 기존 D 토큰/줄바꿈·focus·터치44px을 따른다. 아트보드의 도구줄/합성본문/가짜 pending 전환은 제품 코드로 옮기지 않는다. 실제 source는 none/current/outdated/unavailable/읽기 실패만 표시한다. pending/error/생성 버튼은 S3 계약 뒤 추가한다.
- DailyStory의 고정 props는 `{date:string;data:StoryDay|null;reflectionTime:string|null;hasMoments:boolean;headingLevel?:2|3}`다. data=null은 읽기 실패, hasMoments=false와 story 존재는 삭제 후 보존 안내에 쓴다. server 모듈/사용자 문맥을 import하지 않고 이 화면 자료만 받는다. 이 인터페이스로 실제 컴포넌트의 합성 캡처를 검증한다.

## 3. 소유와 RED

- 제품: calendar.pg.ts/view-data.ts/DailyStory.tsx, 위 페이지3개, DayBoard.tsx/AccountDayBoard.tsx/DaysView.tsx/MonthCalendar.tsx, globals.css. S1의 SQL/저장·생성 모듈·공통 auth/helper/Claude adapter/package/lock/workflow는 byte변경0이다.
- 디자인: story/index.html·story/README.md와 기존 design README의 이야기 링크/상태를 갱신한다. 구현 뒤 실제 컴포넌트3폭 PNG를 격리 CI에서 회수·직접 대조하기 전 visual PASS를 선언하지 않는다.
- RED 소유 신규 `app/tests/db/story-view.test.ts`, `app/tests/e2e-auth/story.spec.ts`. 공통 helper/issuer/global setup/config·기존 auth41은 변경0. 기존 signIn/DB fixture helper를 읽기만 재사용한다.
- DB: 같은날 여러 version의 날짜 중복 제거/범위 끝 제외·62일/양쪽 계정 격리·stale/pending 거부·쓰기0을 실제 PG18 app role로 확인한다. 신규 모듈 부재는 존재 assert 뒤 변수 동적 import로만 실패시킨다.
- E2E는 mock OIDC/일회용PG18/합성 이야기만: (a) 실제 생성한 메모의 DB localDate를 고정하고 SQL fixture 이야기와 두 기기(Chromium PC·WebKit phone) 읽기·폰 메모 수정 뒤 outdated/동일본문 보존·회고설정 재조회, (b) 원본 전부 삭제 뒤 /days 달력의 이야기-only 링크·폰 재로그인/재조회, (c) 다른 계정/로그아웃 보호와 HTML처럼 생긴 합성본문의 text escape·읽기 실패/닫힌 생성 버튼 경계. 날짜를 서버 현재일 추측으로 덮어쓰지 않는다.
- E2E fixture는 선언된 revision 공식으로 owner가 합성 행을 준비한다. 성공 mock generator/실 API 호출/사진·실제 사용자 자료0이다. 재현 가능한 fixture를 만들기 위해 제품 권한을 완화하지 않는다.
- S1 GREEN 뒤 실제 UI RED를 확인하고 별도 작성자가 제품 파일만 GREEN 구현한다. 새 testcase 수는 실측 전 예상으로만 기록한다. 기존 app 323+S1·DB197+S1·auth41·image6/front14/preview10 회귀와 server-only 빌드 경계를 같은 SHA의 격리 CI에서 확인한다. host 앱 시험·브라우저/설치0이다.
- 시각 증거는 기존 account visual 파일을 바꾸지 않고 신규 `app/tests/support/story-visual-capture.mjs`와 main 소유 `.github/workflows/story-visual-validation.yml`로 만든다. 기존 캡처처럼 CI 임시 Next 사본·실제 컴포넌트/CSS·합성 DTO·원본 hash 불변·POST/외부/cookie0·자신의 임시 자료만 정리를 검증한다. 5상태(current/outdated의2000자/deleted/unavailable/read-failed)×3폭=15 PNG의 정확 파일/서명/폭을 검사하고 그15개만 artifact에 올린다. DB/auth 실동작은 앞 E2E와 구분하며 가짜 RootLayout은 제품에 넣지 않는다. RED writer가 신규 캡처 script를 작성하고 컴포넌트 부재의 명시 assert를 확인한 뒤 UI author가 제품을 구현한다. 실제 PNG 직접 확인 전 visual PASS는 아니다.

## 4. 복귀·후속

S2는 DB 쓰기·외부 전송·migration0이다. 이야기 UI/읽기 helper를 회수하면 기존 조각 화면으로 돌아가며 저장된 이야기와 원본을 삭제하지 않는다. 공용 nginx·timer·운영 전환0이다. 데이터 범위·월 상한·사진 저장소 결정, S3의 실제 생성·공유 예약/비용/동의 및 정시 worker, 같은SHA 게시 이미지/서비스 DB/Google B5·30분 복귀를 거친 뒤 dev를 연다.
