# PLAN — 계정 탈퇴·30일 복구·삭제 (R5: 구현 계약)

- **상태:** 계획이다. 정책·기술 결정은 §1~§8(R4, dev 통합됨)에 있고, RED 담당용 **구현 계약은 §9~§13(R5)**이다. 코드·SQL·migration·cron·DB·계정 등록은 하지 않았다. 이 문서는 구현 착수나 완료를 뜻하지 않는다.
- **R5 BASE:** `dev` `3832cca94164c2b9c81c21fa58c7ad8d38a23715`(F4a codec `96bcf8c` 포함). 3832cca 통합 CI 결과는 이 문서 작성 시 직접 확인하지 않았다.
- **BASE:** `dev` `76a39d1e65a889a03eb1e5bd64a7e0b3ef161800`.
  - 근거 코드: `app/migrations/0001_init.up.sql`, `app/src/server/account/login.ts`, `app/src/server/credit/first-login-grant.ts`, `app/src/server/db/migrate.ts`.
- **[사용자 확정] 2026-11-03:** "로그인은 둘다 붙이고, 30일 복구 기간 후 삭제"([PRD](../PRD.md) §0).
  - 사용자가 확정한 것은 **Google·Kakao 로그인**과 **탈퇴 뒤 30일 복구 기간이 지나면 삭제**, 이 두 가지뿐이다.
  - 30일은 계정 단위다. 개별 조각 삭제(현재 즉시 DELETE)는 바꾸지 않는다.
- **[메인 기술·UX 결정] 2026-11-03(사용자 원문에 없는 내용):**
  - 탈퇴 요청 즉시 접근을 차단한다.
  - 복구는 명시적인 확인을 거쳐서만 한다. 자동 복구나 자동 재가입은 없다.
  - 세션 철회는 M안(§4)이다.
  - `LoginOutcome`을 판별 union으로 확장한다.
  - purge 함수 권한·시각 기준·복구 쿠키는 §3·§5에 적었다.
- **[미정] 사용자:**
  - 공급자 간 계정 연결. 권고 후보는 로그인 뒤 다른 수단 연결, 대안은 공급자별 별도 계정이다. email 자동 연결과 기록·잔액 병합은 승인되지 않았다.
  - 완전 삭제 뒤 재가입 시 다시 지급하지 않도록 식별자를 보관할지(§5). 사용자에게 묻는 일은 메인이 관리한다.
- 관련 문서: [PLAN_mvp-authentication](PLAN_mvp-authentication.md) §5(세션 계약), [DATA_CONTRACT](../product/DATA_CONTRACT.md)(구현 PR에서 갱신).
- 표기: **[사실]** 코드로 확인 / **[메인]** 메인 기술 결정 / **[미정]** / **[미확인]**

## 1. 현재 스키마 사실 (BASE `0001_init.up.sql`)

| 대상 | 사실 | 영향 |
|---|---|---|
| `pod.users` | 열은 `id`·`created_at`·`first_login_at`뿐이다. app 권한은 `SELECT, INSERT, UPDATE(first_login_at)`이고 DELETE는 없다 | 상태·기한·generation 열이 필요하다 → migration |
| `auth_identities` | users FK `ON DELETE CASCADE`, `UNIQUE(provider, subject)` | 기간 중에는 남아 있어 같은 계정으로 재로그인할 수 있다 |
| `preferences`·`design_versions`·`diary_moments`·`day_summaries` | users FK `ON DELETE CASCADE`(preferences→design_versions는 `SET NULL (applied_design_version_id)`) | users 삭제 시 함께 지워진다 |
| `credit_accounts` | users FK `ON DELETE RESTRICT` | 남아 있으면 users 삭제가 실패한다 |
| `emotion_ledger` | credit_accounts FK `ON DELETE RESTRICT`. 트리거가 owner를 포함한 모든 role의 UPDATE·DELETE·TRUNCATE에 `P0001`을 낸다. 트리거 함수는 `REVOKE ALL … FROM PUBLIC`(선례) | **현재 계약으로는 원장이 있는 사용자를 삭제할 수 없다** → §5 |
| `migrate.ts` `USER_DATA_TABLES` | 8개 테이블 | 열만 추가하므로 목록은 바뀌지 않는다 |
| `completeSuccessfulLogin` | 사용자 상태를 확인하지 않는다 | 탈퇴 중에도 세션이 발급된다 → §3 |

## 2. 상태 모델과 시각 기준 [메인]

```
active ──탈퇴 요청(t)──▶ pending_deletion(purge_after = t + 720h)
   ▲                         │
   └── 복구(t < purge_after, 명시 확인) ┘
pending_deletion ──(t ≥ purge_after)── 복구·로그인·새 가입 거부 ──purge──▶ 행 없음
```

- **기준 시각 t:** users 행 잠금(`SELECT … FOR UPDATE`)을 얻은 **뒤** 같은 트랜잭션에서 `clock_timestamp()`를 **한 번** 읽은 값이다.
  - 탈퇴 요청: `deletion_requested_at = t`, `purge_after = t + interval '720 hours'`(정확히 30×24시간, DST 영향 없음).
  - 복구·로그인·purge의 자격은 모두 t로 판정한다.
  - `now()`(트랜잭션 시작 시각)로 경계를 정하지 않는다. 잠금을 기다리는 동안 기한이 지나면, 기한 전에 시작한 트랜잭션이라도 복구할 수 없다.
- 트랜잭션은 짧게 유지한다. DB·서버 시계는 바꾸지 않는다. 클라이언트 시각은 쓰지 않는다.
- **경계:** `t < purge_after`이면 복구할 수 있다. `t ≥ purge_after`이면 접근·복구를 거부하고 삭제 대상이 된다.
- **즉시 차단 [메인]:** 탈퇴 요청 즉시 모든 세션을 막는다(§4). 기록은 복구를 위해 보존하되 앱 경로에서는 읽거나 쓰지 않는다.
- **멱등:** 이미 `pending_deletion`이면 기한을 유지한다. `active`에서 복구를 요청하면 아무것도 하지 않는다.

## 3. 로그인·복구 연결 (F4b/c) [메인]

**`LoginOutcome` 확장(F3 공개 계약 변경, 기술적으로 수락됨):**

```ts
type LoginOutcome =
  | { kind: "active"; userId: string; gen: number; createdUser: boolean; granted: boolean; balance: number }
  | { kind: "pending_deletion"; userId: string; gen: number; purgeAfter: Date }
  | { kind: "purge_due" };
```

- 기존 identity이면 users 행을 `FOR UPDATE`로 잠그고 t를 읽는다.
  - `pending_deletion`이고 `t < purge_after`이면 **지급을 호출하지 않고 `first_login_at`도 바꾸지 않는다.** 세션도 발급하지 않는다.
  - `t ≥ purge_after`이면 `purge_due`이며, 새 계정을 만들지 않는다.
- `active`만 지금의 흐름(지급 멱등)을 탄다. 같은 행 잠금에서 읽은 `gen`을 반환해 세션을 발급한다.
- **TDD 경로:**
  - lifecycle RED에서 기존 `tests/db/f3-login-grant.test.ts`의 기대값(`toEqual({ userId, createdUser, granted, balance })`)을 `kind:"active"`·`gen`을 포함하는 형태로 **먼저** 고치고, 새 경계 시험을 함께 작성한다(TEST_PATTERNS 경로).
  - 그다음 GREEN에서 제품 코드를 고친다.
  - 기준선 단위 103·DB 99 회귀를 유지한다.
- 다른 공급자 로그인: 같은 user에 연결된 identity면 위와 같다. 연결되지 않은 공급자 identity는 현행 스키마에서 별도 canonical user다. 연결 정책은 [미정]이다.

**복구 확인 쿠키 계약 (F4b/c 범위, F4a 세션 codec과 분리) [메인]:**

| 항목 | 계약 |
|---|---|
| 이름 | `secureCookies`이면 `__Host-pod_recovery`, 개발 http이면 `pod_recovery`. 속성은 세션 쿠키와 같다(HttpOnly·`Path=/`·Lax·Domain 없음) |
| payload | `{ purpose: "account_recovery", v: 1, userId, gen, iat, exp }` **정확히 키 6개**. `gen`은 안전한 양의 정수, 수명은 **10분 이하**. 봉인 시 iron `ttl: 600`을 명시하고 읽기는 자체 `exp`도 검사한다. 기본 TTL이나 `ttl: 0`에 의존하지 않는다 |
| 분리 | 일반 세션 API(`readSession`)로 읽지 않는다. 일반 세션도 복구 API로 읽지 않는다(purpose·키 수가 다르면 `invalid`). F4a에는 복구 쿠키 함수를 넣지 않는다 |
| 복구 POST | Origin 검사(`assertSameOrigin`) → 쿠키 검증 → users 행 잠금 → t → `status='pending_deletion' AND t < purge_after AND auth_generation = 쿠키 gen`일 때만 `status='active'`, 시각 NULL, `auth_generation + 1`. 성공하면 복구 쿠키를 삭제하고 새 `gen`으로 일반 세션을 발급한다 |
| 재사용 차단 | 복구하면 `gen`이 증가하므로, 옛 복구 쿠키로는 "복구 → 재탈퇴" 뒤에 다시 복구할 수 없다 |

## 4. 세션 철회 — M안 채택 [메인]

- **[사실]** S1 봉인 쿠키만으로는 복사된 쿠키를 철회할 수 없다.
- **채택:** `users.auth_generation` + 세션 payload `gen` + DAL이 **매 요청** `SELECT status, auth_generation FROM pod.users WHERE id=$1`로 `status='active' AND auth_generation = gen`을 확인한다.
  - codec은 안전 정수 범위를 허용하고 DB 열은 int4이므로, SQL에서 비교할 때 `auth_generation::bigint = $n::bigint`로 대조한다. int4 범위를 넘는 봉인 값을 raw `22003`으로 흘리지 않고 불일치로 거부하는 회귀를 추가한다.
  - 탈퇴·복구 때 `gen + 1`. 불일치·비활성·행 없음은 "로그인 필요"다.
  - 비용은 요청마다 PK 조회 1회이고, 기기별 개별 로그아웃은 불가능하다.
  - S2(DB 세션)는 미채택 대안이다.
- 세션 codec 계약(키 5개, `sealSession(cfg, { userId, gen })` 등)은 [PLAN_mvp-authentication](PLAN_mvp-authentication.md) §5에 단일 계약으로 있다.

## 5. 삭제(purge) [메인, 구현 전]

**사전 조건 (한 트랜잭션):** users 행 `FOR UPDATE` → t를 읽는다. `status='pending_deletion' AND purge_after <= t`가 아니면 `not_due`로 끝낸다. 행이 없으면 `absent`(성공·멱등).

**순서:**
1. `set_config('pod.purge_user_id', uid, true)`
2. `DELETE FROM pod.emotion_ledger WHERE user_id = uid`
3. `DELETE FROM pod.credit_accounts WHERE user_id = uid`
4. `DELETE FROM pod.users WHERE id = uid`(나머지는 CASCADE)
5. COMMIT. 실패하면 전체 ROLLBACK되고 `pending_deletion`이 남는다. 다음 실행에서 다시 시도한다.

**트리거:** `pod.emotion_ledger_append_only()`를 바꾼다. **DELETE** + `current_setting('pod.purge_user_id', true) = OLD.user_id::text` + `current_user`가 owner role일 때만 허용한다. 그 밖(UPDATE·TRUNCATE 포함)은 `P0001`이다. 일반 app의 원장 DELETE 보호는 유지된다(app에는 DELETE 권한도 없다).

**함수·권한 (P1 필수):**
- `pod.purge_user_if_due(uuid) returns text`와 `pod.list_purge_due(int) returns setof uuid`. 둘 다 owner 소유 `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`이고, 본문은 모든 객체를 `pod.`로 완전 수식한다.
- **같은 migration 트랜잭션 안에서** 생성 직후 두 함수 모두 `REVOKE ALL ON FUNCTION … FROM PUBLIC`.
  - [사실] 새 함수의 EXECUTE는 기본으로 PUBLIC에 부여되고, app은 `USAGE ON SCHEMA pod`를 가진다. 그래서 회수하지 않으면 app이 호출할 수 있다.
- app에는 EXECUTE를 주지 않는다. 전용 purge role에만 `GRANT USAGE ON SCHEMA pod`와 두 함수의 `GRANT EXECUTE`를 준다. purge role에는 테이블 권한이 없다.
- 신뢰 경계: owner와 그 구성원(migrator)은 트리거를 끄거나 함수를 바꿀 수 있는 신뢰 주체다. 이 설계는 그 수준을 넘는 보장을 하지 않는다.

**동시성:** 복구와 purge는 같은 users 행 잠금으로 직렬화되고, 각자 잠금을 얻은 뒤의 t로 판정한다. purge를 중복 실행하면 `absent`가 된다.

**due 이후 공백:**
- 기한이 지났지만 purge가 아직 돌지 않은 동안에는 그 identity로 복구·로그인·새 가입이 모두 거부된다.
- purge 주기, 실패 재시도, 최대 대기 SLA는 **F6 출시 선행 조건**이며 아직 정하지 않았다(값을 만들어 넣지 않음). 실행 주기도 설치되지 않았다.

**보관 정책:**
- 무료 MVP 감정덩어리에 대해 법정·무기한 원장 보관을 만들지 않는다. 원장도 함께 삭제한다.
- [사실·기술 결과] 완전 삭제 뒤 같은 공급자 계정으로 로그인하면 새 canonical user가 되어 첫 10개를 다시 받는다.
- 이를 막을 식별자 보관 여부는 **사용자 [미정]**이다(질문은 메인이 관리).

**백업:** 백업에서 즉시 물리 삭제된다고 약속하지 않는다. 백업 만료와 복원 시 삭제 재적용 절차는 F6 운영 선행 조건(미설정)이다.

## 6. migration 초안 `0002_account_lifecycle` [메인]

- `pod.users`에 추가할 열:
  - `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_deletion'))`
  - `deletion_requested_at timestamptz NULL`
  - `purge_after timestamptz NULL`
  - `auth_generation integer NOT NULL DEFAULT 1 CHECK (auth_generation >= 1)`
  - 일관성 CHECK: active이면 두 시각 모두 NULL, pending이면 둘 다 NOT NULL이고 `purge_after = deletion_requested_at + interval '720 hours'`.
  - `timestamptz + interval`은 STABLE이라 CHECK에는 쓸 수 있지만 생성 열이나 인덱스 식으로 옮길 수는 없다. 그래서 CHECK에만 둔다.
- 부분 인덱스: `(purge_after) WHERE status='pending_deletion'`.
- app 권한 추가: `UPDATE (status, deletion_requested_at, purge_after, auth_generation)`. DELETE는 주지 않는다.
- **신뢰 경계:**
  - 이 열들은 신뢰된 app 도메인 경로가 DB에서 얻은 t로만 쓴다.
  - 탈퇴·복구용 SECURITY DEFINER 함수는 지금 추가하지 않는다.
  - DB CHECK는 상태와 기간의 일관성만 지킨다. 악성 app이 과거 시각을 직접 쓰는 것까지는 보장하지 않는다.
- 트리거 함수 교체, purge 함수 2개와 §5의 REVOKE/GRANT. role 생성은 CI 부트스트랩과 운영 프로비저닝이 한다(F2 관례).
- down은 빈 CI DB에서만 한다. 영향 범위: DATA_CONTRACT §4~§6, `privileges`·`constraints`·`migrate` 회귀.

## 7. 시험 수용 기준 [메인]

실제 PG18 일회용 DB를 쓴다. app role, purge role, owner(시험 하네스) 각각으로 접속한다.

1. **즉시 차단:** 탈퇴 뒤 이전 `gen` 세션은 DAL에서 "로그인 필요"다. Google·Kakao 각각의 연결 identity로 로그인해도 `pending_deletion`이 되고 세션은 없다.
2. **경계:** `purge_after − 1초`에는 복구가 성공하고, 그 시각 이후에는 복구·로그인을 거부(`purge_due`)한다.
3. **잠금 대기 경계:** 기한 전에 트랜잭션을 시작한 복구가 행 잠금을 기다리는 동안 기한이 지나면, 잠금을 얻은 뒤의 t로 판정해 **거부**한다.
4. **복구:** 같은 userId, 잔액·원장 그대로, `granted=false`, `gen + 1`, 복구 쿠키 삭제. 이전 세션 쿠키는 거부되고 새 세션만 통과한다.
5. **복구 쿠키:** 일반 세션으로 복구할 수 없다. 복구 쿠키로 일반 세션을 대신할 수 없다. 10분이 지나면 거부한다. "복구 → 재탈퇴" 뒤 옛 복구 쿠키로는 복구할 수 없다(`gen` 불일치). Origin 누락·불일치는 거부한다.
6. **탈퇴 중 지급 우회 불가:** 원장 행 수·잔액·`first_login_at`이 변하지 않는다.
7. **purge:** 기한 전 `not_due`, 기한 뒤 모든 종속 행 0행, 재실행하면 `absent`. 실패를 주입하면 전체 롤백 → 다음 실행에서 성공.
8. **권한:**
   - app이 `pod.purge_user_if_due`·`pod.list_purge_due`를 호출하면 **둘 다 `42501`**이다.
   - purge role은 두 함수를 정상 실행하고, `pod.users`·`pod.emotion_ledger` 직접 접근은 `42501`이다.
   - app의 원장 UPDATE·DELETE는 `42501`, owner가 GUC 없이 DELETE하면 `P0001`이다.
9. **동시성:** 복구와 purge를 동시에 실행하면 하나만 효과가 있고 부분 삭제는 없다. purge를 2개 동시에 실행해도 한 번만 삭제된다.
10. **F3 회귀:** 수정된 `f3-login-grant` 기대값으로 기존 지급 멱등·동시성 사례가 통과하고, 단위 103·DB 99 기준선을 유지한다.
11. **purge 뒤 재로그인:** 새 user가 만들어지고 새로 지급된다(현행 기술 결과, 정책은 미정).

## 8. 의존·순서·롤백

- 순서:
  1. 이 계획과 auth §5의 수락
  2. F4a codec(키 5개)
  3. L1 schema·role slice → L2 도메인·로그인 slice(§13)
  4. F4b/c OAuth·HTTP·복구 쿠키·화면
  5. F6 purge 주기·SLA·백업 규칙, 운영 provisioning(§11)
- 롤백:
  - 앱을 되돌리면 경로가 꺼진다. 열은 expand 상태로 둔다.
  - `pending_deletion` 행이 있으면 down하지 않는다(F2 가드).
  - 이미 purge된 데이터는 백업 절차 없이는 복원할 수 없다.
- 미확인: 구현·시험(미실행), 운영 시계·시간대, 백업 도구·보존 기간.

## 9. 구현 계약 — 도메인 API (R5, L2 slice)

**파일:** `app/src/server/account/lifecycle.ts`(신규, `import "server-only"`), `app/src/server/account/login.ts`(변경). 기존 `Db`·`withTransaction`·`Result`·`isUuid`만 쓰고, 새 프레임워크나 저장 추상화는 만들지 않는다.

```ts
export type SessionSubject = { userId: string; gen: number };   // 검증된 세션 또는 복구 증명에서만 온다

// 매 요청 DAL 진입 검사(잠금 없음, 한 SELECT)
export function verifyActiveAccount(db: Db, s: SessionSubject): Promise<boolean>;
// 탈퇴 요청: 검증된 일반 세션의 subject로만 호출
export function requestWithdrawal(db: Db, s: SessionSubject):
  Promise<Result<{ purgeAfter: Date; gen: number; changed: boolean }, "not_found" | "stale_session">>;
// 복구: 검증된 복구 쿠키(F4b/c)의 subject로만 호출
export function restoreAccount(db: Db, proof: SessionSubject):
  Promise<Result<{ gen: number }, "not_found" | "not_pending" | "stale_proof" | "expired">>;
```

- **호출 경계:** userId·gen은 F4a `readSession`이나 F4b/c 복구 쿠키 검증 결과에서만 받는다. HTTP 입력의 userId를 신뢰하는 경로는 없다. 일반 F3 저장 함수(diary·decoration·preferences·balance)의 시그니처는 바꾸지 않는다. 활성 검사는 F4b/c DAL이 `verifyActiveAccount`를 한 번 호출하는 것으로 한다.
- **공통 입력 검사(SQL 전):** `isUuid(userId)`가 아니거나 `!(Number.isSafeInteger(gen) && gen > 0)`이면 → `verifyActiveAccount`는 `false`, 나머지 둘은 `not_found`.
- **gen 비교:** SQL에서는 항상 `auth_generation::bigint = $2::bigint`. int4 범위를 넘는 안전 정수는 오류(22003) 없이 불일치가 된다.

| 함수 | 처리(한 트랜잭션, Read Committed) | 결과 |
|---|---|---|
| `verifyActiveAccount` | `SELECT 1 FROM pod.users WHERE id=$1::uuid AND status='active' AND auth_generation::bigint=$2::bigint` | 행이 있으면 `true`. 그 밖(없음·pending·gen 불일치)은 `false` |
| `requestWithdrawal` | ① `SELECT status, auth_generation, purge_after … FOR UPDATE` ② `t := clock_timestamp()` 한 번 | 행 없음 → `not_found`. `active`이고 gen이 다름 → `stale_session`(변화 없음). `active`이고 gen이 같음 → `status='pending_deletion'`, `deletion_requested_at=t`, `purge_after=t+'720 hours'`, `gen+1` → `ok{changed:true}`. 이미 `pending_deletion` → **변화 없이** `ok{purgeAfter(기존), gen(현재), changed:false}`(기한 연장·gen 중복 증가 없음) |
| `restoreAccount` | ① 행 잠금 ② `t := clock_timestamp()` | 행 없음 → `not_found`. `active` → `not_pending`(변화 없음). `pending_deletion`이고 `t ≥ purge_after` → `expired`. `pending_deletion`이고 gen이 다름 → `stale_proof`. 그 밖 → `status='active'`, 두 시각 NULL, `gen+1` → `ok{gen}` |

- 판정 순서는 표의 순서로 고정한다. 복구는 기한 검사가 gen 검사보다 먼저다.
- **복구는 `grantFirstLogin`을 호출하지 않는다.** 잔액·원장·`first_login_at`은 그대로다.

**`completeSuccessfulLogin` 변경**(F3 공개 계약과 대조):

| 항목 | 현재(F3) | 변경 |
|---|---|---|
| 서명 | `(db, identity) → Result<LoginOutcome, "invalid_identity">` | 같다 |
| 성공 값 | `{ userId, createdUser, granted, balance }` | §3의 union. `active`는 잠금 안에서 읽은 `gen`을 포함한다 |
| 신규 identity | users INSERT → identity INSERT(경합에서 지면 ROLLBACK 후 1회 재시도) → grant | 같다. `INSERT … RETURNING id, auth_generation`(=1) → `kind:"active"` |
| 기존 identity | grant → `first_login_at` | **users `FOR UPDATE` → t** → `active`면 grant → `first_login_at` / `pending_deletion`이고 `t < purge_after`면 `pending_deletion`(grant·`first_login_at` 변경 없음) / `t ≥ purge_after`면 `purge_due` |

- **잠금 순서(고정):** users 행 → credit_accounts 행(`grantFirstLogin` 내부). 탈퇴·복구·purge도 users 행을 먼저 잠근다. 그래서 교착 순서가 생기지 않는다.
  - [사실] app은 `UPDATE(first_login_at)`을 가지므로 users `FOR UPDATE`가 가능하다.
- **동시성 결과:**
  - 로그인 대 탈퇴: 행 잠금으로 직렬화된다. 로그인이 먼저 커밋되면 `active` 세션(옛 gen)이 발급되지만, 다음 요청의 DAL에서 거부된다.
  - 복구 대 purge: 하나만 효과가 있다(각자 잠금 뒤의 t).
  - 탈퇴 2건 동시: 하나만 `changed:true`다.
- **"즉시 차단"의 범위:** 탈퇴가 커밋된 **뒤 시작하는 요청**의 DAL 검사가 거부한다. 이미 검사를 통과해 진행 중인 요청을 자동으로 취소하지는 않는다. 그 이상의 직렬화(쓰기마다 users 잠금 등)는 도입하지 않는다(메인 결정이 있으면 별도로 한다).

## 10. migration `0002_account_lifecycle` 파일 계약 (L1 slice)

**`app/migrations/0002_account_lifecycle.up.sql`** (실행기가 BEGIN·advisory lock·`SET LOCAL ROLE owner` 안에서 실행)
1. `ALTER TABLE pod.users ADD COLUMN`: `status`, `deletion_requested_at`, `purge_after`, `auth_generation`(§6 정의).
   - CHECK 이름: `users_status_check`, `users_auth_generation_check`, `users_lifecycle_consistency`
   - 일관성 CHECK 식: `(status='active' AND deletion_requested_at IS NULL AND purge_after IS NULL) OR (status='pending_deletion' AND deletion_requested_at IS NOT NULL AND purge_after = deletion_requested_at + interval '720 hours')`
2. `CREATE INDEX users_purge_due_idx ON pod.users (purge_after) WHERE status = 'pending_deletion'`.
3. app GRANT: `UPDATE (status, deletion_requested_at, purge_after, auth_generation) ON pod.users`(기존 DO 블록 방식, `format('%I')`). DELETE는 주지 않는다.
4. `CREATE OR REPLACE FUNCTION pod.emotion_ledger_append_only()`: `TG_OP='DELETE' AND current_setting('pod.purge_user_id', true) = OLD.user_id::text AND current_user = (SELECT owner_role FROM pod_meta.db_environment)`일 때만 `RETURN OLD`. 그 밖은 기존과 같은 `RAISE EXCEPTION 'emotion_ledger is append-only'`. 기존 두 트리거(행 UPDATE/DELETE, 문장 TRUNCATE)는 그대로 두고, TRUNCATE·UPDATE는 항상 거부된다.
5. `CREATE FUNCTION pod.list_purge_due(p_limit int) RETURNS SETOF uuid`
   - `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp`
   - `p_limit`이 1~1000 밖이면 RAISE(상한은 [추천] 기술값)
   - 본문: `SELECT id FROM pod.users WHERE status='pending_deletion' AND purge_after <= clock_timestamp() ORDER BY purge_after, id LIMIT p_limit`
6. `CREATE FUNCTION pod.purge_user_if_due(p_user uuid) RETURNS text`(같은 속성)
   - 반환 `'absent' | 'not_due' | 'purged'`. 본문은 §5 순서(행 잠금 → t → 조건 → GUC → 원장 → 계정 → users)다. 모든 객체를 `pod.`로 완전 수식한다.
7. **같은 파일(같은 트랜잭션)에서** 두 함수 모두 `REVOKE ALL ON FUNCTION … FROM PUBLIC`.
8. purge role GRANT(§11 추천안 A): `GRANT USAGE ON SCHEMA pod`, 두 함수 `GRANT EXECUTE`. 테이블 권한은 주지 않는다.

**`0002_account_lifecycle.down.sql`** (빈 CI DB 전용)
- 첫 문장: 0001 down과 같은 `DO $guard$`(`name='ci'` + 8개 테이블 무데이터)
- 이후 순서: purge role의 `REVOKE EXECUTE`·`USAGE` → `DROP FUNCTION` 두 개 → 트리거 함수를 0001 본문으로 `CREATE OR REPLACE`(이후 `REVOKE ALL … FROM PUBLIC` 유지) → app 열 UPDATE 권한 `REVOKE` → `DROP INDEX` → CHECK·열 `DROP`
- meta 열(`purge_role`)은 provisioning 소유이므로 지우지 않는다.

**sql-policy:**
- [사실] 현재 validator는 최상위 트랜잭션 제어·VACUUM·`CREATE DATABASE`·`CONCURRENTLY`·`ALTER SYSTEM`·`BEGIN ATOMIC`만 막는다. 달러 인용 PL/pgSQL `CREATE FUNCTION … SECURITY DEFINER`·`DO` 블록은 허용된다.
- 그래서 **validator 변경은 필요 없다.** `SECURITY DEFINER`의 `search_path` 고정은 정책 규칙이 아니라 DB 시험(카탈로그 `prosecdef`·`proconfig` 확인)으로 보장한다.

## 11. purge role 이름·GRANT 경로 — 비교와 추천

[사실] `pod_meta.db_environment`에는 `name, app_role, owner_role`만 있다.
- CI에서는 `tests/db/helpers.ts`가 role(`pod_ci_owner/migrator/app`)을 만들고 DB마다 meta 행을 넣는다. 운영에서는 provisioning이 넣는다.
- migrator에는 `CREATEROLE`이 없으므로 **migration이 role을 만들 수 없다.**
- `readEnvironment`와 `environment.test`는 열 이름을 명시해 SELECT하므로, meta 열이 늘어도 기존 코드·시험이 깨지지 않는다.

| 안 | 내용 | 변경 파일 | 장점 | 단점 |
|---|---|---|---|---|
| **A [추천]** meta 열 확장 + migration GRANT | provisioning이 `db_environment.purge_role name NOT NULL`과 role을 준비한다. 0002가 DO 블록에서 읽어 `format('%I')`로 GRANT하고, 열이 없거나 NULL이면 RAISE(fail closed) | `tests/db/helpers.ts`(role `pod_ci_purge` LOGIN·무구성원, `ROLE_SPECS`·`membershipProblems`, meta 열·값, DB CONNECT), 0002 up/down, DATA_CONTRACT §5·§6(메인 동기화), 운영 런북(F6) | 권한이 migration 이력과 체크섬 안에 있다. app_role과 같은 기존 패턴이고 down으로 대칭 회수된다 | 운영 provisioning 계약이 한 열 늘어난다 |
| B provisioning이 migration 뒤 GRANT | 0002는 PUBLIC 회수만 하고, owner 권한 step이 따로 GRANT한다 | helpers.ts(post-up GRANT step), 런북 | migration이 role을 몰라도 된다 | 권한이 migration 밖에 있어 drift·누락 위험이 있고, `lazyMigrated` 뒤 별도 단계가 필요하며 down이 대칭이 아니다 |
| (불가) migration이 role 생성 | — | — | — | migrator에 CREATEROLE이 없다(F2 계약) |

- **실패 정리:**
  - A에서 role이나 열이 없으면 0002가 롤백되고 기록 행도 남지 않는다.
  - 하네스는 기존 규칙대로 role을 "없으면 만들고, 있으면 속성만 확인(다르면 중단, 비밀번호 덮어쓰기 금지)"한다. 이번 실행이 만든 DB만 삭제하고, role은 지우지 않는다(기존 관례).
- **운영 경계(F6):** 실제 dev/prod purge role 생성·비밀번호·접속 경로·실행 주기는 비공개 런북이 정한다. 이 추천은 메인 기술 검토 대상이며, 사용자에게 인프라 권한을 새로 승인받은 것이 아니다.

## 12. 시험·runner 소유 (`.claude/tdd.conf` TEST_PATTERNS)

[사실] `TEST_PATTERNS="tests/* .claude/tdd.conf app/tests/* app/vitest*.ts app/playwright*.ts"`. `server-only`는 `app/vitest*.ts`의 no-op alias로 해석되고, migration CLI 경로(`migrate-cli.ts`·`migrate.ts`·`sql-policy.ts`)에는 marker가 없다(유지).

| 단계 | 소유 경로 | 내용 |
|---|---|---|
| RED | `app/tests/db/helpers.ts`, `app/tests/db/f2-support.ts`(필요한 helper만), `app/tests/db/environment.test.ts`, `app/tests/db/migrate.test.ts`, `app/tests/db/privileges.test.ts`, 신규 `app/tests/db/lifecycle-schema.test.ts`(L1), `app/tests/db/f3-login-grant.test.ts`, 신규 `app/tests/db/lifecycle.test.ts`(L2) | harness role·meta 열, 기대값 변경, 새 시험. 새 제품 모듈은 각 `it` 안에서 동적 import한다 |
| GREEN | `app/migrations/0002_account_lifecycle.{up,down}.sql`(L1), `app/src/server/account/lifecycle.ts`·`login.ts`(L2) | RED 파일 수정 0 |
| 변경 없음 | `sql-policy.ts`, `migrate.ts`, `.github/workflows/app-validation.yml` | CI는 기존 `npm run test:db` + global-setup의 role 부트스트랩으로 실행된다 |

- **RED에서 고칠 기존 기대값:**
  - `migrate.test` "up on an empty DB applies 0001"의 기록 행이 `[(1,'init',…), (2,'account_lifecycle',…)]`이 된다. pod 테이블 목록은 8개 그대로다.
  - `f3-login-grant`의 `toEqual({ userId, createdUser, granted, balance })` 같은 정확 일치는 `{ kind: "active", userId, gen: 1, createdUser, granted, balance }`로 바뀐다(`toMatchObject` 사례는 `kind`만 추가).
  - `environment.test`: purge role 속성과 meta `purge_role` 값.
- **실제 PG18 시험**(일회용 DB, app·purge·owner 접속, mock 최소화):
  - **L1** `lifecycle-schema.test.ts`:
    - CHECK 위반(23514)
    - app 열 UPDATE 허용 / users DELETE 42501
    - app이 두 함수 호출 시 **42501**
    - purge role 함수 실행 OK / purge role의 `pod.users`·`emotion_ledger` 직접 SELECT·DELETE 42501
    - 카탈로그 `prosecdef=true`·`proconfig={search_path=pg_catalog, pg_temp}`·PUBLIC EXECUTE 없음
    - 원장: app UPDATE·DELETE 42501, owner의 GUC 없는 DELETE·UPDATE·TRUNCATE P0001, owner가 GUC를 다른 user로 설정한 DELETE P0001
    - purge: `not_due`(기한 전) / `purged`(owner가 과거 시각으로 만든 행, 8개 테이블 종속 행 0) / 재실행 `absent` / 실패 주입 트리거로 전체 롤백
    - `list_purge_due` 정렬·limit 경계
    - up→down→up 스냅샷 동일
  - **L2** `lifecycle.test.ts`(§9 표의 모든 분기):
    - 탈퇴 중복 → `changed:false`, 기한·gen 불변
    - stale session·stale proof
    - `purge_after − 1s` 복구 OK / `purge_after` 이후 `expired`
    - **잠금 대기 경계:** tx A가 행을 잠그고 기한을 넘긴 뒤 커밋하면, 기한 전에 시작한 복구는 거부된다
    - 복구 뒤 잔액·원장 행 수·`first_login_at` 불변, gen +1
    - `verifyActiveAccount`: 옛 gen·pending·없음·int4 초과 gen(예: 2^31) → false(raw 22003 없음)
    - 로그인: Google·Kakao 각각 pending → `pending_deletion`(원장 불변), due → `purge_due`(새 user 없음)
    - 동시성: 로그인 대 탈퇴, 복구 대 purge, 탈퇴 2건
    - purge 뒤 재로그인 → 새 user + 지급(현행 기술 결과)
  - **회귀:** 기존 단위 122·빌드 경계 4·DB 99(기대값만 바뀐 사례 포함)·prod 6·E2E 12·root 42 유지. 신규 시험 수는 잠그지 않는다.
- **명령**(일회용 PG18 컨테이너·격리 CI만): `npm --prefix app run test:db -- tests/db/lifecycle-schema.test.ts`, `… tests/db/lifecycle.test.ts`, 전체 `npm --prefix app run test:db`·`npm --prefix app test`.

## 13. slice와 완료 조건

| slice | 전제 | 범위 | 완료 조건 | 롤백 |
|---|---|---|---|---|
| **L1 schema·role** | 이 계획 수락, §11 안 선택(A 추천), F4a 통합 | RED: harness role·meta, migrate·environment·privileges 기대값, `lifecycle-schema.test`. GREEN: 0002 up/down | L1 시험과 기존 회귀 통과(Node 24·26 CI), down 대칭 | PR revert(앱 경로 미연결이라 영향 없음). 적용된 DB는 빈 CI에서만 down |
| **L2 도메인·로그인** | L1 통합 | RED: `f3-login-grant` 기대값, `lifecycle.test`. GREEN: `lifecycle.ts`, `login.ts` | §9 모든 분기, 동시성, 지급 회귀 | PR revert. 열은 expand 상태로 남는다 |

- **범위 밖(F4b/c·F6):** OAuth·HTTP route·DAL 연결·복구 쿠키 codec·화면, 실제 purge 실행 주기·SLA·백업 삭제 재적용, 운영 role provisioning.
- 새 개인정보·법정 보관 정책이나 SLA 값은 만들지 않는다. 계정 연결 답변은 이 canonical user 단위 backend의 선행 조건이 아니다.
