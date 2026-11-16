# AI 하루 이야기 부분 수정·재생성 (2026-11-16)

사용자 요청: 14일 회고를 개선한 지침으로 다시 만들고 AI 이야기의 일부 문장도 직접 고칠 수 있게 한다.
기준 b56eb2b. 기존 글은 삭제/UPDATE하지 않고 다음 버전으로 보존한다. 개인 입력·출력은 공개 문서/시험/하위 pane에 넣지 않는다.

## 1. 저장·권한

- 새 migration `0007_story_edits.{up,down}.sql`, 새 표 없음(USER_DATA_TABLES 15 유지).
- story_versions: `origin text NOT NULL DEFAULT 'ai' CHECK IN ('ai','user_edit')`, `base_version integer NULL` 추가.
- base NULL 또는 `1 <= base_version < version`, user_edit이면 base 필수. (user_id,local_date,base_version)는 같은 표의 (user_id,local_date,version)를 FK로 참조한다.
- 기존 UNIQUE(user_id,local_date,source_revision)를 제거하고 같은 열의 `story_versions_first_per_revision` 부분 UNIQUE(base_version IS NULL)로 대체한다. 실제 제약명은 PG CI에서 확인한다.
- 최초 AI 생성은 base NULL, 수정/재생성은 직전 최신 version을 base로 둔다. source_revision은 실제 입력 v1을 그대로 승계한다(salt/가짜 입력 변경 금지).
- story_jobs: `base_version integer NULL CHECK(base_version >= 1)`, base가 있으면 kind=manual CHECK. UPDATE grant에는 추가하지 않는다(snapshot 불변).
- manual_once 인덱스는 기존 조건에 base_version IS NULL을 추가한다. `story_jobs_regen_once`는 (user_id,local_date,base_version), base NOT NULL AND state IN ('queued','running','succeeded') 부분 UNIQUE다. one_inflight·일3회·동의/lease/gen/usage 불변.
- down은 기존 0006의 ci+15표 자료0 guard를 먼저 실행한 뒤 인덱스/제약/열을 복구한다. dev에서 down하지 않는다. 이전 source는 BY_REVISION 정렬이 없어 복수 버전 반환이 불명확하므로 장애 시 정렬을 유지한 forward fix 또는 static 복귀한다.

## 2. 서버 exact 계약

- `StoryRef`는 기존4필드에 `edited?: true`만 추가한다. **AI 글에는 이 키를 생략**해 기존 DTO/fixture를 유지한다. origin/base/revision을 브라우저로 보내지 않는다.
- store COLUMNS에 origin/base를 읽고 toRef는 user_edit에만 edited:true를 붙인다. findByRevision은 ORDER BY version DESC LIMIT 1.
- appendStoryVersionTx의 선택 인자 `{baseVersion:number;origin:'ai'|'user_edit'}`: 없으면 기존 replay/append 그대로. 있으면 users lock(active+gen) 뒤 최신 version과 source_revision 일치 확인 후 base+1 INSERT, 불일치 conflict. 기존 rows UPDATE/DELETE 0.
- 신규 `editStoryVersion(db,subject,date,input:unknown)` → Result<{story:StoryRef;unchanged:boolean}, not_signed_in|invalid_date|invalid_body|conflict|busy>. input은 정확 `{expectedVersion,body}`이며 expectedVersion은 양의 safe integer. body는 raw에서 C0/DEL/C1 거부(LF/CR/TAB 허용) 후 trim, 1..2000 codepoint. SQL 전 검증.
- edit: users FOR UPDATE active/gen → 그날 queued/running이면 busy → 최신 version 기대 불일치 conflict → 같은 trim body면 unchanged/INSERT0 → origin=user_edit로 append. 키/외부전송 동의 불필요, 사진/메모를 읽거나 고치지 않는다.
- readStoryDay는 기존 상태·DTO를 유지하고, latest.edited가 true일 때만 story.edited를 복사한다. user_edit도 같은 입력이면 current, 이후 조각 변경이면 outdated.
- requestManualStory opts에 `expectedStoryVersion?:number` 추가. 생략은 기존 그대로, 형식 오류 conflict. 재생성은 최신version==expected && sourceRevision==captureV1을 요구하고 이미 current 검사 대신 queued(base_version) INSERT. outdated이면 기존 일반 생성 사용. 동의/한도/계정/입력 검사 순서 유지. regen_once 고유위반 already_current.
- ClaimedStoryJob에 `baseVersion?:number|null`(기존 mock 호환) 추가. claim base NULL이면 기존 skip, base 있으면 최신 version/revision 확인 후 claim. markSent는 기존 fence에 base 최신 확인도 추가해 바뀌면 input_changed/HTTP0.
- finish는 기존 usage 정산을 먼저 보존하고 base 있을 때 append opts(origin ai)를 전달한다. 최신 변경 conflict는 input_changed로 실패, 기존 글 보존. 신규 error enum/자동재시도/사진 전송/모델 변경 없음.
- actions/story.ts: `saveStoryEditAction(date:unknown,input:unknown)`은 verifiedSubject → edit, 성공 revalidatePath. `requestStoryRegenerationAction(date:unknown,expectedVersion:unknown)`은 verifiedSubject → key → requestManualStory opts → revalidate. 잘못된 날짜/버전·예외는 고정 오류. HTTP origin/계정 검증 생략 금지.
- 페이지 두 곳은 account 모드에서만 위 actions를 bind해 DailyStory의 선택 props로 전달한다. fixture 계정/서버/AI 진입점 0.

## 3. 화면

- 기존 D 아트보드/토큰/64ch·기록 글꼴·본문 pre-wrap 유지. `DailyStory`에 선택 action props를 추가하고 순수 client `StoryControls.tsx`를 붙인다. client가 서버 모듈을 import하지 않는다.
- action prop이 없으면 기존15PNG 렌더/버튼 수 그대로다. 실제 계정에서만 '이야기 수정' 버튼. queued/running이면 수정 진입을 막고 안내한다. 미동의/키 없음이어도 직접 수정은 허용한다.
- 수정: 전체 현재본문이 들어간 라벨 '이야기 내용' textarea에서 일부를 고칠 수 있다. 저장/취소, 저장중 중복 방지. codepoint 수를 사용하고 UTF16 maxLength=2000으로 잘라내지 않는다. 오류/충돌이면 입력 유지, 자동 새로고침/자동초안폐기 0. 충돌 문구는 복사 후 다시 불러오도록 안내한다. 성공 때만 닫고 refresh. 같은 내용은 새 버전 없이 닫는다.
- 직접 수정한 글에는 '직접 다듬은 글이에요' 출처를 표시하고 만든/수정 시각을 구분한다. 원본 조각·사진·하루 한 줄 불변.
- current + 조각 있음 + manual 가능(ready 또는 failed&canRetry)일 때 '다시 만들기'. 확인 단계에서 현재 조각을 AI에 다시 보내며 기존/수정 글은 이력으로 남음을 설명하고 'AI로 다시 만들기'/취소. enqueue 성공 뒤만 refresh, 유료 동작 자동호출0. 하루3회 한도 공유.
- 수정·재생성 실패는 고정 한국어 오류, role=alert. 터치44px·키보드focus·375/768/1440 overflow0. 전체 이력 열람/되돌리기 UI는 이번 범위 밖(DB 보존).

## 4. RED → GREEN 검증

- RED는 신규 `tests/db/story-edits.test.ts`, `tests/e2e-auth/story-edit.spec.ts` + 필요한 기존 마이그레이션/스키마 기대만 개정. 일반 store/generator/worker/기존 계정44+story2 회귀를 약화하지 않는다.
- migration up/down·기존행 보존·CHECK/FK·부분unique·base UPDATE권한 거부·purge CASCADE를 실PG18에서 검증한다. 목록/체크섬 기대는7 추가, 표15 유지. 기존0005·0006 down guards는 당시 스키마만 검사하므로 새열을 요구하지 않는다.
- edit 정상/원문보존/revision current/후속outdated/unchanged·타계정·stalegen·탈퇴·busy·2연결 충돌·입력 validation·실패 draft 보존. HTML은 text로만 표시.
- regen request/claim/markSent/finish 전체 경로를 실PG+mock fetch로 검증(외부HTTP0). 같은 base 중복·일한도·동의철회·입력변경·lease/삭제·usage 정산·current 유지. 재생성 후 수정, 수정 후 재생성의 버전 chain도 확인한다.
- E2E는 기존 fake2env/issuer를 그대로 사용한다. 수정/취소/충돌/폰↔PC/로그아웃 보호와 재생성 확인→실 action queue 확인, 결과만 fixture seed로 종단한다(실 API라고 주장0).
- 기존 story-visual-capture의 순수 소스 복사에 StoryControls도 포함한다(서버 import0·전후hash 검증 유지). 기존 story-generation visuals의 'current 버튼0' 계약은 action prop 없는 legacy 캡처 그대로다. 기존 E2E에서 실제 current 계정의 버튼0 의미 단언은 새 수정/재생성 버튼을 특정해 범위를 갱신한다.
- 새 E2E는 읽기/편집/충돌/재생성확인 × 375/768/1440의 PNG12를 만든다. 기존 visual workflow의 exact PNG12는 유지하고 이번12를 별도 artifact로 추가하는 검사 변경은 메인 검토 후 한다. 불필요한 workflow/보안권한 변경 없음.
- 호스트 npm 설치/앱시험/서버 실행0. 정적 diff/gate/문법만, 유효 RED·GREEN·전체 회귀는 기존 격리 Actions 원문으로 판정한다.

## 5. dev·14일 실제 처리

- RED/검토 GREEN 후 dev 통합·C1 불변 이미지 게시. approved6<latest7일 때 소비자가 SSH 전 거부하는 동안 현재 dev는 계속 제공한다.
- 메인이 실제 이미지의 migration status/up/status로0007만 적용, 승인7 확인 후 같은 publication 소비자를 실행·runtime/HTTPS/cron 검증한다. 자동 시간복귀0, production 변경0.
- 14일은 메인이 이전 보존 proof와 일치하는 단1사용자/현재 story version·동의를 확인해 **제품 requestManualStory 재생성 경로로 단1회** 요청하고 job/usage/새version 성공 및 기존v1 hash 불변을 확인한다. 동의/한도/권한 우회·직접 story INSERT·원문 덮어쓰기0. 코드가 native operator에서 호출되려면 exact source·불변 image의 Node26/조건부 server-only·alias 해석을 검토한 소유 일회 컨테이너를 쓴다(가짜 endpoint/production backdoor0). 개인정보 출력0, 자동재시도0.
- 14일 새 글은 사용자 화면에서 최신 버전으로 보인다. 하위에는 원문/사진/키/DB를 제공하지 않는다.
