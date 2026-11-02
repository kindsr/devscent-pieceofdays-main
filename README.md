# pieceofdays

DevScent 서비스 pieceofdays의 저장소다. 아직 PRD가 없고 운영·dev 모두 정적 placeholder 단계다.
앱 스택·DB는 정하지 않았다(DB 없음). 진행 순서는 [AGENTS.md](AGENTS.md) §2를 따른다.

## 현재 상태 (2026-11-02 읽기 전용 조사 기준)

| 구분 | 경로·브랜치 | Compose | 컨테이너 | 실행 방식 |
|---|---|---|---|---|
| 운영 | `~/projects/devscent-pieceofdays-main` (master) | project `devscent-pieceofdays-main`, `docker-compose.yml` | `pieceofdays-comingsoon` (healthy) | `nginx:stable-alpine`이 이 체크아웃의 `deploy/comingsoon/html`을 bind mount(`:ro`) |
| dev | `~/development/devscent-pieceofdays-main` (dev) | project `pieceofdays-dev`, `docker-compose.dev.yml` | `pieceofdays-frontend-dev` (healthy) | `frontend/`를 빌드한 정적 이미지, 마운트 없음 |

- 두 스택 모두 호스트 포트를 게시하지 않고 공용 nginx → `edge` 네트워크로만 접근한다.
- **주의:** 운영이 이 작업 트리를 직접 서빙하므로 `deploy/comingsoon/html/` 저장은 커밋 전에도 즉시 운영에 반영된다.
- dev 자동배포(현행, `~/server-runbook/15_DEV_PROD_WORKFLOW_RUNBOOK.md`): dev 체크아웃의 `dev` 브랜치에
  새 원격 커밋이 생기면 1분 주기 크론이 `docker-compose.dev.yml`로 재빌드한다. 추적 파일에 미커밋 변경이 있으면 보류한다(untracked 파일은 보류 사유가 아님).
  이 README는 그 범위를 설명할 뿐 자동배포·운영 배포 권한을 추가하지 않는다.
- 브랜치(2026-11-02): 로컬 master는 원격 master `281fc06`(공통 docs 사본 삭제·참조 전환 문서 커밋, 앱·Compose 변경 없음)과
  동기화됐다. origin/dev `71fdf4a`는 master보다 7커밋 뒤이며 아직 dev에 반영·push하지 않았다. dev 정리는 다음 구현의 선행조건이다.
- 운영 nginx의 `99-pieceofdays-dev.conf`에는 `deploy/nginx/` 사본에 없는 `include security-headers.inc` 한 줄이 있다(현황 차이, 미반영).

작업·dev·운영 경로 분리 제안은 [PLAN](docs/plans/PLAN_workspace-deployment-separation.md)에 있으며 **권고안·미적용**이다.

## 도메인

| 도메인 | 동작 |
|---|---|
| `https://pieceofdays.com` | canonical, 운영 준비중 페이지(noindex) |
| `pieceofdays.co.kr`(+www), `www.pieceofdays.com`, http 요청 | 301 → `https://pieceofdays.com$request_uri` |
| `https://dev.pieceofdays.com` | dev, 접근 제한(허용 대역 또는 basic auth) + noindex |

2026-11-02 서버 안 조사에서 운영 200·301을 확인했고, 허용 대역 밖을 흉내 낸 dev 요청은 401+noindex였다.
실제 외부 네트워크에서의 dev 401 확인은 하지 않았다.

## 문서 진입

- 작업 지침: [CLAUDE.md](CLAUDE.md)(Claude) · [AGENTS.md](AGENTS.md)(Codex·공통 경계). 공통 정본은 `../_template/`(Linux `~/projects/_template`).
- 배포·인증서 절차: [deploy/README.md](deploy/README.md) · 운영 문서: `~/server-runbook/README.md`
- 변경 이력: [CHANGELOG.md](CHANGELOG.md)
- 공통 docs 사본 `docs/01~05_*.md`는 원격 master `281fc06`에서 삭제됐고 정본은 `../_template/docs/`다.
  `PROMPT_NEW_SERVICE_DOMAIN_BOOTSTRAP.md`는 초기 구성 당시 자료이며 현재 정본이 우선한다.

## 안전한 확인 명령 (읽기 전용)

```bash
git -C ~/projects/devscent-pieceofdays-main status --short --branch
git -C ~/development/devscent-pieceofdays-main status --short --branch
docker ps --filter name=pieceofdays --format '{{.Names}}\t{{.Status}}'
docker inspect pieceofdays-comingsoon --format '{{index .Config.Labels "com.docker.compose.project"}} {{json .Mounts}}'
curl -sI https://pieceofdays.com/ | head -n 1
```

빌드·`docker compose up/down/restart`·nginx 반영 등 배포 명령은 확인 단계가 아니다. [deploy/README.md](deploy/README.md)와
운영 런북의 절차·승인 범위에서만 실행한다.
