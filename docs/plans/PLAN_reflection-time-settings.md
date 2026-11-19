# PLAN — 계정별 회고 시간 설정

- 기준: `dev` `690be1d5`, 요구 정렬 `9c6d1c8`. 사용자 요청으로 구현 진행(2026-11-10).
- 확정: 사용자 메뉴 → 설정에서 매일 회고할 시간을 고른다. 초기값은 **20:00(저녁 8시)**. PC·휴대폰에서 사용한다.
- 이 단계는 실제 계정 저장 기능이다. 사진·AI 하루 이야기의 전체 완료 기준은 [핵심 계획](PLAN_ai-daily-story-core.md)에 남긴다.

## 1. 사용자 흐름·화면

로그인한 계정의 상단 ‘사용자 메뉴’에 ‘설정’ 링크를 둔다. 글꼴 전용 링크나 URL 직접 입력에만 의존하지 않는다. 기존 D 설정 화면의 글꼴 위에 ‘회고 시간’ 구역을 추가한다. 기존 색·간격·입력·버튼을 재사용하고 화면 전체를 다시 디자인하지 않는다.

```text
설정 / 나에게 맞게
회고 시간
하루를 돌아볼 시간을 골라 주세요.
매일 회고할 시간  [20:00 ▾]  [저장]
한국 시간(Asia/Seoul) 기준 · 기본 저녁 8시
계정에 저장되어 PC와 휴대폰에서 같은 시간으로 보여요.
[저장 중… / 회고 시간을 저장했어요. / 오류와 재시도]
기록 글꼴 …(기존)
계정 …(기존)
```

- 현재 조각 날짜 정책과 같은 **Asia/Seoul** 기준 벽시계 시각을 저장한다. UTC 변환이나 새 시간대 선택기를 추가하지 않는다.
- `<input type="time" step="60">`, 연결된 label·설명, 명시적인 저장 버튼. 44px 이상 조작 대상, 키보드 초점, 375/768/1440 가로 넘침 0.
- 저장 전에는 입력 초안만 바뀐다. 저장 중 중복 제출/입력은 잠그고, 성공+서버 재조회 완료를 기다린다. 실패하면 초안을 유지하고 저장됐다는 문구를 표시하지 않는다.
- 신규 계정/설정 행 없음은 정상 기본값20:00. DB 읽기 오류는 ‘회고 시간을 불러오지 못했어요’로 표시하며 편집 가능한 기본값을 만들지 않는다.
- 로그아웃/사용 불가/fixture는 계정 회고 시간 편집기를 노출하지 않는다. fixture 체험판 글꼴은 보존한다.
- 이 단계에서 알림·예약 작업·정시 AI 외부 호출을 켜지 않는다. 사용자 화면에 실행되지 않는 알림/생성을 약속하지 않는다.

## 2. 공개 계약·권한

| 파일 | 계약 |
|---|---|
| `app/src/shared/reflection-time.ts` | `DEFAULT_REFLECTION_TIME = "20:00"`; `parseReflectionTime(unknown): string \| null`. 정확5자 ASCII `HH:mm`, 00:00~23:59. 공백·초·줄바꿈·숫자·객체는 거부 |
| `app/src/server/account/reflection-time.pg.ts` | `getReflectionTime(db, userId): Promise<string>`: 잘못된 UUID/행 없음은20:00, 읽기 오류는 전파. `setReflectionTime(db,userId,unknown): Promise<Result<string,"invalid_reflection_time" \| "not_found">>`: 검증 후 자기 행 upsert, 해당 시간+updated_at만 변경 |
| `app/src/app/actions/diary.ts` | `setReflectionTimeAction(unknown)` 추가. 기존 설정→Origin→매 요청 viewer→DB 순서와 `asUser` 재사용. 클라이언트가 보낸 userId를 사용하지 않음. 실패는 고정 오류 코드, 원문/비밀 로그0 |
| `app/src/app/settings/page.tsx` | 사용자별 동적 조회. 글꼴/시간의 읽기 오류를 각 구역에서 처리. userId 등 비공개 식별자를 client props로 넘기지 않음 |
| `app/src/ui/d/AccountReflectionSettings.tsx` | `initialTime: string`만 받는 편집기. 서버 성공 후 refresh. 오류/기본값/시간대 안내 |
| `app/src/ui/d/TopBar.tsx` | 계정용 `사용자 메뉴` navigation의 `설정` 링크(`/settings`), 현재 설정 경로 표시. 기존 조각 추가·주 메뉴·fixture/로그아웃 분기 유지. CSS는 기존 상단 grid 안에서만 배치 |

기존 preferences 조회 shape·기존 5개 action의 동작은 보존한다. action 오류 union의 확장 때문에 AccountDayBoard의 오류 사전1항목만 함께 추가한다. 기존 메모 발생 시각·날짜·글꼴·디자인·지급·세션은 바꾸지 않는다.

## 3. DB 변경·복귀

- 신규 `0003_reflection_time.up.sql` / `.down.sql`. 기존 migration1/2 바이트 보존.
- `pod.preferences.reflection_time TEXT NOT NULL DEFAULT '20:00'`. 길이5와 ASCII시분 범위 CHECK로 앱을 통하지 않는 잘못된 값도 거부한다. 기존 행은20:00으로 확장한다.
- 환경 테이블의 app_role에 **UPDATE(reflection_time)**만 추가한다. 기존 SELECT/INSERT, 글꼴/디자인 열 권한은 보존한다. user_id UPDATE·원장 수정·PUBLIC 권한을 넓히지 않는다.
- 신규 시간 upsert는 글꼴/디자인을 덮지 않으며 기존 글꼴/디자인 upsert도 시간을 보존한다. 계정 삭제 시 기존 preferences cascade가 적용된다.
- down은 기존0002처럼 첫 문장에서 `ci` 환경·사용자8테이블 전부 비었음을 확인하고 그 외는 거부한다. 새 UPDATE 열 권한을 회수한 뒤 새 열/제약만 제거한다. 기록/계정/원장 삭제 없음. 실제 서비스에서는 down하지 않고 앱 코드 복귀 후 열을 남기는 방법이 우선이다.
- 실제 DB는 아직 migration2다. 이번 PR은 CI 일회용 DB에서만 검증한다. 실제 migration3 적용·배포 승인 상한 변경·앱 활성화는 설치/배포 검토 단계로 분리하며 현재 dev 정적/OFF 보류를 유지한다.
- image label latest는 migration 이름에서 동적 계산되어3이 된다. 합성 CLI fixture의 임의 latest2는 그대로 둔다. 구조128 사례/워크플로 권한·배포 조건은 변경하지 않는다.

## 4. 역할·시험

1. RED: 아래 시험 파일만 수정. 기본20:00, 모든 시분 경계/잘못된 타입, 저장·계정 분리, 기존 설정 보존, SQL 제약/권한, action 가드, UI 실패/다시 읽기·다른 기기 확인을 요구로 고정한다. 미구현은 명시 단언으로 실패시켜 문법/환경 오류와 구분한다.
2. GitHub PR 기존 CI에서 의도한 RED를 확인한 뒤 시험을 동결한다. 호스트 npm/브라우저/DB 시험은 실행하지 않는다.
3. 별도 GREEN은 제품·migration만 구현하며 시험 바이트0. 독립 검토와 기존 CI 전체를 회수한다.

RED 소유 범위:

- 신규 `app/tests/unit/reflection-time.test.ts`
- 기존 `app/tests/unit/diary-actions.test.ts`: 정확5→6 export·가드 공통 호출에 새 action 추가, 새 입력 실패 사례
- 신규 `app/tests/db/reflection-time.test.ts`
- 기존 `app/tests/db/migrate.test.ts`, `lifecycle-schema.test.ts`: 실제 기본 migration 목록/체크섬을3까지 갱신. 임의 probe fixture는 보존
- 신규 `app/tests/e2e-auth/reflection.spec.ts`: 실제 mock OIDC·일회용 PG·사용자 메뉴의 설정 진입으로 기본/저장/재접속/계정 분리·실패 검증. 최초612 RED 이후 실제 진입 누락은 이 파일 첫 사례만 별도 RED로 고정하고 독립 GREEN으로 보완
- 기존 `app/tests/e2e-auth/device.spec.ts`: 기존 두 교차 엔진 여정에 PC→폰·폰→PC 회고 시간 readback만 추가

GREEN 소유는 §2·3의 제품/SQL과 최소 CSS다. DB 하네스·workflow·package/lock·기존 CLI/제품 보안 규칙은 편집하지 않는다. RED가 실제 새 schema 때문에 추가 영향을 확인하면 메인에 보고하고 정당한 기대 변경을 RED 단계에서 먼저 명시한다.

## 5. 수락 기준

- [ ] 기본20:00, 00:00·23:59·사용자 변경 저장/재조회, 기존 preference와 계정 간 분리
- [ ] 잘못된 입력 SQL0, DB CHECK, 열 권한·up/down 보존
- [ ] Origin/로그인 재확인·타인 ID 위조 거부·고정 오류/민감 로그0
- [ ] 저장 중 잠금·실패 초안 보존·읽기 실패 때 거짓 기본값0
- [ ] 기존 Chromium↔WebKit 두 기기 여정에서 회고 시간이 양방향 일치, 반응형/키보드
- [ ] 기존 root·구조128·Node24/26·DB·auth·image6/front14/preview10 회귀 통과

구현/CI 성공과 실서버 게시·실기기·Google B5 통과는 구분해서 보고한다.
