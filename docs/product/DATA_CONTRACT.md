# MVP 데이터 계약 (PostgreSQL 18)

- 상태: **F2 설계·구현 계약.** `0001_init` SQL과 권한·제약을 일회용 PG18 CI에서 검증했다. 실서버 DB·계정은 만들지 않았다. 초기 설계 기준은 `dev` `e5ebd58`이며 [실행 계획·결과](../plans/PLAN_mvp-database.md)에 실제 구현 기준을 기록한다.
- 정본 입력: [00_TECH_STACK_DECISION](00_TECH_STACK_DECISION.md) §3, [03_MVP](03_MVP.md), [PLAN_mvp-foundation](../plans/PLAN_mvp-foundation.md) §3·§5·F2·F3, [DECORATION_MARKET_ARCHITECTURE](DECORATION_MARKET_ARCHITECTURE.md) §3.4·§5·§6. F1 저장 port(작업 브랜치 `claude/nextjs-foundation-mvp-0p73cn` `e5dd64d`의 `app/src/server/diary/store.ts`)는 읽기만 했다.
- 표기: **[계약]** F2 RED 시험이 그대로 검사할 값, **[가정]** 사용자 결정 전의 전제, **[미정]** 결정 필요.
- 인증 공급자는 **Google·카카오 둘 다**로 확정했다(2026-11-03 사용자 선택). 이 현행 스키마 계약은 공급자 중립이며, 이메일·이름·프로필 같은 공급자 개인정보 열을 두지 않는다. 공급자 간 계정 연결은 미정이다.
- 근거 문서: PostgreSQL 18 공식 문서
  - 제약: https://www.postgresql.org/docs/18/ddl-constraints.html
  - 권한: https://www.postgresql.org/docs/18/ddl-priv.html
  - UUID: https://www.postgresql.org/docs/18/functions-uuid.html
  - 잠금: https://www.postgresql.org/docs/18/explicit-locking.html
  - 트리거: https://www.postgresql.org/docs/18/sql-createtrigger.html
  - 격리 수준: https://www.postgresql.org/docs/18/transaction-iso.html
  - 확인일: 2026-11-02, 18.6 문서

## 1. 범위

| 만든다 (F2) | 만들지 않는다 |
|---|---|
| `users`, `auth_identities`, `preferences`, `diary_moments`, `day_summaries`, `design_versions`, `credit_accounts`, `emotion_ledger`, 메타 `pod_meta.*` | 마켓(`design_listings`·`purchases`·`entitlements`), 정산, 사진·에셋 객체 테이블, 공유·AI 테이블, 세션 테이블(미도입) |

## 2. 공통 규칙 [계약]

- 스키마: 앱 객체는 전용 스키마 `pod`에, 마이그레이션 기록은 `pod_meta`에 둔다. `public` 스키마에는 아무것도 만들지 않는다.
- 기본 키: `uuid DEFAULT uuidv7()`. `uuidv7()`은 PostgreSQL 18 함수이며 시간 순서를 가진다.
- 시각: `timestamptz NOT NULL DEFAULT now()`. `now()`는 트랜잭션 시작 시각이다.
- 문자열 길이는 `CHECK (char_length(…) …)`로 제한한다.
- 열거형은 PostgreSQL `ENUM` 대신 `text + CHECK (… IN (…))`을 쓴다. 값을 넓힐 때는 새 migration으로 CHECK를 교체한다.
- 소유자: 사용자 데이터 행은 모두 `user_id`(또는 `owner_id`) `uuid NOT NULL`을 가진다. 앱 SQL은 항상 `WHERE user_id = $sessionUserId`로 조건을 건다(시험 책임은 F3).

## 3. 날짜·시간대 [가정]

- MVP는 단일 시간대 `Asia/Seoul`을 가정한다(foundation 권고값). 사용자별 시간대는 [미정]이며, 결정되면 CHECK를 넓히는 migration을 추가한다.
- `diary_moments.local_date`(`date`)는 **작성 시점에 앱이 정한 하루 칸**이며 권위 값이다. `occurred_at`(`timestamptz`)은 실제 시각이다.
  - 화면의 `HH:MM`(F1 port `DiaryMoment.time`)은 `occurred_at`을 행의 `time_zone`으로 변환해 만든다.
  - `local_date`와 `occurred_at`·`time_zone`의 일치는 DB CHECK로 강제하지 않는다. 시간대 변환 함수의 불변성 가정을 피하기 위해서다. F3에서 시험한다.
- MVP에서 조각의 `occurred_at`·`local_date`는 수정하지 않는다. 본문만 수정한다. 조각을 다른 날로 옮기는 기능은 [미정]이다.

## 4. 테이블 [계약]

### 4.1 `pod.users`

| 열 | 타입·제약 |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` — canonical user_id |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `first_login_at` | `timestamptz NULL` — 첫 성공 로그인 시각(F4에서 기록) |

삭제 정책은 **계정 탈퇴 후 30일 복구 기간 뒤 삭제**로 확정했다(2026-11-03). 현행 스키마에는 이 상태·기한이 없고, 앱 role에는 `DELETE` 권한이 없다. 원장의 `RESTRICT`(§4.8) 때문에 원장이 있는 사용자는 owner 권한으로도 삭제되지 않는다. [계정 수명주기 계획](../plans/PLAN_account-lifecycle.md)에 후속 migration·삭제 경로를 분리하며, 이 문서는 현재 `0001_init`의 실제 제약을 유지한다.

### 4.2 `pod.auth_identities` (공급자 중립)

| 열 | 타입·제약 |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `user_id` | `uuid NOT NULL REFERENCES pod.users(id) ON DELETE CASCADE` |
| `provider` | `text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$')` |
| `subject` | `text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255)` — 공급자가 준 불변 사용자 식별자 |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

- 제약: `UNIQUE (provider, subject)`.
- 인덱스: `(user_id)`. 외래키는 참조하는 쪽 인덱스를 자동으로 만들지 않으므로 직접 만든다.
- 한 사용자에게 공급자 계정을 여러 개 연결하는 정책은 [미정]이다(F4). 스키마는 이를 허용한다.

### 4.3 `pod.preferences`

| 열 | 타입·제약 |
|---|---|
| `user_id` | `uuid PRIMARY KEY REFERENCES pod.users(id) ON DELETE CASCADE` |
| `font_key` | `text NOT NULL DEFAULT 'gothic' CHECK (font_key IN ('gothic','serif','hand'))` — F1 `FONT_KEYS`와 같음 |
| `applied_design_version_id` | `uuid NULL` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

- 제약: `FOREIGN KEY (applied_design_version_id, user_id) REFERENCES pod.design_versions(id, owner_id) ON DELETE SET NULL (applied_design_version_id)`.
  - 이렇게 하면 **본인 버전만 적용**할 수 있다.
  - 버전이 삭제되면 적용 값만 `NULL`이 되어 기본 D로 돌아간다. 열 목록을 붙인 `SET NULL`은 PostgreSQL 공식 문서 예시와 같은 형태다.
- 폰트 허용 목록을 바꿀 때는 F1의 `FONT_KEYS`와 이 CHECK를 같은 PR에서 함께 바꾼다.

### 4.4 `pod.diary_moments`

| 열 | 타입·제약 |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `user_id` | `uuid NOT NULL REFERENCES pod.users(id) ON DELETE CASCADE` |
| `local_date` | `date NOT NULL` |
| `occurred_at` | `timestamptz NOT NULL` |
| `time_zone` | `text NOT NULL DEFAULT 'Asia/Seoul' CHECK (time_zone = 'Asia/Seoul')` [가정] |
| `body` | `text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300 AND btrim(body) <> '')` — D 입력 최대 300자 |
| `version` | `integer NOT NULL DEFAULT 1 CHECK (version >= 1)` |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

- 인덱스: `(user_id, local_date, occurred_at, id)`. 하루 보기와 월 보기 범위 조회에 쓴다.
- F1 port 대응: `DiaryMoment.image`(예시 이미지 키)에 해당하는 열은 **만들지 않는다.** PG 구현은 `null`을 돌려준다. 사진과 예시 이미지 저장은 [미정] (PRD Q1)이다.

### 4.5 `pod.day_summaries`

| 열 | 타입·제약 |
|---|---|
| `user_id` | `uuid NOT NULL REFERENCES pod.users(id) ON DELETE CASCADE` |
| `local_date` | `date NOT NULL` |
| `body` | `text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300 AND btrim(body) <> '')` |
| `version` | `integer NOT NULL DEFAULT 1 CHECK (version >= 1)` |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

- `PRIMARY KEY (user_id, local_date)`로 하루 1개를 보장한다.
- 빈 한 줄은 행이 없는 것으로 표현한다. F1 port의 `summary: ""`가 여기에 해당한다.

### 4.6 낙관적 잠금 계약 (`diary_moments`, `day_summaries`)

```sql
UPDATE pod.diary_moments
   SET body = $body, version = version + 1, updated_at = now()
 WHERE id = $id AND user_id = $uid AND version = $expected
RETURNING version;
```

- 결과가 1행이면 성공이다.
- 결과가 0행이면 같은 `user_id`로 `id`가 있는지 다시 조회한다.
  - 있으면 **충돌**이다.
  - 없으면 **없음**이다. 다른 사용자의 행이거나 삭제된 행이며, 존재 여부를 드러내지 않는다.
- 삭제도 같은 방식이다: `DELETE … WHERE id AND user_id AND version`.

### 4.7 `pod.design_versions` (개인용, 변경 불가)

| 열 | 타입·제약 |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `owner_id` | `uuid NOT NULL REFERENCES pod.users(id) ON DELETE CASCADE` |
| `manifest` | `jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND manifest ? 'schema' AND manifest ? 'base')` |
| `visibility` | `text NOT NULL DEFAULT 'private' CHECK (visibility = 'private')` — MVP |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

- 제약: `UNIQUE (id, owner_id)`. §4.3의 복합 외래키 대상이다.
- 인덱스: `(owner_id, created_at DESC)`.
- manifest의 상세 검증(슬롯·좌표·획 상한·크기)은 앱 스키마 검증이 맡는다. DB는 최소 형태만 막는다.
- 저장할 때마다 새 행을 만든다. `UPDATE`는 없다. 오래된 버전 정리(보관 개수)는 [미정]이며 그때 `DELETE` 권한을 추가한다.

### 4.8 `pod.credit_accounts` / `pod.emotion_ledger` (감정덩어리)

**`credit_accounts`**

| 열 | 타입·제약 |
|---|---|
| `user_id` | `uuid PRIMARY KEY REFERENCES pod.users(id) ON DELETE RESTRICT` |
| `balance` | `integer NOT NULL DEFAULT 0 CHECK (balance >= 0)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

**`emotion_ledger`** (append-only)

| 열 | 타입·제약 |
|---|---|
| `entry_id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `user_id` | `uuid NOT NULL REFERENCES pod.credit_accounts(user_id) ON DELETE RESTRICT` |
| `delta` | `integer NOT NULL CHECK (delta <> 0)` |
| `reason` | `text NOT NULL CHECK (reason IN ('first_login_grant'))` — 구매 등은 후속 migration에서 추가 |
| `grant_key` | `text NOT NULL UNIQUE CHECK (char_length(grant_key) BETWEEN 1 AND 200)` |
| `ref_type` / `ref_id` | `text NULL` / `uuid NULL` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

- 정책 CHECK: `CHECK (reason <> 'first_login_grant' OR (delta = 10 AND grant_key = 'first_login:' || user_id::text AND ref_type IS NULL AND ref_id IS NULL))`.
- 부분 유일 인덱스: `CREATE UNIQUE INDEX … ON pod.emotion_ledger (user_id) WHERE reason = 'first_login_grant'`. `grant_key` 형식과 상관없이 사용자당 1회를 보장한다.
- 인덱스: `(user_id, created_at)`.
- 보호 트리거(심층 방어, owner 포함 모든 role에 적용): `BEFORE UPDATE OR DELETE … FOR EACH ROW`, `BEFORE TRUNCATE … FOR EACH STATEMENT`. 둘 다 `RAISE EXCEPTION 'emotion_ledger is append-only'`(SQLSTATE `P0001`)를 낸다.
- 잔액의 권위는 `SUM(delta)`다. `credit_accounts.balance`는 같은 트랜잭션에서 갱신하는 사본이다. 일치 여부는 F3가 시험한다.
- `ON DELETE RESTRICT`로 원장을 보존한다. 원장이 있는 사용자·계정은 지워지지 않는다. 사용자 삭제가 `CASCADE`로 일기를 지우려 해도 원장 쪽 `RESTRICT`가 전체 삭제를 막는다. 확정된 탈퇴 정책은 별도 migration과 운영 절차로 구현한다([계정 수명주기 계획](../plans/PLAN_account-lifecycle.md)).
- PostgreSQL 18의 부모 `DELETE` RESTRICT 위반은 SQLSTATE `23001`이며, 참조 없는 FK 값의 삽입·갱신 위반 `23503`과 구분해 시험한다.

### 4.9 책임 분리 (F2 / F3 / F4)

| 보장 | F2(스키마·권한) | F3(도메인·PG 구현) | F4(실제 로그인) |
|---|---|---|---|
| 사용자당 첫 지급 1회 | `grant_key UNIQUE`, 부분 유일 인덱스, 정책 CHECK | `INSERT … ON CONFLICT DO NOTHING` 뒤 삽입된 경우에만 잔액 +10, 한 트랜잭션 | 첫 성공 로그인 사건에서 호출, 공급자 계정과 `user_id` 연결 |
| append-only | 앱 role 권한(§5), 보호 트리거 | UPDATE/DELETE 경로 없음 | — |
| 잔액 ≥ 0 | `CHECK (balance >= 0)` | 원장 `SUM`과 사본 일치 | — |
| 다중 로그인 동시성 | 유일 제약(Read Committed에서 `ON CONFLICT DO NOTHING`은 다른 트랜잭션의 삽입 결과에 따라 건너뛴다, 공식 문서) | 병렬 연결로 N회 → 원장 1행·잔액 10 | 콜백 중복·두 기기 E2E |

## 5. role과 권한 [계약]

role 이름은 논리 이름이다. 실제 이름과 비밀번호는 환경별 비공개 런북이 정한다. CI는 아래 가짜 값만 쓴다.

| 논리 role | CI 값 | LOGIN | 권한 |
|---|---|---|---|
| owner | `pod_ci_owner` | 아니오 | `pod`·`pod_meta` 스키마와 모든 객체의 소유자 |
| migrator | `pod_ci_migrator` | 예 | owner의 구성원(`SET ROLE owner`로 DDL 실행). 앱 실행에는 쓰지 않는다 |
| app | `pod_ci_app` | 예 | 아래 표만 가진다. 슈퍼유저·`CREATEROLE`·`CREATEDB`·`BYPASSRLS`는 없다 |

| 객체 | app 권한 |
|---|---|
| DB / 스키마 | `CONNECT` / `USAGE ON SCHEMA pod`. `pod_meta`와 `CREATE` 권한 없음 |
| `users` | `SELECT, INSERT, UPDATE (first_login_at)` |
| `auth_identities` | `SELECT, INSERT` |
| `preferences` | `SELECT, INSERT, UPDATE (font_key, applied_design_version_id, updated_at)` |
| `diary_moments`, `day_summaries` | `SELECT, INSERT, UPDATE, DELETE` |
| `design_versions` | `SELECT, INSERT` |
| `credit_accounts` | `SELECT, INSERT, UPDATE (balance, updated_at)` |
| `emotion_ledger` | **`SELECT, INSERT`만.** `UPDATE`·`DELETE`·`TRUNCATE` 없음 |

- 모든 테이블에 대해 생성 migration 안에서 `REVOKE ALL … FROM PUBLIC`을 실행한다. 공식 문서도 객체를 만드는 트랜잭션 안에서 REVOKE하라고 권한다.
- `TRIGGER`·`REFERENCES` 권한은 app에 주지 않는다.
- 클러스터 단위 role 생성은 migration이 하지 않는다. CI에서는 부트스트랩 SQL이, dev/prod에서는 운영 프로비저닝이 만든다.
- migration은 role 이름을 `pod_meta.db_environment`(§6)에서 읽어 `format('%I')`로 GRANT한다. 그래서 SQL 파일은 환경과 무관하게 같다.

## 6. 메타 테이블 [계약]

| 테이블 | 열 | 만드는 주체 |
|---|---|---|
| `pod_meta.db_environment` | `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`, `name text NOT NULL CHECK (name IN ('ci','dev','prod'))`, `app_role name NOT NULL`, `owner_role name NOT NULL` | CI 부트스트랩 / 운영 프로비저닝(migration 아님) |
| `pod_meta.schema_migrations` | `version integer PRIMARY KEY`, `name text NOT NULL`, `checksum char(64) NOT NULL`(up 파일 SHA-256 hex), `applied_at timestamptz NOT NULL DEFAULT now()`, `applied_by name NOT NULL DEFAULT current_user` | 실행기(runner) |

- 실행기는 `db_environment`가 없으면 시작하지 않는다.
- down은 `name = 'ci'`이고 `pod` 스키마의 사용자 데이터 테이블(§4.1~§4.8)이 모두 비어 있을 때만 허용한다. 빈 CI DB의 리허설 전용이다([PLAN_mvp-database](../plans/PLAN_mvp-database.md) §3).

## 7. 미정

Google·카카오와 계정 탈퇴 후 30일 복구 뒤 삭제는 확정했다. 미정·구현 전 항목은 다중 공급자 연결, 세션 철회·탈퇴 상태·삭제 경로의 후속 migration, 사용자별 시간대, 사진·예시 이미지 저장, 개인 버전 보관 개수, 백업 만료·복원 시 삭제 재적용, 잔액 표시, 감정덩어리의 다른 `reason`과 구매 원장이다.

## 8. 채택한 후속 계약 — 0002 (아직 미구현)

[계정 수명주기 계획](../plans/PLAN_account-lifecycle.md) R6 §9~§13을 독립 검토 후 수락했다(2026-11-03). 위 표는 현재 `0001_init`의 실제 계약을 유지한다. 다음 항목은 아직 SQL·제품·시험에 반영하지 않았다.

| 대상 | 후속 계약 |
|---|---|
| `pod.users` | `status`, `deletion_requested_at`, `purge_after`, `auth_generation` 추가. pending의 두 시각은 모두 필수이며 720시간 차이를 검사한다 |
| `pod_meta.db_environment` | provisioning 소유 `purge_role name NOT NULL`. role 생성·접속·상속 검증은 CI harness와 F6 provisioning이 맡고, 0002는 메타값을 검증한 뒤 제한 GRANT한다(A안) |
| purge 함수 | `list_purge_due(int)`·`purge_user_if_due(uuid)`: PUBLIC 실행권 회수, 전용 role만 실행, 일반 앱은 실행·원장 DELETE 불가 |
| 구현 순서 | L1 schema·role 시험 → 0002 SQL, 이후 L2 도메인·로그인 결과 변경. 실제 OAuth·운영 role·purge 주기·백업 적용은 후속 |

기존 운영 메타데이터의 열 전환과 실제 role 생성은 이 문서로 실행하지 않는다. 시험·권한·down·실패 복귀의 정확한 계약은 위 계획이 정본이다.
