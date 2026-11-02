# PLAN — MVP 기반 구축 (Next.js 앱·DB·인증 소유권·개인용 꾸미기 Lite)

- 상태: **계획. 아직 패키지 설치·앱 구현·DB 생성을 하지 않았다.** 기준 `dev` `efe6b0f`.
- 근거: [00_TECH_STACK_DECISION](../product/00_TECH_STACK_DECISION.md)(사용자 선택, 2026-11-02), [PLAN_product-evolution](PLAN_product-evolution.md) 단계 1, [DECORATION_MARKET_ARCHITECTURE](../product/DECORATION_MARKET_ARCHITECTURE.md), [PRD 초안](../PRD.md).
- MVP 범위([확정]): 기록 CRUD(조각 수정 포함), 날짜별 보기, 사용자 폰트 선택, **개인용 하루 꾸미기 Lite**. **마켓·구매·정산은 MVP에서 제외**한다.
- 각 단계(F1~F6)는 별도 작업 브랜치와 PR로 진행한다. dev/main 반영과 배포는 메인이 통합할 때 한다.

## 1. 파일 경계 (첫 구현)

| 경로 | 내용 | 비고 |
|---|---|---|
| `app/` | Next.js 앱 전체(신규). 아래 하위 구조만 둔다 | 기존 `frontend/`·`deploy/`·`scripts/ops/`는 F6 전까지 건드리지 않는다 |
| `app/package.json`, lockfile, `tsconfig.json`, `next.config.ts` | 버전은 결정 기록 §2 기준으로 정확히 고정한다. 패키지 관리자는 npm(Node 동봉)을 권고한다 | |
| `app/src/app/` | 경로: 오늘, 모아보기·특정 날, 설정(폰트), 꾸미기 | D 화면 구조를 그대로 따른다 |
| `app/src/ui/d/` | D 컴포넌트·토큰. `docs/design/concepts/d-warm-pieces/`와 확정 핸드오프에서 옮긴다 | D 원본 파일은 수정하지 않는다 |
| `app/src/ui/decorate/` | Konva 편집기. **클라이언트 전용** | 서버 모듈에서 import하지 않는다 |
| `app/src/shared/manifest.ts` | manifest 스키마와 타입 1곳 | 서버 검증과 렌더러가 함께 쓴다 |
| `app/src/server/db.ts` | 연결과 트랜잭션 도우미 | |
| `app/src/server/{account,diary,decoration,credit}/` | 도메인 모듈 4개(마켓 없음) | 모든 함수는 `userId`를 첫 인자로 받는다 |
| `app/src/server/auth/` | 세션 → `userId` 해석 1곳 | 공급자 연동은 F4(G4 결정 후) |
| `app/migrations/` | 번호 붙은 SQL migration(up/down) | 도구는 F1에서 1개 고른다 |
| `app/tests/{unit,db,e2e}/` | 단위 / 실제 PostgreSQL 18 컨테이너 / 브라우저 | |
| `.github/workflows/` | 앱 검사 job 추가(F1, 메인 검토) | 배포 job·키는 바꾸지 않는다 |

추상화는 지금 미리 만들지 않는다. 저장소·인증 공급자 인터페이스 계층도 두지 않고 함수와 모듈만 둔다.

## 2. 서버 처리(API) 경계

모든 처리는 세션에서 `userId`를 얻는 것으로 시작한다. 세션이 없으면 거부한다. SQL은 항상 `WHERE user_id = $userId`로 소유자를 제한한다.
다른 사용자의 ID를 넣으면 "없음"과 같은 응답을 준다(존재 여부를 드러내지 않음).

| 처리 | 입력 | 결과·규칙 |
|---|---|---|
| `createMoment` | 날짜, 글(최대 길이), (사진: Q1 결정 후) | 시각이 붙은 조각 |
| `updateMoment` / `deleteMoment` | 조각 ID, `version` | 낙관적 잠금. 버전이 다르면 충돌 응답 |
| `upsertDaySummary` | 날짜, 글 | 하루 1개(`UNIQUE(user_id, local_date)`) |
| `getDay` / `listMonth` | 날짜 / 연월 | 본인 기록만 |
| `setFont` | `font_key` | 허용 목록만 |
| `saveDesign` | manifest | 검증 → private `design_versions` 새 행 |
| `applyDesign` | 버전 ID 또는 `null` | 본인 버전만 적용, `null`이면 기본 D |
| `onSuccessfulLogin` | 인증 결과 | `users` 확보 + 첫 로그인 지급(§3), 한 트랜잭션 |

날짜 기준 시간대는 [미정]이다. 권고는 사용자 설정 시간대이며 기본값은 `Asia/Seoul`이다.

## 3. DB 경계 (MVP 스키마 초안)

| 테이블 | 핵심 열·제약 |
|---|---|
| `users` | `id`(canonical), `created_at`, `first_login_at` |
| `auth_identities` | `user_id` FK, `provider`, `subject`, `UNIQUE(provider, subject)`. 공급자 값은 G4 결정 후 정한다 |
| `preferences` | `user_id` PK, `font_key`, `applied_design_version_id` NULL 허용 |
| `diary_moments` | `id`, `user_id`, `local_date`, `occurred_at`, `body`, `version`, 인덱스 `(user_id, local_date)` |
| `day_summaries` | `UNIQUE(user_id, local_date)`, `body`, `version` |
| `design_versions` | `id`, `owner_id`, `manifest jsonb`, `visibility='private'`(MVP), `created_at` |
| `credit_accounts` | `user_id` PK, `balance integer CHECK (balance >= 0)` |
| `emotion_ledger` | `delta integer`, `reason`, `grant_key UNIQUE`, `ref_*`. 앱 계정에 UPDATE/DELETE 권한 없음 |
| (Q1 사진 포함 시) `moment_photos` | `object_key UNIQUE`, `owner_id`, `sha256`, `content_type`, `bytes` — 이미지 자체는 저장하지 않는다 |

첫 성공 로그인 지급([확정] 1회 10개):
- `onSuccessfulLogin` 트랜잭션 안에서 `grant_key='first_login:{user_id}'`를 `INSERT … ON CONFLICT DO NOTHING`으로 넣는다.
- 행이 들어간 경우에만 잔액을 +10 한다.
- 같은 사람이 여러 공급자로 로그인할 때 `user_id`를 연결하는 정책은 G4에서 정한다.

마켓 테이블(`design_listings`·`purchases`·`entitlements`)은 MVP에서 만들지 않는다. 구매 1개 정책은 [확정]이지만 구현은 후속이다.

## 4. 이미지 저장 경계

- MVP 꾸미기 Lite의 기본 스티커는 **앱에 동봉하는 정적 자산**이다(라이선스 확인분만). 따라서 버킷이 없어도 Lite가 동작한다.
- 버킷은 사진(Q1) 또는 본인 그림 업로드를 MVP에 넣을 때만 연결한다. 연결 방식:
  - 이 서비스 전용 비공개 버킷을 쓰고 dev와 prod를 분리한다.
  - 업로드는 서버에서 형식 확인과 재인코딩을 거친 뒤 저장한다.
  - 읽기는 소유권을 확인한 뒤 서명 URL이나 앱 경유로만 허용한다.
  - DB에는 객체 키·권한·해시만 둔다.
- 버킷 인스턴스와 자격 증명은 메인이 비공개 런북으로 준비한다 [미정].

## 5. TDD 필수 목록 (테스트를 먼저 쓴다)

1. **인증·소유권:** 처리마다 비로그인 거부, 타인 ID 접근 시 "없음" 응답. 표(§2)의 모든 행이 대상이다.
2. **첫 로그인 지급:** 실제 DB에서 병렬 연결로 `onSuccessfulLogin`을 동시에 N회 실행해도 원장 1행·잔액 10. 트랜잭션이 중간에 실패하면 둘 다 남지 않는다.
3. **원장 권한:** 앱 계정으로 `UPDATE`·`DELETE emotion_ledger`를 실행하면 권한 오류가 난다. 잔액 사본은 `SUM(delta)`와 같다.
4. **낙관적 잠금:** 두 탭에서 같은 조각을 수정하면 하나는 충돌 응답을 받는다. 삭제된 조각을 수정하면 "없음" 응답이다.
5. **manifest 검증:** 범위 밖 좌표, 모르는 슬롯, 허용하지 않은 색·굵기, 획·점 수 상한, 남의 버전 적용.
6. **폰트 허용 목록:** 목록 밖 키는 거부한다. 꾸미기 적용으로 `font_key`가 바뀌지 않는다.
7. **렌더 fallback:** manifest나 에셋이 오류여도 기본 D로 렌더되고, 기록은 정상이다.
8. **migration:** 빈 DB에서 up → down → up이 성공하고, 스키마 비교 결과가 같다.

## 6. 단계별 진행과 검증

| 단계 | 내용 | 완료 검증 | 막는 결정 |
|---|---|---|---|
| F0 | 결정 기록과 이 계획(이 PR) | 문서 링크·요구 대조 | — |
| F1 | `app/` 뼈대, 버전 고정, lint·typecheck·unit, CI 앱 검사 job | PR 검사 통과. 기존 `tests/` 배포 계약 테스트 통과. `frontend/`는 변경 없음 | — |
| F2 | migration·DB 계정·권한, 실제 PG18 컨테이너 테스트 | §5-3·8 통과. 로컬·CI 컨테이너만 쓰고 공용 서버 DB는 만들지 않는다 | — |
| F3 | 도메인 모듈(account·diary·decoration·credit) TDD | §5-2·4·5·6 통과 | 시간대(권고값으로 진행 가능) |
| F4 | 인증 연동, `onSuccessfulLogin` | §5-1 전체, 실제 로그인 E2E | **G4 인증 공급자·로그인 방식** |
| F5 | D 화면 이식, 폰트 설정, 꾸미기 Lite(Konva), 사진(Q1 시) | E2E: 375/768/1440px, 키보드, 터치 펜, 실행 취소, 리셋, fallback, 대비 AA, D 기본과 시각 비교 | 폰트·스티커 라이선스(G5), Q1 |
| F6 | 앱 배포 전환(별도 계획 `PLAN_app-deployment`, 메인 주도) | §7의 조건 | dev/prod DB·버킷 준비, 배포 프로그램 검토 |

## 7. 기존 정적 배포와의 호환·전환·롤백

- 현행 배포 프로그램은 `frontend/`의 승인된 정적 nginx Dockerfile만 허용한다. 포트 80·고정 health만 허용하고 환경 변수와 비밀값 주입은 없다.
  따라서 **F1~F5는 배포에 영향이 없다.** dev 도메인은 계속 정적 페이지와 `/design/` 시안을 제공한다.
- F6 전환 조건(별도 계획에서 확정한다):
  - 메인이 설치본 배포 프로그램을 검토·갱신한다. 앱 이미지, 비밀값 주입, DB 네트워크를 허용하는 범위로 하며 다른 서비스·공용 nginx·TLS는 바꾸지 않는다.
  - dev와 prod에 전용 DB와 계정을 준비하고 백업 절차를 마련한다.
  - migration은 확장/수축(expand/contract) 방식으로 한다.
  - `/design/` 시안 게시 사본을 계속 제공할지 정한다.
- 롤백:
  - 앱 이미지 배포가 실패하면 직전 동결 이미지로 복귀한다. 첫 전환이라면 직전 정적 이미지로 복귀한다.
  - DB는 되돌리지 않고, 이전 앱과 호환되는 확장 단계에 머문다.
  - 원장 데이터는 롤백 때도 삭제하지 않는다.
- 운영(main) 전환은 dev에서 앱 운영을 검증한 뒤 사용자·메인이 따로 판단한다.

## 8. 미결정 의존성

| 항목 | 영향 | 담당 |
|---|---|---|
| G4 인증 공급자·로그인 방식(외부 공급자로 가는 식별 정보 포함) | F4, 첫 로그인 지급 | 사용자 |
| PRD Q1 사진 / Q2 AI / Q3 공유 | F5 범위, 버킷 필요 여부, 외부 전송 | 사용자 |
| DB·버킷 실행 형태와 인스턴스 | F6 | 메인(비공개 런북) |
| 허용 폰트 목록·기본 스티커 세트 라이선스(G5) | F5 | 메인·사용자 |
| 시간대 정책, 개인 버전 보관 개수, 잔액 표시 시점 | F3·F5 | 사용자(권고값으로 진행 가능) |
| 감정덩어리 현금화·정산, 창작자 +1 시점 | 후속 마켓 단계 | 사용자 |

## 9. 비목표

마켓·구매·정산 구현, 전문 드로잉 도구, 별도 백엔드 플랫폼(Python 서버·Redis·큐), 외부 AI 연동, 공용 서버 설정 변경, 이 계획 단계에서의 패키지 설치·DB 생성.
