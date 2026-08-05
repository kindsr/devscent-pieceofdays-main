# DevScent 운영 매뉴얼 인덱스

최종 업데이트: 2026-04-17

> 목적: DevScent 인프라 운영자가 한 번에 볼 수 있는 단일 진입점 문서입니다. 
> 원칙: 루트 변경 없이 운영 표준을 통일하고, 긴급 대응 시 15분 내 추적 가능한 상태로 전개합니다.

## 1) 즉시 확인해야 할 규칙(필독)

- 운영 환경은 `docker compose` + `nginx edge` + `postgres14` 패턴을 기본으로 유지합니다.
- 공용 자원(`edge`, `postgres14`, 도메인/포트 정책)을 건드리는 변경은 사전 승인 후 반영합니다.
- 운영 변경은 무조건 기록: `/home/kindsr/server-runbook/03_OPS_CHANGELOG.md`
- 서비스 추가/삭제/도메인 변경은 `/home/kindsr/server-runbook/04_PORT_EXPOSURE_POLICY.md`와 `/home/kindsr/server-runbook/02_SERVICE_INVENTORY.md` 갱신이 선행되어야 합니다.
- 외부 공개 포트, 민감값, 스케줄러는 문서 동기화가 선행되어야 합니다.

## 2) 공통 기준(실행 원칙)

1. **단일 재현 원칙**: 각 프로젝트는 기본적으로 다음 위치에서 동일한 운영 명령으로 시작/재시작 가능해야 합니다.
   - 루트에서 `docker compose up -d --build`
2. **서비스 격리 원칙**: 도메인 라우팅 변경은 다른 서비스에 영향이 없어야 하며, 배포 전 사전 점검 스크립트를 통해 격리 확인.
3. **루프백/네트워크 원칙**: 공개는 Nginx 및 도메인 경유만 허용하고, DB·내부 서비스는 되도록 내부 경로·볼륨 기반으로 분리.
4. **문서 우선 원칙**: 새 작업 착수 전 `CLAUDE.md`와 서버 운영 문서를 읽고 진행.

## 3) 핵심 참조 문서(필독 경로)

### 공통 운영 레퍼런스

- `/home/kindsr/server-runbook/00_SERVER_OPERATIONS_MID_REVIEW_2026-02-24.md`
- `/home/kindsr/server-runbook/01_SERVER_MANAGEMENT_EXECUTION_GUIDE_2026-02-24.md`
- `/home/kindsr/server-runbook/02_SERVICE_INVENTORY.md`
- `/home/kindsr/server-runbook/03_OPS_CHANGELOG.md`
- `/home/kindsr/server-runbook/04_PORT_EXPOSURE_POLICY.md`
- `/home/kindsr/server-runbook/05_CRON_SCHEDULER_POLICY.md`
- `/home/kindsr/server-runbook/06_BACKUP_RESTORE_RUNBOOK.md`
- `/home/kindsr/server-runbook/07_SECRETS_ROTATION_LIST.md`
- `/home/kindsr/server-runbook/09_MONITORING_LOGGING.md`

### 프로젝트 공통 레퍼런스

- `/home/kindsr/projects/devscent-home/CLAUDE.md`
- `/home/kindsr/projects/devscent-home/CHANGELOG.md`
- `/home/kindsr/projects/devscent-home/docs/01_ABOUT_DEVSCENT.md`
- `/home/kindsr/projects/devscent-home/docs/02_DESIGN_GUIDE.md`
- `/home/kindsr/projects/devscent-home/docs/02_DESIGN_GUIDE_v2.md`
- `/home/kindsr/projects/devscent-home/docs/03_PORTFOLIO_GUIDE.md`
- `/home/kindsr/projects/devscent-home/docs/04_PORTFOLIO_BRIEF_TEMPLATE.md`

## 4) 프로젝트별 빠른 실행 명령(최소 버전)

공통 실행 루트에서 동일하게 먼저 시도: `cd <project_dir> && docker compose up -d --build`

| 프로젝트 | 추천 실행 위치 | compose 파일 |
|---|---|---|
| devscent-home | `/home/kindsr/projects/devscent-home` | `docker-compose.yml` |
| devscent-atrader | `/home/kindsr/projects/devscent-atrader` | `docker-compose.yml` |
| devscent-btrader | `/home/kindsr/projects/devscent-btrader` | `docker-compose.yml` |
| devscent-erp-main | `/home/kindsr/projects/devscent-erp-main` | `docker-compose.yml` |
| devscent-farmdiary-main | `/home/kindsr/projects/devscent-farmdiary-main` | `docker-compose.yml` |
| devscent-fishing-main | `/home/kindsr/projects/devscent-fishing-main` | `docker-compose.yml` |
| devscent-games-main | `/home/kindsr/projects/devscent-games-main` | `docker-compose.yml` |
| devscent-hagwonloop-main | `/home/kindsr/projects/devscent-hagwonloop-main` | `docker-compose.yml` |
| devscent-inmemorytrip-main | `/home/kindsr/projects/devscent-inmemorytrip-main` (루트 우선) | `docker-compose.yml` | 
| devscent-namu-main | `/home/kindsr/projects/devscent-namu-main/backend` | `docker/docker-compose.yml` (백엔드), `README` 기준 경로 점검 필요 |
| devscent-parking-solution | `/home/kindsr/projects/devscent-parking-solution/backend` | `docker-compose.dev.yml` (개발/미활성 참고) |
| devscent-ppt-main | `/home/kindsr/projects/devscent-ppt-main` 또는 `/home/kindsr/projects/devscent-ppt-main/deploy` | `docker-compose.yml`, `deploy/docker-compose.yml` |
| devscent-smtm-main | `/home/kindsr/projects/devscent-smtm-main` | `docker-compose.yml` |
| devscent-somudam-main | `/home/kindsr/projects/devscent-somudam-main` (도커 경로 확인) | `docker/docker-compose.yml` |
| devscent-toop-main | `/home/kindsr/projects/devscent-toop-main` | `docker-compose.yml` |
| devscent-wedding-main | `/home/kindsr/projects/devscent-wedding-main` | `docker-compose.yml` |
| fusion-sensor-monitoring | `/home/kindsr/projects/fusion-sensor-monitoring` | `docker-compose.yml` 또는 `docker/docker-compose.yml` |

> 운영팀은 위 표를 기준으로, 실제 배포 환경에서 동작이 다른 프로젝트는 각 프로젝트의 `README.md`와 `CLAUDE.md`를 최종 진입점으로 확인해야 합니다.

## 5) 기본 점검 체크리스트(당일 운영)

- `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'`
- 핵심 로그: `docker logs --tail 200 nginx` / `docker logs --tail 200 postgres14` / 핵심 앱 컨테이너
- 라우팅 반영: `docker exec nginx nginx -t && docker exec nginx nginx -s reload`
- 크론/배치 실행 경로 확인 및 실패 알림 확인
- 운영 변경 이력 기록 (`/home/kindsr/server-runbook/03_OPS_CHANGELOG.md`)

## 6) 긴급도 높은 운영 경로

- 도메인/포트 정책: `/home/kindsr/server-runbook/04_PORT_EXPOSURE_POLICY.md`
- 백업/복구: `/home/kindsr/server-runbook/06_BACKUP_RESTORE_RUNBOOK.md`
- 크론 정책: `/home/kindsr/server-runbook/05_CRON_SCHEDULER_POLICY.md`
- 시크릿 변경: `/home/kindsr/server-runbook/07_SECRETS_ROTATION_LIST.md`
- 모니터링: `/home/kindsr/server-runbook/09_MONITORING_LOGGING.md`
- 장애 대응 로그 템플릿: `/home/kindsr/server-runbook/03_OPS_CHANGELOG.md`

## 7) 다음 단계(필수 보강)

1. 각 프로젝트 루트 `CLAUDE.md` 존재 여부 표준화 (`/home/kindsr/projects/*/CLAUDE.md`).
2. 각 프로젝트 루트 `CHANGELOG.md` 버전 기록 기준 통일.
3. 프로젝트별 `docker compose` 재현성 점검(실제 환경별로 최소 1회 리허설).
4. 위 문서를 `/home/kindsr/projects/devscent-home/docs/plans` 또는 사전 승인된 내부 플레이북 경로에 추가 반영.
5. `/home/kindsr/server-runbook/02_SERVICE_INVENTORY.md`와 문서 인덱스를 월 1회 동기화.

## 8) 운영 문서 정합성 감사(요약)

`/tmp/devscent_audit/doc_audit_report.md` 기준, 현재 누락 항목이 보이는 프로젝트(필수 01~04/CHANGELOG 기준)는 아래와 같습니다.

- `devscent-atrader`: `01_ABOUT_DEVSCENT.md`, `02_DESIGN_GUIDE.md`
- `devscent-erp-main`: `CHANGELOG.md`, `01_ABOUT_DEVSCENT.md`
- `devscent-games-main`: `CHANGELOG.md`, `01_ABOUT_DEVSCENT.md`, `02_DESIGN_GUIDE.md`
- `devscent-inmemorytrip-main`: `01_ABOUT_DEVSCENT.md`
- `devscent-namu-main`: `01_ABOUT_DEVSCENT.md`
- `devscent-ppt-main`: `CHANGELOG.md`, `01_ABOUT_DEVSCENT.md`, `02_DESIGN_GUIDE.md`
- `devscent-smtm-main`: `CHANGELOG.md`, `01_ABOUT_DEVSCENT.md`, `02_DESIGN_GUIDE.md`
- `devscent-tps-main`: `CLAUDE.md`, `CHANGELOG.md`, `04_PORTFOLIO_BRIEF.md`
- `fusion-sensor-monitoring`: `01_ABOUT_DEVSCENT.md`, `02_DESIGN_GUIDE.md`
