# PLAN — AI 하루 이야기 S1 저장·스냅샷·날짜별 읽기

- 기준 `824559fdd5c8056e100d3fa682a87339dca313a3`, 2026-11-11. 사용자 ‘이어서 진행’에 따라 이야기 저장·화면·회고 시간·dev 연결을 진행한다. 서버 Claude 어댑터는 PR86의 격리 CI와 합성1회 생성 검증을 통과했다. 개발 앱은 아직 정적/OFF다.
- 이 단계는 서버 저장 기반이다. 실제 일기·사진 전송, 사용자 호출 진입점, 키 live env, 서비스 DB 적용·dev push·앱 전환·timer 활성은 하지 않는다. 전송 범위·개발 월 상한·사진 저장소 방식은 사용자 답변 대기다. 실제 호출에는 서버 동의·원자적 진행 예약·공유 비용 한도가 모두 필요하며 후속 0006에서 구현한다.
- 현재 확정 요구는 실제 사진+짧은 메모로 하루 이야기, 같은 계정 PC/폰 조회, 설정의 회고 시간 기본20:00(서울)이다. S1을 이 전체 경험의 완료로 세지 않는다.

## 1. 변경 경계와 SQL

제품 소유는 다음 9파일이다. 기존 0001~0004·Claude adapter·사진/인증/원장/기록 CRUD·UI·package/lock·workflow/helper는 byte 변경0이다.

- `app/migrations/0005_daily_stories.{up,down}.sql`
- `app/src/server/db/migrate.ts`: USER_DATA_TABLES에 story_versions 한 항목(12표).
- `app/src/shared/stories.ts`
- `app/src/server/stories/{input.pg,store.pg,generator,generate,read}.ts`

up은 `pod.story_versions` 한 표만 만든다: id UUID PK default uuidv7(), user_id UUID users FK ON DELETE CASCADE, local_date DATE, version INTEGER>=1, source_revision TEXT 64자리 lowercase SHA256, body TEXT char_length 1..2000 및 btrim 공백만 금지, created_at TIMESTAMPTZ default now(). 전부 NOT NULL이다. UNIQUE(user_id,local_date,version), UNIQUE(user_id,local_date,source_revision). PUBLIC 권한을 제거하고 app에는 SELECT/INSERT만 준다. UPDATE/DELETE/TRUNCATE·purge 직접 권한은 없다. 별도 trigger/function/index/lease/attempt 표를 만들지 않는다.

down은 SQL 자체에서도 ci 환경과 12표 모두 비어 있음을 확인한 뒤 DROP한다(0004와 같은 DO guard). 실행기 USER_DATA_TABLES guard도 유지한다. 직접 down과 실행기 down 모두 사용자 자료를 지우지 못해야 한다. 서비스 DB에 이 migration을 아직 적용하지 않는다.

## 2. 서버 계약

새 server 모듈은 import server-only. 환경·키·fetch·Claude adapter·blob을 읽거나 호출하지 않는다. 기존 provider 모듈은 그대로 보존한다. shared는 서버 모듈을 import하지 않는다.

`shared/stories.ts`:

```ts
export const STORY_INPUT_MAX_MOMENTS = 30;
export const STORY_TEXT_MAX = 300;
export const STORY_INPUT_MAX_BYTES = 48 * 1024;
export const STORY_MAX = 2000;
export type StoryError = "invalid_date" | "not_signed_in" | "no_input" | "input_too_large"
  | "invalid_input" | "conflict" | "unavailable" | "timeout" | "invalid_output";
export type StoryRef = { id: string; version: number; body: string; createdAt: string };
export type StoryDay = { date: string; inputRevision: string | null; story: StoryRef | null;
  state: "none" | "current" | "outdated"; generation: "unavailable" };
```

DTO에 userId/gen/momentId/photoId/object key·내부 sourceRevision은 넣지 않는다. inputRevision은 예상 입력 비교를 위한 불투명 revision이며 비밀값이 아니다. StoryRef.id는 이야기 행의 ID다.

`input.pg.ts`:

- StoryMoment={id:string,version:number,time:string,text:string}, StoryInput={date:string,revision:string,moments:StoryMoment[]}.
- `storyRevision(date, refs:readonly {id:string;version:number}[]):string` = sha256(`v1\n` + date + `\n` + id 오름차순으로 정렬한 `${id}:${version}\n` 연결). caller 배열을 변경하지 않는다. 날짜/id/version/추가/삭제 변화는 revision을 바꾼다. 정리 한 줄·글꼴·회고 시간은 입력이 아니다.
- `storyPayload(input:StoryInput)` → 새 plain `{date,moments:[{time,text}]}`만 복사. DB 식별자·사진 정보0.
- `captureStoryInput(db:Pick<Db,"query">,userId:string,date:string)` → Result<StoryInput,"invalid_date"|"no_input"|"input_too_large"|"invalid_input">. userId/date 형식 오류는 SQL 전에 invalid_date. 미래 판정은 generate가 담당한다.
- SQL 문1개: diary_moments를 user_id/local_date로 제한하고 `ORDER BY occurred_at,id LIMIT 31`. time은 `to_char(occurred_at AT TIME ZONE time_zone,'HH24:MI')`, text는 원래 body. 현재 기록 삭제는 실제 DELETE이며 숨김/soft-delete 열이 없다. 기존 getDay와 같은 메모 가시성을 따른다. 사진 JOIN·day_summaries 없음. 현재 사진 연결은 조각과 함께 불변으로 생성되며, 사진 전송 계약을 도입하면 revision v2와 별도 RED를 적용한다.
- 0행 no_input, 31행 input_too_large. 어떤 text든 trim 후 비었거나300codepoint 초과·금지 제어 문자(C0/DEL/C1, LF/CR/TAB 제외)이면 invalid_input. 행을 건너뛰거나 자르지 않는다. payload JSON UTF8 48KiB 초과는 input_too_large. 현재 다른 상한 뒤 도달 불가여도 방어를 유지한다.

`store.pg.ts`:

- 서버 전용 StoredStory=StoryRef&{sourceRevision:string}.
- `findLatestStory(db:Pick<Db,"query">,userId:string,date:string):Promise<StoredStory|null>`.
- `findStoryByRevision(db:Pick<Db,"query">,userId:string,date:string,revision:string):Promise<StoryRef|null>`.
- `appendStoryVersion(db:Db,subject:SessionSubject,date:string,revision:string,body:string)` → Result<{story:StoryRef;replayed:boolean},"not_signed_in">.
- append는 withTransaction 안에서 users의 id/status active/auth_generation 일치를 FOR UPDATE로 확인한다. 실패하면 not_signed_in. 같은 revision이 있으면 replayed:true, 없으면 같은 user/day의 max(version)+1 INSERT. 사용자 행 잠금이 동시 저장을 직렬화한다. 외부 I/O 동안 이 잠금을 유지하지 않는다. 예상 밖 SQL 오류는 상위에서 unavailable로 바꾼다.

`generator.ts`: StoryGenerator.generate({date,moments:{time,text}[]},signal:AbortSignal) → Promise<Result<{body:string},"unavailable"|"timeout"|"invalid_output">>. `getStoryGenerator():StoryGenerator|null`은 S1에서 항상 null. 성공 mock이나 메모리 예산·예약을 제품에 넣지 않는다.

`generate.ts`: `STORY_GENERATE_TIMEOUT_MS=20000`; `generateDailyStory(db:Db,generator:StoryGenerator|null,subject:SessionSubject,args:{date:string;expectedInputRevision:string|null},opts?:{now?:()=>Date})` → Result<{story:StoryRef;replayed:boolean},StoryError>.

처리 순서는 subject UUID/양의 안전 정수 gen → 날짜/미래(서울 현재일 기준) 및 expectedRevision(null 또는64hex, 형식 오류는 conflict) → verifyActiveAccount(active+gen) → capture → expected revision 충돌 → 이미 저장된 같은 revision 재사용 → generator null이면 unavailable → generator에 20초 signal과 식별자 없는 payload 전달 → 결과 검증 → append fence이다. stale/pending 계정은 capture와 generator 전에 거부한다.

결과와 value는 plain/null-prototype record이며 body는 own string이어야 한다. trim 뒤 비거나2000codepoint 초과·금지 제어 문자면 invalid_output. 허용되지 않은 port 오류/throw는 unavailable, timeout은 timeout. 원문·stack은 로그/결과0. 실패는 기존 이야기/원본을 보존한다. 주입 생성기 호출 중 별도 연결로 원본 CRUD가 가능하고, 캡처한 revision으로 저장한 결과는 이후 read에서 outdated가 될 수 있다. S1의 주입 port는 격리 시험 전용이며 실제 provider 진입점0이다.

`read.ts`: `readStoryDay(db:Db,subject:SessionSubject,date:string)` → Result<StoryDay,"invalid_date"|"not_signed_in">. subject 오류 not_signed_in, 날짜 오류 invalid_date, active/gen 확인 후 최신 이야기→현재 capture 순서로 읽는다. capture 실패(no_input/31행/invalid_input)는 inputRevision=null로 두고 기존 이야기는 반환한다. story가 없으면 none, capture 성공 revision과 StoredStory.sourceRevision이 같으면 current, 나머지는 outdated. StoryRef만 복사해 내부 sourceRevision을 DTO에서 제거한다. generation은 unavailable. 읽기는 쓰기·생성0이다. 예상 밖 DB 오류는 throw해 호출자가 읽기 실패를 표시한다.

## 3. RED → GREEN·검증

- RED 소유: 새 `app/tests/unit/story-revision.test.ts`, `app/tests/db/stories.test.ts`. 기존 migrate/lifecycle-schema/photo-storage/reflection-time 시험의 정확한 기본 migration 목록·checksum 기대에0005를 추가한다. 예외는 `app/tests/db/f2-support.ts`의 USER_DATA_TABLES 목록에 story_versions 한 항목만 추가하는 것이다(기존11항목/동작/SQL/역할/정리 불변). 그 외 common helper/global setup/fixture/package/workflow/claude-story.test.ts 변경0. 새 helper는 stories.test.ts 안에 둔다. 새 모듈 검사는 실제 env/키/fetch/provider/blob 경계에 한정하며 무해한 인증 타입 import까지 금지하지 않는다.
- 제품 부재는 existsSync와 파일/to_regclass 명시 assert로 검출한 뒤 변수 동적 import/SQL을 호출한다. missing literal import·문법·타입 오류·환경 실패는 유효 RED가 아니다.
- revision 정렬/변경·정확 payload·설정/순수 import network0·닫힌 생성기·DTO의 식별자 미포함, single snapshot·시간순/서울 자정·31개/빈 입력/제어 문자/보안 경계, append replay/version 보존/동시 저장, 생성 중 CRUD·계정 gen 변경·탈퇴·purge 후 늦은 결과 거부, read none/current/outdated·잘못된 입력에도 기존 글 보존·읽기 쓰기0을 실제 PG18의 app role로 검증한다.
- schema 권한/CHECK/FK/CASCADE/unique·원장 보존·USER_DATA_TABLES12·CI 빈 DB up/down·이야기가 있는 down 거부·SQL 자체 non-ci down 거부를 검증한다. 실제 서비스 DB/외부 API/키0.
- host 앱/DB 시험·설치0. GitHub 격리 Actions의 기존 app unit/db/auth·build/boundary·image/front 회귀만 사용한다. RED 실측 실패 이유를 회수한 뒤 별도 작성자가 GREEN 9파일만 구현하고 시험 byte0을 지킨다. 메인이 feature commit/push/PR·로그 회수와 독립 검토를 조율한다.

## 4. 다음 연결과 복귀

- S2는 D 날짜 화면 이야기 영역과 동의/생성 상태·PC/폰 읽기를 연결하고 실제 아트보드/핸드오프를 갱신한다. S3는 선택된 전송 범위, persisted consent, PG 원자 예약과 사용자 삭제로 지워지지 않는 공유 월 비용 원장, provider·실행기를 함께 검증한다.
- front read timeout30초와 provider30초를 같은 동기 action에 그대로 잇지 않는다. S1의20초 signal은 전체 HTTP 시한을 보증하지 않는다. 후속은 PG 예약행을 실제 작업으로 쓰고 enqueue/상태 읽기 + one-shot worker에서 실행하는 방안을 우선 검토한다. 추가 큐 프레임워크·Next setInterval·프로세스 로컬 예산은 쓰지 않는다.
- 사용자 설정 시각(기본20:00 서울)을 worker에 연결하되 자동 전송을 포함한 동의·비용·배포 선행조건을 먼저 충족한다. 키 allowlist/helper 개정·실제 저장소·DB 연속 migration·같은SHA CI/게시이미지·Google B5/실기기와30분 복귀는 main 통합 단계다.
- 코드 회수 시 기존 CRUD/사진/글꼴/회고 설정/Claude adapter는 그대로다. S1에서 외부 전송·실제 행 생성0이므로 서비스 DB down은 하지 않는다. 배포 후 rollback도 기존 이야기/원본을 삭제하지 않는 코드 회수 방식으로 검토한다. 외부 전송·발생 비용을 코드 revert로 회수할 수 있다고 약속하지 않는다.
