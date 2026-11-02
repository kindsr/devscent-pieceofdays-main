# AGENTS.md — DevScent pieceofdays

## 0. 먼저 읽을 정본

공통 규칙의 정본은 `../_template/`다. 경로 참조만으로 본문이 주입됐다고 가정하지 않고 작업 전에 실제로 읽는다.
`../_template`를 찾지 못하면 Linux 정본 `/home/kindsr/projects/_template/`를 읽는다
(`~/development/_template`는 그 symlink다).

1. `../_template/AGENTS.md` 전체(Claude에서 외부 가져오기가 허용돼 이미 읽혔다면 다시 읽지 않는다).
2. 그 작업 표가 가리키는 `../_template/docs/09_DEVELOPMENT_WORKFLOW.md`의 해당 절만.
3. 신규 기술·DB 선택이면 `../_template/docs/10_TECH_STACK_SELECTION.md`.
4. Herdr 메인·하위 진행이면 `../_template/docs/12_HERDR_DEVELOPMENT_WORKFLOW.md`
   (메인 §2.3~2.7, 위임받은 하위 §2.3~2.5·§4). 터미널 주소는 실행 시 확인하며 이 repo 문서에 고정하지 않는다.

모든 작업에 `$karpathy-guidelines`를 적용한다. 아래 서비스 계약은 공통 규칙을 구체화하거나 좁힐 뿐,
작업·운영·배포 권한을 넓히지 않는다.

## 1. 현재 상태

- PRD가 없다. 운영·dev 모두 정적 placeholder 단계이며 앱 스택·DB는 정하지 않았다(DB 없음).
  과거 문서의 PostgreSQL14 등 특정 DB를 이 서비스의 선택으로 보지 않는다.
- 운영: `docker-compose.yml`의 `pieceofdays-comingsoon`이 작업 트리의 `deploy/comingsoon/html`을 bind mount한다.
- dev: `docker-compose.dev.yml`의 `pieceofdays-frontend-dev`가 `frontend/`를 정적 이미지로 빌드한다.
- 현행 경로·도메인·확인 명령은 [README.md](README.md), 배포 절차는 [deploy/README.md](deploy/README.md)다.

## 2. 다음 진행 순서

1. PRD 작성(`docs/PRD.md`) → 공통 09 §2.1~2.3(PRD 분석·shaping·MVP, `docs/product/`).
2. 공통 docs/10에 따라 목적별 전체 구성 2~3안 제시 → 사용자 선택 → `docs/product/00_TECH_STACK_DECISION.md` 기록.
   선택 전에는 중립 문서·기획만 진행한다.
3. 공통 09 §2.4: 스토리보드 → 디자인 브리프 → 서로 다른 시안 3안·사용자 선택 → 선택안 하이파이 아트보드와
   `docs/design/README.md` 핸드오프. 텍스트 와이어프레임·하이파이 문서를 필수 산출물로 만들지 않는다.
4. 공통 09 §2.5 구현 계획(`docs/plans/PLAN_<작업명>.md`) → 구현·시험.

## 3. 경로·배포 경계

- `~/projects/devscent-pieceofdays-main`(master)은 작업 경로이면서 **현재 운영 Compose 위치**다.
  `deploy/comingsoon/html/`의 파일 저장은 커밋·재시작 없이 운영 화면에 반영되므로 사용자 승인 없이 수정하지 않는다.
- `~/development/devscent-pieceofdays-main`(dev)은 자동배포가 origin/dev를 fetch해 `ff-only`로 받는 클린 dev 배포본이다.
  이 서비스의 작업 경계 제안(2026-11-02 메인 권고·미적용, 채택 후 적용): 기능·화면 개발과 커밋은 `~/projects` 아래 별도 worktree에서 하고 `dev` 브랜치를
  push한다. `~/development`에서 파일을 직접 편집·커밋하거나 임시 worktree를 만들지 않는다. 이는 15 런북 §3의
  "`~/development`에서 수정·커밋·push" 예시와 다르다. dev 체크아웃의 `git merge`·ff 같은 배포 유지관리는 파일 편집과 구분하며,
  15 런북과 사용자 승인 범위에서만 한다. 자동배포 동작·merge·push·배포 권한은 기존 그대로이며 이 문서로 늘지 않는다.
- 운영 배포 전용 경로(예: 제안된 `~/deployment/...`)에서는 AI 세션을 시작하지 않는다.
- 작업·dev·운영 경로 분리는 [PLAN](docs/plans/PLAN_workspace-deployment-separation.md)의 **권고안·미적용**이다.
  채택·이전·배포 승인 전까지 위 현행이 유효하다.
- nginx conf 원본은 `deploy/nginx/`, 운영 문서 위치는 `~/server-runbook/README.md` 작업 표에서 찾는다.

## 4. 역사 자료

템플릿 복사 시점의 공통 문서 사본 `docs/01~05_*.md`는 원격 master `281fc06`에서 삭제됐다. 정본은 `../_template/docs/`다.
과거 커밋·체크아웃에 사본이 보여도 근거로 쓰지 않는다.
루트의 `PROMPT_NEW_SERVICE_DOMAIN_BOOTSTRAP.md`도 초기 구성 당시 자료이며, 현재 정본(공통 `_template`·`~/server-runbook`)이 우선한다.
