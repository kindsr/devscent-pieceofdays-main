# PLAN — 개발 앱의 기록 저장 연결 (S3a·S3b)

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
3. 매 호출 `getViewer()`를 확인한다. `user`만 허용하고 `fixture`·`signed_out`은 `not_signed_in`, `unavailable`은 `unavailable`이다. viewer/config 예외도 fail closed이며 원문을 노출하지 않는다.
4. 검증된 viewer의 userId만 기존 `createPgDiaryStore(getAppDb())`·`setFontKey(getAppDb(), userId, key)`에 전달한다. 외부 userId 인자는 없고 여분 인자·헤더·다른 쿠키가 권한이 되지 않는다.
5. 문자열이 아닌 id는 `not_found`, 잘못된 버전은 `invalid_version`, 날짜/본문 타입은 `invalid_date`/`invalid_body`로 거부한다. 그 밖의 UUID·trim·코드포인트 300·버전/소유권 검증과 오류는 기존 F3에 위임한다. 입력 거부 시 mutation SQL 0이다. `getAppDb()`는 Pool 획득이며 검증 전 쿼리를 추가하지 않는다.
6. DB/연결 오류는 `unavailable`. 성공/도메인 오류는 그대로 돌려준다. 새 로그인 지급·탈퇴·복구·재시도는 호출하지 않는다.

## 2. 날짜·갱신·화면 오류

- 새 조각은 기존 F3의 서버 now와 `Asia/Seoul` 오늘에만 생성한다. 요청에서 날짜를 받지 않는다. 기존 조각은 과거 날도 수정/삭제할 수 있고 원래 날짜·시각은 유지된다.
- 하루 한 줄은 기존 F3처럼 유효한 날짜를 받는다(과거 포함). 생성 null·기대 버전 수정·빈 본문 삭제를 유지하며 새 날짜 제한을 임의 추가하지 않는다.
- S3a는 캐시 갱신을 호출하지 않는다. 아직 UI에 연결하지 않아 HTTP/화면 동작을 완료로 세지 않는다. S3b의 성공 응답 뒤 client `router.refresh()`로 보호된 dynamic page/layout을 다시 읽고, 새 id·버전을 반영한다. DB 성공 뒤 캐시 갱신 실패를 DB 실패로 바꾸거나 mutation을 자동 재호출하지 않는다.
- S3b에서 `forbidden`은 다시 열어 시도 안내, `not_signed_in`은 로그인 안내, `unavailable`은 초안 보존·재시도 안내, `conflict`는 다른 곳에서 변경됨·다시 불러오기, `not_found`는 삭제/접근 불가, 입력 오류는 해당 필드 오류로 표시한다. 성공 전 저장 성공을 표시하지 않는다.

## 3. 소유·시험·관문

- RED: 신규 `app/tests/unit/diary-actions.test.ts`, `app/tests/db/f5-diary-actions.test.ts`만. 각 it에서 모듈을 동적 import하고 export 부재로 정상 RED를 확인한다. 제품·기존 시험·설정 변경 금지.
- GREEN: `app/src/app/actions/diary.ts`만. 시험 변경 0, 기존 context·UI·스키마·package·CI 변경 0이다.
- 단위: config 오류, Origin 누락/불일치/`null`, viewer 종류별 거부, 호출마다 viewer 재확인, 잘못된 입력·300 경계, DB 실패, 도메인 오류/성공 매핑, 외부 userId 무시, raw 오류/비밀값 로그 없음을 확인한다. Next headers·요청 입력/DB 경계의 시험 mock과 실제 도메인 검증을 구분한다.
- 실제 PG18: 기존 일회용 harness·app role·실제 세션 codec/getViewer·실제 F3 함수로 작성/읽기·수정/삭제/한 줄/글꼴, A/B 소유권, 낡은 버전 conflict·int4 초과 버전, 탈퇴 COMMIT 뒤 새 요청 거부, 실패 시 원문 보존을 확인한다. account/lifecycle·codec·저장 도메인을 mock하지 않는다. 요청 cookies/headers·React 요청 seam만 시험에서 대체한다.
- RED → 독립 runner → GREEN → 독립 검토 → 메인 통합. 원본 `.claude/tdd.conf`와 gate를 따른다. Cloud에 PG18이 없으면 설치/PG16 우회 없이 CI PG18 근거로 구분한다. 공유 서버에서 npm/Next/DB 시험·FullCheck를 띄우지 않는다.

## 4. S3b 연결 경계 (후속)

- `DiaryContext`에 `{kind:"account";userId:string;store:DiaryStore;today:LocalDate}`를 추가한다. 값은 `getViewer`의 검증 사용자·PG store·서울 오늘에서만 만든다. 이 서버 문맥과 store·userId를 Client Component에 넘기지 않고 최소 day 자료만 전달한다.
- 기존 `fixture`는 예시 메모리 동작을 그대로 유지한다. 실제 계정은 서버 액션을 기다려 성공/실패를 표시하고 예시 사진 선택을 보이지 않는다. 날짜별 저장·버전 갱신·삭제 확인·키보드와 375/768/1440을 auth mock E2E로 검증한다.
- layout·설정은 `getPreferences`로 저장 글꼴을 읽고 허용된 키만 기록 본문에 적용한다. 함수/타입 공개 계약은 S3b RED 전에 이 절에 필요한 세부를 더 고정한다. S3a를 기다리게 만들지 않는다.
- S3b RED에서 B3의 `signed_in` 저장소 없음 단언을 F5의 검증 사용자 문맥 단언으로 명시 전환한다. GREEN이 기존 시험을 조용히 바꾸지 않는다.

## 5. 배포 영향·되돌리기

S3a는 HTTP route·화면·배포/DB 설정을 추가하지 않는다. 이 파일과 시험 커밋을 revert할 수 있다. S3b를 되돌리면 실제 사용자는 다시 기록 연결 전 안내를 보며, 기존 저장 행·원장·체험판 localStorage는 삭제하지 않는다. 실제 이용은 별도 F6-dev의 전용 DB·비밀값·실제 OAuth 검증 후 켠다.

기술 근거: [Next 데이터 보안](https://nextjs.org/docs/app/guides/data-security)(2026-11-05 조회). 현재 설치한 Next 16.4.3·React 19.3.1은 유지한다. 실제 프록시 Host·Origin·쿠키와 Server Action HTTP 경계는 S3b/F6-dev E2E에서 직접 검증하며 단위 호출을 그 증거로 세지 않는다.
