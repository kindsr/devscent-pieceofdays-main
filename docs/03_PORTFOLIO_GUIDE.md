# DevScent Portfolio Documentation Guide

**Version**: 1.0.0  
**Last Updated**: 2026-03-28  
**Applies to**: All DevScent product repositories

---

## 1. Purpose

이 문서는 각 DevScent 프로젝트에서 포트폴리오 소개 문서와 이미지를
일관된 방식으로 관리하기 위한 공통 규칙입니다.

목표는 다음과 같습니다.

- `devscent-home` 포트폴리오 페이지를 업데이트할 때 전체 소스코드를 뒤지지 않도록 한다.
- 각 프로젝트 repo가 자기 소개의 원본(source of truth)을 직접 관리하도록 한다.
- 공개용 포트폴리오 자산과 QA용 캡처를 분리한다.
- AI 에이전트가 우선적으로 읽어야 할 문서 경로를 고정한다.

---

## 2. Standard Files

각 프로젝트 repo에는 아래 구조를 권장합니다.

```text
docs/
  01_ABOUT_DEVSCENT.md
  02_DESIGN_GUIDE.md
  03_PORTFOLIO_GUIDE.md
  04_PORTFOLIO_BRIEF.md
  portfolio/
    manifest.json
    cover.svg
    screens/
  qa/
    screens/
```

### Required

- `docs/03_PORTFOLIO_GUIDE.md`
  - 공통 규칙 문서
  - 이 문서를 그대로 복사해서 사용
- `docs/04_PORTFOLIO_BRIEF.md`
  - 프로젝트별 실제 소개 내용
  - 대외 소개문, 핵심 강조 포인트, 보여줄 화면 등을 관리
- `docs/portfolio/manifest.json`
  - 기계가 읽기 쉬운 구조화 메타데이터
  - `devscent-home`가 자동 집계할 때 사용
- `docs/portfolio/screens/`
  - 공개용 포트폴리오 이미지
- `docs/qa/screens/`
  - QA 원본 캡처

### Optional

- `docs/portfolio/cover.svg`
  - 리스트 카드에서 쓰는 대표 커버
- `docs/portfolio/cover.png`
  - SVG 커버가 없는 경우 대체 이미지

### Bootstrap From devscent-home

프로젝트에 포트폴리오 문서가 아직 없다면 아래 원본을 기준으로 시작합니다.

- `docs/03_PORTFOLIO_GUIDE.md`가 없다면
  - `~/projects/devscent-home/docs/03_PORTFOLIO_GUIDE.md`를 복사
- `docs/04_PORTFOLIO_BRIEF.md`가 없다면
  - `~/projects/devscent-home/docs/04_PORTFOLIO_BRIEF_TEMPLATE.md`를 복사한 뒤
  - 프로젝트 경로에서 파일명을 `docs/04_PORTFOLIO_BRIEF.md`로 저장

나중에 슬라이드형 상세 화면이나 자동 집계를 위해 구조화 메타데이터와 이미지 경로가 필요하면 아래도 같이 복사합니다.

- `docs/portfolio/manifest.json`이 없다면
  - `~/projects/devscent-home/docs/portfolio/MANIFEST_TEMPLATE.json`를 복사한 뒤
  - 프로젝트 경로에서 파일명을 `docs/portfolio/manifest.json`로 저장
- `docs/portfolio/screens/`가 없다면
  - `~/projects/devscent-home/docs/portfolio/screens/README.md`를 복사
- `docs/qa/screens/`가 없다면
  - `~/projects/devscent-home/docs/qa/screens/README.md`를 복사

---

## 3. Source of Truth Rules

- 포트폴리오 소개 원본은 각 프로젝트 repo 안에 둡니다.
- `devscent-home`은 원본을 복제 보관하는 곳이 아니라 집계/표현 레이어입니다.
- 기능 소개 문구는 코드에서 추론하지 말고 `docs/04_PORTFOLIO_BRIEF.md`를 우선 참조합니다.
- 소개 문구와 이미지 설명은 공개 가능한 정보만 포함합니다.
- 관리자/내부 운영 화면은 민감 정보 제거 후 공개용으로 선별합니다.

---

## 4. Screenshot Policy

공개용 포트폴리오 이미지는 반드시 QA 원본과 분리합니다.

- 공개용: `docs/portfolio/screens/`
- QA 원본: `docs/qa/screens/`

이유:

- QA 캡처는 중복, 임시 파일, 민감 정보, 실험 화면이 섞이기 쉽습니다.
- 포트폴리오용 이미지는 캡션과 노출 순서가 정리된 선별본이어야 합니다.

### Naming

파일명 규칙:

```text
NN-role-screen-purpose.webp
```

예시:

```text
01-admin-dashboard-overview.webp
02-admin-member-list.webp
03-user-booking-flow.webp
04-mobile-checkin-screen.webp
```

규칙:

- `NN`: 노출 순서
- `role`: `guest`, `user`, `member`, `staff`, `admin`, `mobile` 등
- `screen-purpose`: 화면 이름과 의미
- 확장자는 가능하면 `webp`, 필요 시 `png`

피해야 할 이름:

- `capture.png`
- `final.png`
- `new.png`
- `real-final.png`
- `screenshot-1.png`

---

## 5. 04_PORTFOLIO_BRIEF.md Writing Rules

`04_PORTFOLIO_BRIEF.md`는 아래 원칙을 따릅니다.

- 기능 전체 목록이 아니라 소개에 넣을 핵심만 작성합니다.
- 현재 운영 상태 기준으로 갱신합니다.
- “왜 중요한지”가 드러나야 합니다.
- 기술 스택 나열만 하지 말고 구조적 차별점을 설명합니다.
- 포트폴리오 상세 페이지에서 어떤 화면을 보여줘야 하는지까지 같이 적습니다.

필수 항목:

- One-liner
- Current Status
- What It Solves
- Current Highlights
- Ops / Automation Points
- Architecture / Tech Keywords
- Screens Worth Showing
- Last Updated

---

## 6. manifest.json Rules

`manifest.json`은 AI/스크립트가 읽기 쉬운 형태여야 합니다.

포함 권장 필드:

- `id`
- `name`
- `status`
- `summary`
- `category`
- `period`
- `role`
- `domain`
- `cover`
- `highlights`
- `gallery`
- `last_updated`

`gallery` 각 항목 권장 필드:

- `src`
- `title`
- `caption`
- `role`
- `order`
- `public`

---

## 7. Update Workflow

프로젝트 기능이 크게 바뀌거나 운영 상태가 달라지면 아래 순서로 갱신합니다.

1. `docs/04_PORTFOLIO_BRIEF.md` 수정
2. `docs/portfolio/manifest.json` 수정
3. 필요 시 `docs/portfolio/screens/` 선별 이미지 교체
4. 소개문/메타데이터를 반영하려면 `~/projects/devscent-home/scripts/build_portfolio_catalog.py` 실행
5. 갤러리 자산을 반영하려면 `~/projects/devscent-home/scripts/sync_portfolio_gallery.py` 실행
6. 그 다음 `devscent-home` 포트폴리오 반영 및 확인

---

## 8. AI Agent Rule

AI 에이전트에게는 아래 순서를 우선 참조하도록 지시합니다.

1. `docs/03_PORTFOLIO_GUIDE.md`
2. `docs/04_PORTFOLIO_BRIEF.md`
3. `docs/portfolio/manifest.json`
4. `docs/portfolio/screens/`
5. `docs/plans/`

이 문서들이 존재하면 전체 코드베이스 스캔보다 우선합니다.

---

## 9. CLAUDE.md Copy Block

아래 블록은 각 프로젝트의 `CLAUDE.md`에 그대로 복사해서 사용할 수 있는 최소 규칙입니다.

```md
## Portfolio Docs

- 포트폴리오 소개, 서비스 요약, 공개용 캡처 정리 작업이 있다면 먼저 아래를 확인합니다:
  - `docs/03_PORTFOLIO_GUIDE.md`
  - `docs/04_PORTFOLIO_BRIEF.md`
- 위 문서가 있으면 전체 코드베이스 스캔보다 우선해서 참조합니다.
- `docs/03_PORTFOLIO_GUIDE.md`가 없다면 `~/projects/devscent-home/docs/03_PORTFOLIO_GUIDE.md`를 복사해 사용합니다.
- `docs/04_PORTFOLIO_BRIEF.md`가 없다면 `~/projects/devscent-home/docs/04_PORTFOLIO_BRIEF_TEMPLATE.md`를 복사해 생성합니다.
- 공개용 이미지는 `docs/portfolio/screens/`를 사용합니다.
- QA 원본 캡처는 `docs/qa/screens/`에 보관하고 직접 공개용으로 사용하지 않습니다.
- 구조화 메타데이터가 필요하면 `docs/portfolio/manifest.json`을 사용합니다.
- `docs/portfolio/manifest.json`이 없다면 `~/projects/devscent-home/docs/portfolio/MANIFEST_TEMPLATE.json`를 복사해 생성합니다.
- `docs/portfolio/screens/` 또는 `docs/qa/screens/`가 없다면 `~/projects/devscent-home/docs/` 아래 동일 경로의 README/구조를 복사해 시작합니다.
```

더 긴 버전이 필요하면 다음 요소를 추가할 수 있습니다.

- `docs/portfolio/manifest.json`
- `docs/portfolio/screens/`
- `docs/plans/`
