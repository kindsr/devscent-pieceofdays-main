# PLAN — pieceofdays 작업·dev·운영 경로 분리

- 작성: 2026-11-02
- **상태: 초기 권고 기록.** 이후 사용자가 GitHub Actions dev/main 자동배포를 승인했다(2026-11-02). 실제 전환 계약·검증은 [후속 계획](PLAN_github-actions-deployment.md)을 따른다. 아래 현행은 전환 전 조사 시점의 상태다.
- 경로 표기: `<source-dir>`·`<dev-dir>`·`<release-dir>`·`<private-runbook>` 등은 공개 저장소용 placeholder다(조사 당시 실측 경로를 가림). 정확한 서버 값은 비공개 운영 정본이 관리한다.
- 범위: pieceofdays 한 서비스. 도메인은 유지한다.
- 근거: 2026-11-02 메인 배정 읽기 전용 조사(`docker inspect` 라벨·마운트, `curl`, `git ls-remote`/`fetch`)의 실측값을 §1에 옮겼다.
  조사 보고 원문은 임시 파일이라 보존되지 않는다. 대조할 정본 경로: `<private-runbook>/15_DEV_PROD_WORKFLOW_RUNBOOK.md` §1~4,
  `<private-runbook>/02_SERVICE_INVENTORY.md`의 pieceofdays 행, 저장소 `docker-compose.yml`·`docker-compose.dev.yml`·
  `deploy/nginx/99-pieceofdays*.conf`, `<dev-poller>`(fetch → `status --porcelain -uno` → `merge --ff-only` → `up -d --build`),
  Docker 공식 문서(§9).

## 1. 현행 (실측)

| 역할 | 경로·브랜치 | Compose project | 실행 |
|---|---|---|---|
| AI 작업 + **운영** | `<source-dir>` (master `281fc06`) | `devscent-pieceofdays-main` (폴더명 기본값) | `pieceofdays-comingsoon`이 작업 트리 `deploy/comingsoon/html`을 bind mount(`:ro`) |
| dev | `<dev-dir>` (dev `71fdf4a`) | `pieceofdays-dev` | `pieceofdays-frontend-dev`, `frontend/` 정적 이미지, 마운트 없음, 1분 자동배포 |
| 운영 배포본 | 없음 (`<release-root>` 미존재) | — | — |

- nginx upstream은 컨테이너 이름(`pieceofdays-comingsoon:80`, `pieceofdays-frontend-dev:80`)만 쓴다. 파일 경로 의존 없음.
- DNS·TLS·공개 URL 감시는 도메인 기반이다. pieceofdays 전용 크론·DB·미디어 백업 대상은 없다.
- 현황 차이(이번에 수정하지 않음): 운영 `99-pieceofdays-dev.conf`에 저장소 사본에 없는 `include security-headers.inc`가 있다.

### 문제

1. AI 세션의 작업 폴더가 운영 bind mount 원본이다. 커밋하지 않은 편집도 즉시 `pieceofdays.com`에 노출된다.
   15 런북 §1 원칙 3(운영 체크아웃에 미커밋 수정 금지)과 구조적으로 충돌한다.
2. `:ro`는 컨테이너 안의 쓰기만 막는다. 호스트 편집의 운영 반영은 막지 못한다.
3. 운영 버전이 커밋·이미지로 고정되지 않아 무엇이 떠 있는지와 이전 버전을 기록·복원하기 어렵다.

## 2. 권고 구조와 비교

| 역할 | 현행 | 권고 (미적용) |
|---|---|---|
| AI 편집·브랜치·worktree | `<source-dir>` (운영과 공유) | `<source-dir>` — AI 작업 전용, 운영 Compose 실행 금지 |
| dev 런타임 | `<dev-dir>` | 동일. 자동배포가 origin/dev를 `ff-only`로 받는 클린 배포본. 개발·커밋은 `<source-dir>` 아래 별도 worktree → `dev` push |
| 운영 | `<source-dir>/...` 작업 트리 bind mount | `<release-dir>` — 배포 설정·릴리스 기록, SHA 태그 고정 이미지(필요 시 clean release checkout). 소스 bind mount 없음 |

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A. 현행 유지 | 변경 없음 | 작업 없음 | 위 문제 1~3 그대로 |
| B. 이미지 고정만 | 같은 폴더에서 bind 제거·이미지 빌드 | 호스트 편집의 즉시 반영 차단 | 운영 실행 위치와 AI 작업 폴더가 계속 섞임 |
| **C. 권고** | B + 운영 실행 위치를 `<release-dir>`로 분리 | 역할별 경로가 명확, 지금이 이전 비용 최저(정적 1컨테이너·DB/env 없음) | 15 런북 "운영 = `<source-dir>`" 규칙의 서비스 한정 예외가 생김 |

같은 호스트·같은 사용자·같은 Docker 권한이므로 C도 서버·보안 격리가 아니다. 목적은 실수 반영 방지와
"운영은 기록된 커밋·이미지로만 바뀐다"는 추적성이다.

## 3. 선행 조건 (모두 이전 착수 전)

1. master: 로컬 master를 원격 `281fc06`과 동기화 완료(2026-11-02). 이 계획을 포함한 문서 정리 변경은 미커밋이다.
2. dev: origin/dev `71fdf4a`는 master보다 7커밋 뒤이며 미푸시 상태다. `AGENTS.md` §3 작업 경계와 15 런북·사용자 승인 범위에서 정리하고 dev 정상 동작을 확인한다.
   dev는 `frontend/`의 다른 이미지라 dev 정상은 운영 후보 이미지의 검증이 아니다(§4-4).
3. 사용자가 C안 채택과 운영 컨테이너 교체를 승인한다. DB가 없어 데이터 migration은 없지만 컨테이너 재생성 중 짧은 중단이 생길 수 있다.

## 4. 최소 이전 순서 (승인 후, 메인이 실행)

1. **롤백 자료 동결(저장소 변경 전):** 작업 트리 밖, 후보 릴리스와 분리된 위치(예: `<release-dir>/rollback/<날짜>/`)에
   현재 실제로 서빙 중인 HTML 사본과 해시, 현재 `docker-compose.yml` 사본, 현재 컨테이너의 nginx base 이미지 ID를 보관한다.
   그 HTML을 같은 base 이미지 ID 위에 담은 롤백 이미지(예: `pieceofdays-comingsoon:rollback-<날짜>`)와, 같은 project 이름·
   `container_name`·`edge`로 그 이미지를 띄우는 롤백 Compose를 만든다. 롤백 Compose는 다른 폴더에서 실행되므로
   `name: devscent-pieceofdays-main`을 반드시 명시한다. 이 자료는 이후 단계에서 바꾸지 않는다.
2. **저장소 변경(추후 구현, dev 브랜치 → master):** 운영 Compose 정의의 정본은 저장소 `docker-compose.yml` 하나로 둔다.
   준비중 HTML을 `COPY`하는 이미지 정의를 추가하고, bind mount를 제거하고, 이미지는 `image: ${IMAGE_REF:?}` 같은 변수 계약으로
   참조한다(자기 커밋 SHA를 파일에 박지 않는다). `name: devscent-pieceofdays-main` 명시로 현재 project 이름을 보존한다.
   `container_name: pieceofdays-comingsoon`과 `edge` 네트워크는 유지한다(nginx 변경 불필요).
   project 이름을 바꿔야 한다는 판단이 생기면 이 계획에서 하지 않고 별도 검토한다.
   **이 Compose가 master에 들어온 뒤 §4-6 전환과 §5 검증이 끝날 때까지 `<source-dir>`에서 운영 Compose `up`·`build`·`pull`을
   실행하지 않는다.** 그 사이에도 `<source-dir>` 작업 트리의 HTML이 계속 운영에 서빙되므로 현행 운영 체크아웃 규칙을 유지한다.
   준비중 HTML 수정이 필요하면 전환을 먼저 끝내거나 롤백 자료를 다시 동결한다.
3. **후보 이미지·릴리스 manifest:** 이미지는 검증된 SHA의 clean checkout에서 빌드해 SHA로 태그하고 이미지 ID(registry를 쓰면
   digest로 고정)를 기록한다. `<release-dir>`에는 그 SHA의 저장소 Compose를 그대로 가져온 사본과, 변경 이력이 남는
   (예: 그 폴더의 Git으로 추적하는) 릴리스 manifest만 둔다. manifest에는 배포 일시·커밋 SHA·`IMAGE_REF` 값·이미지 ID/digest·
   Compose 파일 해시·직전 버전·롤백 자료 위치를 남긴다. 배포 위치의 Compose 사본은 임의로 고치지 않으며, 바꿀 때는 저장소 커밋 →
   새 릴리스로만 바꾼다. `docker compose config` 결과는 앞으로 비밀값이 섞일 수 있으므로 전문을 저장하지 않고
   비밀을 뺀 설정 요약이나 해시만 남긴다.
4. **후보 격리 검증:** 후보 이미지를 다른 이름의 격리 컨테이너(`edge` 미연결, 호스트 포트 없음)로 따로 실행해 health와
   서빙 HTML(해시·제목·noindex)을 확인한 뒤 제거한다. dev 컨테이너는 `frontend/`의 다른 이미지라 이 검증을 대신하지 않는다.
5. **기준 측정:** 운영 200·제목·noindex, http/https 301과 경로·쿼리 보존, 컨테이너 health를 기록한다.
6. **전환:** 직전에 실행할 이미지 ID가 릴리스 기록·격리 검증한 후보와 같은지 확인한다. 같은 project 이름이라
   `<release-dir>`에서 `up -d`하면 기존 컨테이너가 재생성되며 짧은 중단이 생길 수 있다.
   project 이름이 다른 두 스택을 동시에 올리지 않는다(`container_name` 충돌·중복 기동).
7. **검증(§5)이 모두 끝난 뒤에만** `<source-dir>`을 AI 작업 전용으로 선언한다. 그 뒤 이 폴더에서
   운영 Compose를 실행하면 같은 project로 되돌아가므로 실행을 금지한다. `<release-dir>`에서는 AI 세션을 시작하지 않는다.
8. **문서 동기화(§7).**

## 5. 검증

- `docker inspect pieceofdays-comingsoon`: project=`devscent-pieceofdays-main`, working_dir=`<release-dir>`, 마운트 없음,
  이미지 ID가 릴리스 기록·격리 검증 후보와 같음, healthy.
- §4-5 기준과 같은 HTTP 결과. 공개 URL 감시 다음 주기 OK.
- 편집 분리는 실제 배포일에 위 마운트 없음·라벨·이미지 ID와 함께 내용 동일성으로 판정한다: 컨테이너 안 서빙 HTML(검사 범위 파일)의
  해시 = 후보 이미지 빌드 시 해시 = 해당 SHA 저장소 파일 해시, 배포 위치 Compose 해시 = manifest 기록.
  `<source-dir>`나 다른 원본 파일을 고쳐 보는 방식으로 확인하지 않는다.
- dev 컨테이너·자동배포 상태 변화 없음, nginx conf 변경 없음.

## 6. 롤백

- 전환 후 문제: §4-1에서 동결한 롤백 Compose·롤백 이미지로 `up -d`해 이전 HTML을 같은 project·`container_name`으로 되돌린다.
  §4-2 이후 바뀐 `<source-dir>`의 Compose나 작업 트리는 롤백 원본으로 쓰지 않는다. 롤백 후 서빙 HTML 해시가 동결 해시와 같은지 확인한다.
- 이후 릴리스 문제: 릴리스 기록의 직전 이미지 태그·ID(digest)로 되돌린다. 저장소 변경은 커밋 revert.
- 롤백 자료는 검증 기간이 끝나고 새 릴리스 기록이 안정될 때까지 지우지 않는다.
- DB가 없어 데이터 migration·되돌릴 수 없는 지점은 없다. 전환·롤백 때 컨테이너 재생성으로 짧은 중단은 있을 수 있다.
  DNS·TLS·nginx는 건드리지 않는다.

## 7. 실제 적용 시 동기화할 목록 (지금 수정하지 않음)

- `<private-runbook>/02_SERVICE_INVENTORY.md` pieceofdays 운영 행의 소스 경로
- `<private-runbook>/03_OPS_CHANGELOG.md` 전환 이력
- `<private-runbook>/15_DEV_PROD_WORKFLOW_RUNBOOK.md` §2 구조 표·§4 운영 배포의 pieceofdays 예외
- `<private-runbook>/04_PORT_EXPOSURE_POLICY.md` — 포트 게시가 바뀌는 경우에만
- 백업·감시 문서 — 경로 의존이 새로 생기는 경우에만(현재 없음)
- 저장소 `README.md`, `AGENTS.md`, `deploy/README.md`

## 8. 제외 범위

- 다른 서비스의 일괄 이전, 전역 배포 권한·자동배포 정책 변경, 크론 재설정
- 도메인·DNS·TLS·nginx conf 변경(현황 차이인 security-headers include 동기화 포함)
- `<release-root>` 생성, 운영 컨테이너 교체, merge·push — 승인 전까지 실행하지 않는다

## 9. 근거 링크

- 운영 Compose에서 앱 코드 volume binding 제거 권고: <https://docs.docker.com/compose/how-tos/production/>
- bind mount `ro`는 컨테이너의 쓰기만 막음: <https://docs.docker.com/engine/storage/bind-mounts/>
- Compose project 이름 우선순위(`-p` > `COMPOSE_PROJECT_NAME` > `name:` > 폴더명): <https://docs.docker.com/compose/how-tos/project-name/>
