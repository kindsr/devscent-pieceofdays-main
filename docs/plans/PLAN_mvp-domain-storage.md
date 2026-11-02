# PLAN — F3 도메인·PostgreSQL 저장 (공급자 중립)

- 상태: **slice ①·② 구현·CI 검증 완료. slice ③은 계획.** 실행 결과는 §9·§10에 기록한다.
- 기준: `dev` `d4d1b5c`. F2가 통합됐고 CI·개발 자동배포·컨테이너/HTTPS 검증까지 끝났다.
  - 실서버 DB는 없고, 앱은 정적 dev에 연결돼 있지 않다.
  - **F3 baseline(동결): 단위 71 · DB 57 · Node 24/26 prod 6·E2E 12 · root 42.**
- 상위 문서: [PLAN_mvp-foundation](PLAN_mvp-foundation.md) F3/F4, [PLAN_mvp-database](PLAN_mvp-database.md), [DATA_CONTRACT](../product/DATA_CONTRACT.md), [03_MVP](../product/03_MVP.md), [DECORATION_MARKET_ARCHITECTURE](../product/DECORATION_MARKET_ARCHITECTURE.md) §3·§5·§7, [디자인 핸드오프](../design/README.md).
- 표기:
  - **[확정]** 사용자·상위 문서가 정한 것
  - **[가정]** 기존 가정
  - **[기본값]** 메인이 수락한 기술 기본값(사용자 선택이 아님)
  - **[미정]** 결정 필요
- PR19 독립 검토의 차단 B1~B5를 반영했다(§6·§3·§1·§1·§2~§4).

## 0. 범위

| F3에서 한다 | F3에서 하지 않는다 (남기는 곳) |
|---|---|
| 공급자 중립 계정 해석 + 첫 성공 로그인 10개 지급 함수(원자적) | 실제 OAuth·세션·HTTP 연결, 로그인 사용자에게 지급 켜기 (**F4**, grant와 같은 PR) |
| 조각·하루 한 줄 CRUD, 소유권, 낙관적 잠금, 서울 날짜 | 화면 저장 연결·삭제 UI·편집기 (**F5**) |
| manifest 검증, 개인 버전 불변 저장, 본인 적용, 기록 글꼴 저장 | Konva 편집기·렌더러의 D 안전 영역 clip·스티커 registry (**F5**), 마켓·구매·정산 (후속) |
| UI 공유 타입 분리 + client→server import lint 경계 | 전이 import 전체 보장(F4/F5에서 강화), DB 프로비저닝·배포 (**F6**) |

원칙:
- 새 ORM·의존성·Redis·큐는 없다. 이미 고정된 `pg`와 `eslint`만 쓴다.
- 기존 port(`DiaryStore`)를 우선한다. DI는 DB 핸들과 시계만 받는다.
- **F2 스키마·권한 계약은 바꾸지 않고, 새 migration도 없다.** migration이 필요하다고 증명되면 멈추고 메인에 올린다.
- [확정] 감정덩어리 10개는 계정당 한 번이다. 구매 사용은 후속이다. D UI·테마는 고정이고 글꼴 키는 `gothic|serif|hand`다.
- [미정] 인증 공급자·사진·공유·스티커 라이선스. [가정] `Asia/Seoul`.

## 1. 공통 기반과 경계 (slice ① GREEN에 포함)

| 파일 | 공개 계약 |
|---|---|
| `app/src/server/db/pool.ts` | `type Db = pg.Pool`, `type Tx = pg.PoolClient`, `getAppDb(): Db`, `withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>` |
| `app/src/server/result.ts` | `type Result<T, E extends string> = { ok: true; value: T } \| { ok: false; error: E }` |
| `app/src/server/ids.ts` | `isUuid(value: unknown): value is string` |
| `app/src/shared/local-date.ts` (추가) | `seoulLocalDate(instant: Date): LocalDate`, `seoulTime(instant: Date): string` (`HH:MM`) |
| `app/src/shared/diary.ts` (신규, B4) | UI 공유 타입(§3에서 정의) |
| `app/src/server/diary/store.ts` | `shared/diary.ts` 타입을 재export하고 `DiaryWriteStore`를 정의한다 |
| `app/src/server/context.ts` | `DiaryContext` 타입을 `shared/diary.ts`에서 재export한다. `getDiaryContext` 동작은 그대로다 |
| UI 4곳: `app/src/ui/d/{DayBoard,MonthCalendar,DaysView}.tsx`, `app/src/ui/d/sample-images.ts` | `import type` 경로만 `@/shared/diary`로 바꾼다. 스타일·동작은 바꾸지 않는다 |
| `app/eslint.config.mjs` | 아래 lint 경계 |

- `getAppDb`는 `POD_DATABASE_URL`을 읽어 지연 생성하고, 없으면 오류를 낸다. F3에서는 아무 곳에서도 호출하지 않는다.
- `withTransaction`은 `BEGIN`·`COMMIT`을 하고, 오류가 나면 `ROLLBACK` 후 다시 던진다. 격리 수준은 Read Committed다.
- **환경 변수 [계약]:** F3 신규 제품 모듈(`server/db/pool.ts`, `server/{account,credit,diary,decoration}/**`) 가운데 env를 읽는 곳은 `pool.ts`의 `POD_DATABASE_URL` 하나다. F2 migration CLI의 `POD_MIGRATE_DATABASE_URL`는 별개이고 바꾸지 않는다. 이 계약은 grep 시험으로 보장하지 않고 리뷰에서 확인한다.
- **SQL:** 값은 모두 `$n` 매개변수다. 식별자는 코드 상수로만 쓰고 입력으로 조립하지 않는다.
- **사용자 ID의 출처:** `userId`는 함수 인자로만 받는다. HTTP 헤더·URL·폼에서 사용자 ID를 읽는 코드는 없다. 실제 값은 F4 세션에서만 온다.
- **원장 보호의 근거:** F2 권한(`42501`)과 트리거(`P0001`), F3 DB 회귀 시험이다. 원장 SQL 문자열을 grep하는 시험은 두지 않는다.

**lint 경계 (B4, 선택 (a)):** `no-restricted-imports`는 flat config에서 뒤에 선언한 블록이 이기므로, Konva 금지와 server 금지를 같은 블록에 합성한다.

| 파일 범위 | 규칙 |
|---|---|
| `**/*.{ts,tsx}` (기존 블록, decorate 제외) | Konva 금지. **유지** |
| `src/ui/**`, `src/shared/**` (decorate 제외) | Konva 금지 + server 금지(alias `@/server`·`@/server/**`, 상대 경로 `…/server/**`, 타입 import 포함) |
| `src/ui/decorate/**` | Konva 허용 + server 금지 |
| `src/app/**` (서버 컴포넌트) | 기존대로 server import 허용 |

한계:
- ESLint `files`는 파일 내용(`"use client"`)으로 대상을 고를 수 없다. 그래서 경로로만 막는다.
- `ui → shared → server` 같은 전이 import는 lint만으로 보장되지 않는다. F3 코드는 UI에 연결되지 않는다. **실제 HTTP 연결 전에 F4/F5에서 강화 검증한다**(안전이 보장됐다고 쓰지 않는다).

## 2. Slice ① 계정 해석 + 첫 성공 로그인 지급

| 파일 | 공개 계약 |
|---|---|
| `app/src/server/account/login.ts` | 아래 `completeSuccessfulLogin` |
| `app/src/server/credit/first-login-grant.ts` | `grantFirstLogin(tx: Tx, userId: string): Promise<{ granted: boolean; balance: number }>`(같은 트랜잭션에서만 호출) |
| `app/src/server/credit/balance.ts` | `getBalance(db: Db, userId: string): Promise<number>`(계정 없음·비UUID → 0, 비UUID는 SQL 없이) |

```ts
type LoginIdentity = { provider: string; subject: string };
type LoginOutcome = { userId: string; createdUser: boolean; granted: boolean; balance: number };
completeSuccessfulLogin(db: Db, identity: LoginIdentity): Promise<Result<LoginOutcome, "invalid_identity">>;
```

- identity의 출처는 **F4에서 검증한 서버 인증 사건뿐이다.** 사용자가 보낸 HTTP 값으로 호출하는 경로는 없다.
- 한 트랜잭션에서 아래 순서로 처리한다.
  1. `provider`는 `^[a-z][a-z0-9_-]{0,31}$`, `subject`는 1~255자인지 확인한다. 틀리면 `invalid_identity`이고 SQL은 실행하지 않는다.
  2. `SELECT user_id FROM pod.auth_identities WHERE provider=$1 AND subject=$2`.
  3. 없으면 `INSERT pod.users … RETURNING id`, 이어서 `INSERT pod.auth_identities … ON CONFLICT (provider, subject) DO NOTHING RETURNING user_id`.
     - 반환 행이 없으면 다른 연결과의 생성 경합이다. 트랜잭션 전체를 `ROLLBACK`해 고아 user를 남기지 않는다. app role에는 users DELETE 권한이 없다.
     - 그 뒤 **새 트랜잭션에서 2단계부터 한 번만** 다시 시도한다. 그래도 실패하면 오류를 던진다.
  4. `grantFirstLogin`:
     1. `INSERT pod.credit_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING`
     2. `SELECT balance … WHERE user_id=$1::uuid FOR UPDATE` — 같은 사용자의 지급을 직렬화한다.
     3. `INSERT pod.emotion_ledger (user_id, delta, reason, grant_key) VALUES ($1::uuid, 10, 'first_login_grant', 'first_login:' || $1::uuid::text) ON CONFLICT DO NOTHING RETURNING entry_id` — 매개변수를 한 가지 형(uuid)으로만 캐스트한다.
     4. 삽입된 경우에만 `UPDATE pod.credit_accounts SET balance = balance + 10, updated_at = now() WHERE user_id=$1::uuid`.
  5. `UPDATE pod.users SET first_login_at = now() WHERE id=$1::uuid AND first_login_at IS NULL`.
- 결과: 원장·잔액·`first_login_at`·user·identity가 모두 커밋되거나 모두 남지 않는다. 재호출하면 `granted=false`이고 잔액은 10이다.
- F4에 남기는 것: 실제 로그인에 연결하고 지급 켜기(같은 PR), 세션, 여러 identity 연결 정책 [미정].

## 3. Slice ② 조각·하루 한 줄 CRUD

[확정] 조각은 오늘과 지난 날 모두 수정할 수 있다. [미정] 사진·예시 이미지 저장 → PG 구현의 `image`는 항상 `null`이다.

```ts
// app/src/shared/diary.ts — slice ① GREEN에서 이동(필드 그대로), slice ② GREEN에서 version 필드 추가
import type { LocalDate } from "./local-date";
export type SampleImageKey = "window" | "noodle" | "ginkgo";
export type DiaryMoment = { id: string; time: string; text: string; image: SampleImageKey | null; version: number };       // version: ②
export type DiaryDay = { date: LocalDate; summary: string; summaryVersion: number | null; moments: DiaryMoment[] };    // summaryVersion: ②
export interface DiaryStore { getDay(userId: string, date: LocalDate): Promise<DiaryDay | null>; listMonth(userId: string, year: number, month: number): Promise<DiaryDay[]> }
export type DiaryContext = { kind: "fixture"; userId: string; store: DiaryStore; today: string } | { kind: "unavailable" };

// app/src/server/diary/store.ts
export type MomentRef = { id: string; version: number };
export interface DiaryWriteStore {
  createMoment(userId: string, body: string): Promise<Result<MomentRef, "invalid_body" | "not_found">>;
  updateMoment(userId: string, id: string, expectedVersion: number, body: string):
    Promise<Result<MomentRef, "invalid_body" | "invalid_version" | "not_found" | "conflict">>;
  deleteMoment(userId: string, id: string, expectedVersion: number):
    Promise<Result<null, "invalid_version" | "not_found" | "conflict">>;
  saveSummary(userId: string, date: string, expectedVersion: number | null, body: string):
    Promise<Result<{ version: number } | null, "invalid_body" | "invalid_date" | "invalid_version" | "not_found" | "conflict">>;
}
// app/src/server/diary/store.pg.ts
export function createPgDiaryStore(db: Db, opts?: { now?: () => Date }): DiaryStore & DiaryWriteStore;
```

**쓰기 검증 순서 [기본값]** — 앞 단계에서 걸리면 SQL을 실행하지 않는다.
1. `userId`가 UUID가 아님 → `not_found`
2. `id`가 UUID가 아님 → `not_found`
3. `expectedVersion`이 안전한 정수 ≥ 1이 아님 → `invalid_version`. 한 줄 생성 때만 `null`을 허용한다.
4. `date`가 `parseLocalDate`에 실패하거나 서울 오늘보다 미래 → `invalid_date`. 지난 날은 허용한다.
5. 본문: `String.prototype.trim()` 후 코드포인트 수(`[...s].length`, DB `char_length`와 같다)가 조각은 1~300, 한 줄은 0~300이어야 한다. 아니면 `invalid_body`다. 저장하는 값도 trim한 결과다.
6. SQL. 정상 UUID지만 없는 사용자는 FK 오류(23503)를 `not_found`로 바꾼다. raw 오류는 밖으로 내보내지 않는다. 한 줄의 `null`+빈 본문 no-op도 사용자가 없으면 `not_found`다.

**규칙:**
- 작성: `occurred_at = now()`(주입된 시계), `local_date = seoulLocalDate(occurred_at)`. 호출자는 날짜를 넘기지 않는다. 수정할 때는 시각·날짜를 바꾸지 않는다.
- 없음과 충돌: `UPDATE/DELETE … WHERE id AND user_id AND version`이 0행이면 같은 소유자 조건으로만 다시 조회한다. 행이 있으면 `conflict`, 없으면 `not_found`다. 타인·삭제됨·비UUID는 모두 `not_found`로 같다.
- `saveSummary`:

  | expectedVersion | 본문 | 기존 행 없음 | 기존 행 있음 |
  |---|---|---|---|
  | `null` | 비어 있지 않음 | INSERT → `{version:1}` | `conflict` |
  | `null` | 빈 값 | `ok(null)` no-op | `conflict`(버전 없이 삭제하지 않음) |
  | `n` | 비어 있지 않음 | `not_found` | 버전 일치 시 UPDATE, 불일치 시 `conflict` |
  | `n` | 빈 값 | `not_found` | 버전 일치 시 DELETE → `ok(null)`, 불일치 시 `conflict` |

- 읽기:
  - `getDay`는 `occurred_at, id` 순이고 `time = to_char(occurred_at AT TIME ZONE time_zone, 'HH24:MI')`다. 조각과 한 줄이 모두 없으면 `null`이다. 날짜가 잘못됐거나 `userId`가 비UUID면 SQL 없이 `null`이다.
  - `listMonth`는 `[월초, 다음 월초)`를 매개변수로 조회한다. `year`가 정수 1~9999, `month`가 정수 1~12가 아니거나 비UUID면 `[]`다.

## 4. Slice ③ 개인 꾸미기 manifest·버전·기록 글꼴

```ts
// app/src/shared/manifest.ts — 순수 함수만(F5 편집기와 공유)
type Anchor = "start" | "end";
type Breakpoint = 375 | 768 | 1100;
type GeneralPlacement = { slot: "board.backdrop" | "board.corner" | "oneline.tape" | "empty.illust";
  asset: string; anchor: Anchor; x: number; y: number; max_w: number; rotate: number; hide_below?: Breakpoint };
type StickerPlacement = { slot: "piece.sticker"; asset: string;
  corner: "top-start" | "top-end" | "bottom-start" | "bottom-end"; every: number; hide_below?: Breakpoint };
type InkStroke = { slot: "board.corner" | "empty.illust"; anchor: Anchor;
  color: "ink" | "accent" | "muted" | "focus"; width: 2 | 4 | 8; points: [number, number][] };
export type Manifest = { schema: 1; base: "d-warm-pieces@1"; placements: (GeneralPlacement | StickerPlacement)[]; ink: InkStroke[] };
export type ManifestOpts = { allowedAssets?: ReadonlySet<string> };   // 기본 = 빈 집합
export const MANIFEST_LIMITS: { maxBytes: 65536; maxPlacementsPerSlot: Record<string, number>; maxStrokes: 200; maxPointsPerStroke: 500; maxPoints: 5000 };
export function validateManifest(input: unknown, opts?: ManifestOpts):
  { ok: true; value: Manifest } | { ok: false; error: "invalid_manifest"; issues: string[] };
export function manifestForRender(input: unknown, opts?: ManifestOpts): Manifest | null;   // null → 기본 D
```

**고정값 [기본값, 메인 수락]** — 정본 §3.2~§3.4의 수치를 구현값으로 채택한다.

| 항목 | 값 |
|---|---|
| 최상위 | 4개 키 모두 필수(`placements`·`ink`는 빈 배열 가능). 다른 키는 없다 |
| 크기 | `JSON.stringify` 결과 UTF-8 ≤ 65,536바이트. 순환 참조·BigInt 등으로 stringify가 실패하면 `invalid_manifest`이며 예외를 밖으로 내보내지 않는다 |
| placement 개수(슬롯별) | `board.corner` 2개, 나머지 슬롯 각 1개 |
| 일반 placement | `x`·`y` 0~1, `max_w` 0초과~1, `rotate` −15~15 정수 |
| `piece.sticker` | `every` 1~12 정수. `x`·`y`·`max_w`·`rotate`·`anchor`는 허용하지 않는다 |
| 공통 | 모든 placement에 `hide_below`(선택)를 쓸 수 있다. 숫자는 유한값만 허용한다 |
| ink | 슬롯은 `board.corner`·`empty.illust`. 획 ≤ 200, 획당 점 2~500, 전체 점 ≤ 5,000, 점은 `[x, y]`(0~1). placement 개수 상한과는 별개로 센다 |
| asset | `^builtin:[a-z0-9-]{1,32}$` 형식이면서 `allowedAssets`에 들어 있어야 한다. 이 형식은 정본 예시 `ast_…`(업로드 에셋)를 **업로드가 없는 MVP 기본 세트로 좁힌 것**이다 |

asset 허용 목록:
- 기본값이 빈 목록이므로 asset을 배치하면 거부된다. 펜만 쓴 manifest는 유효하다.
- F5가 검증한 registry를 서버·편집기 설정으로 주입한다. 허용 목록을 HTTP 사용자 값으로 받지 않는다.

**렌더 정책 (`manifestForRender`)**
- 다음은 전체 `null`(기본 D)이다: 모르는 `schema`/`base`, 루트 구조 오류, 알려진 항목의 잘못된 수치·형식.
- 다음은 그 항목만 버린다: 모르는 slot, 허용 목록에 없는 asset.
- D 안전 영역으로 자르는(clip) 처리는 F5 렌더러가 한다.

```ts
// app/src/server/decoration/store.pg.ts
saveDesignVersion(db: Db, userId: string, input: unknown, opts?: ManifestOpts):
  Promise<Result<{ id: string; createdAt: Date }, "invalid_manifest" | "not_found">>;      // 저장 = 형식 + 목록 모두 검사, 새 행만
listDesignVersions(db: Db, userId: string, limit?: number): Promise<{ id: string; createdAt: Date }[]>;
getDesignVersion(db: Db, userId: string, id: string, opts?: ManifestOpts): Promise<Manifest | null>;
// app/src/server/account/preferences.pg.ts
getPreferences(db: Db, userId: string): Promise<{ fontKey: FontKey; appliedDesignVersionId: string | null }>;
setFontKey(db: Db, userId: string, key: unknown): Promise<Result<FontKey, "invalid_font" | "not_found">>;
applyDesign(db: Db, userId: string, versionId: string | null): Promise<Result<null, "not_found">>;
```

- `listDesignVersions`: 정렬은 `created_at DESC, id DESC`. `limit` 기본값은 20이며, 정수 1~100이 아니면 20을 쓴다. 비UUID 사용자는 `[]`다.
- `getDesignVersion`: 같은 소유자 조건으로 조회한 뒤 `manifestForRender` 결과를 돌려준다.
- `getPreferences`: 행이 없거나 사용자가 비UUID면 `gothic`/`null`이다.
- 쓰기 3종(`saveDesignVersion`·`setFontKey`·`applyDesign`):
  - 비UUID 사용자와 없는 사용자는 `not_found`다. FK 오류(23503)는 밖으로 내보내지 않는다.
  - `setFontKey`는 `parseFontKey`(F1) 결과가 `null`이면 `invalid_font`다.
  - `applyDesign`은 먼저 소유자 조건으로 버전을 조회하고, 없으면 `not_found`다. 그 뒤 `INSERT … ON CONFLICT (user_id) DO UPDATE SET applied_design_version_id`로 적용하며 복합 FK는 마지막 방어선이다. `null`이면 해제한다.
  - 글꼴과 적용 값은 서로의 열을 건드리지 않는다.

## 5. 시험 계약

공통:
- F2 하네스(`tests/db/helpers.ts`, `tests/db/f2-support.ts`의 `lazyMigrated`·`withOwner`·`expectSqlError`)를 재사용한다. 도메인 함수에는 `db.urls.app`으로 만든 `pg.Pool`을 넘긴다.
- **실패 주입:** 제품 코드에 시험용 플래그를 넣지 않는다. 시험이 `withOwner`로 시험 전용 트리거를 만들고 `try/finally`에서 `DROP TRIGGER`한다. 그렇게 할 수 없으면 사례마다 일회용 DB를 쓴다.

| 파일 (신규·변경) | slice | 핵심 사례 |
|---|---|---|
| `tests/unit/client-boundary.test.ts` (신규) | ① | 아래 ①-a |
| `tests/unit/seoul-date.test.ts` | ①·② | 서울 자정·월말·연말·`HH:MM`. ② RED에서 IANA 과거 이력 두 사례를 보강 |
| `tests/db/f3-login-grant.test.ts` (신규) | ① | 아래 ①-b |
| `tests/unit/diary-memory-store.test.ts` (**RED에서 변경**) | ② | B2 정리만. 새 사례는 없고 기존 4건은 계속 통과 |
| `tests/db/f3-diary.test.ts` (신규) | ② | 아래 ② |
| `tests/unit/manifest.test.ts` (신규) | ③ | §4 표 각 경계의 통과/실패, 엄격 키, 64 KiB, 순환 참조, 렌더 정책, 허용 목록 |
| `tests/db/f3-decoration-preferences.test.ts` (신규) | ③ | 아래 ③ |
| `tests/db/f3-support.ts` (신규) | ① | app Pool 생성·종료, `SUM(delta)`와 `balance` 조회 |

**①-a client-boundary (ESLint `lintText`):**
- 이미 고정된 `eslint`의 `new ESLint({ cwd: APP_DIR })`를 쓴다. 가상 `filePath`로 예제 코드를 lint한다. 파일·DB·서버를 만들거나 grep으로 대신하지 않는다.
- 오류(`no-restricted-imports`)가 나야 하는 경우:
  - `src/ui/d/x.tsx`의 `import type { DiaryDay } from "@/server/diary/store"`
  - `src/ui/d/x.tsx`의 `import … from "../../server/diary/store"`
  - `src/shared/x.ts`의 `import … from "../server/ids"`
  - `src/ui/decorate/x.tsx`의 `@/server/...` import
- 양성 제어(같은 `it` 안에서 확인):
  - `src/ui/d/x.tsx`의 `konva` import는 여전히 오류다.
  - `src/ui/decorate/x.tsx`의 `konva`는 허용된다.
  - `src/app/x.tsx`의 `@/server/context`는 허용된다.
  - `src/ui/d/x.tsx`의 `@/shared/diary`는 허용된다.
- 위험: 가상 경로가 타입 기반 lint에 걸려 lint 자체가 실패하면 그것은 RED가 아니라 환경 실패다. 이 경우 멈추고 메인에 보고한다.
- ESLint 설정 첫 로드를 고려해 각 lint fixture 시험의 제한은 30초로 둔다. 시간 초과도 환경 실패로 구분한다.

**①-b 로그인·지급:**
- 새 identity → `createdUser=true`, `granted=true`, 잔액 10, 원장 1행, `first_login_at`이 채워진다.
- 재호출 → `granted=false`, 잔액 10.
- 같은 identity로 **app role 연결 8개를 동시에** 호출 → 모두 같은 userId, `granted=true`는 정확히 1회, users·identity·원장 각 1행, 잔액 10.
- 서로 다른 identity 2개를 동시에 → 각각 10.
- 실패 주입 — 새 identity:
  - users 갱신 단계 또는 credit 갱신 단계에서 실패시킨다.
  - user·identity·계정·원장·`first_login_at`이 아무것도 남지 않는다.
- 실패 주입 — 기존 identity(user·identity를 owner로 미리 커밋하고 지급은 안 된 상태):
  - credit 갱신 단계에서 실패시킨다.
  - 이미 있던 user·identity(와 계정이 있었다면 그 잔액)는 그대로이고, 새 변경은 롤백된다.
  - 트리거를 제거하고 재호출하면 정상 지급이 1회 된다.
- 모든 사례 끝에 `SUM(delta) = balance`를 확인한다. app role의 원장 `UPDATE`·`DELETE`는 `42501`이어야 한다(회귀).
- 잘못된 identity는 `invalid_identity`이고 행 수가 늘지 않는다.
- 비UUID에 대한 `getBalance`는 0이다.

**② 조각·하루 한 줄:**
- 작성 후 읽기: 시각·순서·`version=1`, 경계 시각의 `local_date`를 확인한다. 주입 시계를 `1988-08-01T14:30Z`·`1960-01-01T15:15Z`로 둔 경우에도 IANA `Asia/Seoul`과 PG 읽기가 각각 `1988-08-02 00:30`·`1960-01-01 23:45`로 일치해야 한다. 같은 두 사례를 단위 시험에도 추가한다.
- 본문: 300자 통과, 301자·공백만 있는 본문은 `invalid_body`.
- 수정·삭제: 낡은 버전 `conflict`, 타인·삭제됨·비UUID id `not_found`, `expectedVersion` 0/1.5/NaN은 `invalid_version`.
- 사용자 조건: 비UUID·없는 사용자로 쓰면 `not_found`. 타인의 `getDay`는 `null`, `listMonth`는 `[]`. `listMonth(2026, 13)`은 `[]`.
- `saveSummary`: §3 표의 8칸, 미래 날짜는 `invalid_date`.

**③ 꾸미기·글꼴:**
- 유효 manifest 2회 저장 → 행 2개(불변). 무효 manifest → `invalid_manifest`이고 행이 늘지 않는다.
- 허용 목록 밖 asset은 저장 거부. 펜만 쓴 manifest는 기본 목록(빈 목록)으로 저장된다.
- `listDesignVersions`의 정렬과 limit 경계(0·101·2.5 → 20).
- `getDesignVersion`: 타인 버전은 `null`.
- 적용: 본인 버전 OK, 타인·없는 버전 `not_found`, `null` 해제.
- `setFontKey("serif")`는 적용 값을 바꾸지 않고, `applyDesign`은 글꼴을 바꾸지 않는다. `"comic"`은 `invalid_font`. 비UUID·없는 사용자의 쓰기는 `not_found`.

## 6. TDD 순서·명령 (B1·B2)

slice마다 **RED 커밋(`TEST_PATTERNS` 경로만) → 독립 runner로 실패 이유 확인 → GREEN 커밋(제품 경로만, 시험 변경 0)** 순서다. `TEST_PATTERNS`에 제품 경로를 넣지 않는다.

**RED 작성 규칙 (B1, F2 `sql-policy.test.ts`의 `loadPolicy` 선례):**
- 새 제품 모듈과 기존 모듈의 새 export(`seoulLocalDate`·`seoulTime`)는 정적으로 import하지 않는다. 시험 파일 위쪽에 절대경로 상수(`path.join(APP_DIR, "src/server/…")`)를 두고, **각 `it` 안에서 `await import(/* @vite-ignore */ MOD)`** 한 뒤 함수 존재를 단언한다.
- 필요한 공개 타입은 시험 파일 안에 **최소 로컬 계약 타입**으로 둔다. 그래서 TS2307이 나지 않고 typecheck와 lint가 통과한다.
- **RED로 인정하는 조건:**
  - lint·typecheck 성공
  - 대상 `it`이 전부 수집·실행됨
  - 미구현(모듈 없음이나 기대값 불일치) 때문에 실패
  - baseline(단위 71·DB 57)은 계속 통과
- 0개 수집, skip, 환경 실패(DB 연결·`DisposableEnvError`·lint 설정 오류)는 RED가 아니다.
- 이미 통과하는 양성 제어는 같은 `it` 안에서 확인하거나 baseline으로 따로 보고한다.

**Slice ②의 기존 시험 정리 (B2):**
- RED가 `diary-memory-store.test.ts`의 `const days: DiaryDay[] = [...]`를 **타입 주석 없는 변수**로 바꾼다. 신선한 리터럴이 아니므로 excess property 검사가 없다.
- 같은 RED에서 `version: 1`, `summaryVersion`(본문이 있으면 1, 빈 값이면 `null`)을 미리 넣고, 쓰지 않게 된 `DiaryDay` 타입 import를 지운다.
- 현재 `LocalDate`는 string alias이고 이미지는 `null`이라, 구조 타입으로 기존 `createMemoryDiaryStore` 인자와 호환된다.
- GREEN의 기존 코드 타입 대응은 `shared/diary.ts`, `fixture.ts`, `src/app/page.tsx`의 빈 날짜 대체값(`summaryVersion: null`), 필요하면 `store.memory.ts`다. 쓰기 port·PG 구현은 §3 파일 표를 따른다. 시험 파일은 바꾸지 않는다.
- version 필수화는 slice ②에서만 한다. slice ①의 타입 이동은 필드를 그대로 옮긴다.

| 단계 | 명령 (저장소 루트) | 예상 |
|---|---|---|
| ①RED | `npm --prefix app run lint && npm --prefix app run typecheck` | 성공 |
| ①RED | `npm --prefix app test -- tests/unit/client-boundary.test.ts tests/unit/seoul-date.test.ts` | 새 `it` 전부 실행 후 실패: server 금지 오류가 없거나 모듈 없음. 양성 제어 단언은 통과 |
| ①RED | `npm --prefix app run test:db -- tests/db/f3-login-grant.test.ts` | 새 `it` 전부 실행 후 모듈 없음으로 실패. 다른 DB 시험 57건 통과 |
| ①GREEN | 위 명령 + `npm --prefix app test` + `npm --prefix app run test:db` | 단위 71+u₁, DB 57+d₁ 통과 |
| ②RED/GREEN | `… test -- tests/unit/diary-memory-store.test.ts tests/unit/seoul-date.test.ts`, `… test:db -- tests/db/f3-diary.test.ts` | RED: 메모리 4건 통과 + IANA 두 사례·f3-diary 실패 / GREEN: 통과 |
| ③RED/GREEN | `… test -- tests/unit/manifest.test.ts`, `… test:db -- tests/db/f3-decoration-preferences.test.ts` | 같은 형태 |
| slice 끝 | `bash app/tests/full-check.sh` | 전체 통과(prod 6·E2E 12·root 42 유지) |

- DB 시험은 일회용 PG18에서만 돌린다: `POD_TEST_DB_DISPOSABLE=1`, `POD_TEST_ADMIN_URL=postgres://postgres:…@127.0.0.1:<port>/postgres`. full-check는 여기에 `POD_FULL_CHECK_ISOLATED=1`이 필요하다.
- Cloud에서 Docker를 쓸 수 없으면 GitHub CI `db` job으로 판정한다. 공용·실서버 DB는 대신 쓰지 않는다.
- 보고 형식:
  - RED: "새 `it` k개 실행·실패(사유), baseline 통과"
  - GREEN: "단위 71+u·DB 57+d 통과"

## 7. 배포·호환·복귀

- 배포·DB 프로비저닝은 없다. dev 도메인은 정적 화면을 유지하고, F3 코드는 어떤 경로에서도 호출되지 않는다. 앱 접속은 F6에서 한다.
- F1 fixture 모드와 E2E 12건은 유지돼야 한다.
- 복귀는 slice 커밋 단위 revert로 한다. 새 migration이 없으므로 DB 쪽 복귀 절차는 필요 없다.

## 8. 미정·남은 한계

| 항목 | 상태 |
|---|---|
| 인증 공급자·여러 identity 연결·세션 | [미정] — F4 |
| 스티커 registry·라이선스, 안전 영역 clip | [미정]/F5. F3 기본 허용 목록은 빈 목록 |
| 개인 버전 보관·삭제, 사진·예시 이미지, 잔액 표시, 탈퇴 | [미정] |
| 사용자별 시간대 | [가정] `Asia/Seoul` |
| client→server 전이 import | lint 경로 규칙의 한계. F4/F5에서 강화 검증 |
| `lintText` 가상 경로·`$1::uuid::text` 동작 | slice ① CI에서 확인 |
| 서울 시간대 과거 이력 | slice ②에서 IANA 기반으로 보완했고 Node 24/26·PG18.6의 1960·1988년 이력 일치를 검증(§10) |

## 9. Slice ① 실행 결과 (2026-11-02)

- 기준 `e4db8be` → RED `fc079b8` → GREEN `b9ed5e8708b494e8c5e6fb46417e14f73545f3c8`. RED는 시험 4파일만, GREEN은 제품 15파일만 바꿨고 두 범위 관문을 메인이 확인했다. 독립 Cloud runner가 각 CI 원문과 코드 계약을 대조했다.
- [CI `41530631065`](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41530631065): Node 24·26 각각 단위 81·운영 경계 6·E2E 12개, PG18 DB 69개 통과(건너뜀 0). [배포 계약 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41530630974)는 42개와 Compose 검사를 통과했다.
- 8개 app 연결의 canonical 계정·1회 지급, 새/기존 계정의 네 가지 실패 주입과 롤백·재시도, 원장 합계·잔액 일치, SQL 전 형식 거부를 검증했다. 경합 패자 내부 분기의 매회 실행을 강제하는 배리어는 없다.
- 앱 Pool은 지연 생성하고 실제 HTTP·인증·UI 저장 연결은 하지 않았다. UI 네 곳은 공유 타입 import만 바꿨다. 실서버 DB·권한·migration·배포 프로그램은 변경하지 않았다.
- 독립 검토의 비차단 P2(UTC+9 고정)는 slice ②의 RED/PG 시각 비교에서 보완한다. [IANA 이력](https://data.iana.org/time-zones/tzdb/asia)과 명시한 `Asia/Seoul`을 따르며 Date 입력 범위를 임의로 제한하지 않는다.
- 다음 slice의 BASE는 이 결과가 통합된 dev의 정확한 SHA로 동결한다. 앱은 계속 정적 시안과 별개이며 실제 로그인·지급 연결은 F4다. FullCheck 스크립트 전체 실행과 실서버 DB 적용은 미실행이다.

## 10. Slice ② 실행 결과 (2026-11-02)

- 기준 `a6e35e4` → RED `a30cb464cc68f943fef1134a1aa59f1f8e3f093b` → GREEN `e36fe7d1f9e20127fc3f61889eddd0f758c5f06c`. RED는 시험 4파일만, GREEN은 제품 6파일만 바꿨고 두 범위 관문과 `diff --check`를 통과했다. 독립 Cloud 검토가 두 단계의 CI 원문과 계약을 대조했고 차단 문제 없이 수락했다.
- [CI `41538131128`](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41538131128): Node 24·26 각각 단위 83·운영 경계 6·E2E 12개, PG18.6 DB 88개 통과(건너뜀 0). [배포 계약 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/41538131166)는 42개와 Compose 검사를 통과했다. 기존 단위 81·DB 69개도 유지됐다.
- 조각·하루 정리 CRUD, 소유자 조건, 버전 충돌·큰 안전 정수 비교, 한 줄 표 8칸, 월 경계·잘못된 값의 SQL 미실행을 검증했다. 두 app 연결에서 수정·삭제·한 줄 생성/수정 경합의 단일 승자를 확인했다. 삭제 우선/수정 우선 두 분기를 모두 강제 실행하는 장치는 없다.
- `Intl`의 명시 IANA `Asia/Seoul`과 PG 읽기 시각이 1960년 UTC+8:30·1988년 서머타임을 포함해 일치했다. slice ①의 UTC+9 고정 P2는 해소됐다. 본문은 trim한 결과를 저장하고, 미래 판정의 오늘은 주입 시계의 서울 날짜다.
- `DiaryMoment.version`·`DiaryDay.summaryVersion`을 필수화하고 제품 fixture·빈 날짜 대체값을 보정했다. D 화면·스타일, F2 스키마·권한, 환경 변수·의존성은 바꾸지 않았다. 실제 인증·HTTP·화면 저장 연결·실서버 DB 적용과 FullCheck 스크립트 전체 실행은 미실행이다.
- 월별 결과의 일자 순서는 아직 계약이 없다. 화면에서의 정렬은 F5에서 정한다. 조각·한 줄은 별도 SELECT로 읽으며 같은 snapshot을 보장하지 않는다.
- 다음 slice ③은 개인 꾸미기 manifest·불변 버전·기록 글꼴 저장이다. BASE는 이 결과가 통합된 dev의 정확한 SHA로 동결한다.
