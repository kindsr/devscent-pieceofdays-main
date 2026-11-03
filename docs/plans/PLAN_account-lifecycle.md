# PLAN — 계정 탈퇴·30일 복구·삭제 (구현 전 계획)

- **상태:** 계획 초안이며 검토 대기다. 코드·SQL·migration·cron·DB·계정 등록은 하지 않았다.
- **BASE:** `dev` `76a39d1e65a889a03eb1e5bd64a7e0b3ef161800`. 근거 코드는 `app/migrations/0001_init.up.sql`, `app/src/server/account/login.ts`, `app/src/server/credit/first-login-grant.ts`, `app/src/server/db/migrate.ts`다.
- **[확정] 사용자 2026-11-03:** "로그인은 둘다 붙이고, 30일 복구 기간 후 삭제"([PRD](../PRD.md) §0).
  - **Google·Kakao 로그인**과 **계정 탈퇴 → 30일 복구 기간 → 삭제**가 확정이다.
  - 30일은 **계정 단위** 정책이다. 개별 조각 삭제(현재 즉시 DELETE)를 30일 보관으로 바꾸지 않는다.
- **[미정] 사용자:** 공급자 간 계정 연결. 권고 후보는 로그인 뒤 다른 수단을 연결하는 것, 대안은 공급자별 별도 계정이다. email 자동 연결과 기록·잔액 병합은 승인되지 않았다.
- 관련 문서: [PLAN_mvp-authentication](PLAN_mvp-authentication.md)(세션), [DATA_CONTRACT](../product/DATA_CONTRACT.md)(현행 스키마 계약. 이 계획이 채택되면 구현 PR에서 갱신한다).
- 표기: **[사실]** 코드로 확인, **[권고]** 메인 결정 대상, **[미정]**, **[미확인]**.

## 1. 현재 스키마 사실 (BASE `0001_init.up.sql`)

| 대상 | 사실 | 탈퇴·삭제에 주는 영향 |
|---|---|---|
| `pod.users` | 열은 `id`·`created_at`·`first_login_at`뿐이다. 상태 열이 없다. app role 권한은 `SELECT, INSERT, UPDATE(first_login_at)`이고 DELETE는 없다 | 탈퇴 상태·기한·세대(generation)를 담을 열과 권한이 없다 → **migration 필요** |
| `auth_identities` | `user_id` FK → users `ON DELETE CASCADE`, `UNIQUE(provider, subject)` | users를 지우면 함께 지워진다. 기간 중에는 남아 있어 같은 계정으로 다시 로그인할 수 있다 |
| `preferences`·`design_versions`·`diary_moments`·`day_summaries` | users FK `ON DELETE CASCADE`. preferences→design_versions는 `SET NULL (applied_design_version_id)` | users를 지우면 함께 지워진다 |
| `credit_accounts` | users FK `ON DELETE RESTRICT` | 계정 행이 남아 있으면 users 삭제가 실패한다 |
| `emotion_ledger` | credit_accounts FK `ON DELETE RESTRICT`. 트리거 `emotion_ledger_no_update_delete`(BEFORE UPDATE OR DELETE, 행 단위)와 `_no_truncate`가 **owner를 포함한 모든 role**에 `P0001`을 낸다 | **원장이 있는 사용자는 지금 계약으로는 삭제할 수 없다.** 삭제 경로를 따로 설계해야 한다(§5) |
| `migrate.ts` `USER_DATA_TABLES` | 8개 테이블. 사용자 데이터가 있으면 down을 거부한다 | 새 테이블이 아니라 users에 열만 더하면 목록은 바뀌지 않는다 |
| `completeSuccessfulLogin` | identity로 user를 찾고 → 지급 → `first_login_at`. 상태를 확인하지 않는다 | 탈퇴 중인 계정으로 로그인해도 세션이 발급된다 → **함께 변경 필요**(§3) |

## 2. 상태 모델 [권고]

```
active ──탈퇴 요청(T)──▶ pending_deletion(purge_after = T + 720h)
   ▲                         │
   └── 복구(now < purge_after, 명시 확인) ┘
pending_deletion ──(now ≥ purge_after)── 복구·로그인 거부 ──purge 작업──▶ 행 없음
```

- **기준 시각:** 30일 경계는 DB 서버 시각 `now()`(트랜잭션 시작 시각)로 잰다. `purge_after = deletion_requested_at + interval '720 hours'`로 정확히 30×24시간이다. `'30 days'`는 세션 시간대의 DST 영향을 받을 수 있어 쓰지 않는다. 클라이언트 시각은 쓰지 않는다.
- **경계:** `now() < purge_after`이면 복구할 수 있다. `now() ≥ purge_after`이면 접근·복구를 거부하고 삭제 대상이 된다.
- **탈퇴 요청 즉시:** 모든 세션의 접근을 막는다(§4). 기록은 복구를 위해 기간 동안 보존하되, 앱 경로로는 읽거나 쓰지 않는다.
- **멱등:**
  - 이미 `pending_deletion`인데 탈퇴를 다시 요청하면 기존 기한을 유지한다(연장하지 않음).
  - 이미 `active`인데 복구를 요청하면 아무것도 하지 않는다.

## 3. 로그인과의 연결 (F4b/c, F3 계약 변경)

- **[권고]** `completeSuccessfulLogin`의 결과를 판별 가능한 형태로 넓힌다. 이는 F3 공개 계약을 바꾸는 것이므로 검토가 필요하다.
  - 예: `LoginOutcome = { kind: "active"; userId; createdUser; granted; balance } | { kind: "pending_deletion"; userId; purgeAfter } | { kind: "purge_due" }`
  - 기존 identity를 찾으면 같은 트랜잭션에서 users 행을 `FOR UPDATE`로 잠그고 상태를 읽는다.
    - `pending_deletion`이면 **지급을 호출하지 않고 `first_login_at`도 바꾸지 않은 채** 반환한다. 세션은 발급하지 않는다.
    - 기한이 지났으면 `purge_due`를 반환하고, 새 계정을 만들지 않는다.
  - `active`만 지금의 흐름(지급 멱등 포함)을 탄다.
- 탈퇴 중인 사용자가 다른 공급자로 로그인했을 때:
  - 같은 user에 연결된 identity라면 위와 같이 처리한다.
  - 연결되지 않은 공급자라면 그 공급자의 identity는 **별도 canonical user**다(현행 스키마). 연결 정책은 [미정]이므로 이 계획이 확정하지 않는다.
- **복구 화면 [권고]:**
  - `pending_deletion` 결과면 세션 대신 짧은 수명(예: 10분)의 봉인된 "복구 확인" 쿠키(`userId`·`gen`)만 준다.
  - 화면은 "복구하시겠어요?"를 보여 주고, 사용자가 명시적으로 POST(Origin 검사)해야 복구한다.
  - 자동 복구나 자동 재가입은 하지 않는다.
  - 복구가 끝나면 새 generation으로 일반 세션을 발급한다.

## 4. 세션 무효화 (S1 iron 쿠키의 한계와 보완)

- **[사실]** S1 봉인 쿠키는 서버 상태가 없다. 복사된 쿠키를 7일 안에 서버에서 철회할 수 없다([PLAN_mvp-authentication](PLAN_mvp-authentication.md) §5).

| 안 | 내용 | 장점 | 비용 |
|---|---|---|---|
| **M 최소안 [권고]** | `users.auth_generation integer`를 두고, 세션 payload에 `gen`을 넣는다. DAL(`verifySession`)이 **매 요청** `SELECT status, auth_generation FROM pod.users WHERE id=$1`로 `status='active' AND auth_generation = payload.gen`을 확인한다. 탈퇴·복구 때 `gen + 1` | 새 테이블 없음. 탈퇴 즉시 모든 기기를 차단하고, 복구 뒤 옛 쿠키는 다시 쓸 수 없음. 같은 방식으로 "모든 기기 로그아웃"도 가능 | 요청마다 PK 조회 1회. 기기별 개별 로그아웃은 불가 |
| S2 DB 세션 | 세션 테이블에 토큰 해시를 저장한다 | 기기별 폐기 | 새 테이블, `USER_DATA_TABLES`·down 가드·권한 변경(auth 계획 §6) |

**M을 채택할 때의 세션 계약 영향 (F4a RED 전 검토 대상):**
- payload: `{ v: 1, userId, gen, iat, exp }`. `gen`은 안전한 양의 정수이고 키는 정확히 5개다. **R2의 "키 4개" 계약은 이 결정 전까지 잠그지 않는다.**
- `sealSession(cfg, { userId, gen })`, `readSession` → `ok { userId, gen, expiresAt }`.
- 상태와 generation 대조는 DB가 필요하므로 codec(F4a)이 아니라 DAL(F4b/c)에서 한다. 불일치나 비활성 상태는 `missing`·`invalid`·`expired`와 똑같이 "로그인 필요"로 처리한다.
- package-only `iron-session` bootstrap(F4a ①)은 이 결정과 무관하게 진행할 수 있다.

## 5. 삭제(purge) 설계 [권고, 구현 전]

**사전 조건 (한 트랜잭션 안에서 다시 확인):** `SELECT … FROM pod.users WHERE id=$1 FOR UPDATE` 결과가 `status='pending_deletion' AND purge_after <= now()`. 행이 없으면 `absent`(성공·멱등), 조건이 맞지 않으면 `not_due`로 끝내고 아무것도 지우지 않는다.

**삭제 순서 (같은 트랜잭션):**
1. `set_config('pod.purge_user_id', <uuid>, true)` — 트랜잭션 범위 표시.
2. `DELETE FROM pod.emotion_ledger WHERE user_id = $1`. 트리거가 아래 조건일 때만 허용한다.
3. `DELETE FROM pod.credit_accounts WHERE user_id = $1`.
4. `DELETE FROM pod.users WHERE id = $1`. identities·preferences·design_versions·diary_moments·day_summaries는 CASCADE로 함께 지워진다.
5. COMMIT. 어느 단계든 실패하면 전체 ROLLBACK되고 상태는 `pending_deletion`으로 남는다. 다음 실행에서 다시 시도한다.

**트리거와 권한:**
- `pod.emotion_ledger_append_only()`를 바꾼다. **DELETE이면서** `current_setting('pod.purge_user_id', true) = OLD.user_id::text` **이고** `current_user`가 owner role(`pod_meta.db_environment.owner_role`)일 때만 `RETURN OLD`. UPDATE·TRUNCATE와 그 밖의 모든 경우는 지금처럼 `P0001`이다.
- app role은 GUC를 설정할 수는 있지만 `current_user`가 owner가 아니므로 삭제할 수 없다. 그래서 **일반 앱의 원장 UPDATE·DELETE 보호는 유지된다.**
- 삭제는 `SECURITY DEFINER`(owner 소유, `SET search_path = pod, pg_temp`) 함수 `pod.purge_user_if_due(uuid) returns text` 하나에서만 한다.
- 실행 권한: **전용 purge role**에만 `EXECUTE`를 준다(그 role에는 테이블 직접 권한이 없다). app role에는 주지 않는다.
- 대상 목록은 `pod.list_purge_due(limit int)`(SECURITY DEFINER, `id`만 반환)로 얻는다.
- [사실·한계] owner·migrator는 원래 트리거를 끌 수 있는 신뢰 주체다. 이 설계는 그 수준을 넘는 보장을 하지 않는다.

**동시성:**
- 복구(`UPDATE … WHERE id=$1 AND status='pending_deletion' AND now() < purge_after`)와 purge는 같은 users 행 잠금으로 직렬화된다.
- 기한 전 복구는 purge의 사전 조건 재확인에서 `not_due`가 된다. 기한 뒤 복구는 0행이 되어 거부된다.
- purge를 중복 실행하면 두 번째는 `absent`가 된다.

**데이터 보관 정책 [사용자 승인 없이 만들지 않음]:**
- 무료 MVP 감정덩어리에 대해 법정 금융 보관이나 무기한 익명 원장 보관 정책을 새로 만들지 않는다. 계획은 **원장까지 함께 삭제**한다.
- 탈퇴 뒤 같은 공급자 계정으로 재가입하면 새 canonical user가 되어 첫 10개를 다시 받는다. 이를 막으려면 식별자 해시 같은 보관이 필요하며, 이것은 [미정] (사용자·메인 결정)이다. 이 계획은 보관을 도입하지 않는다.

**백업:**
- 삭제는 운영 DB에서 일어난다. **백업에서 즉시 물리 삭제된다고 약속하지 않는다.**
- 백업 보존 기간이 지나면 사라지는 것, 그리고 백업을 복원할 때 삭제를 다시 적용하는 절차(삭제 대상 user id 목록과 그 보관 방식 포함)는 **F6 운영 선행 조건이며 아직 설정되지 않았다.**
- purge 주기(cron 등)도 아직 설치되지 않았다(F6).

## 6. migration 초안 `0002_account_lifecycle` [권고]

- `pod.users`에 추가하는 열:
  - `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_deletion'))`
  - `deletion_requested_at timestamptz NULL`
  - `purge_after timestamptz NULL`
  - `auth_generation integer NOT NULL DEFAULT 1 CHECK (auth_generation >= 1)`
  - 일관성 CHECK: `active`이면 두 시각이 모두 NULL, `pending_deletion`이면 둘 다 NOT NULL이고 `purge_after = deletion_requested_at + interval '720 hours'`
- 부분 인덱스: `(purge_after) WHERE status='pending_deletion'`
- app 권한 추가: `UPDATE (status, deletion_requested_at, purge_after, auth_generation)`. DELETE 권한은 계속 주지 않는다.
- 트리거 함수 교체(§5), purge 함수 2개, purge role GRANT. role 생성 자체는 CI 부트스트랩과 운영 프로비저닝이 한다(F2 관례).
- down: F2 규칙대로 빈 CI DB에서만 실행한다. 열·함수 제거, 트리거 함수는 0001 정의로 되돌린다.
- 영향: DATA_CONTRACT §4~§6, `tests/db/privileges`·`constraints` 회귀, F2 `migrate` 시험.

## 7. 시험 수용 기준 [권고]

실제 PG18 일회용 DB를 쓴다. app role과 purge role로 각각 접속하고, 시계는 DB `now()` 기준이다(행의 시각을 과거로 넣어 경계를 만든다).

1. **탈퇴 즉시 차단:** 요청 뒤 같은 세션(이전 `gen`)으로 들어오면 DAL이 "로그인 필요"로 처리한다. Google·Kakao 각각의 연결 identity로 로그인해도 `pending_deletion`이 되고 세션은 발급되지 않는다.
2. **경계:** `purge_after − 1초`에는 복구가 성공하고, `purge_after`와 그 뒤에는 복구·로그인이 거부된다(`purge_due`).
3. **복구:** 같은 canonical userId, 잔액·원장 행 그대로, `granted=false`(지급 1회 유지), `gen`은 증가. 복구 전에 발급된 쿠키는 거부되고 새로 발급한 세션만 통과한다.
4. **탈퇴 중 지급 우회 불가:** `pending_deletion`에서 로그인하면 원장 행 수·잔액·`first_login_at`이 변하지 않는다.
5. **purge:**
   - 기한 전 `not_due`, 기한 뒤 모든 종속 행 0행. 원장·계정까지 사라진다.
   - 재실행하면 `absent`.
   - 단계 실패(시험 전용 트리거로 주입)면 전체 롤백 → 다음 실행에서 성공.
6. **동시성:** 복구와 purge를 동시에 실행하면 둘 중 하나만 효과가 있고 부분 삭제는 없다. purge 2개를 동시에 실행해도 한 번만 삭제된다.
7. **보호 회귀:** app role의 원장 `UPDATE`·`DELETE`는 계속 `42501`. owner가 GUC 없이 DELETE하면 `P0001`. GUC를 설정하더라도 app role에서는 삭제가 불가능하다.
8. **purge 뒤 재로그인:** 같은 identity가 새 user로 생성되고 새로 지급된다(현행 정책 그대로, §5 미정 사항 표시).

## 8. 의존·순서·롤백

- 순서:
  1. 이 계획과 [PLAN_mvp-authentication](PLAN_mvp-authentication.md)의 `gen` 결정을 검토한다.
  2. F4a codec(필요하면 `gen` 포함).
  3. migration 0002와 lifecycle 도메인(RED → GREEN).
  4. F4b/c에서 로그인·복구·탈퇴 화면을 연결한다.
  5. F6에서 purge 주기·백업 규칙을 설정한다.
- 롤백:
  - 앱을 되돌리면 탈퇴·복구 경로가 꺼진다. 열은 expand 상태로 둔다.
  - `pending_deletion` 행이 있으면 down하지 않는다(사용자 데이터가 있으므로 F2 가드가 거부한다).
  - purge로 이미 삭제한 데이터는 백업 절차 없이는 복원할 수 없다.
- 미확인: 실제 구현과 시험(미실행), 운영 시각과 시간대 설정, 백업 도구·보존 기간.
