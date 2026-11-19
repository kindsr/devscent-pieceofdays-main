# PLAN — 개발 앱의 기록 저장 연결 (S3a·S3b)

> **2026-11-10 제품 범위 정정:** 아래 메모 전용·서버 시각·수동 한 줄 계약은 당시 구현한 기반 슬라이스다. 사진·설정 시간·AI 하루 이야기는 현재 핵심 요구이며 [별도 계획](PLAN_ai-daily-story-core.md)으로 확장한다. 이 문서로 기존 API/시험의 완료 이력을 바꾸거나 새로운 시간 동작이 이미 구현됐다고 표시하지 않는다.

- 상태: 2026-11-05 메인 구현 계약. [실사용 전환 계획](PLAN_dev-usable-app.md)의 S3을 구체화한다. source 기준은 dev `e49b0c3`이다.
- 목표: 검증된 요청 사용자로 기존 F3 저장 함수를 호출하고, 이후 실제 화면에 연결한다. 새 저장 스키마·계정 정책·사진·꾸미기·마켓은 추가하지 않는다.
- S3a는 B4와 파일이 겹치지 않는 Server Actions 5개를 먼저 만든다. S3b는 B4 통합 뒤 context·page·layout·설정을 연결한다. S3a만으로 화면 저장이 켜진 것은 아니다.

## 1. S3a 공개 계약

제품 파일은 `app/src/app/actions/diary.ts` 하나다. 최상단 `"use server"`, 서버 경계를 유지하며 런타임 export는 아래 async 함수 5개뿐이다. 타입 export는 가능하다. 제품 DI·추가 HTTP route·Client Component 연결은 만들지 않는다.

`ActionResult<T> = {ok:true; value:T} | {ok:false; error:ActionError}`.

`ActionError`는 `forbidden | not_signed_in | unavailable | invalid_body | invalid_version | invalid_date | invalid_font | not_found | conflict`다. 함수별 도메인 오류는 기존 F3 오류 집합 그대로이며 문자열·스택·DB URL·쿠키를 응답/로그하지 않는다.

| 함수 | 입력 | 성공 value |
|---|---|---|
| `createMomentAction(body:unknown)` | 본문만. 날짜·userId 인자 없음 | `{id:string;version:number}` |
| `updateMomentAction(id:unknown, expectedVersion:unknown, body:unknown)` | 소유 조각 UUID·양의 안전 정수·본문 | `{id:string;version:number}` |
| `deleteMomentAction(id:unknown, expectedVersion:unknown)` | 소유 조각 UUID·기대 버전 | `null` |
| `saveSummaryAction(date:unknown, expectedVersion:unknown, body:unknown)` | 유효 `YYYY-MM-DD`, 생성은 null/수정은 양의 안전 정수, 본문 | `{version:number}` 또는 삭제 시 `null` |
| `setFontAction(key:unknown)` | `gothic | serif | hand` | 같은 `FontKey` |

모든 함수는 다음 순서를 따른다.

1. `loadAuthConfig(process.env, process.env.NODE_ENV)`. 오류는 `unavailable`이며 mutation은 없다.
2. `(await headers()).get("origin")`을 기존 `assertSameOrigin(cfg.session, origin)`으로 검사한다. 누락·`null`·불일치는 `forbidden`, viewer/DB 호출·쓰기 0이다. Next의 내장 Origin/Host 대조도 유지하고 `allowedOrigins` 우회는 추가하지 않는다.
3. 매 호출 `getViewer()`를 확인한다. `user`만 허용하고 `fixture`·`signed_out`은 `not_signed_in`, `unavailable`은 `unavailable`이다. viewer/config/headers 예외도 `unavailable`로 fail closed이며 원문을 노출하지 않는다. 실제 fixture env는 앞의 config 미설정·충돌에서 `unavailable`이 된다. viewer `fixture` 분기는 단위 seam의 방어 사례다. 시험은 액션 호출마다 요청 번호를 늘려 새 POST 요청을 모델링한다. 같은 요청 안의 React cache memo를 인증 재검사 실패로 세지 않는다.
4. 검증된 viewer의 userId만 기존 `createPgDiaryStore(getAppDb())`·`setFontKey(getAppDb(), userId, key)`에 전달한다. 외부 userId 인자는 없고 여분 인자·헤더·다른 쿠키가 권한이 되지 않는다.
5. 문자열이 아닌 id는 `not_found`, 잘못된 버전은 `invalid_version`, 날짜/본문 타입은 `invalid_date`/`invalid_body`로 거부한다. 그 밖의 UUID·trim·코드포인트 300·버전/소유권 검증과 오류는 기존 F3에 위임한다. 입력 거부 시 mutation SQL 0이다. `getAppDb()`는 Pool 획득이며 검증 전 쿼리를 추가하지 않는다.
6. DB/연결 오류는 `unavailable`. 성공/도메인 오류는 그대로 돌려준다. 새 로그인 지급·탈퇴·복구·재시도는 호출하지 않는다.

## 2. 날짜·갱신·화면 오류

- 새 조각은 기존 F3의 서버 now와 `Asia/Seoul` 오늘에만 생성한다. 요청에서 날짜를 받지 않는다. 기존 조각은 과거 날도 수정/삭제할 수 있고 원래 날짜·시각은 유지된다.
- 하루 한 줄은 기존 F3처럼 유효한 날짜를 받는다(과거·오늘 포함, 서울 오늘 이후는 `invalid_date`). 생성 null·기대 버전 수정·빈 본문 삭제를 유지하며 새 날짜 제한을 임의 추가하지 않는다.
- int4를 초과해도 양의 안전 정수인 기대 버전은 기존 F3의 bigint 비교로 처리한다. 존재하는 본인 기록이면 `conflict`, 없거나 타인 소유면 `not_found`이며 `invalid_version`으로 바꾸지 않는다.
- S3a는 캐시 갱신을 호출하지 않는다. 아직 UI에 연결하지 않아 HTTP/화면 동작을 완료로 세지 않는다. S3b의 성공 응답 뒤 client `router.refresh()`로 보호된 dynamic page/layout을 다시 읽고, 새 id·버전을 반영한다. DB 성공 뒤 캐시 갱신 실패를 DB 실패로 바꾸거나 mutation을 자동 재호출하지 않는다.
- S3b에서 `forbidden`은 다시 열어 시도 안내, `not_signed_in`은 로그인 안내, `unavailable`은 초안 보존·재시도 안내, `conflict`는 다른 곳에서 변경됨·다시 불러오기, `not_found`는 삭제/접근 불가, 입력 오류는 해당 필드 오류로 표시한다. 성공 전 저장 성공을 표시하지 않는다.

## 3. 소유·시험·관문

- RED: 신규 `app/tests/unit/diary-actions.test.ts`, `app/tests/db/f5-diary-actions.test.ts`만. 각 it에서 모듈을 동적 import하고 export 부재로 정상 RED를 확인한다. 제품·기존 시험·설정 변경 금지.
- GREEN: `app/src/app/actions/diary.ts`만. 시험 변경 0, 기존 context·UI·스키마·package·CI 변경 0이다.
- 단위: config 오류, Origin 누락/불일치/`null`, viewer 종류별 거부, 호출마다 viewer 재확인, 잘못된 입력·300 경계, DB 실패, 도메인 오류/성공 매핑, 외부 userId 무시, raw 오류/비밀값 로그 없음을 확인한다. Next headers·요청 입력/DB 경계의 시험 mock과 실제 도메인 검증을 구분한다.
- 실제 PG18: 기존 일회용 harness·app role·실제 세션 codec/getViewer·실제 F3 함수로 작성/읽기·수정/삭제/한 줄/글꼴, A/B 소유권, 낡은 버전 conflict·int4 초과 버전, 탈퇴 COMMIT 뒤 새 요청 거부, 실패 시 원문 보존을 확인한다. account/lifecycle·codec·저장 도메인을 mock하지 않는다. 요청 cookies/headers·React 요청 seam만 시험에서 대체한다.
- RED → 독립 runner → GREEN → 독립 검토 → 메인 통합. 원본 `.claude/tdd.conf`와 gate를 따른다. Cloud에 PG18이 없으면 설치/PG16 우회 없이 CI PG18 근거로 구분한다. 공유 서버에서 npm/Next/DB 시험·FullCheck를 띄우지 않는다.

## 4. S3b 화면 연결 계약 (B4·S3a 통합 뒤)

### 4.1 서버 읽기·소유

- `DiaryContext`의 `signed_in` 안내를 `{kind:"account";userId:string;store:DiaryStore;today:LocalDate}`로 바꾼다. `fixture`·`signed_out`은 유지한다. `unavailable`에는 선택 필드 `reason?:"db_unavailable"`만 추가한다. viewer의 DB 오류·store 초기화 실패에는 이 reason을 주고, 인증 미설정·설정 오류는 기존 `{kind:"unavailable"}` 그대로다. 값은 검증 사용자·PG store·서울 오늘에서만 만든다.
- 서버 문맥·store·userId·gen을 **어떤 React 컴포넌트의 props에도 넘기지 않는다(서버 컴포넌트 포함)**. `next dev`의 Flight 디버그 정보가 서버 컴포넌트 props도 직렬화할 수 있기 때문이다. page의 일반 서버 함수에서 문맥을 확인하고 모든 읽기를 마친 뒤 화면 자료만 JSX에 넣는다. 서버 함수의 내부 인자로 문맥을 쓰는 것은 허용하지만 JSX의 props로 전달하지 않는다.
- `DayBoard`에는 기존 `DiaryDay`와 `mode?:"fixture"|"account"`만 추가하며 기본은 fixture다. `DaysView`의 props는 `{today,picked,thisMonth,lastMonth,day,mode?}`다. `today`·`picked`는 날짜(선택 없음은 null), 월 자료 둘은 `DiaryDay[]`, `day`는 `DiaryDay|null`, mode 기본은 fixture다. 날짜·최소 기록 자료 외 사용자 식별자·저장소는 없다. `DaysView`는 PG를 읽지 않는다.
- 오늘·달력·날짜 page는 각각 문맥을 확인한다. 실제 계정은 같은 PG store의 `getDay`·`listMonth`로 본인 자료만 읽는다. 자료 없음은 빈 하루다. `reason:"db_unavailable"` 또는 실제 읽기 예외에는 h1 "오늘"/"모아보기"를 유지하고 h2 "기록을 불러오지 못했어요", 본문 "잠시 뒤 다시 열어 주세요."를 보인다. 인증 미설정의 기존 준비 중 문구는 유지한다. 실패를 빈 자료나 fixture로 대체하지 않는다. page는 월·선택 날짜의 읽기가 모두 성공한 뒤에만 `DaysView`를 그리고, 하나라도 실패하면 달력 전체 대신 위 실패 안내를 그린다.
- layout은 상단 표시와 저장 글꼴에만 문맥을 쓴다. 접근 검사는 각 page/action에서 유지한다. `force-dynamic`·no-store를 유지한다. `canWrite`는 fixture/account에서만 true다.

### 4.2 기록·한 줄

- `DayBoard`의 fixture 경로는 기존 메모리 동작·문구·예시 이미지·E2E를 유지한다. account 경로만 S3a의 5개 액션 중 해당 함수를 직접 호출한다. 새 쓰기 route·클라이언트 userId·제품 DI는 없다.
- account의 새 조각은 오늘 화면에서만 작성한다. 기존 조각은 과거 날도 수정·삭제한다. 폼은 마지막 서버 자료의 id·version을 사용한다. summary는 마지막 `summaryVersion`(없으면 null)을 보낸다. 입력에서 날짜·시각·userId를 조각 생성에 넣지 않는다.
- account에는 예시 이미지 선택·업로드 제어가 없고 빈 상태 문구는 "메모 한 줄로 첫 조각을 붙여 보세요."다. 기록 본문에 예시 사진을 넣지 않는다. fixture의 기존 문구는 유지한다.
- account의 하루 한 줄은 조각 0개여도 오늘 화면에서 쓸 수 있다. 과거 자료를 펼친 화면에서는 그날 한 줄을 수정·삭제할 수 있다. 빈 본문 저장은 기존 S3a 계약의 삭제다.
- account 달력은 조각 또는 비어 있지 않은 한 줄이 있는 날을 누를 수 있다. 조각 0개·한 줄만 있는 날의 접근성 이름은 `${dateLabel(date)} 하루 한 줄`이고, 조각이 있는 날의 기존 이름은 유지한다. `MonthCalendar`에 `includeSummary?:boolean`(기본 false)을 추가하고 account에서만 true로 한다. 과거 날에 조각만 있고 한 줄이 없으면 "한 줄 쓰기"로 생성도 허용한다. 아무 자료도 없는 과거 날의 새 진입점은 추가하지 않는다.
- 본문 검증은 trim 뒤 코드포인트 1~300(조각), 0~300(한 줄)이다. account textarea의 UTF-16 `maxLength`는 제거하고 코드포인트로 검사한다. 공백 조각은 "메모를 한 줄 적어 주세요.", 초과는 "300자 이하로 적어 주세요."로 표시한다. 서버 검증을 유지한다.
- account 작성/수정의 제출 버튼은 "저장"/"고치기", 한 줄은 "저장"이다. pending 동안 중복 제출·입력 변경·dialog 취소·Esc를 막고 `role="status"`로 "저장 중…"을 알린다. account 작성 dialog는 client 시각을 표시하지 않으며, 수정에는 기존 서버 조각 시각만 표시한다.
- account에만 삭제 버튼을 추가한다. 각 조각의 "조각 삭제" 접근성 이름을 가진 버튼으로 연다. D dialog에서 제목 "조각 지우기", 설명 "이 조각을 지울까요? 지운 뒤에는 되돌릴 수 없어요.", "지우기"·"취소"를 표시한다. pending 전 취소·Esc는 쓰기 0, 확인하면 해당 id·version으로 삭제한다. 성공 후 보드 제목으로 포커스를 돌린다.
- 성공 전 목록·원문·초안을 성공 상태로 바꾸지 않는다. 실패하면 입력 초안과 기존 조각을 유지한다. 성공 후 작성/수정/한 줄/삭제는 각각 "조각을 저장했어요."/"조각을 고쳤어요."/"한 줄을 저장했어요."(빈 본문이면 "한 줄을 지웠어요.")/"조각을 지웠어요."로 알린다.
- account의 목록·한 줄·기본 버전은 최신 서버 props에서 파생하고 첫 `useState(day)` 값에 고정하지 않는다. 열린 초안과 편집을 시작할 때의 기대 버전만 로컬에 둔다. 성공 후 `useTransition` 안의 `router.refresh()`로 canonical 자료를 읽고 refresh pending이 끝날 때까지 연속 쓰기를 막는다. 새 조각 강조에는 결과 id를 쓰며 client 시각으로 조각을 만들지 않는다. 자정을 넘겨 작성하면 서버의 새 서울 날짜에 저장되고 refresh 뒤 오늘 화면도 그 날짜가 된다.
- conflict의 "다시 불러오기"는 읽기만 한다. 초안을 유지하고 새 서버 내용은 dialog 안 "서버의 최신 글"로 함께 표시한다. 사용자가 이 재조회를 명시 선택한 뒤에만 편집 기대 버전을 새 props로 갱신하고, 다시 "고치기"/"저장"을 눌러 반영한다. 외부의 자동 props 갱신은 열린 편집 버전을 조용히 바꾸지 않는다. 삭제된 대상은 재제출하지 못하게 하고 초안은 복사할 수 있게 둔다.
- 생성 응답 유실 뒤 자동 재시도는 없다. 재조회에서 저장된 글을 사용자가 확인한 뒤 수동 재제출 여부를 정한다. 같은 글의 수동 재제출 중복을 서버에서 멱등 제거하는 새 기능은 이번 범위가 아니다. 시험은 요청 전 차단(쓰기0)과 처리 뒤 응답 유실(재조회 시1행·자동 재시도0)을 구분한다.

### 4.3 오류·글꼴

| 오류 | account 화면 문구·행동 |
|---|---|
| `forbidden` | "요청을 확인할 수 없어요. 화면을 다시 열고 시도해 주세요." |
| `not_signed_in` | "다시 로그인해 주세요. 쓰던 글은 그대로 두었어요."와 로그인 링크. 초안은 유지 |
| `unavailable` 또는 통신 예외 | "저장을 확인하지 못했어요. 쓰던 글은 그대로 두었어요. 다시 불러와 확인해 주세요."와 재조회. 응답 유실 때 DB 반영 여부는 단정하지 않으며 자동 재시도하지 않음 |
| `conflict` | "다른 곳에서 기록이 바뀌었어요. 쓰던 글은 그대로 두었어요."와 "다시 불러오기"(읽기만) |
| `not_found` | "기록을 찾을 수 없어요. 다시 불러와 주세요."와 재조회 |
| 입력 오류 | 위 본문 문구, `invalid_date`는 "기록할 날짜를 확인해 주세요.", `invalid_version`은 재조회 안내, `invalid_font`는 "글꼴을 다시 골라 주세요." |

- layout과 설정 page는 `getPreferences`로 허용된 `fontKey`를 읽는다. 기본 gothic은 html의 `data-record-font`를 생략하고 serif/hand만 넣는다. layout의 글꼴 조회 실패는 표시용 기본값으로 제한하고 접근을 허용하는 근거로 쓰지 않는다. 설정 조회 실패는 h1 "설정", h2 "기록 글꼴을 불러오지 못했어요", 본문 "잠시 뒤 다시 열어 주세요."이며 편집기는 없다.
- `FontSettings`는 `mode?:"fixture"|"account"`·`initialFont?:FontKey`를 받으며 기본은 기존 fixture다. account는 마지막 서버 글꼴을 보여 주고 `setFontAction` 성공 뒤에만 라디오·html 속성을 바꾸며 refresh한다. 실패 시 이전 글꼴을 유지한다. 기본값 버튼도 같은 액션으로 gothic을 저장한다. 실제 계정 안내는 "계정에 저장돼 다른 기기에서도 같은 글꼴로 보여요."다.
- 실제 계정에서 글꼴 성공 문구는 "기록 글꼴을 저장했어요."다. signed_out/unavailable에게는 저장할 수 있는 글꼴 편집기를 보이지 않고 B4의 계정/로그인 안내를 유지한다. fixture는 기존 메모리 편집기를 유지한다. 메뉴·제목·상단 글꼴은 바꾸지 않는다.

### 4.4 소유·검증·회귀 기대 전환

- S3b RED는 `app/tests/unit/request-context.test.ts`의 기존 `signed_in` 문맥 기대와 DB 실패의 문맥 기대만 위 account/reason으로 명시 전환하고, 신규 `app/tests/e2e-auth/diary.spec.ts`를 추가한다. 기존 `f4-dal.test.ts`의 getViewer 기대는 바꾸지 않는다. 실제 getDiaryContext의 PG 읽기 연결을 추가할 경우 신규 `app/tests/db/f5-diary-context.test.ts`만 쓴다. B4 harness 확장은 통합 SHA에서 main이 확인해 배정한다.
- B4 E2E의 "기록 연결 전" 기대는 S3b RED에서 실제 빈 보드/저장 동작으로 명시 전환한다. 이 기대가 있는 정확 파일·행은 B4 통합 SHA에서 main이 확인해 배정한다. GREEN은 시험 변경 0이다.
- GREEN 소유: `shared/diary.ts`, `server/context.ts`, page 3개·layout·settings, `ui/d/{DayBoard,DaysView,FontSettings,TopBar,MonthCalendar,NotConnected}.tsx`·필요한 최소 D CSS. fixture 경로를 보존하기 위한 내부 `ui/d/AccountDayBoard.tsx`·`AccountFontSettings.tsx` 분리와, 반복 읽기를 줄이는 일반 서버 helper `server/diary/view-data.ts`는 필요할 때만 허용한다. 추가 외부 API나 자료 수집은 없다. B4 계정 영역·공식 버튼·route와 S3a 액션은 유지한다. 스키마·package·lock·배포/CI 변경은 없다.
- 시험은 실제 mock OAuth 로그인 → 첫 빈 보드 → 300코드포인트 조각 저장 → 새로고침·다른 browser context의 동일 계정에서 유지 → 수정·삭제·취소 → 한 줄(조각0개 포함)·달력/과거 보기 → 글꼴 새로고침 유지, A/B 격리, 낡은 버전 충돌·네트워크 실패 초안 보존·재조회만 실행을 검증한다. 계정 생성·지급·세션을 직접 조작해 성공 경로를 대신하지 않는다.
- 실제 서버 액션 HTTP의 Origin 거부, 375/768/1440 넘침0·44px·키보드·초점·loading/error를 확인한다. 클라이언트 액션 참조는 Next의 허용된 Server Action 방식으로 연결하고 서버 저장 구현·자격이 client graph에 들어가지 않는 build 경계를 유지한다.
- 읽기 실패는 해당 일회용 DB의 app 권한을 owner 시험 연결에서 잠깐 회수하고 finally 복원해 E2E로 재현한다(실서버 금지). 계정 식별자 비직렬화는 그 시험 계정 UUID가 문서 HTML·RSC 응답·Client props에 없음을 확인한다. B4 통합 후 실제 harness의 지원 방식과 시험 파일을 배정할 때 고정한다.
- PR61 독립 검토(2026-11-05)의 개발 Flight props 문제는 위의 React props 경계로 해결한다. 비직렬화 시험을 느슨하게 하거나 운영에서만 확인하는 방식으로 옮기지 않는다. 이 보완은 화면·저장 정책을 바꾸지 않고 개발 모드에서도 같은 개인정보 경계를 지킨다.
- 기존 fixture E2E12·production 기본6과 단위/PG 회귀를 유지한다. 의미 있는 새 경계만 검사하며 fixture를 실제 저장처럼 바꾸지 않는다. RED→독립 runner→GREEN→독립 검토를 따른다.

## 5. 배포 영향·되돌리기

S3a는 HTTP route·화면·배포/DB 설정을 추가하지 않는다. 이 파일과 시험 커밋을 revert할 수 있다. S3b를 되돌리면 실제 사용자는 다시 기록 연결 전 안내를 보며, 기존 저장 행·원장·체험판 localStorage는 삭제하지 않는다. 실제 이용은 별도 F6-dev의 전용 DB·비밀값·실제 OAuth 검증 후 켠다.

기술 근거: [Next 데이터 보안](https://nextjs.org/docs/app/guides/data-security)(2026-11-05 조회). 현재 설치한 Next 16.4.3·React 19.3.1은 유지한다. 실제 프록시 Host·Origin·쿠키와 Server Action HTTP 경계는 S3b/F6-dev E2E에서 직접 검증하며 단위 호출을 그 증거로 세지 않는다.
