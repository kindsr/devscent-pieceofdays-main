# PLAN — F3 도메인·PostgreSQL 저장 (공급자 중립)

- 상태: **계획. 구현·시험·패키지·migration을 바꾸지 않았다.** 기준 `dev` `e3c72fe`.
- F2 읽기 기준: `24af097`(`claude/f2-green-implementation-07z9g6`, PR16 검토 중). **F2는 아직 완료가 아니고 운영 DB도 없다.** F3는 F2가 dev에 합쳐진 뒤 그 dev SHA를 기준으로 시작하고, 그 시점의 단위·DB 시험 수를 baseline으로 동결한다.
- 상위 문서: [PLAN_mvp-foundation](PLAN_mvp-foundation.md) F3/F4, [PLAN_mvp-database](PLAN_mvp-database.md), [DATA_CONTRACT](../product/DATA_CONTRACT.md), [03_MVP](../product/03_MVP.md), [DECORATION_MARKET_ARCHITECTURE](../product/DECORATION_MARKET_ARCHITECTURE.md) §3·§5·§7, [디자인 핸드오프](../design/README.md).
- 표기: **[확정]** 사용자·상위 문서가 정한 것, **[가정]** 기존 가정, **[권고→계약]** 이 계획이 정하는 고정값(메인 검토 대상), **[미정]**.

## 0. 범위

| F3에서 한다 | F3에서 하지 않는다 (남기는 곳) |
|---|---|
| 공급자 중립 계정 해석 + 첫 성공 로그인 10개 지급 함수(원자적) | 실제 OAuth·세션·쿠키·HTTP 연결, 로그인 사용자에게 지급 켜기 (**F4**, grant와 같은 PR) |
| 조각·하루 한 줄 CRUD, 소유권, 낙관적 잠금, 서울 날짜 | 화면 저장 연결·삭제 UI·편집기 (**F5**) |
| manifest 검증, 개인 버전 불변 저장, 본인 적용, 기록 글꼴 저장 | Konva 편집기·렌더러·스티커 세트 확정 (**F5**), 마켓·구매·정산 (후속) |
| 실제 PG18 app role 시험(F2 하네스 재사용) | DB 프로비저닝·배포·앱 접속 (**F6**), 사진·AI·공유·탈퇴 정책 (미정) |

- 원칙:
  - 새 아키텍처·ORM·Redis·큐는 쓰지 않는다. 의존성은 이미 고정된 `pg`만 쓴다.
  - 기존 port(`DiaryStore`)를 우선한다. DI는 DB 핸들 하나와 시계(clock) 하나만 받는다.
  - **F2 스키마와 권한 계약은 바꾸지 않는다.** F3 범위에서 새 migration이 필요하다고 판단하지 않았다. 필요가 증명되면 계획을 멈추고 메인에 올린다.

## 1. 공통 기반 (slice ① 첫 커밋에 포함)

| 파일 | 공개 계약 |
|---|---|
| `app/src/server/db/pool.ts` | 아래 4개 공개 계약 |
| `app/src/server/result.ts` | `type Result<T, E extends string> = { ok: true; value: T } \| { ok: false; error: E }` |
| `app/src/shared/local-date.ts` (기존 파일에 추가) | `seoulLocalDate(instant: Date): LocalDate`, `seoulTime(instant: Date): string` (`HH:MM`) |
| `app/src/server/ids.ts` | `isUuid(value: string): boolean`. 형식이 틀린 ID는 쿼리 전에 `not_found`로 처리해 `22P02` 오류가 새지 않게 한다 |

`pool.ts`의 공개 계약:
- `type Db = pg.Pool`
- `type Tx = pg.PoolClient`
- `getAppDb(): Db` — `POD_DATABASE_URL`(app role)만 읽는다. 지연 생성하며, 값이 없으면 오류를 낸다. F3에서는 호출하는 곳이 없고 F4가 연결한다.
- `withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>` — `BEGIN`·`COMMIT`을 하고, 오류가 나면 `ROLLBACK` 후 다시 던진다. 기본 격리 수준은 Read Committed다.

규칙:
- **서버 전용:** `src/server/**`는 클라이언트 컴포넌트에서 import하지 않는다. F3 첫 커밋에서 ESLint `no-restricted-imports`에 `@/server/*` 금지 규칙을 `src/ui/**`·`"use client"` 파일 대상으로 추가한다. `server-only` 패키지는 추가하지 않는다.
- **접속 분리:** 제품 코드는 `POD_DATABASE_URL`만 읽는다. migration(`POD_MIGRATE_DATABASE_URL`)과 시험 관리자(`POD_TEST_*`)는 읽지 않는다. 시험은 F2 하네스가 만든 `db.urls.app`으로 `new pg.Pool`을 만들어 함수에 넘긴다.
- **SQL:** 모든 값은 `$n` 매개변수로 넘긴다. 테이블·열 이름은 코드 상수로만 쓰고, 입력값으로 식별자를 조립하지 않는다.
- **사용자 ID의 출처:** 모든 도메인 함수는 `userId`를 첫 인자로 받는다. HTTP 헤더·URL·폼에서 사용자 ID를 읽는 코드는 F3에 없다(F1 `context.ts` 원칙 유지). 그 값은 F4 세션에서만 온다.

## 2. Slice ① 계정 해석 + 첫 성공 로그인 지급

[확정] 첫 성공 로그인에 canonical 계정당 감정덩어리 10개를 한 번 지급한다. 구매 1개 사용은 후속이며 F3에서 구현하지 않는다. 인증 공급자는 [미정]이다.

| 파일 | 공개 계약 |
|---|---|
| `app/src/server/account/login.ts` | `completeSuccessfulLogin(db: Db, identity: { provider: string; subject: string }): Promise<Result<LoginOutcome, "invalid_identity">>` |
| `app/src/server/credit/first-login-grant.ts` | `grantFirstLogin(tx: Tx, userId: string): Promise<{ granted: boolean; balance: number }>` (같은 트랜잭션 안에서만 호출) |
| `app/src/server/credit/balance.ts` | `getBalance(db: Db, userId: string): Promise<number>` (계정이 없으면 0) |

`type LoginOutcome = { userId: string; createdUser: boolean; granted: boolean; balance: number }`

`completeSuccessfulLogin`은 아래 전체를 **한 트랜잭션**으로 처리한다.

1. 입력 검사: `provider`는 `^[a-z][a-z0-9_-]{0,31}$`, `subject`는 1~255자. 틀리면 `invalid_identity`이며 DB에 접근하지 않는다.
2. `SELECT user_id FROM pod.auth_identities WHERE provider=$1 AND subject=$2`.
3. 없으면 `INSERT pod.users … RETURNING id`, 이어서 `INSERT pod.auth_identities … ON CONFLICT (provider, subject) DO NOTHING RETURNING user_id`.
   - 반환 행이 없으면 다른 연결이 먼저 만든 것이다(**계정 생성 경합**). 이번 트랜잭션 전체를 `ROLLBACK`해서 고아 user를 남기지 않는다. app role에는 users DELETE 권한이 없다.
   - 그 뒤 새 트랜잭션에서 2단계부터 **한 번만** 다시 시도한다. 두 번째도 실패하면 오류를 던진다.
4. `grantFirstLogin(tx, userId)`:
   1. `INSERT pod.credit_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`
   2. `SELECT balance FROM pod.credit_accounts WHERE user_id=$1 FOR UPDATE` — 같은 사용자의 지급을 직렬화한다.
   3. `INSERT pod.emotion_ledger (user_id, delta, reason, grant_key) VALUES ($1::uuid, 10, 'first_login_grant', 'first_login:' || $1::text) ON CONFLICT DO NOTHING RETURNING entry_id`(형 추론이 모호하지 않게 명시적으로 캐스트)
   4. 3단계에서 행이 들어갔을 때만 `UPDATE pod.credit_accounts SET balance = balance + 10, updated_at = now() WHERE user_id=$1`
5. `UPDATE pod.users SET first_login_at = now() WHERE id=$1 AND first_login_at IS NULL`.

보장되는 성질:
- 원장·잔액·`first_login_at`·user·identity는 모두 커밋되거나 모두 남지 않는다.
- 재시도해도 같은 결과다(`granted=false`, 잔액 10 유지).
- 지급 키는 사용자 ID로 정해지므로 기존 사용자별로 고정된다(F2 CHECK).

F4에 남기는 것:
- 이 함수를 실제 로그인 성공 사건에 연결한다. 연결과 지급 켜기는 같은 PR이다.
- 공급자 계정 여러 개를 한 사용자에 연결하는 정책 [미정].
- 세션 발급.

## 3. Slice ② 조각·하루 한 줄 CRUD

[가정] 시간대는 `Asia/Seoul`이다(DATA_CONTRACT §3). [확정] 개별 조각은 오늘과 지난 날 모두 수정할 수 있다. 사진·예시 이미지 저장은 [미정]이므로 PG 구현의 `image`는 항상 `null`이다.

**기존 port 호환:**
- `DiaryStore`(읽기)의 시그니처는 유지한다. 반환 타입에 아래 필드를 **추가**한다.
  - `DiaryMoment.version: number`
  - `DiaryDay.summaryVersion: number | null`
- `fixture.ts`·`store.memory.ts`·단위 시험은 같은 커밋에서 필드만 추가한다(값 1/`null`).
- 쓰기는 새 port에 둔다. 메모리 구현은 읽기 전용 그대로이며 쓰기 port를 구현하지 않는다.

| 파일 | 공개 계약 |
|---|---|
| `app/src/server/diary/store.ts` | 위 타입 추가 + `interface DiaryWriteStore` |
| `app/src/server/diary/store.pg.ts` | `createPgDiaryStore(db: Db, opts?: { now?: () => Date }): DiaryStore & DiaryWriteStore` |

`DiaryWriteStore`의 메서드(`MomentRef = { id: string; version: number }`):

| 메서드 | 반환 |
|---|---|
| `createMoment(userId, body)` | `Result<MomentRef, "invalid_body">` |
| `updateMoment(userId, id, expectedVersion, body)` | `Result<MomentRef, "invalid_body" \| "not_found" \| "conflict">` |
| `deleteMoment(userId, id, expectedVersion)` | `Result<null, "not_found" \| "conflict">` |
| `saveSummary(userId, date, expectedVersion: number \| null, body)` | `Result<{ version: number } \| null, "invalid_body" \| "invalid_date" \| "not_found" \| "conflict">` — 결과가 `null`이면 행이 삭제된 것 |

규칙:
- **본문:** 저장 전에 앞뒤 공백을 제거한다. 조각은 제거 후 1~300자다. 하루 한 줄은 제거 후 빈 값이면 **행 없음**(삭제)으로 처리하고, 그렇지 않으면 1~300자다. 길이는 `char_length` 기준(코드포인트)이며 DB CHECK와 같다.
- **작성 시각:** `occurred_at = now()`(주입된 시계)이고 `local_date = seoulLocalDate(occurred_at)`이다. 호출자는 날짜를 넘기지 않는다. 그래서 날짜와 시각이 어긋날 수 없고, 이를 시험으로 확인한다. 수정 시에는 시각과 날짜를 바꾸지 않는다.
- **`saveSummary` 날짜:** `parseLocalDate`를 통과해야 한다. 서울 기준 오늘보다 미래인 날짜는 `invalid_date`다. 이 미래 날짜 금지는 [권고→계약]이며, 지난 날 한 줄 작성 허용 여부를 메인이 검토한다.
  - `expectedVersion=null`이면 생성이다(`INSERT … ON CONFLICT DO NOTHING`). 이미 있으면 `conflict`다.
- **없음과 충돌 구분:** `UPDATE/DELETE … WHERE id=$ AND user_id=$ AND version=$` 결과가 0행이면 `SELECT 1 … WHERE id=$ AND user_id=$`로 같은 소유자 조건에서만 다시 조회한다. 행이 있으면 `conflict`, 없으면 `not_found`다.
  - 타인 ID, 삭제된 ID, uuid가 아닌 문자열은 모두 `not_found`로 같게 응답한다. 존재 여부를 드러내지 않는다.
- **읽기:**
  - `getDay`는 조각을 `occurred_at, id` 순으로 돌려준다. `time = to_char(occurred_at AT TIME ZONE time_zone, 'HH24:MI')`다. 조각도 한 줄도 없으면 `null`이다.
  - `listMonth`는 `local_date >= 월초 AND < 다음 월초` 범위를 매개변수로 조회한다.
- 비로그인은 F3 함수 경계에 없다. `userId`가 없는 호출은 F4 세션 계층이 막는다. F3 시험은 "임의 uuid 사용자 = 아무것도 없음"으로 검사한다.

## 4. Slice ③ 개인 꾸미기 manifest·버전·기록 글꼴

[확정] 개인용 하루 꾸미기 Lite, D UI·테마 고정, 폰트 키 `gothic|serif|hand`. 마켓·게시는 후속이다.

| 파일 | 공개 계약 |
|---|---|
| `app/src/shared/manifest.ts` | 아래 4개 공개 계약. 클라이언트 편집기(F5)와 함께 쓰므로 순수 함수만 둔다 |
| `app/src/server/decoration/store.pg.ts` | `saveDesignVersion(db, userId, input: unknown): Promise<Result<{ id: string; createdAt: Date }, "invalid_manifest">>`, `listDesignVersions(db, userId, limit = 20)`, `getDesignVersion(db, userId, id): Promise<Manifest \| null>` |
| `app/src/server/account/preferences.pg.ts` | `getPreferences(db, userId): Promise<{ fontKey: FontKey; appliedDesignVersionId: string \| null }>`(행이 없으면 `gothic`/`null`), `setFontKey(db, userId, key: unknown): Promise<Result<FontKey, "invalid_font">>`, `applyDesign(db, userId, versionId: string \| null): Promise<Result<null, "not_found">>` |

`manifest.ts`의 공개 계약:
- `type Manifest`
- `MANIFEST_LIMITS`
- `validateManifest(input: unknown): Result<Manifest, "invalid_manifest"> & { issues?: string[] }`
- `manifestForRender(input: unknown): Manifest | null` — 오류가 있으면 `null`을 돌려주고, 화면은 기본 D를 렌더한다.

규칙:
- 저장할 때마다 새 행을 만든다. 갱신 경로는 없다. app role에 UPDATE 권한이 없다는 F2 계약에 기댄다.
- `applyDesign`은 먼저 같은 소유자 조건으로 버전을 조회한다. 없으면 `not_found`다. 그 뒤 `INSERT … ON CONFLICT (user_id) DO UPDATE SET applied_design_version_id`로 적용한다. 복합 FK는 마지막 방어선이다. `null`이면 기본 D로 되돌린다.
- `setFontKey`는 `parseFontKey`(F1)로 검사하고 `font_key`만 갱신한다. `applyDesign`도 적용 값만 갱신한다. **둘은 서로의 열을 건드리지 않는다.**

**manifest v1 고정값 [권고→계약, 메인 검토]** — 출처: DECORATION_MARKET_ARCHITECTURE §3.2~§3.4. 문서에 수치가 없던 것은 *표시했다.

| 항목 | 값 |
|---|---|
| 최상위 | `{ schema: 1, base: "d-warm-pieces@1", placements: [], ink: [] }`. 모르는 키는 저장 거부(엄격) |
| 크기* | `JSON.stringify` 결과 UTF-8 64 KiB 이하 |
| 슬롯 | `board.backdrop`·`oneline.tape`·`empty.illust` 각 최대 1개, `board.corner` 최대 2개, `piece.sticker` 최대 1개 |
| placement 공통 | `asset`은 `^builtin:[a-z0-9-]{1,32}$`* 형식이다. 허용 목록은 F5가 정한다. F3는 형식만 검사하고, 목록 주입 인자를 둔다 |
| placement 위치 | `x`·`y`는 0~1, `max_w`는 0초과~1, `rotate`는 −15~15 정수, `anchor`는 `start\|end`, `hide_below`는 `375\|768\|1100` 중 하나(선택) |
| `piece.sticker` | `corner`는 `top-start\|top-end\|bottom-start\|bottom-end`, `every`는 1~12 정수* |
| ink 슬롯 | `board.corner`·`empty.illust`만 |
| ink 색·굵기 | `color`는 `ink\|accent\|muted\|focus`, `width`는 `2\|4\|8`* |
| 획·점 상한* | 획 최대 200개, 획당 점 2~500개, 전체 점 최대 5,000개, 각 점은 `[x, y]`(0~1) |
| 숫자 | 유한한 숫자만 허용한다(`NaN`·`Infinity` 거부) |

- 사용자 HTML·CSS·JS나 폰트 필드는 없다. 이미지 파일 포맷이나 마켓 프로토콜은 정하지 않는다.
- 렌더(`manifestForRender`)는 저장보다 관대하다. 저장 검증은 통과했지만 렌더러가 모르는 slot 하나는 **그 항목만 무시**한다. 구조 오류가 있으면 전체를 `null`로 처리한다.

## 5. 시험 계약

공통:
- DB 시험은 F2의 `tests/db/helpers.ts`(`createDisposableDatabase`·`dropDisposableDatabase`·`cleanupAll`)와 F2 시험 지원(`lazyMigrated`·`withOwner`·`expectSqlError`)을 재사용한다. 파일마다 일회용 DB를 쓰고 migration 실행기 CLI로 `up`한다.
- 도메인 함수에는 `db.urls.app`으로 만든 `pg.Pool`을 넘긴다. 슈퍼유저나 owner로 대신 시험하지 않는다.
- **실패 주입:** 제품 코드에 시험용 플래그를 넣지 않는다. 시험이 자기 일회용 DB에 `withOwner`로 **시험 전용 트리거**를 만든다. 예: `BEFORE UPDATE ON pod.users`가 `RAISE EXCEPTION`을 내게 한 뒤 호출해서 원자성을 확인하고, 그 DB는 파일이 끝날 때 삭제된다.

| 파일 (신규) | 핵심 사례 |
|---|---|
| `app/tests/unit/seoul-date.test.ts` | `2026-11-01T14:59:59Z`→`2026-11-01`, `15:00:00Z`→`2026-11-02`, 월말·연말, `HH:MM` |
| `app/tests/unit/manifest.test.ts` | 최소 유효 manifest, 표 §4의 각 경계(통과/실패 양쪽), 모르는 키 거부, 64 KiB 경계, 렌더 관대성 |
| `app/tests/unit/server-boundary.test.ts` | `src/server/credit/**`에 `UPDATE pod.emotion_ledger`·`DELETE FROM pod.emotion_ledger`·`TRUNCATE`가 없음(정적 검사), 제품 코드가 `POD_TEST_`·`POD_MIGRATE_`를 읽지 않음 |
| `app/tests/db/f3-login-grant.test.ts` | 아래 ①의 사례 |
| `app/tests/db/f3-diary.test.ts` | 아래 ②의 사례 |
| `app/tests/db/f3-decoration-preferences.test.ts` | 아래 ③의 사례 |
| `app/tests/db/f3-support.ts` | app Pool 생성·종료, 원장 합계 조회(`SUM(delta)`·`balance`) |

**① 로그인·지급**
- 새 identity → `createdUser=true`, `granted=true`, 잔액 10, 원장 1행, `first_login_at`이 채워진다.
- 같은 identity를 다시 호출 → `granted=false`, 잔액 10, 원장 1행(재시도 멱등).
- 같은 identity로 **app role 연결 8개를 동시에** 호출 → 모두 같은 `userId`, `granted=true`는 정확히 1회, users·identities·원장 각 1행, 잔액 10.
- 서로 다른 identity 2개를 동시에 호출 → 서로 독립적으로 각각 10.
- 실패 주입(users 갱신 단계 / credit 갱신 단계): 오류가 전파되고 user·identity·계정·원장·`first_login_at`이 하나도 남지 않는다.
- 모든 사례 끝에 `SUM(delta) = balance`를 확인한다. F2 권한 회귀로 app role의 원장 `UPDATE`·`DELETE`는 `42501`이어야 한다.
- 잘못된 `provider`·`subject`는 `invalid_identity`이고 DB 행이 늘지 않는다.

**② 조각·하루 한 줄**
- 작성 후 `getDay`로 읽으면 시각·순서·`version=1`이 맞다. 경계 시각(`14:59:59Z` / `15:00:00Z`)의 `local_date`를 확인한다.
- 본문: 300자 통과, 301자·공백만 있는 본문은 `invalid_body`.
- 수정: 버전이 맞으면 `version=2`. 낡은 버전이면 `conflict`. 타인·삭제됨·임의 문자열 ID는 `not_found`(셋의 응답이 같다).
- 삭제도 같은 규칙이다. 타인의 `getDay`·`listMonth`는 `null`·`[]`.
- 한 줄: 생성 / 중복 생성 `conflict` / 수정 / 빈 값 → 행 삭제 후 `summary=""`·`summaryVersion=null` / 미래 날짜 `invalid_date`.

**③ 꾸미기·글꼴**
- 유효 manifest 저장 → 새 id, 두 번 저장하면 두 행(불변). 잘못된 manifest는 `invalid_manifest`이고 행이 늘지 않는다.
- 본인 버전 적용 OK, 타인 버전·없는 id는 `not_found`, `null`이면 해제.
- `setFontKey("serif")` 뒤 적용 값은 그대로이고, `applyDesign` 뒤 글꼴도 그대로다. `"comic"`은 `invalid_font`.

## 6. TDD 순서·명령

slice마다 다음 순서로 진행한다: **RED 커밋 → 독립 runner로 실패 이유 확인 → GREEN 커밋.**
- RED 커밋은 `.claude/tdd.conf`의 `TEST_PATTERNS`(`app/tests/*`, `app/vitest*.ts` 등)만 바꾼다.
- GREEN 커밋은 제품 파일만 바꾼다. 시험 파일은 건드리지 않는다.
- `TEST_PATTERNS`에 제품 경로를 넣지 않는다.

| 단계 | 명령 (저장소 루트) | 예상 |
|---|---|---|
| ①RED | `npm --prefix app test -- tests/unit/seoul-date.test.ts tests/unit/server-boundary.test.ts` | 새 모듈을 찾지 못해 해당 파일 실패. 기존 단위 시험은 baseline 그대로 통과 |
| ①RED | `npm --prefix app run test:db -- tests/db/f3-login-grant.test.ts` | import 실패로 파일 실패. F2 DB 시험은 그대로 통과 |
| ①GREEN | 위 두 명령 + `npm --prefix app run lint && npm --prefix app run typecheck` | 새 사례 전부 통과 |
| ②RED/GREEN | `… test:db -- tests/db/f3-diary.test.ts` (+ 기존 `tests/unit/diary-memory-store.test.ts`) | RED: `DiaryWriteStore` import 실패 / GREEN: 통과, 메모리 시험 유지 |
| ③RED/GREEN | `… test -- tests/unit/manifest.test.ts`, `… test:db -- tests/db/f3-decoration-preferences.test.ts` | 같은 형태 |
| 각 slice 끝 | `bash app/tests/full-check.sh` | 전체 통과 |

- DB 시험 환경 변수는 일회용 PG18 컨테이너에서만 쓴다: `POD_TEST_DB_DISPOSABLE=1`, `POD_TEST_ADMIN_URL=postgres://postgres:…@127.0.0.1:<port>/postgres`. `full-check.sh`에는 추가로 `POD_FULL_CHECK_ISOLATED=1`이 필요하다.
- Cloud에서 Docker를 쓸 수 없으면 GitHub CI `db` job 결과로 판정한다. 공용·실서버 DB는 대신 쓰지 않는다.
- 숫자: 아직 실제 시험 수는 없다.
  - RED 보고에는 "새 파일 k개 실패(사유: 모듈 없음), baseline unit U·DB D 통과"를 적는다.
  - GREEN 보고에는 "unit U+u·DB D+d 통과"를 적는다.
  - U·D는 F2 통합 dev SHA에서 동결한다.

## 7. 배포·호환·복귀

- 배포·DB 프로비저닝은 없다. dev 도메인은 정적 화면을 유지한다. F3 코드는 어떤 경로에서도 호출되지 않는다(`getAppDb`를 쓰는 곳 없음). 앱 접속은 F6에서 한다.
- F1 fixture 모드는 그대로 동작해야 한다(F1 E2E 유지).
- 복귀는 slice 커밋 단위 revert로 한다. 새 migration이 없으므로 DB 쪽 복귀 절차는 필요 없다.

## 8. 미정·검토 요청

| 항목 | 상태 |
|---|---|
| 인증 공급자, 다중 identity 연결, 세션 | [미정] — F4. F3는 `(provider, subject)` 중립 입력만 받는다 |
| 지난 날짜 한 줄 작성 허용 | [권고→계약] 미래 날짜만 금지 — 메인 검토 |
| manifest 상수(* 표시), 스티커 허용 목록 | [권고→계약] — 메인 검토. 목록 확정은 F5·라이선스(G5) |
| 개인 버전 보관 개수·삭제 | [미정] — F3는 삭제 경로 없음 |
| 사진·예시 이미지 저장, 잔액 표시, 탈퇴 | [미정] |
| 사용자별 시간대 | [가정] `Asia/Seoul` 고정 |
