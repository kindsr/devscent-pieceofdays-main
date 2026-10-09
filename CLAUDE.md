# CLAUDE.md — DevScent Project Guide

이 파일은 Claude Code가 프로젝트 작업 시 기본적으로 따르는 가이드입니다.
모든 DevScent 프로젝트(`~/projects/devscent-*`)에서 동일한 워크플로우를 적용합니다.

---

## 1. 프로젝트 시작 워크플로우 (PRD 기반)

새로운 기능 개발 또는 프로젝트 시작 시 반드시 아래 순서를 따릅니다:

### Step 1: 요구사항 확인
- `docs/PRD.txt` 를 읽고 요구사항을 파악합니다.
- PRD가 없으면 사용자에게 요청합니다.

### Step 2: 디자인 가이드 참조
- `../_template/docs/02_DESIGN_GUIDE.md` 를 참고하여 DevScent 브랜드 디자인 시스템을 따릅니다.
- UI/프론트엔드 작업 시 반드시 디자인 가이드의 컬러, 타이포그래피, 레이아웃 규칙을 준수합니다.

### Step 2.5: 포트폴리오 문서 참조
- 포트폴리오 소개, 서비스 요약, 공개용 캡처 정리 작업이 있다면 먼저 아래를 확인합니다:
  - `../_template/docs/03_PORTFOLIO_GUIDE.md`
  - `docs/04_PORTFOLIO_BRIEF.md`
- 위 문서가 있으면 전체 코드베이스 스캔보다 우선해서 참조합니다.
- `docs/04_PORTFOLIO_BRIEF.md`가 없다면 `../_template/docs/04_PORTFOLIO_BRIEF_TEMPLATE.md`를 복사해 생성합니다.
- 공개용 이미지는 `docs/portfolio/screens/`를 사용합니다.
- QA 원본 캡처는 `docs/qa/screens/`에 보관하고 직접 공개용으로 사용하지 않습니다.
- 구조화 메타데이터가 필요하면 `docs/portfolio/manifest.json`을 사용합니다.
- `docs/portfolio/manifest.json`이 없다면 `~/projects/devscent-home/docs/portfolio/MANIFEST_TEMPLATE.json`를 복사해 생성합니다.
- `docs/portfolio/screens/` 또는 `docs/qa/screens/`가 없다면 `~/projects/devscent-home/docs/` 아래 동일 경로 구조를 복사해 시작합니다.
- `devscent-home` 포트폴리오 소개문/메타데이터를 반영해야 하면 `~/projects/devscent-home/scripts/build_portfolio_catalog.py`를 실행해 `frontend/portfolio-data.js`를 재생성합니다.
- `devscent-home` 포트폴리오 상세 갤러리에 반영해야 하면 `~/projects/devscent-home/scripts/sync_portfolio_gallery.py`를 실행해 공개 자산과 `frontend/portfolio-gallery-data.js`를 동기화합니다.

### Step 3: 운영 환경 확인
- `~/server-runbook/` 아래 운영 문서들을 확인합니다:
  - `00_SERVER_OPERATIONS_MID_REVIEW_2026-02-24.md` — 서버 운영 현황
  - `01_SERVER_MANAGEMENT_EXECUTION_GUIDE_2026-02-24.md` — 서버 관리 가이드
  - `02_SERVICE_INVENTORY.md` — 서비스 인벤토리 (도메인/포트/라우팅)
  - `03_OPS_CHANGELOG.md` — 운영 변경 이력
  - `04_PORT_EXPOSURE_POLICY.md` — 포트 정책
  - `05_CRON_SCHEDULER_POLICY.md` — 크론/스케줄러 정책
  - `06_BACKUP_RESTORE_RUNBOOK.md` — 백업/복원 런북
  - `07_SECRETS_ROTATION_LIST.md` — 비밀값 관리
  - `09_MONITORING_LOGGING.md` — 모니터링/로깅

### Step 4: 인프라 영향도 점검
- 운영 서버의 `/opt/infra` 하위 구성을 확인합니다:
  - `/opt/infra/nginx/` — 리버스 프록시 설정 (다른 서비스 라우팅에 영향 없도록)
  - `/opt/infra/postgres14/` — 공용 DB (기존 DB/스키마 충돌 방지)
- 공유 Docker 네트워크: `edge`
- **기존 운영 서비스에 영향이 없음을 반드시 확인한 후 작업을 진행합니다.**

### Step 5: 개발 계획 수립
- `/feature-planner` skill을 사용하여 TDD 기반 클린 아키텍처 구조의 개발 PLAN을 생성합니다.
- PLAN 문서는 `docs/plans/PLAN_<feature-name>.md`에 저장합니다.
- 사용자 승인 후 구현을 시작합니다.

---

## 2. 클린 아키텍처 원칙

프로젝트 구조는 아래 레이어를 따릅니다:

```
src/
├── domain/          # 엔티티, 비즈니스 규칙 (외부 의존성 없음)
├── application/     # 유스케이스, 서비스 레이어
├── infrastructure/  # DB, 외부 API, 프레임워크 구현체
└── presentation/    # API 컨트롤러, UI
```

- 의존성 방향: presentation → application → domain (안쪽으로만)
- domain 레이어는 외부 프레임워크에 의존하지 않습니다.
- 인터페이스(포트)를 domain/application에 정의하고, infrastructure에서 구현합니다.

---

## 3. TDD 워크플로우

모든 기능 구현은 Red-Green-Refactor 사이클을 따릅니다:

1. **RED**: 실패하는 테스트를 먼저 작성
2. **GREEN**: 테스트를 통과하는 최소한의 코드 구현
3. **REFACTOR**: 테스트가 통과한 상태에서 코드 품질 개선

---

## 4. CHANGELOG 관리

모든 변경사항은 프로젝트 루트의 `CHANGELOG.md`에 기록합니다.

### 기록 규칙
- [Semantic Versioning](https://semver.org/) 준수 (`MAJOR.MINOR.PATCH`)
- 변경 직후 즉시 기록
- 카테고리: `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Deprecated`
- 날짜 형식: `YYYY-MM-DD`

### 버전 올리기 기준
- **MAJOR**: 하위 호환성이 깨지는 변경
- **MINOR**: 하위 호환 가능한 기능 추가
- **PATCH**: 버그 수정, 사소한 개선

---

## 5. 운영 문서 동기화

인프라/배포/설정 변경 시 반드시:
1. `~/server-runbook/03_OPS_CHANGELOG.md` 에 운영 변경 이력 추가
2. `~/server-runbook/02_SERVICE_INVENTORY.md` 에 서비스 정보 최신화
3. 포트/도메인 변경 시 `~/server-runbook/04_PORT_EXPOSURE_POLICY.md` 업데이트

---

## 6. 기술 스택 공통 사항

### 인프라
- 리버스 프록시: nginx (Docker, `/opt/infra/nginx/`)
- DB: PostgreSQL 14 (Docker, `/opt/infra/postgres14/`)
- 네트워크: Docker `edge` 네트워크
- 소스 루트: `/home/kindsr/projects/`

### 배포
- 각 서비스별 `docker-compose.yml` 기반
- 포트는 `127.0.0.1` loopback-only 바인딩 원칙
- nginx conf는 `/opt/infra/nginx/conf.d/` 에 서비스별 파일로 관리

---

## 7. 프로젝트 파일 구조 규칙

```
project-root/
├── CLAUDE.md              # 이 파일 (Claude Code 가이드)
├── CHANGELOG.md           # 버전별 변경 이력
├── README.md              # 프로젝트 소개 및 실행 방법
├── docker-compose.yml     # 서비스 컨테이너 구성
├── docs/
│   ├── PRD.txt            # 제품 요구사항 정의서
│   ├── 04_PORTFOLIO_BRIEF.md
│   └── plans/             # 개발 계획 문서
├── backend/               # 백엔드 소스
├── frontend/              # 프론트엔드 소스
└── .claude/
    └── skills/            # Claude Code skills (feature-planner 등)
```

---

## 8. 금지 사항

- 운영 서버에서 다른 서비스의 nginx conf를 수정하지 않습니다.
- 공용 postgres DB의 다른 서비스 스키마/데이터를 변경하지 않습니다.
- `docker network edge`에 연결된 다른 컨테이너에 영향을 주지 않습니다.
- 사용자 승인 없이 `docker compose down` 또는 `docker compose restart`를 실행하지 않습니다.
- 포트를 `0.0.0.0`으로 바인딩하지 않습니다 (loopback-only 원칙).

## 공통 문서 참조 (DevScent 공통 원본)

회사 공통 문서는 이 repo 에 복사하지 않는다. 원본을 직접 읽는다.

- 원본 위치: `../_template/docs/` (Windows: `D:\Projects\_template\docs`, Linux: `~/projects/_template/docs`)
- 01_ABOUT_DEVSCENT · 02_DESIGN_GUIDE(공통 원칙) · 02_DESIGN_GUIDE_v2(devscent.com 마케팅 표면) · 03_PORTFOLIO_GUIDE · 04_PORTFOLIO_BRIEF_TEMPLATE · 05_COMPANY_OPERATION_ONBOARDING · 06_BUSINESS_LEGAL_INFO · 07_NICEPAY_INTEGRATION · 08_DATA_PROCESSING_AGREEMENT
- 고칠 내용은 `_template` 에서 고친다. 이 repo 의 `docs/` 에 위 이름의 파일을 만들지 않는다.
- 서비스 고유 내용: 디자인 `docs/design/`, 기획 `docs/product/`, 서비스 소개 `docs/ABOUT_SERVICE.md`, 포트폴리오 `docs/04_PORTFOLIO_BRIEF.md`
