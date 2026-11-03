# MVP 데이터 계약 (PostgreSQL 18)

- 상태: **F2 설계·구현 계약 + F4 L1(`0002_account_lifecycle`) 반영.**
  - `0001_init`은 F2에서 일회용 PG18 CI로 검증한 초기 계약이며, 이후 회귀 기준이다.
  - `0002`는 PR33 코드(`0876c4b`)에서 일회용 PG18 CI(DB 119개)로 검증했다. **독립 SQL 검토와 dev 통합은 아직 진행 중**이다.
  - 실서버 DB·계정·role은 만들지 않았다. 초기 설계 기준은 `dev` `e5ebd58`이며 [실행 계획·결과](../plans/PLAN_mvp-database.md)에 실제 구현 기준을 기록한다.
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
| `status` (0002) | `text NOT NULL DEFAULT 'active'`, `users_status_check`: `status IN ('active','pending_deletion')` |
| `deletion_requested_at` (0002) | `timestamptz NULL` |
| `purge_after` (0002) | `timestamptz NULL` |
| `auth_generation` (0002) | `integer NOT NULL DEFAULT 1`, `users_auth_generation_check`: `>= 1` |

- `users_lifecycle_consistency`(0002): active이면 두 시각이 NULL이다. pending이면 두 시각 모두 NOT NULL이고 `purge_after = deletion_requested_at + interval '720 hours'`다.
- 기존 사용자는 0002 적용 시 active / gen 1 / 시각 NULL이 된다.
- 부분 인덱스 `users_purge_due_idx ON (purge_after) WHERE status='pending_deletion'`(0002).
- 삭제 정책은 **계정 탈퇴 후 30일 복구 기간 뒤 삭제**다(2026-11-03 사용자 확정).
  - 앱 role에는 계속 `DELETE` 권한이 없다.
  - 삭제는 §5.1 purge 함수로만 설계됐다(L1 SQL). 탈퇴·복구를 요청하는 도메인 코드(L2)는 아직 없다.
  - 0001 초기 계약에서는 원장의 `RESTRICT` 때문에 owner로도 원장이 있는 사용자를 삭제할 수 없었다. 이 이력은 §4.8에 남긴다.

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
- 보호 트리거: `BEFORE UPDATE OR DELETE … FOR EACH ROW`, `BEFORE TRUNCATE … FOR EACH STATEMENT`. 거부할 때 `RAISE EXCEPTION 'emotion_ledger is append-only'`(SQLSTATE `P0001`)를 낸다.
  - 0001 초기 계약에서는 owner를 포함한 모든 role의 UPDATE·DELETE·TRUNCATE를 거부했다.
  - **0002 이후:**
    - UPDATE·TRUNCATE는 계속 항상 거부된다.
    - DELETE는 `current_user`가 owner role이고 트랜잭션 GUC `pod.purge_user_id`가 그 행의 `user_id`와 같을 때만 허용된다(중첩 IF).
    - 일반 app은 원장 DELETE 권한 자체가 없어 `42501`이다. 트리거 함수의 PUBLIC 회수도 유지된다.
  - **신뢰 경계:** owner와 그 구성원(migrator)은 GUC를 직접 설정해 이 예외를 쓸 수 있는 신뢰 주체다. 그래서 "purge 함수 안에서만 가능하다"는 보장은 하지 않는다.
- 잔액의 권위는 `SUM(delta)`다. `credit_accounts.balance`는 같은 트랜잭션에서 갱신하는 사본이다. 일치 여부는 F3가 시험한다.
- `ON DELETE RESTRICT`는 0002에서도 그대로다. 사용자 삭제가 `CASCADE`로 일기를 지우려 해도, 원장·계정 행이 남아 있으면 `RESTRICT`가 전체 삭제를 막는다. 그래서 purge 함수(§5.1)는 원장 → 계정 → users 순서로 직접 지운다([계정 수명주기 계획](../plans/PLAN_account-lifecycle.md) §5·§10).
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
| purge (0002) | `pod_ci_purge` | 예 | `USAGE ON SCHEMA pod`와 §5.1 두 함수의 `EXECUTE`만 가진다. 테이블 권한이 없고, owner의 구성원도 구성원 보유자도 아니다 |

| 객체 | app 권한 |
|---|---|
| DB / 스키마 | `CONNECT` / `USAGE ON SCHEMA pod`. `pod_meta`와 `CREATE` 권한 없음 |
| `users` | `SELECT, INSERT, UPDATE (first_login_at)` + 0002 `UPDATE (status, deletion_requested_at, purge_after, auth_generation)`. `id`·`created_at` UPDATE와 DELETE는 없다 |
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
- app은 lifecycle 열을 직접 UPDATE할 수 있다. 시각은 신뢰된 도메인 코드가 DB에서 얻은 값으로만 쓴다(L2). CHECK는 일관성만 보장한다.

### 5.1 purge 함수 (0002, L1)

| 함수 | 계약 |
|---|---|
| `pod.list_purge_due(p_limit integer) RETURNS SETOF uuid` | `p_limit`이 NULL이거나 1~1000 밖이면 `P0001`. `clock_timestamp()`를 한 번 읽은 t로 `status='pending_deletion' AND purge_after <= t`를 `purge_after, id` 순으로 고른다. 잠금은 없다 |
| `pod.purge_user_if_due(p_user uuid) RETURNS text` | NULL이면 `P0001`. users 행 `FOR UPDATE` → 0행이면 `absent` → `clock_timestamp()` t → pending이 아니거나 `purge_after > t`이면 `not_due`. 자격이 있으면 GUC 설정 → `emotion_ledger` → `credit_accounts` → `users` 삭제(나머지 5개 테이블은 CASCADE) → GUC를 `''`로 비움 → `purged`. 실패하면 전체 롤백 |

- 둘 다 owner 소유 `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`이고 객체를 완전 수식한다.
- 같은 migration 트랜잭션 안에서 `REVOKE ALL … FROM PUBLIC`을 실행한다. app은 실행할 수 없다(`42501`).
- 0002는 meta의 `purge_role`이 없거나 NULL이거나 role이 존재하지 않거나 app·owner·migration `session_user`와 같으면 GRANT 없이 실패한다.
- 실행기는 migration 파일마다 별도 트랜잭션이다. 그래서 0002만 롤백되고 0001은 남는다.
- 운영 purge 실행 주기·SLA는 F6이며 아직 없다.

## 6. 메타 테이블 [계약]

| 테이블 | 열 | 만드는 주체 |
|---|---|---|
| `pod_meta.db_environment` | `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`, `name text NOT NULL CHECK (name IN ('ci','dev','prod'))`, `app_role name NOT NULL`, `owner_role name NOT NULL`, `purge_role name NOT NULL`(L1부터) | CI 부트스트랩(`app/tests/db/helpers.ts`가 현재 구현) / 운영 프로비저닝(migration 아님). 기존 운영 meta에 열을 추가하는 순서(nullable → 값 → NOT NULL)는 F6 미실행 절차다 |
| `pod_meta.schema_migrations` | `version integer PRIMARY KEY`, `name text NOT NULL`, `checksum char(64) NOT NULL`(up 파일 SHA-256 hex), `applied_at timestamptz NOT NULL DEFAULT now()`, `applied_by name NOT NULL DEFAULT current_user` | 실행기(runner) |

- 실행기는 `db_environment`가 없으면 시작하지 않는다.
- down은 `name = 'ci'`이고 `pod` 스키마의 사용자 데이터 테이블(§4.1~§4.8)이 모두 비어 있을 때만 허용한다. 빈 CI DB의 리허설 전용이다([PLAN_mvp-database](../plans/PLAN_mvp-database.md) §3).

## 7. 미정

Google·카카오와 계정 탈퇴 후 30일 복구 뒤 삭제는 확정했다. 미정·구현 전 항목은 다중 공급자 연결, 탈퇴·복구·세션 대조 도메인(L2)과 운영 purge 주기, 사용자별 시간대, 사진·예시 이미지 저장, 개인 버전 보관 개수, 백업 만료·복원 시 삭제 재적용, 잔액 표시, 감정덩어리의 다른 `reason`과 구매 원장이다.

## 8. 0002 구현 상태 (L1)

- **L1 schema·role:** PR33 코드 `0876c4b`(RED `a7d8b1f`)에서 구현했다. §4.1·§4.8·§5·§5.1·§6이 반영 내용이다.
- **CI 검증:** app-validation 41679894578, root 41679894597.
  - PG18.6 + Node 26 DB 119(실패·skip 0)
  - Node 24.22.2·26.13.0 각각 단위 122·빌드 경계 4·prod 6·E2E 12·lint·typecheck·build
  - root 42·Compose
- **아직 진행 중:** 독립 SQL 검토와 dev 통합은 아직 끝나지 않았다.
- 이 문서 작성자는 로컬 DB·서버·FullCheck를 실행하지 않았다.
- **L2 미구현:** `requestWithdrawal`·`restoreAccount`·`verifyActiveAccount`, `LoginOutcome` union, 로그인 0행 분기.
- **후속:** 실제 OAuth·DAL 연결·복구 쿠키·UI, 서비스 DB·운영 role provisioning·purge job·백업(F4b/c·F6).
- 정확한 시험·권한·down 계약의 정본은 [계정 수명주기 계획](../plans/PLAN_account-lifecycle.md) §9~§13이다.
