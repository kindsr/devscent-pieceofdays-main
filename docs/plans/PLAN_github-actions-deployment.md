# GitHub Actions 개발·운영 자동배포 계획

- 날짜: 2026-11-02
- 사용자 승인: NAS Git 대신 kindsr/pieceofdays 사용(2026-11-02 사용자가 `kindsr/devscent-pieceofdays-main`으로 이름 변경), dev push 자동 개발 배포, dev→main 병합 자동 운영 배포. 이 서비스에 한정하며 다른 서비스의 수동 배포 규칙은 유지한다.
- 사용자 지시의 개발 경로 오타는 기존 개발 배포 위치로 해석했다.
- 경로 표기: `<source-dir>`(AI 작업 체크아웃)·`<dev-dir>`(개발 배포본)·`<release-dir>`(운영 릴리스 자료)는 placeholder다. 정확한 서버 값은 비공개 운영 정본이 관리한다.

## 목표와 경계

GitHub를 단일 Git 정본으로 사용한다. 현재 NAS 이력과 GitHub 초기 README 이력을 강제 push 없이 통합하고, 이번 세션의 미커밋 문서를 보존한다.
개발은 `<source-dir>` 및 별도 worktree, dev 배포는 `<dev-dir>`, 운영은 `<release-dir>`로 분리한다.
운영 준비중 HTML과 개발 placeholder 내용은 유지한다. 앱 스택·PRD·DB·공용 nginx·DNS·TLS 변경은 제외한다.

## 구현

1. Git 전환 전 이력 번들과 현행 컨테이너 이미지·설정·서빙 HTML 해시를 저장한다. GitHub 초기 이력을 병합하고 origin을 GitHub로 바꾼다. NAS 원격을 지속 운용하지 않는다.
2. GitHub 호스팅 러너에서 `push: [dev, main]`을 받아 검사 후 환경별 SSH 배포를 실행한다. PR은 검사만 실행하고 배포 비밀을 사용하지 않는다.
3. 서버 접속키는 서비스 전용으로 생성해 GitHub 환경별 secret에 저장한다. 호스트 키를 고정하고 authorized_keys의 restrict+강제 명령으로 서비스 배포 요청만 허용한다. 키 값은 저장소·로그·보고에 넣지 않는다.
4. 신뢰된 서버 배포 프로그램은 작업 트리 밖에 설치한다. 허용 명령·환경·40자리 SHA를 검사하고, GitHub 해당 브랜치 최신 SHA와 대조한다. 같은 서비스 배포를 flock으로 직렬화한다.
5. 배포할 SHA의 클린 소스로 이미지를 빌드하고 격리 컨테이너의 health·HTML을 검증한다. 운영은 소스 bind mount를 제거하고 현재 project/container 이름과 edge 네트워크를 보존한다.
6. dev 성공 기록의 Git tree와 main 후보 tree가 같아야 운영 승격한다. main에서도 운영 이미지 자체의 후보 검증을 실행한다.
7. 이전 실행 이미지/설정을 동결하고 해당 서비스 컨테이너만 교체한다. health/HTTP 검증 실패 시 직전 이미지를 복구하고 Actions를 실패로 처리한다. 성공 커밋·tree·이미지 ID·설정 해시·시간을 기록한다.
8. 기존 폴링 목록에서는 pieceofdays 한 줄만 제외한다. 다른 서비스·크론 시간·공유 스크립트는 유지한다.

## 소유 파일과 검증

- `.github/workflows/deploy.yml`: PR 검사, dev/main push 검사·자동 배포, 최소 token 권한, 고정 action revision, 취소하지 않는 배포 동시성 제어.
- `scripts/ops/`: SSH 입력·브랜치·Compose 정책 검사와 배포·복귀 프로그램.
- `tests/`: 명령 주입·허용 환경·SHA·Compose 격리·운영 승격 기록의 독립 RED→GREEN 검사.
- `deploy/comingsoon/Dockerfile`, 두 Compose: 동일한 정적 내용을 이미지로 배포.
- README·AGENTS·CLAUDE·CHANGELOG·배포 문서: GitHub 단일 정본, 자동 배포의 현재 승인 범위, 서버/클라우드 작업 경계.
- 운영 런북 02·03·05·15와 백업/포트 해당 부분: 실제 변경만 동기화하며 기존 미커밋 타 서비스 기록은 보존한다.

검증 순서: 독립 RED 시험 → 실패 이유 확인 → 최소 구현 → 단위/실패경계 검사 → compose config-q·스크립트 검사 → 독립 diff 검토 → GitHub dev 실제 push/Actions 성공 → 개발 HTTPS·health·SHA 대조 → dev→main 실제 PR 병합/Actions 성공 → 운영 HTTPS·health·SHA 대조.
GitHub 호스팅 러너에서 SSH22 접근을 검증한다. Windows 작업이 필요해지면 정확한 실행 프롬프트를 제공한다.

## 복귀와 실패 한계

- GitHub 이력은 삭제/force push하지 않는다. 전환 전 Git 번들은 로컬 백업에 보존한다.
- 운영 전환 전 원본 HTML·현재 이미지와 bind 설정을 작업 폴더 밖에 동결한다. 실패하면 별도 복귀 Compose/고정 이미지로 되돌린다.
- 배포 SSH 키는 전용 authorized_keys 행과 환경 secrets를 제거해 철회할 수 있다.
- Actions 전환 실패 시 이 서비스만 기존 dev 폴링 항목을 복구할 수 있지만 이중 배포는 금지한다.
- DB가 없는 현재는 데이터 migration이 없다. 컨테이너 교체의 짧은 연결 중단은 가능하다.
