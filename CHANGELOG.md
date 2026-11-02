# Changelog

이 파일은 [Semantic Versioning](https://semver.org/)과 [Keep a Changelog](https://keepachangelog.com/) 규칙을 따릅니다.

## 기록 규칙

- 모든 변경은 반드시 기록합니다.
- 카테고리: `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Deprecated`
- 날짜 형식: `YYYY-MM-DD`
- 가장 최신 버전이 위에 옵니다.
- `[Unreleased]` 섹션에 아직 릴리스되지 않은 변경을 먼저 기록하고, 릴리스 시 버전 번호를 부여합니다.

---

## [Unreleased]

### Added
- `docs/PRD.md` 추가 (2026-11-02): PRD·MVP **검토 초안(사용자 응답 전)**. 권고 여정 "순간 기록→하루 정리→날짜별 다시 보기", 가정, 최소 슬라이스, MVP 제외 제안, AI 직접 작성/초안 비교(결정 대기), 질문 3개, 수용 기준 초안, 미정 조건. 같은 작업에서 `AGENTS.md` §3.1에 사용자 선택(pieceofdays의 위임 가능한 기획·구현·검증은 개별 Claude Cloud 세션 우선, 메인은 계획·검토·통합·서버 확인, 다른 서비스·전역 CLI 설정 미적용)을 추가.
- GitHub Actions 개발·운영 자동배포 구성 (2026-11-02): `dev` push 개발 배포, 성공한 dev를 `main`에 병합하면 운영 배포. 서비스 전용 SSH 키, SHA/tree·Compose 격리 검사, 후보 health 확인과 실패 시 이미지 복귀.
- `docs/product/UI_UX_RESEARCH_2026-11-02.md` 추가 (2026-11-02): 디자인 소스·제품 레퍼런스 조사와 잠정 추천(미확정, PRD·시안 선택 전).
- `README.md` 추가 (2026-11-02): 현재 운영(bind mount)·dev(정적 이미지) 상태, 도메인, 문서 진입, 읽기 전용 확인 명령.
- `docs/plans/PLAN_workspace-deployment-separation.md` 추가 (2026-11-02): 작업·dev·운영 경로 분리 **권고안·미적용**(비교·선행조건·이전 순서·검증·롤백).
- 도메인 초기 구성 (2026-08-20): 운영 준비중 페이지(`deploy/comingsoon/`, `docker-compose.yml` — `pieceofdays-comingsoon`) 및 dev 플레이스홀더(`frontend/`, `docker-compose.dev.yml` — `pieceofdays-frontend-dev`) 추가.
- nginx conf 원본 4종 추가 (`deploy/nginx/99-pieceofdays*.conf`): canonical 도메인 `pieceofdays.com`, `pieceofdays.co.kr`(+www)·`www.pieceofdays.com` 은 301 리다이렉트, `dev.pieceofdays.com` 은 접근제한(+noindex) dev 프록시.
- `deploy/README.md`: 배포 절차, 도메인 canonical 정책, 인증서 발급 절차, 실서비스 전환 절차 문서화.
- Codex 작업용 `AGENTS.md` 템플릿 추가: `$karpathy-guidelines`, PRD 기반 계획 산출물, 디자인/개발/운영 검증 흐름 정의.

### Changed
- Git 정본을 `kindsr/pieceofdays`로 전환하고 NAS·GitHub 초기 이력을 보존해 통합 (2026-11-02). 개발은 `~/development`, 운영은 `~/deployment/pieceofdays`의 고정 이미지로 분리하는 사용자 승인 반영.
- `CLAUDE.md`·`AGENTS.md`를 공통 정본(`../_template/`, Linux 절대경로는 AGENTS 읽기 fallback) 참조와 서비스 고유 경계만 남긴 짧은 문서로 정리 (2026-11-02). 공통 docs 사본 `docs/01~05_*.md`는 원격 master `281fc06`에서 삭제됨(정본 `_template`).
- `deploy/README.md`에 2026-11-02 점검 안내를 추가하고, 운영 bind mount라 커밋 전 호스트 편집이 즉시 반영된다는 사실을 명시 (2026-11-02).
- `docs/02_DESIGN_GUIDE.md`를 2.0.0으로 갱신하고 PRD 분석, shaping, MVP, 스토리보드, 와이어프레임, high-fidelity 설계 산출물 계약과 서비스별 디자인 콘셉트 패밀리를 추가.
- `docs/02_DESIGN_GUIDE_v2.md`를 2.1.0으로 갱신하고 devscent.com 마케팅 표면과 제품 설계 가이드의 역할 경계를 명확화.

### Fixed
- SSH 기본 umask가 `0002`일 때도 릴리스의 모든 상위 폴더를 명시적으로 `0700`으로 생성하도록 보완 (2026-11-02). 운영 첫 배포의 사전 권한 검사 실패를 회귀 시험으로 재현했으며 기존 운영은 교체하지 않았다.

---

<!-- 아래는 엔트리 예시입니다. 실제 사용 시 교체하세요. -->

## [1.0.0] - 2026-XX-XX

### Added
- 초기 프로젝트 구성

<!-- 엔트리 템플릿:

## [X.Y.Z] - YYYY-MM-DD

### Added
- 새로 추가된 기능

### Changed
- 기존 기능의 변경사항

### Fixed
- 버그 수정

### Removed
- 제거된 기능

### Security
- 보안 관련 변경

### Deprecated
- 향후 제거 예정 기능
-->
