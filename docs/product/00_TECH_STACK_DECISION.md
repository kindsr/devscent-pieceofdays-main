# 00 기술 스택 결정 기록

- **결정:** [TECH_STACK_OPTIONS](TECH_STACK_OPTIONS.md)의 A안. TypeScript + React/Next.js(서버 기능 포함) + PostgreSQL 18 + 서비스 전용 비공개 이미지 저장소 + Konva(react-konva).
- **선택자:** 사용자. **일자:** 2026-11-02. 메인이 추천안 A를 명시적으로 선택했다고 전달했다.
- **승인 범위:** 사용자는 앱 개발 시작과 추천 스택을 승인했다. 따라서 이 앱(`app/`) 전용 프레임워크·패키지 설치는 구현 작업에서 진행할 수 있고, 별도 승인을 기다릴 대상이 아니다(PLAN_mvp-foundation §1.1의 호환 확인 후 설치). 공용 서버 설정 변경, 다른 서비스 영향, 배포 권한 확대는 이 승인과 별개다.
- **이번 담당의 범위:** 문서만 작성했다. 그래서 이 PR에서는 아무것도 설치·생성하지 않았다.
- 후속 실행 계획: [PLAN_mvp-foundation](../plans/PLAN_mvp-foundation.md). 제품 단계: [PLAN_product-evolution](../plans/PLAN_product-evolution.md). 도메인 설계: [DECORATION_MARKET_ARCHITECTURE](DECORATION_MARKET_ARCHITECTURE.md).

## 1. 목적과 근거

| 목적 | 선택 | 이유 |
|---|---|---|
| 기록 CRUD·날짜별 보기·설정 | Next.js App Router, 서버 측 처리(서버 함수/라우트 처리기) | 화면과 서버 처리를 한 앱·한 이미지로 둔다. **별도 백엔드 플랫폼을 새로 두지 않는다** |
| 감정덩어리 원장·구매 | PostgreSQL 18 단일 DB 트랜잭션과 제약 | 유일·CHECK·FK 제약과 행 잠금으로 멱등·원자성을 보장한다 |
| 개인용 하루 꾸미기 Lite 편집기 | react-konva(편집기 화면만, 브라우저 전용) | 끌기·펜·획 지우개를 캔버스로 처리하고 결과는 manifest 데이터로 저장한다 |
| 보기 화면 | React 서버 렌더 + DOM/CSS(D 마크업) | 기록 텍스트의 접근성과 사용자 폰트를 유지한다 |
| 사진·에셋 | S3 호환 저장소의 **이 서비스 전용 비공개 버킷** | DB에는 객체 식별자·소유자/권한·해시·형식·크기만 둔다 |

장점: 한 언어(TypeScript)로 화면과 서버를 개발한다. react-konva는 Konva의 공식 React 바인딩이다. 자료와 생태계가 넓다.
단점과 대응:
- 서버/클라이언트 경계 규칙이 있다. 편집기는 클라이언트 전용 모듈로 격리한다.
- React·Next·react-konva의 메이저 버전을 함께 맞춰야 한다. 업그레이드는 PR 단위로 하고 E2E로 확인한다.
- 정적 nginx 이미지보다 운영 부담이 크다. 배포 전환은 별도 계획과 메인 검토로 진행한다.

기각한 대안: B안(SvelteKit). 생태계가 상대적으로 작고 Konva 연동을 직접 감싸야 해서 택하지 않았다. 별도 Python 서버·Redis·메시지 브로커는 MVP에 필요하지 않아 두지 않는다.

## 2. 버전 기준 (2026-11-02 공식 출처 확인)

PLAN_mvp-foundation F1의 호환 확인(§1.1)을 거친 뒤 아래 기준으로 `package.json`·lockfile·이미지 태그를 **정확한 버전으로 고정**한다.
그 시점의 최신 패치가 출시된 지 얼마 안 됐으면 직전 안정 패치를 쓴다.

| 구성 | 기준 | 지원 근거(확인일 2026-11-02) | 출처 |
|---|---|---|---|
| Node.js | **26 LTS(Lithium)**, 호환 문제 시 24 LTS(Krypton) | v26: LTS 2026-10-28, 유지보수 시작 2027-10-20, 종료 2029-04-30. v24: 유지보수 2026-10-20~, 종료 2028-04-30. 운영에는 Active/Maintenance LTS만 쓰라는 공식 권고 | https://nodejs.org/en/about/previous-releases , https://github.com/nodejs/Release (schedule.json) |
| Next.js | **16.x**(Active LTS) | 16.x Active LTS(2025-10-21 출시), 15.x Maintenance LTS. 최소 Node 20.9. npm `latest` 16.4.4 | https://nextjs.org/support-policy , https://nextjs.org/docs/app/getting-started/installation |
| React / React DOM | **19.3.x** | 공식 최신 19.3(2026-09-09). npm `latest` 19.3.1 | https://react.dev/versions |
| TypeScript | **6.0.x**(현재 6.0.3) — 프로젝트의 `typescript` 패키지 | TS 7.0(2026-06-18 발표)은 프로그래밍 API를 제공하지 않는다. API를 쓰는 도구는 6.x를 함께 쓰라는 공식 안내가 있다. Next.js의 최소 요구는 5.1. TS 7 `tsc` 도입은 7.1 API가 나온 뒤 다시 검토 | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ , Next 설치 문서 |
| Konva / react-konva | **konva 10.x**(npm `latest` 10.9.1), **react-konva 19.x**(npm `latest` 19.3.2, peer `react ^19.3.0`) | react-konva의 메이저 버전은 React 메이저 버전과 같아야 하고 브라우저 전용이라는 공식 문서 내용 | https://konvajs.org/docs/react/index.html , https://registry.npmjs.org/react-konva |
| PostgreSQL | **18**(현재 18.6) | 지원 종료 2030-11-14. 각 메이저 버전은 5년 지원하며, 최신 마이너 버전을 쓰라는 공식 권고 | https://www.postgresql.org/support/versioning/ |

### 2.1 F1에서 정확히 고정한 버전 (2026-11-02, `app/package.json`·`package-lock.json`)

| 구성 | 고정 | 비고 |
|---|---|---|
| Node.js | 26.13.0(`app/.nvmrc`, CI 기준) · 24.22.2(CI 함께 실행) | 26.13.0은 v26 첫 LTS 릴리스(2026-10-28). `engines` `^24.22.2 \|\| >=26.13.0` |
| npm | Node 동봉(26.13.0 → 11.20.0, 24.22.2 → 11.19.1) | `engine-strict`, `save-exact`(app `.npmrc`) |
| next / eslint-config-next | 16.4.3 | 16.4.4가 확인 당일(2026-11-02) 출시돼 직전 패치 사용 |
| react / react-dom | 19.3.1 / 19.3.1 | |
| react-konva / konva | 19.3.2 / 10.9.1 | peer `react ^19.3.0`, `konva ^10` 충족 |
| typescript | 6.0.3 | typescript-eslint peer `<6.1.0` 충족 |
| @types/react / @types/react-dom / @types/node | 19.3.0 / 19.3.0 / 24.12.0 | @types/node는 지원 하한(24)에 맞춤 |
| eslint | 9.39.5 | npm deprecated(지원 종료) 표시. ESLint 10은 eslint-plugin-react·jsx-a11y·import peer 범위 밖이라 9 유지. 플러그인이 10을 지원하면 올린다 |
| vitest | 5.0.5 | 5.1.0이 확인 당일 출시돼 직전 패치 사용 |
| @playwright/test | 1.63.0 | 저장소의 홍보영상 도구와 같은 버전 |

확인: Node 26.13.0·24.22.2 각각 깨끗한 복사본에서 `npm ci`, `npm ls --all`(peer 문제 없음), lint·typecheck·unit·build·E2E 통과.
`npm audit --omit=dev` 0건. 개발 전용 lint 체인(minimatch)에 moderate 16건. lockfile 라이선스는 대부분 MIT·Apache-2.0·ISC이며, Next 이미지 최적화용 선택 의존성(sharp libvips)이 LGPL-3.0-or-later, lightningcss가 MPL-2.0이다.

라이선스: npm 레지스트리 메타데이터상 next·konva·react-konva는 MIT다. 설치 시 lockfile 기준으로 의존성 전체 라이선스를 다시 확인한다.
npm `latest` 값은 레지스트리 조회 결과이고, 지원 상태는 각 공식 문서 기준이다.

## 3. 데이터·저장소·권한 계약

- **DB:** PostgreSQL 18. **dev와 prod는 서로 다른 DB(데이터·계정·비밀값 분리)**를 쓴다. dev 데이터를 prod로 복사하지 않는다.
  다른 서비스와 DB나 계정을 공유하지 않는다.
- **실행 형태 [기본 추천]:** 새로 두는 공유 PostgreSQL 18 인스턴스 안에 **서비스·환경별 전용 DB**(pieceofdays dev용, prod용)를 만들고, 각 DB에 전용 계정을 둔다.
  - 실제 프로비저닝(인스턴스·DB·계정 생성, 백업 설정)은 별도 운영 절차로 메인이 비공개 런북에 따라 수행한다.
  - 실제 서버 값은 공개 문서에 쓰지 않는다.
- **DB 계정 최소 권한:**
  - 마이그레이션 계정: DDL만.
  - 앱 실행 계정: 자기 스키마의 DML만. `emotion_ledger`에는 `INSERT`·`SELECT`만 주고 `UPDATE`·`DELETE`는 주지 않는다.
  - 읽기 전용 점검 계정: 필요할 때만 둔다.
  - 슈퍼유저로 앱을 실행하지 않는다.
- **이미지 저장소:** S3 호환 저장소에 이 서비스 **전용 비공개 버킷**을 dev와 prod에 따로 둔다. 다른 서비스의 버킷은 공유하지 않는다.
  - 공개 읽기 정책은 두지 않는다. 앱이 소유권을 확인한 뒤 짧은 수명의 서명 URL이나 앱 경유로 전달한다.
  - 사진과 장식 에셋은 접두어와 권한을 분리한다.
  - DB에는 객체 키·소유자·권한·SHA-256·형식·크기만 저장한다.
  - 어떤 저장소 인스턴스를 쓸지는 [미정] (메인·비공개 런북).
- **비밀값:** DB 접속 정보·저장소 키·세션 비밀은 환경별 비밀 저장소(GitHub 환경 Secrets와 서버 쪽 비공개 설정)에 둔다. 공개 문서와 저장소에는 두지 않는다.
- 실제 서버 주소·경로·계정명·비밀은 **비공개 운영 런북**이 정본이다(메인 관리). 이 문서는 그 경로를 적지 않는다.

## 4. 이 결정이 확정하지 않는 것

- 인증 공급자와 로그인 방식 [미정]. 첫 로그인 지급의 기준 사건이 이 결정에 달려 있다.
- 외부 서비스로 개인정보나 일기 내용을 보내는 일(외부 인증 공급자에게 넘어가는 식별 정보, AI 제공자 등)은 확정하지 않았다. 각각 사용자 결정과 동의 설계가 먼저다.
- 사진의 MVP 포함 여부(PRD Q1), AI 초안(PRD Q2), 공유(PRD Q3).
- 앱 이미지의 배포 전환. 현행 배포 프로그램은 승인된 정적 nginx 이미지만 허용하므로, 전환에는 별도 계획과 메인 검토가 필요하다(PLAN_mvp-foundation F6).
- 감정덩어리 현금화·환전·정산 방식, 창작자 +1 시점(권고만 있음).
