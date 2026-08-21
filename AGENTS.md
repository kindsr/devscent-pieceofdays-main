# AGENTS.md - DevScent Codex Project Guide

이 파일은 Codex가 이 템플릿 기반 프로젝트에서 작업할 때 따르는 기본 가이드다. 기존 `CLAUDE.md`의 DevScent 운영/개발 규칙을 Codex용으로 옮기되, 계획 단계 산출물과 검증 기준을 더 명확히 한다.

## 0. Required Skill

- 모든 코드 작성, 리뷰, 리팩터링 작업에는 `$karpathy-guidelines`를 적용한다.
- 작업 전에는 가정, 해석, 성공 기준을 짧게 드러낸다.
- 구현은 요청 범위에 맞춰 작게 진행한다. 단일 사용처를 위해 추상화를 만들지 않는다.
- 기존 코드와 문서 스타일을 따른다. 관련 없는 정리, 포맷 변경, 리팩터링은 하지 않는다.
- 완료 전에는 가능한 검증 명령을 실행하고, 실행하지 못한 검증은 이유를 남긴다.

## 1. Start Here

새 기능, 새 서비스, 리디자인, 운영 변경을 시작하면 아래 순서로 확인한다.

1. 저장소 구조를 먼저 읽는다.
   - `pwd`, `ls`, `rg --files`, 패키지/프레임워크 메타데이터를 확인한다.
   - 기존 구현이 있으면 그 패턴을 우선한다.
2. 요구사항 문서를 찾는다.
   - 우선순위: `docs/PRD.txt`, `docs/PRD.md`, `docs/product/PRD.md`.
   - PRD가 없고 작업 범위가 제품/기능 설계라면 바로 구현하지 말고 PRD 작성 또는 요구사항 정리를 먼저 제안한다.
3. 디자인 작업이면 `docs/02_DESIGN_GUIDE.md`를 먼저 읽는다.
   - `devscent.com` 마케팅 표면은 `docs/02_DESIGN_GUIDE_v2.md`도 함께 확인한다.
4. 운영/배포 영향이 있으면 `~/projects` 운영 문서를 확인한다.
   - `02_SERVICE_INVENTORY.md`, `04_PORT_EXPOSURE_POLICY.md`, `05_CRON_SCHEDULER_POLICY.md`, `06_BACKUP_RESTORE_RUNBOOK.md`, `09_MONITORING_LOGGING.md`.
5. 인프라 변경은 공유 서비스에 미치는 영향을 먼저 판단한다.
   - nginx: `/opt/infra/nginx/`
   - PostgreSQL: `/opt/infra/postgres14/`
   - Docker network: `edge`

## 2. Planning Contract

제품/기능 단위 작업은 PRD를 요구사항 원문으로 삼아 계획 문서를 먼저 만든다. 단순 버그 수정이나 문서 오탈자 수정에는 이 단계를 축소할 수 있다.

### 2.1 PRD Analysis

`docs/product/01_PRD_ANALYSIS.md`에 아래를 정리한다.

- 원문 요구사항 요약
- 사용자군과 핵심 작업
- 문제, 목표, 비목표
- 기능 요구사항과 비기능 요구사항
- 데이터, 권한, 운영, SEO, 국제화, 접근성 요구
- 모호한 부분과 확인 질문
- 성공 기준과 측정 지표

### 2.2 Brainstorming and Shaping

`docs/product/02_SHAPING.md`에 아래를 정리한다.

- 더 나은 아이디어 후보와 버린 이유
- MVP에 넣을 것과 의도적으로 제외할 것
- 기술/디자인/운영 리스크
- 해결이 필요한 rabbit hole
- 시간 예산과 범위 경계

Shape Up 방식처럼 문제, appetite, 솔루션 윤곽, 위험, 제외 범위를 분리한다. 다만 PRD와 현재 코드베이스를 무시한 큰 재설계는 하지 않는다.

### 2.3 MVP Definition

`docs/product/03_MVP.md`에 첫 출시 범위를 정의한다.

- 핵심 사용자 여정
- 수직 슬라이스
- 화면 목록
- API/데이터 모델 초안
- 권한/보안/운영 요구
- 테스트 계획
- 출시 가능 조건

### 2.4 Design Stage

설계 단계에서는 실제 구현 전에 다음 문서를 만든다.

- `docs/product/04_STORYBOARD.md`: 사용자의 감정, 목표, 화면 전환, 실패/빈 상태를 장면 단위로 설명한다.
- `docs/product/05_WIREFRAMES.md`: 데스크톱, 태블릿, 모바일의 핵심 화면을 텍스트 와이어프레임으로 그린다.
- `docs/product/06_HIGH_FIDELITY_DESIGN.md`: 실제 서비스처럼 보일 시각 방향, 컬러/타입/컴포넌트/모션/이미지 사용 기준을 정의한다.

하이파이 설계는 단순 예쁜 콘셉트가 아니라 구현 가능한 화면 명세여야 한다. 버튼 상태, 입력 상태, 빈 데이터, 오류, 로딩, 권한 제한, 모바일 네비게이션까지 포함한다.

### 2.5 Implementation Plan

구현 전 `docs/plans/PLAN_<feature-name>.md`를 만든다.

- 파일별 변경 계획
- 테스트 전략
- 마이그레이션/배포 영향
- 롤백 방법
- 검증 명령

## 3. Product and Design Skill Set

유명 제품 개발 방식에서 가져올 실천 항목은 다음처럼 적용한다.

| Practice | Apply As | When |
|----------|----------|------|
| Karpathy-style surgical coding | 가정 공개, 작은 변경, 검증 루프 | 모든 코드 작업 |
| Shape Up | appetite, pitch, rabbit hole 제거, out-of-bounds 선언 | PRD 이후 범위 확정 |
| Design Sprint | map, sketch, decide, prototype, test 사고방식 | 새 제품/리디자인 초안 |
| TDD | 실패 테스트, 최소 구현, 리팩터링 | 도메인 로직, 버그 수정 |
| ATDD/BDD | 사용자 관점 acceptance scenario와 given/when/then | 권한, 결제, 알림, 운영 플로우 |
| Fowler-style refactoring | 행동 보존, 작은 단계, 테스트 기반 개선 | 기존 코드 정리 |
| Evolutionary architecture | 한 번에 완성 설계보다 마이그레이션 가능한 구조 | DB/API/인프라 변경 |

사용 가능한 로컬 스킬이 있다면 작업 성격에 맞게 사용한다.

- `$design-consultation`: 제품 정체성과 디자인 방향을 잡을 때
- `$design-shotgun`: 여러 디자인 콘셉트를 비교할 때
- `$plan-design-review`: 구현 전 디자인 계획을 검토할 때
- `$plan-eng-review`: 아키텍처와 테스트 계획을 잠그기 전에
- `$browse` 또는 `$gstack`: 실제 브라우저 반응형/상호작용 확인
- `$qa`: 구현 후 사용자 흐름을 점검하고 수정할 때
- `$review`: 랜딩/배포 전 diff 위험을 검토할 때
- `$ship`, `$land-and-deploy`: 커밋, PR, 배포, 배포 후 검증을 묶어서 진행할 때

## 4. Architecture Rules

기본 구조는 클린 아키텍처를 따른다. 기존 프로젝트가 다른 구조를 이미 갖고 있으면 기존 경계를 우선한다.

```text
src/
├── domain/          # 엔티티, 비즈니스 규칙
├── application/     # 유스케이스, 서비스 레이어
├── infrastructure/  # DB, 외부 API, 프레임워크 구현체
└── presentation/    # API 컨트롤러, UI
```

- 의존성은 presentation -> application -> domain 방향으로 둔다.
- domain은 프레임워크, DB, 외부 API에 의존하지 않는다.
- 포트/인터페이스는 domain/application에 두고, 구현은 infrastructure에 둔다.
- DB 변경은 마이그레이션으로 남기고, 데이터 이동/롤백을 함께 고려한다.

## 5. Frontend Rules

- 첫 화면은 실제 사용 가능한 제품 경험이어야 한다. 요청이 명확한 마케팅 사이트가 아니라면 랜딩만 만들지 않는다.
- 디자인은 `btrader`, `atrader`, `malmoelab`, `toop`, `inmemorytrip`, `wedding`처럼 서비스 도메인별로 다른 콘셉트를 가질 수 있다.
- 단, 한 제품 안에서는 하나의 콘셉트, 토큰, 컴포넌트 규칙을 일관되게 사용한다.
- 모바일은 별도 후처리가 아니라 최초 설계 범위다. 네비게이션, 테이블, 차트, 카드, 폼, 모달은 모바일 동작을 문서와 구현에 포함한다.
- 모든 사용자 표시 문구는 가능한 i18n 키로 관리한다.
- 접근성은 WCAG AA를 기준으로 한다. 키보드 포커스, aria label, 색상 대비, reduced motion을 확인한다.

## 6. Testing and Verification

위험도에 맞춰 검증을 선택한다.

- 도메인 로직: unit test
- API/권한/데이터 흐름: integration test
- 핵심 사용자 여정: Playwright 또는 브라우저 QA
- 반응형 UI: 모바일/태블릿/데스크톱 viewport 스크린샷 확인
- 운영/배포: health check, 로그, 컨테이너 상태, nginx 라우팅 확인

검증 결과는 최종 응답에 명령과 결과를 짧게 남긴다.

## 7. Operations Rules

인프라, 도메인, 포트, 크론, 백업, 배포 구성이 바뀌면 운영 문서를 동기화한다.

- `~/server-runbook/03_OPS_CHANGELOG.md`
- `~/server-runbook/02_SERVICE_INVENTORY.md`
- `~/server-runbook/04_PORT_EXPOSURE_POLICY.md`
- `~/server-runbook/05_CRON_SCHEDULER_POLICY.md`
- `~/server-runbook/06_BACKUP_RESTORE_RUNBOOK.md`

금지 사항:

- 다른 서비스의 nginx conf를 임의로 수정하지 않는다.
- 공용 PostgreSQL의 다른 DB/스키마/데이터를 변경하지 않는다.
- `docker network edge`의 다른 컨테이너에 영향을 주지 않는다.
- 사용자 승인 없이 운영 서비스에 `docker compose down`을 실행하지 않는다.
- 포트를 `0.0.0.0`으로 바인딩하지 않는다. 기본은 `127.0.0.1` loopback-only다.

## 8. Changelog and Git

- 모든 의미 있는 변경은 `CHANGELOG.md`에 기록한다.
- 버전 규칙은 SemVer를 따른다.
- 사용자가 커밋/푸시를 요청하면 해당 프로젝트 경로에서만 상태를 확인하고 커밋/푸시한다.
- 작업 전부터 있던 변경은 되돌리지 않는다. 관련 변경이면 읽고 함께 맞춘다.

## 9. Definition of Done

- PRD 또는 사용자 요청과 변경 내용이 직접 연결된다.
- 계획 문서가 필요한 작업이면 PRD 분석, shaping, MVP, storyboard, wireframe, high-fidelity 설계가 남아 있다.
- 구현은 기존 패턴을 따른다.
- 테스트 또는 수동 검증을 실행했다.
- 운영/SEO/문서 영향이 있으면 관련 문서와 파일을 갱신했다.
- 최종 응답에 변경 파일, 검증 결과, 남은 위험을 짧게 보고했다.
