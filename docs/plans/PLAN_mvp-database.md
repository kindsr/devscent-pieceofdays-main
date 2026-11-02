# PLAN — MVP 데이터베이스 F2 (migration 실행기·스키마·권한, PostgreSQL 18)

- 상태: **계획. 패키지 설치·SQL·시험·CI 변경·DB 생성은 하지 않았다.** 기준 `dev` `e5ebd58`. 계약은 [DATA_CONTRACT](../product/DATA_CONTRACT.md)에 있다.
- 상위 문서: [PLAN_mvp-foundation](PLAN_mvp-foundation.md) F2(F3·F4와의 경계는 DATA_CONTRACT §4.9), [00_TECH_STACK_DECISION](../product/00_TECH_STACK_DECISION.md) §3.
- 전제: F1 PR(`e5dd64d`, 후속 수정 중)이 `app/`·`app-validation.yml`을 만든다. **F2는 F1이 dev에 합쳐진 뒤 그 위에서 시작한다.** 이 계획은 F1 파일을 읽기만 했다.
- 인증 공급자 [미정]: F2는 공급자 중립이다. 실제 로그인·세션은 F4다.
- 공용 서버 DB는 아직 없고 만들지 않는다. F2 시험은 **GitHub Actions의 PostgreSQL 18 서비스 컨테이너와 로컬 컨테이너에서만** 실행한다. 공용·실서버 DB를 시험 대신 쓰지 않는다.

## 1. 목표와 비목표

- 목표: 다음 RED 작성자가 바로 시험을 쓸 수 있도록 실행기·파일 규칙·role·시험 목록·예상 실패·명령을 고정한다.
- 비목표:
  - 도메인 저장 구현(F3)
  - 첫 로그인 동시 지급 시험(F3)
  - 실제 로그인(F4)
  - 마켓·사진 테이블
  - ORM·쿼리 빌더
  - dev/prod DB 프로비저닝(운영 절차, 메인)
  - 배포 경로 변경(F6)

## 2. 실행기 비교와 권고

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **A [권고] 저장소 안의 작은 SQL 실행기** | `pg` 드라이버 + 필요한 최소한의 TS(줄 수 목표는 두지 않는다). 순수 SQL up/down 파일, 체크섬, advisory lock | 의존성은 F3에서도 필요한 `pg` 하나뿐. 규칙(체크섬·down 차단·role 주입)을 시험으로 고정하기 쉽다 | 실행기 코드를 직접 유지·시험해야 한다 |
| B migration 전용 패키지 | 기존 도구의 기록 표·잠금 사용 | 바로 쓸 수 있다 | 의존성이 하나 더 생긴다. down 차단·role 주입은 결국 따로 감싸야 한다 |
| C ORM 마이그레이션 | 스키마 DSL로 생성 | 타입 생성 | ORM·추상화를 추가하게 된다(foundation 원칙 위반), 권한·트리거는 결국 SQL로 써야 한다 |
| D psql 셸 스크립트 | 파일을 순서대로 실행 | 의존성이 없다 | 체크섬·잠금·실패 처리가 약하고 시험하기 어렵다 |

권고는 A다.
- 드라이버는 `pg`(node-postgres)를 쓴다. 2026-11-02 npm `latest`는 8.23.1, MIT, `engines node >=16`이다. `@types/pg`는 8.23.1이다.
- **설치할 때 다시 확인하고 정확한 버전으로 고정한다.**

## 3. 실행기 계약 (A)

- 파일:
  - 형식: `app/migrations/NNNN_snake_name.up.sql`과 같은 번호의 `.down.sql`. 번호는 4자리이고 `0001`부터 빈 번호 없이 이어진다.
  - 인코딩: UTF-8, LF.
  - 파일 정책: **최상위(top-level) 트랜잭션 제어문을 금지한다.** 실행기가 감싼 트랜잭션을 파일이 끊으면 원자성이 깨지기 때문이다.
    - 금지 대상(최상위 문장의 첫 키워드): `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`.
    - 트랜잭션 밖에서만 되는 문장도 금지한다: `CREATE INDEX CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`, `ALTER SYSTEM`.
    - **허용:** `DO $$ … BEGIN … END $$`, `CREATE FUNCTION … AS $fn$ BEGIN … END $fn$`처럼 달러 인용 본문 안의 `BEGIN`/`END`(PL/pgSQL 블록), 주석과 문자열 리터럴 안의 단어.
    - SQL 표준 함수 본문(`BEGIN ATOMIC … END`)은 쓰지 않는다. 함수 본문은 달러 인용 PL/pgSQL로만 쓴다(문장 분리를 단순하게 유지하려는 것이다).
    - 검사 방식: 전역 정규식이 아니라 작은 문장 분리기로 한다. 주석(`--`, 중첩 `/* */`), 작은따옴표 문자열, 큰따옴표 식별자, 달러 인용(`$tag$ … $tag$`)을 건너뛴 뒤 최상위 `;` 기준으로 문장을 나누고, 각 문장의 첫 키워드만 검사한다. 위반하면 DB에 접속하기 전에 종료 코드 1로 끝낸다.
- 체크섬:
  - 값은 up 파일 바이트의 SHA-256 hex이며 `pod_meta.schema_migrations.checksum`에 저장한다.
  - 이미 적용된 번호의 파일 체크섬이 다르거나, 파일이 없거나, 번호가 비면 **아무것도 하지 않고** 종료 코드 1로 끝낸다.
- 잠금·트랜잭션: migration 1개마다 아래 순서로 실행한다.
  1. `BEGIN`
  2. `SELECT pg_advisory_xact_lock(<상수 bigint>)`
  3. 적용 여부를 다시 확인
  4. `SET LOCAL ROLE <owner>`
  5. 파일 실행
  6. 기록 행 삽입
  7. `COMMIT`

  거래 수준 advisory lock은 커밋·롤백 때 자동으로 풀린다(공식 문서). 실행기를 동시에 두 개 돌려도 하나가 기다렸다가 건너뛴다. 실패하면 그 migration 전체가 롤백되고 기록 행도 남지 않는다.
- 명령(F2에서 `app/package.json` scripts로 추가):
  - `npm run db:migrate -- status`
  - `npm run db:migrate -- up`
  - `npm run db:migrate -- down --to <N> --allow-down`
- 접속: `POD_MIGRATE_DATABASE_URL`(migrator role). 앱은 F3부터 `POD_DATABASE_URL`(app role)을 쓴다. 값은 환경별 비밀 저장소에 두고 문서·저장소에는 CI 가짜 값만 둔다.
- **down 차단(4중):**
  1. `--allow-down` 플래그가 필요하다.
  2. `pod_meta.db_environment.name = 'ci'`여야 한다(dev/prod는 프로비저닝이 `dev`/`prod`로 넣는다).
  3. **사용자 데이터가 하나라도 있으면 거부한다.** 대상은 `pod` 스키마의 모든 사용자 데이터 테이블이다: `users`, `auth_identities`, `preferences`, `diary_moments`, `day_summaries`, `design_versions`, `credit_accounts`, `emotion_ledger`.
     - 실행기가 down 전에 확인한다.
     - down 파일 첫 문장도 같은 확인(`DO` 블록, `RAISE EXCEPTION`)을 한다. 원장 행이 생기기 전의 일기·디자인만 있는 DB도 보호하기 위한 이중 장치다.
  4. 배포·운영 절차는 `up`만 실행한다.

  결과적으로 파괴적인 down은 **사용자 데이터가 없는 빈 CI DB의 리허설에서만** 실행된다. 데이터가 있는 DB에서는 자동이든 수동 플래그든 실행되지 않는다.
- 실패 복구:
  - 아직 어디에도 적용되지 않은 migration은 파일을 고쳐도 된다.
  - 한 번이라도 적용된 migration은 고치지 않는다. 체크섬이 막는다. 새 번호로 바로잡는다(fix-forward).
  - **배포 실패 시 기본 복귀**(foundation F6과 같다):
    1. 직전 앱 이미지로 복귀한다.
    2. 스키마는 되돌리지 않는다. 직전 앱과 호환되는 expand 단계에 머문다.
    3. 원인은 새 migration으로 바로잡는다(fix-forward).

    그래서 migration은 expand/contract 방식으로 쓴다. 직전 앱이 깨지는 변경(열 삭제·이름 변경·제약 강화)은 앱이 바뀐 뒤 별도 contract migration으로 한다.
  - **백업 복원은 별도 사건이다.** 데이터가 실제로 손상됐을 때만 한다.
    - 먼저 메인이 운영 절차(비공개 런북)로 복원 범위와 최신 쓰기를 어떻게 보존할지 확인한다.
    - 그다음 사람이 따로 실행한다.
    - 실행기·배포 자동화는 DB 전체를 자동으로 복원하지 않는다.

## 4. F2 변경 파일 (예정)

| 파일 | 내용 |
|---|---|
| `app/package.json`, `app/package-lock.json` | `pg`, `@types/pg` 정확 고정. scripts `db:migrate`, `test:db` |
| `app/migrations/0001_init.up.sql` / `.down.sql` | DATA_CONTRACT §2~§6 전체(스키마 `pod`, 테이블 8개, 인덱스, 트리거, REVOKE/GRANT). down은 사용자 데이터가 있으면 거부하는 문장으로 시작 |
| `app/src/server/db/sql-policy.ts` | §3 파일 정책 검사(문장 분리기) |
| `app/src/server/db/migrate.ts` (+ CLI 진입점) | §3 실행기 |
| `app/tests/db/helpers.ts` | 일회용 DB 하네스(§6 안전 계약), 시험별 DB 생성·추적·삭제, role 부트스트랩, `expectSqlState` |
| `app/tests/unit/sql-policy.test.ts` | 파일 정책 시험(DB 없이 실행) |
| `app/tests/db/{migrate,privileges,constraints}.test.ts` | §5 시험 |
| `app/vitest.db.config.ts` | `tests/db`만 포함하고 globalSetup으로 부트스트랩. 기존 `npm test`(단위)에서 db 시험을 제외 |
| `.github/workflows/app-validation.yml` | `db` job 추가(§6). 기존 job·배포 workflow는 바꾸지 않는다 |

F1 파일(`store.ts`·`fixture.ts`·`context.ts` 등)은 F2에서 바꾸지 않는다. PG 저장 구현과 port 연결은 F3다.

## 5. 시험 설계 (RED → 실행기 → GREEN)

### 5.1 순서

1. **RED 커밋:** `helpers.ts`, db 시험 3개, `sql-policy.test.ts`, `vitest.db.config.ts`, CI `db` job을 올린다.
   - 예상 실패: `migrate.ts`·`sql-policy.ts` 모듈이 없음(import 오류), `relation "pod.users" does not exist`(SQLSTATE `42P01`). CI `db` job 빨강을 확인한다.
2. **실행기 커밋:** `migrate.ts`와 빈 `0001`이 없는 상태에서 `migrate.test`의 체크섬·잠금·down 차단 시험을 GREEN으로 만든다. 시험용 임시 migration 디렉터리를 쓴다.
3. **GREEN 커밋:** `0001_init`으로 `privileges`·`constraints`·up→down→up 시험을 GREEN으로 만든다.

### 5.2 접속 role (가짜 CI 값)

| 시험 | 접속 role | 이유 |
|---|---|---|
| 부트스트랩·시험 DB 생성/삭제 | 서비스 컨테이너 관리자 `postgres` | 시험 하네스 전용. 앱·migration 시험에는 쓰지 않는다 |
| migrate | `pod_ci_migrator`(실행기 경유) | 운영과 같은 경로 |
| privileges·constraints | **`pod_ci_app`**: 운영 app과 같은 GRANT를 migration이 부여한 계정 | 슈퍼유저·owner로 대신 시험하지 않는다 |
| 원장 트리거·`RESTRICT`·`SET NULL` | `pod_ci_migrator` → `SET ROLE pod_ci_owner` | owner에게도 append-only가 적용되는지, 부모 삭제가 차단·연쇄되는지 확인 |

### 5.3 시험 목록과 예상 결과

**migrate.test**
- 빈 DB에 up을 실행하면 `schema_migrations`에 `(1, 'init', <sha256>)`이 생긴다.
- up을 다시 실행하면 변화가 없다.
- 적용된 파일 한 바이트를 바꾸면 종료 코드 1, `checksum mismatch`가 나오고 DB는 변하지 않는다.
- 실행기를 동시에 2개 돌리면 둘 다 성공하고 기록 행은 1개다.
- `--allow-down` 없이 down을 실행하면 거부된다.
- `db_environment.name='dev'`인 시험 DB에서 down을 실행하면 거부된다.
- **사용자 데이터가 있으면 down을 거부한다.** 각 경우에 종료 코드 1이 나오고, 스키마와 행이 그대로 남아야 한다.
  - `users` 1행만 있음(계정·원장 없음)
  - `users`+`diary_moments` 1행(원장 생기기 전 일기)
  - `users`+`design_versions` 1행
  - `users`+`credit_accounts`+`emotion_ledger` 1행
  - 실행기의 사전 확인을 건너뛰고 down 파일을 직접 실행해도 첫 문장이 `P0001`로 거부한다.
- 빈 CI DB(사용자 데이터 0행)에서만 down이 성공한다.
- up→down→up 뒤 스키마 스냅샷이 처음과 같다. 스냅샷 대상은 테이블·열·`pg_get_constraintdef`·`pg_get_indexdef`·트리거·`information_schema` 권한 목록이다.

**sql-policy.test** (단위, DB 없음)
- 허용(통과해야 함):
  - `DO $$ BEGIN … END $$;`
  - `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION '…'; END $fn$;`
  - 주석 `-- BEGIN;`, `/* COMMIT; */`(중첩 주석 포함)
  - 문자열 `'COMMIT'`, 식별자 `"begin"`
- 거부(위반 문장 위치와 함께 실패해야 함):
  - 최상위 `BEGIN;`, `START TRANSACTION;`, `COMMIT;`, `END;`, `ROLLBACK;`, `SAVEPOINT a;`
  - `CREATE INDEX CONCURRENTLY …;`, `VACUUM;`
  - `BEGIN ATOMIC` 함수 본문
  - 달러 인용 본문이 끝난 바로 뒤의 최상위 `COMMIT;`

**privileges.test** (`pod_ci_app`)
- 권한 오류(`42501`)가 나야 하는 것:
  - `emotion_ledger`에 대한 `UPDATE`·`DELETE`·`TRUNCATE`
  - `DELETE FROM pod.users`
  - `UPDATE pod.design_versions`
  - `UPDATE credit_accounts SET user_id`
  - `SELECT pod_meta.schema_migrations`
  - `CREATE TABLE pod.x`
- 성공해야 하는 것: 사용자·계정·원장 `INSERT`/`SELECT`, 조각의 `UPDATE`/`DELETE`, `preferences` 허용 열 `UPDATE`.
- owner 경로: 원장 `UPDATE`·`DELETE`·`TRUNCATE` → `P0001`(append-only).

**constraints.test** (`pod_ci_app`, owner 표시 항목은 owner)
- `23514`(CHECK 위반):
  - `balance = -1`
  - 허용 목록 밖 `font_key`
  - 빈 본문 또는 301자 본문
  - `first_login_grant`인데 `delta=5`이거나 `grant_key`가 형식과 다름
  - `reason='purchase'`
  - 잘못된 `provider`
- `23505`(유일 위반): 같은 사용자의 두 번째 `first_login_grant`, 중복 `grant_key`, 같은 날 `day_summaries` 2행, 같은 `(provider, subject)`.
- `23503`(FK 위반): 계정 없는 사용자의 원장 삽입, 다른 사용자의 버전을 `applied_design_version_id`로 지정, owner가 원장이 있는 사용자를 삭제.
- owner가 디자인 버전을 삭제하면 해당 `preferences.applied_design_version_id`가 `NULL`이 되고 `user_id`는 유지된다.

F3로 넘기는 것(여기서 쓰지 않는다): 병렬 연결로 첫 로그인 N회 → 1행·잔액 10, `SUM(delta)` = 잔액, 낙관적 잠금 충돌과 "없음" 응답, 소유자 조건 조회.

시험은 오류를 SQLSTATE로 비교한다. 메시지 문자열에 의존하지 않는다. 단 append-only 메시지는 계약 문자열이라 비교한다.

## 6. CI·재현·격리

`app-validation.yml`에 추가할 `db` job 개요(값은 모두 가짜이며 Secrets를 쓰지 않는다):

```yaml
db:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:18.x@sha256:<구현 시 공식 이미지 최신 18 마이너 digest 고정>
      env: { POSTGRES_PASSWORD: ci-only-not-a-secret }
      ports: ["5432:5432"]
      options: >-
        --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 20
  env:
    POD_TEST_ADMIN_URL: postgres://postgres:ci-only-not-a-secret@localhost:5432/postgres
    POD_TEST_DB_DISPOSABLE: "1"
  # steps: checkout → setup-node(26.13.0) → npm ci → npm run test:db
```

- 부트스트랩(globalSetup, 반복 실행 안전):
  - role `pod_ci_owner`(NOLOGIN), `pod_ci_migrator`(owner 구성원), `pod_ci_app`이 없으면 만든다. 이미 있으면 아래 안전 계약에 따라 확인만 한다. 비밀번호는 `ci-only-*`다.
  - 시험 파일마다 DB `pod_ci_<파일>_<무작위>`를 `OWNER pod_ci_owner`로 만들고 `REVOKE ALL ON DATABASE … FROM PUBLIC`, `GRANT CONNECT`를 실행한다.
  - 그 DB에 `pod_meta.db_environment('ci', 'pod_ci_app', 'pod_ci_owner')`를 넣는다.
- 격리: 시험 파일마다 전용 DB를 쓰므로 파일끼리 병렬 실행해도 안전하다. 권한 오류가 트랜잭션을 중단시키므로 단언마다 SAVEPOINT 또는 새 연결을 쓴다.
- 정리:
  - 파일이 끝나면 연결을 닫고 DB를 삭제한다(`DROP DATABASE … WITH (FORCE)`, 구현 시 18 문서로 문법 확인).
  - CI 서비스 컨테이너는 job이 끝나면 사라진다.
  - 원장은 TRUNCATE가 막혀 있으므로 데이터 정리는 DB 삭제로만 한다.
- **일회용 DB 하네스 안전 계약:** 시험은 그 실행 전용의 로컬 컨테이너나 CI 서비스 컨테이너에서만 돌린다.
  - 호스트가 `localhost`·`127.0.0.1`이 아니거나 `POD_TEST_DB_DISPOSABLE=1`(CI job·로컬 명령에서만 설정)이 없으면 즉시 실패한다. 다만 이 검사는 실수를 빨리 막는 장치일 뿐, 실서버 접근을 막는다는 보장은 아니다. 보장은 "전용 컨테이너에서만 실행"이라는 운용 규칙과 아래의 삭제 제한에서 나온다.
  - 삭제 대상 제한: 하네스는 **이번 실행이 직접 만들어 메모리에 기록한** DB만 삭제한다. 삭제 직전에 이름이 `pod_ci_` 접두인지, 소유자가 `pod_ci_owner`인지 다시 확인하고, 하나라도 다르면 삭제하지 않고 실패한다.
  - 이미 있던 DB와 role은 삭제하지 않고 비밀번호·권한·속성도 덮어쓰지 않는다. 같은 이름의 role이 있으면 속성을 확인한다(LOGIN 여부, 슈퍼유저·`CREATEROLE`·`CREATEDB`·`BYPASSRLS` 없음, migrator→owner 구성원 관계). 기대와 같으면 그대로 재사용하고, 다르면 수정하지 않고 실패한다(fail closed).
  - 클러스터 전역 설정(`ALTER SYSTEM`, 인증 설정 파일, 서버 설정)은 바꾸지 않는다.
- 로컬 재현(Docker가 있는 개발 PC, 이 시험만을 위한 새 컨테이너):

  ```bash
  docker run --rm -d --name pod-pg18 -e POSTGRES_PASSWORD=ci-only-not-a-secret -p 127.0.0.1:55432:5432 postgres:18
  cd app && POD_TEST_DB_DISPOSABLE=1 POD_TEST_ADMIN_URL=postgres://postgres:ci-only-not-a-secret@127.0.0.1:55432/postgres npm run test:db
  docker rm -f pod-pg18
  ```

- Claude Cloud에는 Docker 클라이언트만 있고 데몬 동작은 확인하지 않았다(이 작업에서 실행하지 않았다). Cloud 작업자는 GitHub CI `db` job 결과로 판정한다.

## 7. 복귀

- F2는 배포 이미지·운영 DB에 영향이 없다. 앱은 F1의 메모리 저장을 그대로 쓰고, F6 전까지 앱은 배포되지 않는다.
- PR을 되돌리면 파일 추가가 모두 사라진다. 서버에 만든 DB가 없으므로 데이터 복구는 필요 없다.
- dev/prod에 처음 적용하는 것은 F6 운영 절차다. 백업 → `up`만 실행 → 검증 순서다. 실패하면 그 migration이 롤백되고, 앱은 직전 이미지로 복귀하며, 원인은 fix-forward로 바로잡는다(§3). 백업 복원은 실제 데이터 손상 때 메인 운영 절차로 따로 한다.

## 8. 의존·미정

| 항목 | 영향 |
|---|---|
| F1 dev 반영 | F2 시작 조건 |
| 인증 공급자 | F4. F2 스키마는 공급자 중립이라 영향이 없다 |
| 사용자별 시간대 / 사진 / 버전 보관 / 탈퇴 | 각각 CHECK 확장, 테이블, DELETE 권한, 삭제 절차를 추가하는 migration |
| dev/prod DB·role 프로비저닝 | 운영 절차(메인·비공개 런북). 실제 role 이름·비밀번호는 공개 문서에 쓰지 않는다 |
| PostgreSQL 이미지 마이너·digest, `pg` 버전 | F2 구현 시 공식 출처로 확인해 고정 |

## 9. 시험 환경 준비 결과 (2026-11-02)

- Cloud `15397e1`: `pg`·`@types/pg` 8.23.1 정확 고정, CI PostgreSQL 18.6 서비스와 시험 전용 role·DB 하네스. 제품 `pod` 스키마·8개 테이블·migration 실행기는 아직 없다.
- 이미지 digest는 CI 파일에 고정했다. 메인은 공식 registry의 tag `18` 조회로 같은 OCI index를 확인했다.
- CI `41507022434` 원문: DB 환경 시험 8개, Node 26·24 각각 단위 20개·운영 경계 6개·E2E 12개 통과. `3b956c8` RED는 CREATE 후 권한 부여 실패 시 DB가 남는 실패를 확인했고, `15397e1`은 호출자 정리에 기대지 않고 직접 정리해 GREEN이 됐다.
- Cloud VM의 Docker 데몬 부재로 수행한 native PG18 클러스터 실험은 보조 근거다. 공식 판정은 일회용 CI 서비스 컨테이너 결과로 한다. 공유 서버 DB·전역 패키지·운영 설정은 변경하지 않았다.
- 원 담당자가 `5625548` 초안을 보존하고 `F2_OWNER_STOPPED`로 소유권을 반환했다. 메인은 시험 설정·문서를 마무리하며, `.claude/tdd.conf`는 제품 파일을 시험 패턴으로 넓히지 않는다. `FULL_CHECK`는 환경 누락 시 시험 진입 전에 거부하고 DB→배포→앱 순서로 실행한다. 공유 운영 서버에서는 실행하지 않는다.
- 후속 CLI 계약: `app/src/server/db/migrate-cli.ts`에 `status|up|down`, `--migrations-dir <dir>`, down의 `--to <N>`·`--allow-down`을 둔다. 기본 디렉터리는 `app/migrations`이며 `POD_MIGRATE_DATABASE_URL`을 사용한다. 실패는 exit 1, 성공은 0, 체크섬 오류에는 `checksum mismatch`를 포함하고 URL·비밀번호를 출력하지 않는다. CLI 코드는 이번에 만들지 않았다.
- 후속 순수 정책 함수는 `app/src/server/db/sql-policy.ts`의 `validateSqlPolicy(sql: string): void`다. 위반 시 오류를 던진다. Node의 직접 TS 실행에는 상대 `.ts` import를 쓰고, GREEN에서 `allowImportingTsExtensions`를 설정한다(`noEmit` 전제). Node CLI에서 Next의 `@/` 별칭을 쓰지 않는다.
- 다음 단계의 RED 기준은 이 준비가 통합된 `dev`의 정확한 SHA로 확정한다. 그 이후 시험 작성·독립 실행 확인·GREEN 구현을 다른 역할로 나누며, 준비 작업을 제품 스키마 구현 완료로 보지 않는다.
