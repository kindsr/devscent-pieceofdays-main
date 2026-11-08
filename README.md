# pieceofdays

개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays

## 개발 체험판 `/try/` (브라우저 저장)

"개발에서라도 빨리 써보고 싶다"는 요청에 따라 D 화면으로 직접 기록해 볼 수 있는 **브라우저 저장 체험판**을 추가하고 독립 검토 PASS를 수락했다. [개발 체험판](https://dev.pieceofdays.com/try/)은 dev 첫 화면의 "기록장 써 보기"로 연다. dev 자동배포 뒤의 실제 게시 검증은 [PR43](https://github.com/kindsr/devscent-pieceofdays-main/pull/43)에 기록한다.

- **사용 흐름:** 서울 기준 오늘의 빈 기록장에서 조각을 추가·수정·삭제(확인 후)하고, 하루 한 줄을 쓰고, 달력에서 날짜별로 다시 본다. 설정에서 기록 글꼴(고딕·명조·손글씨)을 고르고 기록을 JSON으로 내려받거나 확인 후 전체 지울 수 있다.
- **저장 한계:** 기록은 **이 브라우저의 전용 저장 항목 하나에만** 남는다. 브라우저 데이터를 지우면 사라지고, 다른 기기와 동기화되지 않으며, 나중의 실제 계정에 자동으로 합쳐지지 않는다. 설정의 "기록 내려받기"로 보관하기를 권장한다. 서버 전송·추적·실계정·감정덩어리·사진·그리기·마켓은 없다.
- **시안과의 차이:** `/design/`의 D 시안은 예시 기록을 보여 주는 메모리 프로토타입이고, `/try/`는 예시 없이 시작해 내 기록을 브라우저에 저장한다. 둘 다 Next 앱이 아니며 MVP 완료를 뜻하지 않는다. 브라우저 저장은 빠른 체험을 위한 임시 기본값이고 계정 정책이 아니다.

[개발 현황](https://dev.pieceofdays.com/status/)에서 사용 가능한 기능과 연결 중인 기능을 확인할 수 있다. [로그인·탈퇴·복구 화면 시안](https://dev.pieceofdays.com/design/d-warm-pieces/auth.html)은 화면 확인용이며 실제 인증 요청은 하지 않는다. 실제 앱 연결 순서와 기록 저장 액션 계약은 [실사용 전환 계획](docs/plans/PLAN_dev-usable-app.md)과 [저장 연결 계획](docs/plans/PLAN_dev-diary-actions.md)에 있다.

운영은 준비중 페이지이며, 개발 환경에서는 사용자가 선택한 **D안(C 화면 구성 + A 색)**을 확인할 수 있다. `/design/` 시안의 조각별 수정과 기록 글꼴 설정은 메모리에서 동작해 새로고침하면 초기화되며, `/try/`는 브라우저에 저장한다.
실제 앱은 **TypeScript·React/Next.js + PostgreSQL + 전용 이미지 저장소**, 그리기는 **Konva**로 개발한다(2026-11-02 사용자 선택). [Next.js 앱](app/README.md)에 D 화면과 시험·빌드 기반, PG 저장 코어와 인증·계정 기록 화면을 만들었다. 이 앱은 현재 dev의 정적 시안 배포와 별개다. MVP는 기록·하루 정리·다시 보기와 개인용 **하루 꾸미기**를 포함하고, 디자인 마켓·구매·정산은 이후 단계다. 실제 공급자 로그인 활성화·서비스 DB·앱 배포·그리기 편집기는 후속이다.

- [선택한 D 화면](https://dev.pieceofdays.com/design/d-warm-pieces/) · [기록 글꼴 설정](https://dev.pieceofdays.com/design/d-warm-pieces/#settings)
- [20초 세로 홍보영상](https://dev.pieceofdays.com/promo/) · [MP4 내려받기](https://dev.pieceofdays.com/promo/pieceofdays-d-vertical.mp4)
- [시안 4안 비교](https://dev.pieceofdays.com/design/) · [디자인 핸드오프](docs/design/README.md) · [PRD](docs/PRD.md)

홍보영상은 예시 기록으로 서비스를 사용하는 모습을 보여 주는 콘셉트 영상이다. 제품 진행과 작업 경계는 [AGENTS.md](AGENTS.md)를 따른다.

DB 기반(F2), 첫 로그인 지급·기록·꾸미기 저장 코어(F3), 세션 봉인·검증과 서버 전용 경계(F4a), 계정 수명주기(L1·L2), 인증 설정·OIDC 처리·요청별 DAL(B1~B3), 기록·한 줄·글꼴 Server Actions 5개(S3a)를 검증했다. B4는 처리 함수를 호출하는 인증 route 5개와 D 로그인·탈퇴·복구 화면을 추가했다([PR57](https://github.com/kindsr/devscent-pieceofdays-main/pull/57)). F6a1은 standalone 앱 이미지·기동 검사·health와 연결 수 제한을 추가했다([PR58](https://github.com/kindsr/devscent-pieceofdays-main/pull/58)). 실제 공급자 자격·서비스 DB·Next 배포는 아직 연결하지 않아 사용자는 계속 정적 체험판을 쓴다. 검증 SHA·시험 수·통합 결과는 [앱 문서](app/README.md)와 PR에 기록한다.

로그인은 **Google·카카오 둘 다**, 계정 탈퇴는 **30일 복구 기간 후 삭제**로 정했다(2026-11-03 사용자 선택). [인증 계획](docs/plans/PLAN_mvp-authentication.md)과 [계정 수명주기 계획](docs/plans/PLAN_account-lifecycle.md)에 구현 순서를 정리한다. 공급자 간 계정 연결은 결정 대기다. B4의 HTTP·화면은 구현했지만 실제 로그인·탈퇴·복구 기능은 아직 사용자에게 제공되지 않는다. 탈퇴 요청은 삭제 운영 검증 전까지 실행 설정으로 닫고 복구는 유지한다. 개발 도메인은 정적 D 시안과 브라우저 저장 체험판을 제공한다.

2026-11-08 계정 기록 화면(S3b)을 연결했다([PR64](https://github.com/kindsr/devscent-pieceofdays-main/pull/64)). 조각 CRUD·하루 한 줄·날짜별 보기·계정 글꼴 저장과 충돌/통신 실패 시 초안 보존을 구현했다. 독립 검토 PASS, Node24/26 단위265·빌드 경계7·운영12·fixture12, DB178, 실제 mock 로그인 기반 인증·기록33, 이미지6/6을 확인했다. 실제 프런트 조합은 PR65, 합성 화면 PNG15는 PR67에서 확인했다. 현재 개발 사이트는 계속 브라우저 저장 체험판이다.

## GitHub와 자동배포

개발용 앱 이미지 게시(C1) 소스는 [PR70](https://github.com/kindsr/devscent-pieceofdays-main/pull/70)에서 통합했다. 검증한 불변 이미지와 게시 결과를 연결하는 단계이며, 현재 개발 사이트의 Next 앱 전환(C2)과 실제 OAuth·서비스 DB 준비는 별도다.

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
- [데이터 계약](docs/product/DATA_CONTRACT.md), [DB·마이그레이션 시험 계획](docs/plans/PLAN_mvp-database.md)
- [도메인·기록 저장 구현 계획](docs/plans/PLAN_mvp-domain-storage.md): 첫 로그인 지급·기록 CRUD·개인 꾸미기 저장을 순서대로 구현
- [Actions 전환 계획](docs/plans/PLAN_github-actions-deployment.md), [초기 경로 분리 검토](docs/plans/PLAN_workspace-deployment-separation.md)
- [CHANGELOG.md](CHANGELOG.md)

공통 docs 사본은 기존 원격 커밋 `281fc06`에서 제거했다. 정본은 `../_template/docs/`이며 루트 bootstrap 프롬프트는 과거 초기 구성 자료다.
