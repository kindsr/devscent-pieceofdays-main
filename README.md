# pieceofdays

개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소.

운영은 정적 준비중 페이지이며 개발 환경에서는 UI 시안 4안(초기 3안 + C 화면에 A 색을 입힌 D)을 비교한다. [PRD](docs/PRD.md)는 검토 초안이며 앱 스택·DB는 아직 정하지 않았다.
제품 진행은 [AGENTS.md](AGENTS.md), UI 방향은 [조사 문서](docs/product/UI_UX_RESEARCH_2026-11-02.md)를 참고한다.
디자인 시안 4안은 https://dev.pieceofdays.com/design/ 에서 비교한다(아직 선택 전, 정본 [docs/design/concepts](docs/design/concepts/README.md)).

## GitHub와 자동배포

Git 정본: https://github.com/kindsr/devscent-pieceofdays-main.git

| 역할 | 브랜치 | 도메인 | 반영 |
|---|---|---|---|
| 소스 작업 | 작업 브랜치/worktree → `dev` | — | 작업 브랜치 → `dev` PR |
| 개발 배포 | `dev` | https://dev.pieceofdays.com | `dev` push → Actions 검사 → 개발 배포 |
| 운영 배포 | `main`의 고정 릴리스 | https://pieceofdays.com | 성공한 `dev`를 `main`에 병합 → Actions 검사 → 운영 배포 |

- 사용자 승인: 2026-11-02, 이 서비스의 dev/main 자동배포. 기존 NAS와 GitHub 초기 이력은 강제 push 없이 통합했다.
- PR은 검사만 실행하며 배포 키를 쓰지 않는다. 환경별 키·GitHub 브랜치 제한·서버의 고정 환경 검사로 dev/운영 권한을 나눈다.
- 운영은 성공한 dev와 같은 소스 tree만 승격하고, 후보·실제 HTTPS/health 확인에 실패하면 직전 이미지로 복귀한다.
- `.co.kr`(+www)·`www.pieceofdays.com`은 canonical(`pieceofdays.com`)로 301한다. dev는 접근 제한+noindex다.
- 배포 흐름은 [배포 문서](deploy/README.md)에 있다. 서버 경로·설정·접속 등 상세 운영 절차는 공개 저장소에 두지 않고 비공개 운영 문서에서 관리한다.

## 로컬 확인

```bash
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
git diff --check
docker compose -f docker-compose.dev.yml -p pieceofdays-dev config --quiet
docker compose -f docker-compose.yml -p devscent-pieceofdays-main config --quiet
```

현재 시험은 배포 권한·격리 계약을 다루며 제품 기능 시험은 앱 구현 후 추가한다. 실행용 이미지 값은 배포 프로그램이 제공한다.
소스 저장소의 Compose로 운영을 직접 실행하지 않는다. 배포 결과는 GitHub Actions에서 확인한다.

## 문서

- [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md): 공통 `_template` 참조와 서비스 작업 경계
- [Actions 전환 계획](docs/plans/PLAN_github-actions-deployment.md), [초기 경로 분리 검토](docs/plans/PLAN_workspace-deployment-separation.md)
- [CHANGELOG.md](CHANGELOG.md)

공통 docs 사본은 기존 원격 커밋 `281fc06`에서 제거했다. 정본은 `../_template/docs/`이며 루트 bootstrap 프롬프트는 과거 초기 구성 자료다.
