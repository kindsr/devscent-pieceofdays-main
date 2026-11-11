# PLAN — 사진+메모 실제 AI 하루 이야기·수동 생성·회고 시각 자동 생성

> 2026-11-11 통합 시 좁은 시험 갱신: 설정에 AI 동의 저장 form이 추가되어 기존 `story.spec.ts`의 `saveReflection`·`reflection.spec.ts`의 `save`가 가정하던 페이지 전체 `저장` 버튼 1개는 성립하지 않는다. 두 selector만 기존 접근 이름 `회고 시간` region 안으로 한정하고 기대값·case·보안 단언을 보존한다. AI 저장 버튼을 숨겨 시험에 맞추지 않으며, 같은 값 재저장도 동의 epoch를 증가시킨다. 그 외 기존 auth44 및 신규 S3 RED15는 동결한다.

- 2026-11-11 사용자 실제 AI 생성/dev 배포 요청에 따른 실행 계획. 기준 4ea611e, planner t1xh 초안을 main t93이 선택·보완했다. 월 한도는 사용자 확보 후 정하는 원문 의미로 적용하고, 비용 추적/중복 방지는 유지한다. dev 전용 MinIO/NAS 백업 연계는 별도 PLAN_dev-minio-story-runtime으로 검증한다.
- **수락된 방향(t93):** 내부 인증 route + native CLI, 기존 Pool·S1 재사용. 일반 사용자의 사진+메모, 회고 설정, 수동 생성까지 연결한다.
- 비용 상한: 최신 사용자 원문은 ‘사용자 확보 후 설정’이며 main이 이를 적용한다. 고정 월 cap은 0이고, 호출 usage·unknown 기록은 필수다. **닫는 조건은 키 null뿐**이다. cap 미설정 때문에 멈추는 기존 관문 문구는 최신 지시에 맞춰 바꾼다(§9).
- S1 제품 동결: `input.pg.ts`·`read.ts`·`generate.ts`·`generator.ts`는 byte 변경 0이다(`getStoryGenerator()` null 계약 유지). `store.pg.ts`는 Tx export만 추가한다. S1 시험은 몰래 깨뜨리지 않는다. 0006 추가로 바뀌는 정당한 기대값(마이그레이션 목록, 15표, 새 checksum)만 별도 RED 작성자가 개정한다(§6).
  `claude-core.mjs`는 함수 추가와 parser 공유만 하며, 기존 `claude-story.test.ts` 28건은 byte 변경 0이다.
- 근거 경로: `scripts/ops/deploy.py:43,52,54,76-105,885`, `app/src/server/db/pool.ts:20`, `stories/*.ts`, `photos/blob-store.ts`, `migrate.ts:23-36`.

## 1. revision 정책 (t93 확정: B)

- `story_versions.source_revision`은 **v1 유지**(S1 `storyRevision`)다. S1 `readStoryDay`·`generateDailyStory`·generator-null 계약과 시험은 그대로이며, readLive wrapper는 만들지 않는다.
- v2(`storyRevisionV2`, 사진 sha 포함)는 `story_jobs.source_revision`에만 저장한다. 용도는 manual unique와 I/O 전후 **late fence**다(I/O 중 사진 SHA 차이 검출).
- 근거: 현재 app은 사진 UPDATE·DELETE 권한이 0이다. 사진은 조각을 새로 만들 때 함께 생기고 조각을 지울 때 함께 지워지므로, 실사용 입력 변화는 v1(id/version)에 반영된다.
- 장래에 사진 부착·교체를 추가하면 story provenance v2로 가는 별도 개정(RED)이 필요하다.

## 2. SQL — `app/migrations/0006_story_generation.up.sql`

```sql
-- 0006_story_generation: AI 이야기 동의·작업·사용량. 기존 표·0005는 변경하지 않는다.
CREATE TABLE pod.story_ai_settings (
  user_id         uuid PRIMARY KEY REFERENCES pod.users (id) ON DELETE CASCADE,
  consent_version  integer NOT NULL CHECK (consent_version >= 1),   -- 정책(고지문) 버전 = 서버 상수
  consent_revision bigint  NOT NULL DEFAULT 1 CHECK (consent_revision >= 1), -- 사용자 동의 epoch: save마다 +1
  manual_enabled  boolean NOT NULL DEFAULT false,
  auto_enabled    boolean NOT NULL DEFAULT false,
  auto_enabled_at timestamptz NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_ai_settings_auto_at CHECK (auto_enabled = (auto_enabled_at IS NOT NULL))
);

CREATE TABLE pod.story_jobs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  local_date      date NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  state           text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  source_revision  text NULL CHECK (source_revision ~ '^[0-9a-f]{64}$'),    -- v2. manual=enqueue 시, scheduled=claim 시(이후 불변)
  auth_generation  bigint  NOT NULL CHECK (auth_generation >= 1),            -- enqueue snapshot(불변)
  consent_version  integer NOT NULL CHECK (consent_version >= 1),            -- enqueue snapshot(불변)
  consent_revision bigint  NOT NULL CHECK (consent_revision >= 1),           -- enqueue snapshot(불변)
  lease_token     uuid NULL,
  lease_until     timestamptz NULL,
  story_id        uuid NULL REFERENCES pod.story_versions (id) ON DELETE SET NULL,
  error           text NULL CHECK (error IN ('no_input', 'input_too_large', 'invalid_input', 'photo_unavailable',
                    'consent_missing', 'not_signed_in', 'input_changed', 'unavailable', 'timeout', 'invalid_output',
                    'lease_expired', 'already_current')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_jobs_lease CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT story_jobs_manual_rev CHECK (kind <> 'manual' OR source_revision IS NOT NULL),
  CONSTRAINT story_jobs_rev_running CHECK (state NOT IN ('running', 'succeeded') OR source_revision IS NOT NULL),
  CONSTRAINT story_jobs_error CHECK ((state IN ('failed', 'skipped')) = (error IS NOT NULL))
);
CREATE UNIQUE INDEX story_jobs_scheduled_once ON pod.story_jobs (user_id, local_date) WHERE kind = 'scheduled';
CREATE UNIQUE INDEX story_jobs_one_inflight   ON pod.story_jobs (user_id) WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX story_jobs_manual_once    ON pod.story_jobs (user_id, local_date, source_revision)
  WHERE kind = 'manual' AND state IN ('queued', 'running', 'succeeded');
CREATE INDEX story_jobs_queue   ON pod.story_jobs (state, created_at);
CREATE INDEX story_jobs_by_day  ON pod.story_jobs (user_id, local_date, created_at DESC);

-- 사용량 원장: 사용자 FK·user_id·본문·요청 범위 기록 0 → purge 뒤에도 남는다.
CREATE TABLE pod.story_usage (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  job_id        uuid NOT NULL UNIQUE,                        -- FK 없음
  usage_month   date NOT NULL CHECK (extract(day FROM usage_month) = 1),   -- 서울 월
  model         text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
  state         text NOT NULL CHECK (state IN ('sent', 'settled', 'unknown', 'not_sent')),
  input_tokens  integer NULL CHECK (input_tokens >= 0),
  output_tokens integer NULL CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz NULL,
  CONSTRAINT story_usage_tokens CHECK ((state = 'settled') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CONSTRAINT story_usage_settled CHECK ((state = 'sent') = (settled_at IS NULL))
);

REVOKE ALL ON pod.story_ai_settings, pod.story_jobs, pod.story_usage FROM PUBLIC;
DO $grant$
DECLARE app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT SELECT, INSERT ON pod.story_ai_settings, pod.story_jobs, pod.story_usage TO %I', app);
  EXECUTE format('GRANT UPDATE (consent_version, consent_revision, manual_enabled, auto_enabled, auto_enabled_at, updated_at) ON pod.story_ai_settings TO %I', app);
  EXECUTE format('GRANT UPDATE (state, source_revision, lease_token, lease_until, story_id, error, updated_at) ON pod.story_jobs TO %I', app);
  EXECUTE format('GRANT UPDATE (state, input_tokens, output_tokens, settled_at) ON pod.story_usage TO %I', app);
END
$grant$;
```
- down(`0006_story_generation.down.sql`): 0005와 같은 DO guard를 쓴다. ci 환경이고 USER_DATA_TABLES 15표가 모두 비었을 때만 DROP한다(usage 포함 3표, 역순).
- `migrate.ts` USER_DATA_TABLES 끝에 `"story_ai_settings", "story_jobs", "story_usage"`를 추가해 15표로 만든다. 시험 쪽 `f2-support.ts`와 migrate 버전 배열 3곳(`[1..6]`)도 맞춘다.
- job의 `auth_generation`·`consent_version`·`consent_revision`은 UPDATE grant에서 제외해 DB 차원에서 불변이다(새 gen·revision으로 덮어써 구제하는 경로 0). `source_revision`은 scheduled의 claim 1회 기록을 위해서만 grant한다(코드에서 NULL일 때만 UPDATE).
- DELETE·TRUNCATE 권한은 0이다. purge(0002)는 변경하지 않는다. users DELETE가 settings·jobs로 CASCADE되고, usage는 보존된다.
- `story_usage.state` 의미:
  - `sent`: 요청을 보냈고 응답 대기 중이다.
  - `settled`: 응답 usage를 실측했다.
  - `unknown`: 보냈지만 usage 없음, timeout·네트워크 오류, lease 만료. **0비용으로 처리하지 않는다.**
  - `not_sent`: 행을 넣은 뒤 송신 전에 거부됐다.
  - 집계: `SELECT usage_month, state, count(*), sum(input_tokens), sum(output_tokens) … GROUP BY 1,2`.

## 3. 공유 타입·DTO — `app/src/shared/stories.ts` (추가만, 기존 export 불변)

```ts
export const STORY_PHOTO_MAX = 30;
export const STORY_PHOTO_SIDE = 512;
export const STORY_PHOTO_MAX_BYTES = 256 * 1024;      // 재인코딩 후 장당
export const STORY_PHOTOS_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
export const STORY_MANUAL_DAILY_MAX = 3;               // 서울 요청일 기준 계정당 수동 enqueue
export const STORY_CONSENT_VERSION = 1;

export type StoryJobFailure = "photo_unavailable" | "input_changed" | "unavailable" | "timeout"
  | "invalid_output" | "lease_expired" | "consent_missing" | "not_signed_in" | "invalid_input" | "input_too_large";
export type StoryGenerationView =
  | { state: "unavailable" }                                         // 키 null/설정 오류
  | { state: "off"; manualEnabled: false; autoEnabled: boolean }     // 수동 미동의
  | { state: "ready"; autoEnabled: boolean }                         // 버튼 가능
  | { state: "queued" | "running"; kind: "manual" | "scheduled" }
  | { state: "failed"; failure: StoryJobFailure; canRetry: boolean } // canRetry = manual 허용·일일 한도 남음
  | { state: "limited" };                                            // 오늘 수동 3회 소진
export type StoryAiSettingsView = { manualEnabled: boolean; autoEnabled: boolean; reflectionTime: string };
export type StoryRequestError = "not_signed_in" | "invalid_date" | "consent_missing" | "unavailable"
  | "no_input" | "input_too_large" | "invalid_input" | "already_current" | "busy" | "limited";
```
- `StoryDay`(S1)는 변경하지 않는다. 화면은 `StoryDay`와 `StoryGenerationView`를 따로 받는다.
- `DailyStory` props에는 선택 항목 `generation?: StoryGenerationView | null`, `requestAction?: …`만 추가한다. 기존 S2 캡처와 시험의 props는 그대로 유효하다.

## 4. 서버 시그니처

### 4.1 `stories/store.pg.ts` — Tx export(같은 core 공유, SQL byte 불변)
```ts
export async function appendStoryVersionTx(tx: Tx, subject: SessionSubject, date: string, revision: string, body: string)
  : Promise<Result<{ story: StoryRef; replayed: boolean }, "not_signed_in">>;   // 기존 본문을 그대로 옮긴 core
export async function appendStoryVersion(db, subject, date, revision, body) {    // 시그니처 불변
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  return withTransaction(db, (tx) => appendStoryVersionTx(tx, subject, date, revision, body));
}
```
`appendStoryVersionTx`도 `isStorySubject`를 먼저 검사한다. FOR UPDATE를 같은 tx 안에서 다시 잡아도 무해하다.

### 4.2 `stories/input-v2.pg.ts` (신규, server-only. v1 모듈 불변)
```ts
export type StoryPhotoRef = { photoId: string; sha256: string; byteLength: number; objectKey: string }; // 서버 전용
export type StoryMomentV2 = { id: string; version: number; time: string; text: string; photo: StoryPhotoRef | null };
export type StoryInputV2 = { date: string; revision: string; revisionV1: string; moments: StoryMomentV2[] }; // revision=v2(job·fence), revisionV1=story_versions 저장·replay
export function storyRevisionV2(date: string, refs: readonly { id: string; version: number; photoSha256: string | null }[]): string;
//  = sha256("v2\n" + date + "\n" + id 오름차순 `${id}:${version}:${sha|"-"}\n`)
export async function captureStoryInputV2(db: Pick<Db, "query">, userId: string, date: string)
  : Promise<Result<StoryInputV2, "invalid_date" | "no_input" | "input_too_large" | "invalid_input">>;
```
- SQL 문 1개: `diary_moments m LEFT JOIN moment_photos p ON p.moment_id = m.id AND p.user_id = m.user_id`(owner fence). `WHERE m.user_id=$1 AND m.local_date=$2 ORDER BY m.occurred_at, m.id LIMIT 31`.
- 시간·본문 규칙은 v1과 같다(30개, 300 codepoint, 제어 문자, JSON 48KiB). `revisionV1`은 v1의 `storyRevision`을 import해 계산한다(공식 중복 0).
- moment_photos 행은 업로드 ready 확정 후에만 존재한다(ready fence). objectKey는 DTO·payload·로그에 0이다.

### 4.3 `stories/vision.ts` (신규, server-only)
```ts
export type StoryVisionPhoto = { mediaType: "image/jpeg"; data: string };       // base64
export async function prepareStoryPhotos(blobs: BlobStore, photos: readonly StoryPhotoRef[], signal: AbortSignal)
  : Promise<Result<StoryVisionPhoto[], "photo_unavailable">>;
```
- 이미 정규화된 원본(≤2560px JPEG, ≤4MiB)을 `blobs.get(objectKey)`로 owner 행 기준으로 읽는다. bytes 길이와 sha256이 DB와 같아야 한다.
- sharp로 `rotate()` 없이(이미 정규화됨) `resize(512,512,{fit:"inside",withoutEnlargement:true}).jpeg({quality:80})` 재인코딩하고 metadata는 0이다.
- 장당 ≤256KiB, 합계 ≤4MiB, 30장 이하. null 결과·불일치·초과·throw·abort 중 **하나라도 나오면 전체가 `photo_unavailable`**이다. 일부 누락은 0이다. 한 번에 1장씩 직렬로 처리한다.

### 4.4 `stories/claude-core.mjs`·`.d.mts`·`claude.ts` (추가 export, 기존 함수·28 시험 불변)
```ts
export type ClaudePhotoMoment = { time: string; text: string; photo: { mediaType: "image/jpeg"; data: string } | null };
export type ClaudeUsage = { inputTokens: number; outputTokens: number };
export type ClaudePhotoStoryResult =
  | { ok: true; value: { body: string; model: string }; sent: true; usage: ClaudeUsage }
  | { ok: false; error: ClaudeStoryError; sent: boolean; usage: ClaudeUsage | null };
export function generateClaudePhotoStory(config: ClaudeConfig | null,
  input: { date: string; moments: ClaudePhotoMoment[] },
  options?: { fetch?: ClaudeFetch; signal?: AbortSignal }): Promise<ClaudePhotoStoryResult>;
```
- 기존 `generateClaudeStory`는 반환 형태 `{ok,value:{body,model,usage}}`와 wire·오류를 **정확히 그대로** 유지한다(28건 byte 0). 공유는 내부 응답 parser(usage를 따로 꺼내는 core)만이다. 기존 함수는 그 결과를 기존 형태로 감싼다.
- 새 함수는 사진이 0장인 메모 날도 같은 함수로 처리한다(worker는 항상 이 함수를 호출한다). 성공과 실패 모두 `sent`와 `usage`를 반환한다.
  - `sent:false`: HTTP 송신 전 guard 실패. config가 null이거나 무효, 입력 검사 실패, 이미 취소된 signal. fetch를 호출하지 않는다.
  - `sent:true`: fetch 시작 이후. timeout·네트워크·비200·형식 오류 포함. usage는 200 JSON에 유효한 usage가 있을 때만 채우고, 없으면 null(원장 unknown)이다.
- 입력: 메모 1..30·각 300 codepoint, 사진 0..30. base64를 복원한 크기로 장당 256KiB·합계 4MiB를 다시 검사한다. 알 수 없는 필드는 거부한다. 텍스트 JSON 48KiB 한도는 사진 bytes를 뺀 자료 기준이다.
- wire: main이 공식 문서를 확인했다(https://platform.claude.com/docs/en/build-with-claude/vision).
  - image block = `{type:"image", source:{type:"base64", media_type:"image/jpeg", data}}`.
  - user content 순서 = [자료 JSON text(사진 자리는 순번), 사진마다 `사진 N (HH:MM)` text + image block]. RED가 정확한 순서와 바이트를 단언한다.
  - system prompt에 ‘사진에 보이는 것만, 추측한 사람·관계·감정은 사실로 쓰지 않음’을 추가한다. model·version·thinking/effort·max_tokens·redirect·no-retry·응답 128KiB cap은 기존 상수를 공유한다.
- deadline: 기존과 같은 내부30_000ms와 외부 signal 중 먼저 오는 쪽을 따른다. 80_000ms는 사진 준비를 포함하는 worker 전체 시한이며 어댑터의 별도80초 시한을 만들지 않는다.
- `claude.ts`는 export 목록에 `generateClaudePhotoStory`와 새 타입만 추가한다.

### 4.5 `stories/settings.pg.ts` (신규)
```ts
export async function getStoryAiSettings(db: Pick<Db, "query">, userId: string): Promise<{ manualEnabled: boolean; autoEnabled: boolean }>;
// 행 없음·consent_version != STORY_CONSENT_VERSION → 둘 다 false
export async function saveStoryAiSettings(db: Db, subject: SessionSubject, input: { manual: boolean; auto: boolean })
  : Promise<Result<{ manualEnabled: boolean; autoEnabled: boolean }, "not_signed_in" | "invalid_input">>;
// tx: users FOR UPDATE(active+gen) → UPSERT consent_version=STORY_CONSENT_VERSION,
//     consent_revision = (INSERT 1 | 기존 + 1)   ← 모든 save마다 증가(켜기·끄기·재동의 모두 epoch 변경)
//     auto_enabled_at = CASE WHEN 새 auto AND NOT 기존 auto THEN now() WHEN 새 auto THEN 기존값 ELSE NULL END
```
- 결과: save 전에 enqueue된 queued/running job은 모두 revision 불일치가 되어 claim·markSent·finish fence에서 거부된다. **재동의해도 옛 job의 송신·저장은 불가능하다.**

회고 시각은 기존 `getReflectionTime`(행 없음 → 20:00)을 그대로 쓴다. 이 계약은 값을 새로 저장하지 않는다.

### 4.6 `stories/jobs.pg.ts` (신규, SQL 전담)
```ts
export async function requestManualStory(db: Db, subject: SessionSubject, date: string, opts?: { now?: () => Date })
  : Promise<Result<{ jobId: string }, StoryRequestError>>;
export async function readStoryGeneration(db: Pick<Db, "query">, userId: string, date: string, keyReady: boolean)
  : Promise<StoryGenerationView>;
export async function expireStoryLeases(db: Db): Promise<number>;
export async function enqueueDueStories(db: Db, opts?: { now?: Date }): Promise<number>;
export type ClaimedStoryJob = { id: string; userId: string; date: string; kind: "manual" | "scheduled";
  leaseToken: string; gen: number; consentVersion: number; consentRevision: number; input: StoryInputV2 };
export async function claimStoryJob(db: Db): Promise<
  | { kind: "none" }
  | { kind: "skipped" | "failed"; jobId: string }
  | { kind: "claimed"; job: ClaimedStoryJob }>;
export async function markStorySent(db: Db, job: ClaimedStoryJob, model: string)
  : Promise<{ ok: true } | { ok: false; error: "not_signed_in" | "consent_missing" | "input_changed" | "lease_expired" }>;
export async function finishStoryJob(db: Db, job: ClaimedStoryJob, outcome:
  | { ok: true; body: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: StoryJobFailure; sent: boolean; usage: { inputTokens: number; outputTokens: number } | null })
  : Promise<"succeeded" | "failed">;
```
- **requestManualStory** (단일 tx):
  1. subject·날짜(미래 거부)를 검사한다.
  2. users FOR UPDATE(active+gen), settings에서 manual_enabled와 consent_version(현재 상수)을 확인한다. 같은 tx에서 `auth_generation`·`consent_version`·`consent_revision`을 읽는다.
  3. `count(*) FROM story_jobs WHERE user_id=$1 AND kind='manual' AND created_at >= 서울오늘0시 AT TIME ZONE 'Asia/Seoul'`가 3 이상이면 `limited`.
  4. `captureStoryInputV2`가 실패하면 그 오류를 반환한다. `findStoryByRevision(revisionV1)`이 있으면 `already_current`.
  5. INSERT queued(revision v2, auth_generation=users 값, consent_version·consent_revision=settings 값). 고유 위반은 one_inflight면 `busy`, manual_once면 `already_current`.
- **readStoryGeneration**: 키가 null이면 unavailable을 반환한다. 아니면 settings와 그날 최신 job 1개, 오늘 수동 횟수를 조회해 판정한다. skipped(no_input/already_current)는 현재 설정에 따른 ready/off로 취급하고 skipped 사유를 실패 DTO로 노출하지 않는다. 쓰기는 0이다.
- **expireStoryLeases**: `UPDATE story_jobs SET state='failed', error='lease_expired', lease_token=NULL, lease_until=NULL WHERE state='running' AND lease_until <= clock_timestamp()`. 같은 tx에서 job → usage 순서로 해당 job_id의 usage `sent`를 `unknown, settled_at=now()`로 바꾼다(users 잠금 0). 재큐잉은 0이다.
- **enqueueDueStories** (문 1개):
```sql
WITH clock AS (SELECT (COALESCE($2::timestamptz, clock_timestamp()) AT TIME ZONE 'Asia/Seoul') AS ts)
INSERT INTO pod.story_jobs (user_id, local_date, kind, state, auth_generation, consent_version, consent_revision)
SELECT s.user_id, (c.ts)::date, 'scheduled', 'queued', u.auth_generation, s.consent_version, s.consent_revision
  FROM pod.story_ai_settings s
  JOIN pod.users u ON u.id = s.user_id AND u.status = 'active'
  LEFT JOIN pod.preferences p ON p.user_id = s.user_id
  CROSS JOIN clock c
 WHERE s.auto_enabled AND s.consent_version = $1
   AND (c.ts)::time >= COALESCE(p.reflection_time, '20:00')::time
   AND s.auto_enabled_at < (((c.ts)::date + COALESCE(p.reflection_time, '20:00')::time) AT TIME ZONE 'Asia/Seoul')
ON CONFLICT DO NOTHING;   -- scheduled_once·one_inflight 모두 흡수(다음 호출에서 같은 날 재평가)
```
- `$2`는 주입한 유효 Date의 ISO 값이며 기본 NULL로 DB 시각을 쓴다. 제품 worker는 인자 없이 호출한다. 잘못된 Date는 SQL 전에 고정 오류로 거부한다. 경계 시험에서 실제 현재 날짜/시각을 가정하지 않는다.
- **claimStoryJob** (단일 tx):
  1. 후보 조회(잠금 없음): `SELECT id, user_id FROM story_jobs WHERE state='queued' ORDER BY created_at, id LIMIT 1`.
  2. **users FOR UPDATE** → settings 조회 → job `SELECT … WHERE id=$1 AND state='queued' FOR UPDATE SKIP LOCKED`. job 행이 없으면 rollback하고 none을 반환한다(다음 호출에서 다시 시도).
     users `status='active' AND auth_generation = job.auth_generation`이 아니면 failed `not_signed_in`.
     settings `consent_version = STORY_CONSENT_VERSION AND consent_revision = job.consent_revision AND 해당 kind enabled`가 아니면 failed `consent_missing`.
     **snapshot 불일치를 새 gen·revision으로 덮어써 구제하지 않는다.**
  3. captureV2가 실패하면 failed/skipped(no_input은 skipped). `findStoryByRevision(revisionV1)`이 있으면 skipped `already_current`(호출 0, usage 0).
  4. manual: capture v2가 enqueue 때 v2와 다르면 failed `input_changed`(덮어쓰기 0, 사용자가 다시 요청). scheduled: `source_revision IS NULL`일 때만 capture v2를 기록한다.
  5. running으로 바꾸고 `lease_token=gen_random_uuid()`, `lease_until=clock_timestamp()+interval '3 minutes'`. snapshot 열은 건드리지 않는다.
- **markStorySent** (사진 I/O 뒤·HTTP 직전, 단일 tx, 순서 users→settings→job→usage):
  1. users FOR UPDATE `active AND auth_generation = job.gen`. 아니면 `not_signed_in`. 행이 없으면(purge) 같은 결과로 처리하고 갱신할 job도 없다.
  2. settings `consent_version 상수·consent_revision = job.consentRevision·해당 kind enabled`. 아니면 `consent_missing`.
  3. job FOR UPDATE `id·lease_token·state='running'·lease_until > clock_timestamp()`. 아니면 `lease_expired`.
  4. 같은 tx에서 `captureStoryInputV2`를 다시 실행한다. 실패하거나 revision(v2)이 job.source_revision과 다르면 `input_changed`.
  5. 통과하면 `INSERT story_usage(job_id, usage_month=date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date, model, state='sent')`.
  6. 거부되면 같은 tx에서 job을 `failed, error`로 바꾸고 lease를 비운다(가능한 경우). usage 행은 0이다.
  - **효과:** 사진 I/O 중 탈퇴·gen 변화·동의 철회/재동의·조각 삭제·lease 만료가 있으면 외부 송신은 0이다.
- **finishStoryJob** (단일 tx, 최종 원자성):
  **잠금 순서는 모든 경로에서 users → settings/job → usage로 통일한다**(usage를 먼저 잡고 users를 잡으면 enqueue·expire와 deadlock 위험).
  1. users FOR UPDATE를 잡고 `active AND auth_generation = job.gen`을 판정한다. 행이 없으면 purge로 본다.
  2. settings에서 `consent_version 상수 AND consent_revision = job.consentRevision AND 해당 kind enabled`를 확인한다. job은 `FOR UPDATE`로 `id AND lease_token AND state='running' AND lease_until > clock_timestamp()`를 확인한다. **lease가 만료되면 state가 running이라도 성공 저장은 0이다.**
  3. usage UPDATE (fence 결과와 무관하게 항상 commit):
     - outcome에 usage가 있으면 `state IN ('sent','unknown')` 행을 `settled`·실측 tokens로 바꾼다. expire가 먼저 unknown으로 바꾼 경우도 포함한다.
     - usage가 없고 `sent:true`면 `sent`를 `unknown`으로 바꾼다.
     - `sent:false`면 `sent`를 `not_sent`로 바꾼다.
  4. fence가 모두 통과하고 성공 outcome이면 같은 tx에서 `captureStoryInputV2`를 다시 실행해 revision(v2)이 다르거나 capture가 실패하면 `input_changed`로 처리한다(**revision late fence**: I/O 동안 원본이 수정·삭제되면 저장 0, 삭제가 확정된 뒤의 글 저장 금지). 같으면 `appendStoryVersionTx(tx, {userId, gen}, date, input.revisionV1, body)`.
  5. job을 `succeeded, story_id`로 바꾸거나 `failed, error`로 바꾼다. lease는 비운다.
  6. user·job 행이 없으면(purge) 익명 usage(settled 또는 unknown)만 commit한다. 이야기는 0이다.

### 4.7 `stories/worker.ts` (신규, server-only)
```ts
export const STORY_JOB_DEADLINE_MS = 80_000;
export async function runOneStoryJob(deps: { db: Db; blobs: BlobStore | null; claude: ClaudeConfig | null;
  fetch?: ClaudeFetch }): Promise<{ expired: number; enqueued: number;
  result: "closed" | "none" | "skipped" | "failed" | "succeeded" }>;
```
처리 순서:
1. `claude === null`이면 `closed`를 반환한다(만료 처리만 하고 enqueue·claim은 0).
2. expire → enqueue → claim **1건**.
3. 80초 signal을 만든다. 사진이 있는데 `blobs === null`이면 `photo_unavailable`, 그 밖에는 `prepareStoryPhotos`. 실패하면 `finish(sent:false)`. usage 행이 아직 없으므로 원장 변화는 0이고 job만 failed가 된다.
4. `markStorySent`(거부면 송신 0으로 끝낸다. job은 그 tx에서 failed) → `generateClaudePhotoStory`(사진 0장인 날도 같은 함수) → 반환된 `sent`·`usage`를 그대로 `finish`에 전달한다.

외부 I/O 중 DB tx는 0이다. 자동 재시도는 0이다.

### 4.8 HTTP·CLI·action
```ts
// app/src/app/internal/story-worker/route.ts
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response>;   // 그 밖의 method는 Next 기본 405 → RED에서 404/405 고정 확인
```
- 다음은 모두 본문 없는 **404**다:
  - env `POD_STORY_WORKER_TOKEN`이 `/^[0-9a-f]{64}$/`가 아님.
  - `authorization`이 `Bearer <64 lowerhex>`가 아님, 또는 `timingSafeEqual(Buffer.from(hex,'hex'))`가 불일치.
  - `forwarded` 헤더가 있거나, `x-forwarded-for|host|proto|port` 중 하나라도 있는데 완전한 loopback tuple이 아님. tuple은 host=`127.0.0.1:3000`, port=`3000`, proto=`http`, for는 `127.0.0.1`·`::1`·`::ffff:127.0.0.1` 중 단일 값이다. 네 필드가 모두 없는 직접 함수 호출도 허용한다. 토큰·Host·본문 검사는 그대로 유지한다.
  - Host가 `127.0.0.1:3000`이 아님.
  - content-length > 0.
- 성공은 200 `{"expired":n,"enqueued":n,"result":"…"}`, 예상 밖 오류는 503 고정이다. cookie·세션 읽기는 0이고, 키·token·userId·원문 오류도 0이다.
- 설정은 `parseClaudeConfig(process.env)`, blob은 기존 `parsePhotoConfig`/`createS3BlobStore` wrapper(설정이 없으면 null), db는 `getAppDb()`를 쓴다.
- `app/src/server/stories/worker-cli.mjs`(native, 의존성 0, 인자 0):
  - token을 lowerhex64로 검사한다.
  - `fetch("http://127.0.0.1:3000/internal/story-worker", {method:"POST", headers:{authorization:`Bearer ${t}`}, redirect:"error", signal:AbortSignal.timeout(100_000)})`.
  - 200이면 stdout에 받은 JSON을 다시 검증한 1줄을 쓰고 exit 0. 나머지는 stderr `story-worker: unavailable`, exit 1. token은 출력 0이다.
- `app/src/app/actions/story.ts`:
  - `saveStorySettingsAction(formData)`와 `requestStoryAction(date)`. 기존 `actions/diary.ts`의 Origin·세션 처리 패턴을 재사용한다.
  - 결과는 고정 한국어 상태와 `revalidatePath`. 수동 생성은 다음 cron 호출(≤1분)에서 실행된다.

### 4.9 worker 결과 표 (명시)

| 단계·사건 | job | story_versions | story_usage |
|---|---|---|---|
| 키 null | 변화 0(closed, enqueue·claim 0) | 0 | 0 |
| claim: 비활성·동의 없음 | failed `not_signed_in`/`consent_missing` | 0 | 0 |
| claim: 입력 없음·같은 v1 이야기 존재 | skipped `no_input`/`already_current` | 0 | 0 |
| 사진 준비 실패(1장이라도) | failed `photo_unavailable` | 0 | 0(송신 전) |
| markSent 거부: gen 변화·탈퇴·동의 철회·재동의(revision 변경)·lease 만료·v2 불일치·조각 삭제 | failed `not_signed_in`/`consent_missing`/`lease_expired`/`input_changed` | 0 | 0(**송신 0**) |
| HTTP 전 guard 실패(sent:false) | failed `invalid_input`/`unavailable` | 0 | not_sent |
| 송신 뒤 timeout·네트워크·usage 없음 | failed `timeout`/`unavailable`/`invalid_output` | 0 | **unknown**, tokens null |
| 200·usage 있음·본문 무효 | failed `invalid_output` | 0 | settled(실측 tokens) |
| 성공 + fence 통과 + v2 재capture 일치 | succeeded, story_id | append(source_revision=v1, 또는 replay) | settled |
| 성공 + 원본 수정·삭제(v2 불일치·capture 실패) | failed `input_changed` | **0**(삭제 확정 후 저장 금지) | settled |
| 성공 + gen 변화·탈퇴·동의 철회/재동의(revision 변경)/정책 버전 변경 | failed `not_signed_in`/`consent_missing` | 0 | settled |
| 성공 + lease 만료(running 문자열만 남음 또는 expire가 이미 failed) | failed `lease_expired`(이미 failed면 유지) | **0** | settled(unknown → settled 보정) |
| 성공 + purge로 user·job 없음 | (행 없음) | 0 | settled(보존) |
| lease 만료(프로세스 중단 등) | failed `lease_expired` | 0 | sent → **unknown** |

자동 재시도는 0이다. 전송 결과가 불명이면 unknown으로 남기고 0비용으로 처리하지 않는다.

### 4.10 비용 계산 (저장 0, 보고 query)
- DB에는 토큰만 저장한다. budget·cap 표는 0이다(월 상한은 사용자 유예).
- 금액은 settled 행에서만 계산한다: `input_tokens × 2 / 1e6 + output_tokens × 10 / 1e6` USD. 단가는 claude-sonnet-5-5 input 2 / output 10 USD per MTok이다(main이 공식 문서를 확인했다. 조회일은 문서에 기록한다). 이미지 토큰은 input_tokens에 포함된다.
- `unknown`·`sent`는 tokens·cost를 **null**로 보고하고 건수만 센다(가짜 0·상한 추측 0). `not_sent`는 비용 대상이 아니다.
```sql
SELECT usage_month, state, count(*) AS calls,
       sum(input_tokens) FILTER (WHERE state = 'settled') AS input_tokens,
       sum(output_tokens) FILTER (WHERE state = 'settled') AS output_tokens,
       CASE WHEN state = 'settled' THEN round((sum(input_tokens) * 2 + sum(output_tokens) * 10)::numeric / 1000000, 6) END AS known_usd
  FROM pod.story_usage GROUP BY usage_month, state ORDER BY 1, 2;
```
- purge 뒤에도 story_usage는 FK·user_id가 0이므로 전역 사용량이 보존된다.

## 5. UI
- `/settings`: 새 `AccountStorySettings.tsx`. 고정 고지(Anthropic Claude API로 그날 메모 원문과 512px 사진 사본 전송, 회수 불가)를 둔다. 체크는 두 개다: ‘직접 만들기 허용’과 ‘회고 시간(현재 HH:MM)에 자동으로 만들기’, **둘 다 기본 꺼짐**. 회고 시각 표시는 기존 설정값을 따른다.
- 날짜 화면 `DailyStory`: ready면 ‘AI 이야기 만들기’ 버튼, queued·running이면 ‘만드는 중이에요’와 새로고침 링크(polling 0)를 둔다. failed는 고정 문구다(사진은 ‘사진을 읽지 못해 만들지 못했어요’). limited는 ‘오늘은 더 만들 수 없어요’, off(미동의)와 unavailable은 **기존 문구 ‘AI 하루 이야기는 아직 준비 중이에요. 남긴 조각은 그대로 저장돼요.’를 그대로** 쓴다. 기존 S2 unavailable 기대는 바꾸지 않는다. off에만 설정 링크를 추가한다.
  - **주의(실제 시험 근거):** `tests/e2e-auth/story.spec.ts:181`이 이야기 영역의 `a[href="/settings"]` 수를 정확히 1로 단언한다. 회고 시간 행에 이미 `/settings` 링크가 있다(`DailyStory.tsx` 마지막 row).
  - 그래서 off 추가 링크는 **`href="/settings#story-ai"`**(설정 화면 AI 영역 id), 이름은 ‘AI 이야기 설정’으로 둔다. 기존 정확 `/settings` 링크 수는 모든 상태에서 1로 유지되며, 기존 :123·:290 button 0 단언도 미동의 상태에서 그대로 유지된다.
- 시각 증거: 상태 수를 무한히 늘리지 않는다. 기존 15 PNG(5상태×3폭)는 byte 재회귀로 확인한다. 새 설정 패널과 생성 패널(ready 버튼·queued·failed)의 필요한 상태만 새 E2E가 3폭으로 capture한다. 아트보드·핸드오프 갱신은 main 문서 소유다.

## 6. 소유 파일

| 담당 | 파일 |
|---|---|
| RED | 신규: `tests/db/story-jobs.test.ts`, `tests/unit/story-vision.test.ts`, `tests/unit/claude-photo-story.test.ts`(정확 wire·usage·sent·크기), `tests/unit/story-worker-route.test.ts`, `tests/unit/story-worker-cli.test.ts`, `tests/e2e-auth/story-generate.spec.ts`. 갱신(정당 기대 변경만, 별도 RED 작성자): `tests/db/migrate.test.ts:312,325,409` `[1..6]`, `tests/db/photo-storage.test.ts:48` 목록에 `[6,"story_generation"]`, `tests/db/stories.test.ts:116`(pairs 기대에 0006 추가), `:286`(snapshot 비교에서 0006의 3표 제외 조건 추가), `:65-66·290·413` `TWELVE`→15표(helper 기준), `tests/db/f2-support.ts` USER_DATA_TABLES 15, 새 checksum 기대; `tests/image-contract.test.mjs`(worker-cli COPY), `tests/front-contract.test.mjs`(`POST /internal/story-worker` → 404). **동결(위 정당 변경 외 byte 0):** `claude-story.test.ts`(28), `stories.test.ts`의 생성·저장·read 사례, `story-view.test.ts`(slice·index 단언이라 변경 불필요), `e2e-auth/story.spec.ts`(story_versions v1 유지로 변경 불필요) |
| GREEN | `migrations/0006_story_generation.{up,down}.sql`, `server/db/migrate.ts`, `shared/stories.ts`, `server/stories/{store.pg,input-v2.pg,vision,settings.pg,jobs.pg,worker,view-data}.ts`, `server/stories/claude-core.{mjs,d.mts}`, `server/stories/claude.ts`, `server/stories/worker-cli.mjs`, `app/internal/story-worker/route.ts`, `app/actions/story.ts`, `app/settings/page.tsx`, `ui/d/{DailyStory,AccountStorySettings}.tsx`, `app/globals.css`, `app/Dockerfile`(COPY 1줄) |
| main | `scripts/ops/deploy.py` APP_ENV_KEYS에 `ANTHROPIC_API_KEY`(visible ASCII 1..4096)·`POD_STORY_WORKER_TOKEN`(lowerhex64) 추가, `tests/test_deploy_app.py`, `app/tests/deploy-env-parity.test.mjs`, 설치본, 비공개 env, cron, 런북·03_OPS·CHANGELOG·PLAN·디자인 문서 |

RED 시나리오 핵심(동의 epoch·snapshot 추가분 우선 명시):
- consent_revision은 save마다 +1(켜기·끄기·같은 값 재저장·철회 후 재동의). job의 gen·consent_version·consent_revision은 enqueue 때 NOT NULL로 저장되고 app UPDATE 권한으로도 바꿀 수 없다(권한 거부 단언). 자동 enqueue SQL도 users gen과 settings revision을 저장한다.
- claim: gen 또는 revision 불일치면 failed이고 새 값으로 구제하지 않는다. 철회 후 재동의해도 옛 queued job은 failed가 된다.
- markSent: 사진 I/O 중(BlobStore mock의 get 안에서 별도 연결로 변경) 탈퇴·gen 증가·동의 철회·재동의·조각 삭제·lease 시계 경과가 있으면 HTTP 0·usage 0·job failed. `lease_until`이 clock_timestamp 경계와 같으면 만료로 본다.
- finish: lease 만료 후 도착한 성공도 story 0, usage는 settled. expire가 먼저 unknown으로 바꾼 행이 settled로 보정된다. 재동의 뒤 옛 job의 완료도 story 0.
- 잠금 순서 users→settings→job→usage: 같은 사용자에 대해 finish·expire·enqueue·requestManual을 동시에 실행해도 deadlock 0(2 Pool 경합).
- enqueue 경계: 19:59/20:00, auto_enabled_at 전후, 서울 자정, preferences 행 없음 → 20:00.
- 자동 하루 1회, 수동은 revision 고유이고 실패 뒤 재요청 가능, 일 3회 → limited.
- 동시 claim: 2 Pool + SKIP LOCKED.
- lease 만료 → failed·usage unknown·재큐 0.
- 다음 fence: gen 변경(탈퇴·복구), 동의 철회·버전, lease 불일치, late revision(메모 수정·조각 삭제), purge 중 완료 → usage만 보존.
- 그 밖: usage 원장 purge 후 존재·DELETE 권한 거부·unknown/not_sent 구분, 사진 30+메모 30 전체·사진 1장 실패 → 전체 실패·owner 아닌 사진 0, 키 null → closed·enqueue 0, route token·헤더 거부.

### 6.1 시험 전략 (t93 추가 계약)

- **금지:** E2E용 가짜 API endpoint, 제품 test mode·backdoor, Claude endpoint/base URL 옵션, 제품 권한 완화. E2E를 실제 API 완전 경로라고 주장하지 않는다.
- **E2E 환경:** 기존 `tests/e2e-auth/global-setup.ts`의 Next spawn env(:181~)에 시험 전용 **가짜 `ANTHROPIC_API_KEY`·`POD_STORY_WORKER_TOKEN`(lowerhex64) 2개만** 추가한다.
  - 같은 파일에 수집 로그(lines) 출력 시 두 값을 redaction하는 처리를 더한다. 이것이 좁은 RED 예외다.
  - 기존 auth 44건·helper·issuer·config는 byte 0이다.
  - 키가 있으므로 `keyReady=true`가 되지만, 기존 모든 계정은 settings 행이 없는 **미동의 상태**다. 그래서 준비 중 문구와 생성 버튼 0이 유지돼 기존 story.spec이 통과해야 한다.
  - E2E 중 worker route·CLI·cron은 실행하지 않는다. 따라서 외부 송신은 0이다.
- **신규 `tests/e2e-auth/story-generate.spec.ts`:**
  1. 실제 메모를 생성한다.
  2. `/settings`에서 고지를 확인하고 ‘직접 만들기 허용’에 **명시 동의**한다(자동은 기본 꺼짐임을 확인).
  3. 날짜 화면 버튼 → server action이 **실제 job 1건을 enqueue**한다. 화면은 queued, DB는 정확히 1행이며 snapshot 열은 NOT NULL이다.
  4. 기존 S2처럼 owner fixture가 그 job을 종단 상태(succeeded + story 행 v1 revision, 또는 failed)로 둔다.
  5. reload해서 이야기·실패 문구를 표시한다.
  6. 다른 계정·로그아웃 격리를 확인한다(버튼·job·이야기 0).
  7. 3폭 capture를 한다.
  - 같은 날 수동 3회 → limited, 동의 철회 → 버튼 0도 함께 확인한다.
- **worker 본체 증명은 DB 통합 시험**(`tests/db/story-jobs.test.ts`)에서 한다. 실제 PG18 app role, 실제 sharp, 실제 v2 capture/모든 SQL(enqueue·claim·markSent·finish·expire), in-memory BlobStore, **mock fetch**를 주입한 `runOneStoryJob`을 쓴다. §6 RED 사례 전체를 다룬다.
- **route 시험**(`tests/unit/story-worker-route.test.ts`): `vi.mock`으로 worker·db 의존을 대체하고 인증 경계만 검사한다(token·헤더·method·body·Host → 404, 성공 stats만, 503 고정).
  - 2026-11-11 공식 [Next16.4.3 source](https://github.com/vercel/next.js/blob/v16.4.3/packages/next/src/server/base-server.ts#L1024-L1037)에서 route 전에 네 `x-forwarded-*` 기본값을 채우는 것을 확인했다. 최초 '존재하면 전부 거부' 계약은 실제 CLI까지 막으므로 위 tuple 양성/잘못된 tuple 음성으로 교정한다. 헤더는 TCP peer 인증이 아니며 실보안 경계는 비밀 token·고정 Host·공개 front 404다. 이 파일만 후속 RED 개정하고 나머지 신규 RED는 동결한다. 실제 Next/CLI 경로는 최종 불변 이미지에서 별도로 확인한다.
- **CLI 시험**(`tests/unit/story-worker-cli.test.ts`): 실제 child process로 CLI를 실행하고, 가짜 loopback HTTP 서버(127.0.0.1, 시험이 연 port)에 **실제 HTTP**로 붙는다. 검사 항목은 Authorization 형식, stdout 1줄, token 미출력, 비200·timeout exit 1이다.
  - CLI 주소는 고정 `127.0.0.1:3000`이다. §11의 `runStoryWorkerCli({env,request,stdout,stderr})`만 export하며 entry는 상수 URL을 사용한다. 시험용 임의 URL env/CLI 옵션은 없고 고정3000포트 부재/선점을 가정하지 않는다.
- **실제 API 완전 경로는 main 전용**이다. 최종 불변 이미지, 실제 MinIO, dev 전용 합성 계정, 합성 사진·메모로 수동 1회·자동 1회를 실행하고, usage settled·PC/폰 읽기·외부 `/internal/story-worker` 404를 확인한다. 실제 사용자 자료는 0이다. Google B5 실로그인은 별도로 검증한다.

## 7. 배포·cron (main)
1. 순서: helper 키 허용 → 0005·0006 migration → 같은 SHA 이미지 → env(키 + token=`openssl rand -hex 32`) → 실제 동의 → cron.
2. cron: `* * * * * flock -n <lock> timeout 110 /usr/bin/docker exec pieceofdays-app-dev node --env-file=/run/secrets/pod_app_env src/server/stories/worker-cli.mjs >> <log> 2>&1`
3. 처리량은 분당 1건이다(호출당 1 job). dev 규모에는 충분하다. 사용자가 늘어 20:00에 몰리면 후속에서 CLI 반복 호출을 검토한다.
4. 정지: cron 줄을 지우거나 env에서 token·키를 제거한다(route 404·closed). 데이터는 보존된다.
5. MinIO 미연결이면 blobs가 null이고, 사진이 있는 날은 전부 `photo_unavailable`이 된다. 이 상태를 사진+메모 완료로 보고하지 않는다.

## 8. 검증
- GitHub 격리 CI로만 검증한다. mock fetch, 실제 sharp, PG18 app role을 쓰고 키·실제 호출은 0이다. 같은 SHA에서 기존 unit335·DB218·auth44·image6/front14/preview10·구조128 회귀를 확인한다.
- dev 실측(main, §6.1 마지막 항목과 같음. 실제 사용자 자료 0, dev 전용 합성 계정):
  - 실제 사진 ≥2장 + 메모로 수동 1회.
  - 회고 시각을 now+2분으로 두고 자동 1회.
  - PC/폰 재조회.
  - usage settled 2행.
  - 동의 철회 뒤 자동 0.
  - 외부 `/internal/story-worker` 404.

## 9. 기존 문서와 바꿔야 할 관문 문구 (main 문서 소유)
- `PLAN_claude-story-adapter.md` §2: ‘공유 저장소 기반 비용/사용 한도’를 → ‘공유 사용량 원장(필수)’으로 바꾼다. 월 cap은 사용자 결정 전까지 미설정이다.
- `PLAN_ai-daily-story-storage.md` 상단·§4: ‘공유 비용 한도·월 상한 답변 대기’를 → 위와 같은 방향으로 바꾼다.
- `app/src/server/stories/generator.ts:3` 주석의 ‘공유 비용 한도’ 문구는 S1 파일이다. 동결 유지 시 문서에만 기록한다(제품 경로는 이 port를 쓰지 않는다).

## 10. 미확인
- MinIO 연결: t1xg와 418ab18 쪽에서 진행 중이다.
- Vision 요청 전체 크기 한도·장수 상한의 공식 수치: main이 읽은 vision 문서에서 RED가 상수로 확인한다.
- 로그아웃이 gen을 바꾸는지: 미확인. 자동 job은 claim snapshot을 쓰므로 영향이 없다.

## 11. main 최종 보완·검증 경계

- 생성 버튼은 입력이 있고 기존 이야기가 none/outdated이며 generation=ready일 때만 둔다. 원본0/current 이야기는 생성 버튼0이다. off는 기존 준비 중 문구와 `/settings#story-ai` 링크로 표시해 기존 단일 `/settings` 회고시간 링크를 보존한다.
- provider의 전체 응답30초·128KiB 제한은 기존과 같다. 전체 worker는 사진 준비를 포함80초, native CLI100초다. 실제 기본 모델은 claude-sonnet-5-5이고 2026-11-11 공식 pricing에서 input2/output10 USD/MTok를 확인했다. 월 한도 미설정은 무과금이 아니며 unknown 호출을0원으로 보고하지 않는다.
- 공식 Vision 문서의 base64 JPEG source를 사용한다(https://platform.claude.com/docs/en/build-with-claude/vision). 30장/장당256KiB/총4MiB binary·최대6MiB JSON은 이 서비스의 더 좁은 입력 한도다. JPEG의 실제 진위/크기/metadata 제거는 Sharp 준비 단계가 검증하고, 어댑터도 canonical base64/decoded byte 한도/알 수 없는 키를 검증한다. 외부 URL·Files 업로드·추가 beta/API헤더·새 provider/key fallback은0이다.
- CLI는 `export async function runStoryWorkerCli({env,request,stdout,stderr}):Promise<0|1>`를 제공한다. request는 fetch 시그니처이며 고정 URL/POST/Bearer/redirect:error/100초 signal을 받는다. 시험은 이를 검사한 뒤 자기 loopback 임의 포트로 fetch하는 transport를 주입해 실HTTP를 확인할 수 있다. child process는 잘못된 token의 HTTP0·고정 stderr/exit1을 검증하면 충분하다. 실제 entry는 process.env/global fetch를 넣고 고정 URL만 사용하며 임의 URL CLI/env옵션은 없다. 모듈 import만으로 실행하지 않고 직접 entry인 경우에만 호출한다. 서비스3000포트 부재/선점을 추측하는 환경 의존 시험은 만들지 않는다.
- main은 디자인 핸드오프와 승인 D 아트보드를 갱신한다. 제품에 가짜성공이나 예시본 원문을 넣지 않는다. 기존15PNG·기존44 E2E는 회귀로 유지하고 새 UI 상태는 추가 E2E에서 검증한다. 설정 링크는 기존 href=/settings 단일 링크 기대를 보존한다.
- 소유에 명시되지 않은 공통 auth/issuer/실행 모드/패키지/lock/workflow/권한은 변경하지 않는다. worker API용 runtime test backdoor는 만들지 않는다. host 앱/DB/브라우저 시험·설치0, 모든 기능 검증은 기존 격리 CI다. main 실서버 검증과 사용자별 명시 동의, 실제 B5를 mock CI로 대신하지 않는다.
- 개인정보 고지는 사진·메모가 Anthropic API로 전송되는 목적/자료와 철회 후 새 호출 중단, 이미 전송된 자료 회수 불가를 사실대로 표시한다. 공급자 보존기간/법률 적합성은 검증 없이 단정하지 않는다. 실제 안내가 필요한 공개 정책 경로는 dev front에서 제공/대조한 뒤 활성화한다.
- 기존 schema 시험 개정은 최신 버전/이름/checksum/15표 기대와 down snapshot에서0006의3표를 제외하는 부분에만 한정한다. `stories.test.ts`의0005 down SQL 자체 guard는 기존12표 그대로 검사하며, 동결된0005 SQL에 새3표를 요구하지 않는다. migrate의3개 버전 배열뿐 아니라 migrate/lifecycle-schema/photo-storage/reflection-time의 정확 버전 목록도6까지 추가한다. 원0001~0005 migration bytes는 불변이다.

