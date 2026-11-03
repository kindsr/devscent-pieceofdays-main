# AGENTS.md — DevScent pieceofdays

## 0. 먼저 읽을 정본

공통 규칙의 정본은 `../_template/`다. 경로 참조만으로 본문이 주입됐다고 가정하지 않고 작업 전에 실제로 읽는다.
`../_template`를 찾지 못하면 홈 기준 fallback `~/projects/_template/`를 읽는다
(다른 체크아웃의 `../_template`는 이 정본을 가리킨다).

1. `../_template/AGENTS.md` 전체(Claude에서 외부 가져오기가 허용돼 이미 읽혔다면 다시 읽지 않는다).
2. 그 작업 표가 가리키는 `../_template/docs/09_DEVELOPMENT_WORKFLOW.md`의 해당 절만.
3. 신규 기술·DB 선택이면 `../_template/docs/10_TECH_STACK_SELECTION.md`.
4. Herdr 메인·하위 진행이면 `../_template/docs/12_HERDR_DEVELOPMENT_WORKFLOW.md`
   (메인 §2.3~2.7, 위임받은 하위 §2.3~2.5·§4). 터미널 주소는 실행 시 확인하며 이 repo 문서에 고정하지 않는다.

모든 작업에 `$karpathy-guidelines`를 적용한다. 아래 서비스 계약은 공통 규칙을 구체화하거나 좁힐 뿐,
작업·운영·배포 권한을 넓히지 않는다.

## 1. 현재 상태

- [PRD](docs/PRD.md)는 사용자 확정 요건과 미정 항목을 구분한 초안이다. 운영은 준비중 페이지, dev는 정적 프로토타입이다. 사용자 선택(2026-11-02)은 TypeScript·React/Next.js + PostgreSQL + 전용 이미지 저장소, 그리기 Konva다. [app/](app/README.md)에 F1 화면·F2 스키마·F3 저장 코어(지급·기록·개인 꾸미기·기록 글꼴)·F4a 세션 codec과 서버 전용 경계를 검증했다(단위 122·DB 99·빌드 경계 4). 실제 인증·화면 저장·서비스 DB 연결은 아직 없다. 현재 정적 배포에는 이 앱이 포함되지 않는다.
  사용자 확정(2026-11-03): 로그인은 Google·Kakao 둘 다, 계정 탈퇴는 30일 복구 기간 뒤 삭제다. 공급자 간 계정 연결은 미정이다. 설계 문서는 `docs/plans/PLAN_mvp-authentication.md`·`docs/plans/PLAN_account-lifecycle.md`다(F4a만 구현, OAuth·DB 상태 대조·탈퇴·복구·삭제는 후속).
  신규 DB는 공통 docs/10의 PostgreSQL18 기준으로 계획하고, 과거 PostgreSQL14 등 표기를 이 서비스의 선택으로 보지 않는다.
- 운영: `docker-compose.yml`의 `pieceofdays-comingsoon`은 준비중 페이지를 이미지로 빌드한다. 전환 전 bind mount 방식은 §3의 주의를 확인한다.
- dev: `docker-compose.dev.yml`의 `pieceofdays-frontend-dev`가 `frontend/`를 정적 이미지로 빌드한다. `/design/`은 [시안 4안](docs/design/concepts/README.md) 비교판이며 **D 선택 완료**다. 기준은 [디자인 핸드오프](docs/design/README.md)다. 조각 수정·기록 글꼴은 메모리 시안이며 실제 저장과 혼동하지 않는다. `/promo/`는 D 화면의 20초 세로 콘셉트 영상이다.
- MVP: 기록 CRUD·하루 정리·날짜별 다시 보기·기록 글꼴·개인용 하루 꾸미기 기본. 마켓·디자인 구매·제작자 정산은 후속이다. 감정덩어리는 첫 성공 로그인에 계정당 10개 한 번 지급, 디자인 구매 시 1개 사용이 확정 정책이며 정산·환불 세부는 확정 전이다.
- 앱 검사는 `.github/workflows/app-validation.yml`과 `app/README.md`를 따른다. 로컬 예시 사용자 모드는 개발·시험 전용이며 운영 빌드·실행에서 거부한다. 앱 배포 전환은 [F6 계획](docs/plans/PLAN_mvp-foundation.md)에 따라 별도 검토하고 현행 정적 배포 프로그램을 임의 완화하지 않는다.
- 현행 경로·도메인·확인 명령은 [README.md](README.md), 배포 절차는 [deploy/README.md](deploy/README.md)다.

## 2. 다음 진행 순서

1. PRD 초안 검토·요건 확정(`docs/PRD.md`) → 공통 09 §2.1~2.3(PRD 분석·shaping·MVP, `docs/product/`).
2. 공통 docs/10에 따른 구성 비교 뒤 사용자가 Next.js 구성을 선택했다. `docs/product/00_TECH_STACK_DECISION.md`에 버전·지원 근거·환경 경계를 기록하고 구현한다. 로그인 공급자(Google·Kakao)와 탈퇴 30일 복구는 2026-11-03에 확정됐다. 계정 연결·AI 전송·공유 범위는 선택된 것으로 간주하지 않는다.
3. 공통 09 §2.4: 스토리보드 → 디자인 브리프 → 서로 다른 시안 3안·사용자 선택 → 선택안 하이파이 아트보드와
   `docs/design/README.md` 핸드오프. 텍스트 와이어프레임·하이파이 문서를 필수 산출물로 만들지 않는다.
4. 공통 09 §2.5 구현 계획(`docs/plans/PLAN_<작업명>.md`) → 구현·시험.

2026-11-02 사용자 요청으로 선택용 정적 시안은 가정을 표시해 개발 도메인에 먼저 게시한다.
시안 게시와 별도로 확인한 사용자 선택만 확정으로 기록한다. AI 사용 방식·공유·공급자 간 계정 연결은 여전히 미정이다.

## 3. GitHub·개발·운영 배포 경계

- Git 정본은 `https://github.com/kindsr/devscent-pieceofdays-main.git` 하나다(2026-11-02 `kindsr/pieceofdays`에서 이름 변경). 기존 NAS 이력은 병합해 보존하며 NAS 원격을 계속 사용하지 않는다.
- 사용자 승인(2026-11-02): `dev` push → 개발 자동배포, `dev`를 `main`에 병합 → 운영 자동배포. 이 서비스에만 적용한다.
- 서버 경로는 세 논리 역할로 나눈다. 정확한 서버 값은 비공개 운영 런북이 정본이며 공개 문서에 적지 않는다.
  - source: AI 개발·커밋 체크아웃. `dev` 또는 별도 worktree에서 진행한다.
  - dev: 개발 배포본, 도메인 `dev.pieceofdays.com`. 배포본을 직접 편집하지 않는다.
  - release: 운영 배포 자료·고정 이미지, 도메인 `pieceofdays.com`. 배포 경로에서 AI 편집 세션을 시작하지 않는다.
- GitHub Actions의 검사 후 환경별 SSH 강제 명령으로 배포한다. 성공한 dev와 동일한 소스 tree만 main에서 운영 승격하며, 실패 시 동결된 직전 이미지로 복귀한다.
- 서비스 전용 배포 프로그램은 작업 트리 밖에 설치한다. 저장소의 프로그램 수정이 설치본을 자동으로 바꾸지는 않는다. 설치본 변경은 메인 검토·검증 후 별도 반영한다.
- 기존 1분 폴링의 pieceofdays 항목은 Actions 전환 시 제외한다. 다른 서비스·공용 크론·nginx·TLS는 바꾸지 않는다.
- 배포 절차·승인 범위·복귀는 [deploy/README.md](deploy/README.md), 구현 계획은 [PLAN](docs/plans/PLAN_github-actions-deployment.md)이다.
- 전환 전 운영은 `deploy/comingsoon/html/`을 직접 마운트했다. 기존 컨테이너가 그 방식인지 실제 라벨·마운트를 확인하기 전 해당 파일을 운영과 무관하다고 가정하지 않는다.

## 3.1 Claude Cloud 작업

- 사용자 선택(2026-11-02): pieceofdays에서 위임할 수 있는 기획·구현·검증은 개별 Claude Cloud 세션을 우선 사용한다. 메인은 계획·검토·통합과 서버에서 필요한 확인을 맡는다. 다른 서비스와 전역 CLI 설정에는 적용하지 않는다.
- 클라우드 작업은 GitHub 작업 브랜치와 PR로 반환한다. 운영 서버 SSH·배포 키·서버 비밀값을 클라우드 개발 환경에 제공하지 않는다.
- 클라우드에 `../_template`·서버 경로·`hc`가 없으면 읽거나 실행했다고 보고하지 않는다. 메인이 전달한 작업 범위와 이 저장소 지침으로 조사·구현·시험하고 제약을 보고한다.
- PR 검사에는 배포 키를 제공하지 않는다. dev/main 반영·자동배포와 운영 결과 검증은 메인이 통합 단계에서 확인한다.

## 4. 역사 자료

템플릿 복사 시점의 공통 문서 사본 `docs/01~05_*.md`는 원격 master `281fc06`에서 삭제됐다. 정본은 `../_template/docs/`다.
과거 커밋·체크아웃에 사본이 보여도 근거로 쓰지 않는다.
루트의 `PROMPT_NEW_SERVICE_DOMAIN_BOOTSTRAP.md`도 초기 구성 당시 자료이며, 현재 정본(공통 `_template`·비공개 서버 런북)이 우선한다.
