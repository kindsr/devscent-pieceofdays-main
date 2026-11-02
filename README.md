# pieceofdays

개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays

운영은 준비중 페이지이며, 개발 환경에서는 사용자가 선택한 **D안(C 화면 구성 + A 색)**을 확인할 수 있다. 조각별 수정과 기록 글꼴 설정은 현재 메모리에서 동작하는 프로토타입이며 새로고침하면 초기화된다.
실제 앱은 **TypeScript·React/Next.js + PostgreSQL + 전용 이미지 저장소**, 그리기는 **Konva**로 개발한다(2026-11-02 사용자 선택). [Next.js 앱 골격](app/README.md)에 D 화면과 시험·빌드 기반을 만들었다. 이 앱은 현재 dev의 정적 시안 배포와 별개다. MVP는 기록·하루 정리·다시 보기와 개인용 **하루 꾸미기**를 포함하고, 디자인 마켓·구매·정산은 이후 단계다. 실제 계정·영구 저장·그리기 편집기는 아직 구현 전이다.

- [선택한 D 화면](https://dev.pieceofdays.com/design/d-warm-pieces/) · [기록 글꼴 설정](https://dev.pieceofdays.com/design/d-warm-pieces/#settings)
- [20초 세로 홍보영상](https://dev.pieceofdays.com/promo/) · [MP4 내려받기](https://dev.pieceofdays.com/promo/pieceofdays-d-vertical.mp4)
- [시안 4안 비교](https://dev.pieceofdays.com/design/) · [디자인 핸드오프](docs/design/README.md) · [PRD](docs/PRD.md)

홍보영상은 예시 기록으로 서비스를 사용하는 모습을 보여 주는 콘셉트 영상이다. 제품 진행과 작업 경계는 [AGENTS.md](AGENTS.md)를 따른다.

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

위 시험은 배포 권한·격리 계약을 다룬다. 앱의 경계·브라우저 시험과 실행 명령은 [app/README.md](app/README.md)에 있으며 Node 26·24에서 별도로 검사한다. 실행용 이미지 값은 배포 프로그램이 제공한다.
소스 저장소의 Compose로 운영을 직접 실행하지 않는다. 배포 결과는 GitHub Actions에서 확인한다.

## 문서

- [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md): 공통 `_template` 참조와 서비스 작업 경계
- [기술 구성 결정](docs/product/00_TECH_STACK_DECISION.md), [MVP 범위](docs/product/03_MVP.md), [첫 구현 계획](docs/plans/PLAN_mvp-foundation.md)
- [하루 꾸미기·마켓 확장 구조](docs/product/DECORATION_MARKET_ARCHITECTURE.md), [단계별 개발 계획](docs/plans/PLAN_product-evolution.md)
- [Actions 전환 계획](docs/plans/PLAN_github-actions-deployment.md), [초기 경로 분리 검토](docs/plans/PLAN_workspace-deployment-separation.md)
- [CHANGELOG.md](CHANGELOG.md)

공통 docs 사본은 기존 원격 커밋 `281fc06`에서 제거했다. 정본은 `../_template/docs/`이며 루트 bootstrap 프롬프트는 과거 초기 구성 자료다.
