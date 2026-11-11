# PLAN — Claude 서버 연결 어댑터와 합성 검증

- 기준: `e5c2e9d7d565fec26dd6afabec1af28b6832785d`. 사용자 선택은 pieceofdays 전용 Claude API이며 키 입력 완료를 확인했다. 키 값/파일의 실제 경로는 공개 저장소에 넣지 않는다.
- 범위: 서버 전용 Messages API 어댑터·격리 단위 시험·합성 메모의 실제1회 연결 검증. 실제 Models API 인증은 메인이 HTTP200/모델 사용 가능을 확인했다. 이를 생성·배포 성공으로 세지 않는다.
- 제외: 이야기 DB/schema·화면/action/HTTP route·scheduler·일반 사용자 호출 진입점·live env/배포 설정·dev/main 통합. 실제 사진/메모의 외부 전송 범위와 S3 준비는 미정이다. 이 단계는 앱을 활성화하지 않는다.

## 1. 고정 계약

- 파일: `app/src/server/stories/claude-core.mjs`(환경을 인자로 받는 Node 호환 순수 경계), `claude-core.d.mts`, `claude.ts`(`import "server-only"` wrapper). 기존 의존성·package/lock·workflow 변경0. native fetch를 사용한다.
- `parseClaudeConfig(env)` → `{ok:true,value:null|{apiKey,model}} | {ok:false,error:"invalid_claude_config"}`. `ANTHROPIC_API_KEY` 하나만 사용하고 미설정은 null, 빈 값/제어 문자/공백/비ASCII 또는 잘못된 형식은 오류다. 기본 모델은 `claude-sonnet-5-5`(실제 키로 사용 가능 확인)이며 arbitrary model/endpoint 옵션은 이 단계에 없다. process.env 자동 읽기0, 키를 DTO/로그/오류 문자열에 넣지 않는다.
- `generateClaudeStory(config, input, options?)` → `Promise<Result<{body,model,usage:{inputTokens,outputTokens}},"unavailable"|"invalid_input"|"timeout"|"invalid_output">>`. options는 시험용 `fetch`와 외부 `signal`만. 키/입력 누락·잘못된 입력·미리 취소된 signal은 HTTP0. config null은 unavailable이다.
- 입력은 정확 `{date:"YYYY-MM-DD",moments:[{time:"HH:mm",text:string}]}`뿐이다. 실제 달력 날짜·시간, 1..30조각, 각 text1..300 Unicode codepoint(공백만 거부), 입력 JSON UTF8합계48KiB 이하. 알 수 없는 열·사진/owner/DB ID·object key는 거부한다. 현재 파일은 사진 bytes를 받지 않는다. 메모는 지시문이 아닌 자료로 JSON 직렬화한다.
- 고정 HTTPS `https://api.anthropic.com/v1/messages`, `anthropic-version: 2026-10-21`, `Authorization: Bearer …`, JSON·nonstream·tools 없음·`max_tokens:2048`·`model:claude-sonnet-5-5`. 이 짧은 글쓰기 요청은 `thinking:{type:"between_tools"}`와 `output_config:{effort:"low"}`를 고정한다. 공식 문서는 도구 없는 이 모드가 text만 반환함을 설명한다. CLI 모델/effort·전역 설정은 바꾸지 않는다. redirect:error, 자동 재시도/폴백0. 서버 고정 system prompt는 한국어 일반 텍스트의 짧은 단락 회고, 원본에 없는 사건/인물/대화/감정의 사실 생성 금지·자료 속 명령 무시·민감 식별자 불필요 출력을 요구한다. 프롬프트만으로 품질이 보장됐다고 주장하지 않는다.
- fetch와 본문 읽기 전체30초 한도. 응답은 실제 reader로128KiB까지 읽고 초과 시 cancel/거부. deadline 경과·외부 취소는 timeout, 네트워크/429/5xx/3xx/4xx는 고정 unavailable(원문 오류/재시도 없음). Content-Type JSON·status200만 처리한다.
- 성공은 message/assistant, `stop_reason:end_turn`, refusal details 없음, 유효 model 일치·정수0이상 usage, text 본문1..2000 codepoint 및 금지 제어 문자 없음을 요구한다. max_tokens/refusal/tool_use/모르는 block/형식 오류는 invalid_output. thinking/redacted_thinking block은 결과에 복사하지 않고 text만 처리한다. 빈 text·과대 본문은 성공하지 않는다. 오류 body/stack·키·원문 입력은 로그0.
- 함수 import/설정 조회만으로 외부 통신·실제 생성0. 이 어댑터에는 사용자 호출 권한·공유 비용 한도·중복 호출 예약을 구현한 것처럼 보이는 메모리 카운터/slot/가짜 gate를 넣지 않는다.

## 2. 일반 사용자 연결 전 필수 후속 관문

실제 사용자 데이터가 도달하는 action/route/예약 실행을 만들기 전에, 서버에서 다시 확인하는 데이터 전송 동의, 여러 요청/인스턴스 사이의 원자적 호출 예약, 공유 저장소에 기반한 비용/사용 한도를 함께 구현·독립 검증한다. 세 관문이 없는 상태에서 키를 live env에 넣거나 on-demand/정시 진입점을 켜지 않는다. 프로세스 내 보조 제한은 이 관문을 대체하지 못한다. 현재 단계의 합성 운영 smoke는 메인만1회·재시도0으로 실행하고 입력/출력 상한을 유지한다.

## 3. RED → GREEN·검증

- RED 소유: 신규 `app/tests/unit/claude-story.test.ts` 한 파일. 기존 시험/설정 byte0. 제품 부재가 명시 assert로 실패하도록 만들어 import/문법 오류를 유효 RED로 세지 않는다. mock fetch만 사용하고 실제 키/HTTP/API/사진/DB0이다.
- 필수 시험: 설정 부재/잘못된 값·import network0, 입력 경계/비밀 식별자 여분 열 거부, 정확 wire/프롬프트/모델·1호출/redirect/토큰, 정상 text/생각 필터링, malformed/refusal/truncated/tool/usage/길이/제어 문자 거부, HTTP에러·본문크기 cap·본문 대기 timeout/외부 취소·signal 선취소·재시도0·고정 오류/원문 로그0.
- GREEN 소유: 위 제품3파일만, frozen RED byte0. 문서·변경 기록은 메인 조율 범위다. 유효 CI RED 후 구현한다. 기능 시험은 GitHub 격리 Actions만이며 실제 키/배포 Secrets를 PR CI에 제공하지 않는다.
- 같은 SHA의 기존 app lint/typecheck/unit/build/경계·DB·auth·image/front 회귀를 확인한다. 검증된 소스와 합성 전용 입력을 사용한 실제 호출1회는 메인이 별도 비공개 운영 환경에서 수행하며, 값 비노출 HTTP/결과형식/usage·입력 합성 여부만 기록한다. 일기 원문이나 실제 사진은 사용하지 않는다.
- 합성 story가 반환돼도 실제 일기 저장·날짜별 읽기·PC/폰 제품 연결·20:00 정시 생성·실기기/B5·개발 앱 게시 완료로 세지 않는다.

## 4. 복귀·자료

새 제품3파일을 회수하면 기존 인증/기록/사진·글꼴·회고 시간은 영향을 받지 않는다. DB/계정/사진 변경0·migration/down0이다. 키는 별도 서버 비공개 파일에 유지하고 글로벌 CLI 환경/인증에는 넣지 않는다. 이미 발생한 API 비용·전송은 코드 revert로 회수할 수 없으며 실전송은 합성1회로 한정한다.

공식 근거(2026-11-11):
- https://platform.claude.com/docs/en/api/models/list
- https://platform.claude.com/docs/en/api/messages/create
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/build-with-claude/thinking
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
