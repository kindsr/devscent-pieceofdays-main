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
- PC·휴대폰 지원 요구 확정 (2026-11-10): 두 기기 모두에서 로그인·기록을 사용하고 같은 계정의 서버 자료를 다시 불러오는 기준을 PRD와 기기 호환성 검증 계획에 반영했다. 실제 브라우저·기기 검증과 Google 공급자 실검증은 각각 완료 여부를 기록한다.
- 첫 C2 전환 검증 순서 명확화 (2026-11-09): 정적 dev에서 사전 실제 앱 callback 도달을 요구하던 순서를 사전 준비·제한된 첫 자동 전환·실제 전체 chain/B5 후 완료로 구분했다. 사후 callback 실패는 helper 자동 복귀 범위 밖이므로 메인의 정적 복귀·enable flag/후속 배포 통제를 명시했다. 제품·시험·workflow 관문은 변경하지 않았다.
- dev 외곽 콜백 반영·첫 백업 확인 (2026-11-08): 검토된 한 파일 제안의 안전 로그·단일 no-referrer를 실제 반영하고 syntax/reload·새 HTTPS 연결의 안정 응답·edge 합성 query 비기록을 확인했다. reload 직후 이전 worker 응답과 준비확인 창을 구분했다. 첫 dev DB 야간 백업의 로컬 checksum과 NAS 검증 성공 로그도 확인했다. C2 PR72 source/CI는 PASS이며 실제 OAuth 키·앱 콜백 통합·활성화는 대기다.
- 실제 C1 게시·개발 DB 준비 (2026-11-08): dev13764b3의 publisher42484654242와 같은 SHA 필수 앱 검사, 실제 manifest/config 연결·익명 full pull을 확인했다. 게시 digest로 개발 전용 DB migration 0001·0002 적용·앱 역할 접속/권한을 확인하고 검토 helper를 설치했다. C 등급·migration 승인 상한을 기록했다. OAuth·dev 콜백 설정 승인 대기로 실제 앱 전환은 아직 하지 않았으며 현황 페이지에 준비 상태를 반영했다. C2 source는 PR72에서 검토한다.
- C1 개발 앱 이미지 게시 기반 (2026-11-08): PR70의 dev 전용 publisher·read-only 구조 검사·archive/manifest 검증기를 통합했다. 같은 불변 ID의 이미지6·프런트14·원문 preview10, config C=metadata M·라벨과 게시 manifest 연결을 요구한다. Docker 자동 load가 M을 생략하는 실제 조건을 확인하고 고정 BuildKit file export→같은 파일 load→ID save 검증으로 해결했다. 구조92·PR local proof·독립 source/runner PASS를 수락했다. 실제 게시 D/C/M/ID proof와 서버 앱 전환은 별도 단계다.
- 계정 화면 시각 증거 (2026-11-08): PR67의 격리 합성 DTO 캡처 도구와 PNG15장을 추가했다. 실제 계정 컴포넌트·CSS를 원본 그대로 써 기록장·빈 화면·작성·삭제 확인·설정을 375/768/1440에서 메인이 직접 대조했다. 독립 검토 PASS, action POST·외부 요청·쿠키0을 확인했다. 실제 인증·저장 증거와 구분하며 기존 auth harness의 캡처 금지는 유지한다.
- F6a2 실제 프런트·앱 조합 검증 (2026-11-08): PR65의 격리 CI에서 같은 불변 이미지로 이미지6·프런트14·원문 preview10을 통과하고 독립 PASS를 수락했다. 실제 nginx/Next의 정적 응답·Host/Origin·콜백 헤더/로그·상위 프록시 fixture·장애·같은 브라우저 origin의 기록 보존을 확인한다. 시험 포트 연결과 로그 sink 양성 대조·실패 시 정리를 보완했다. 실제 서버 설정·이미지 게시·앱 전환은 후속이다.
- 계정 기록 화면 S3b (2026-11-08): 검증된 계정의 PG 조각 CRUD·하루 한 줄·날짜별 보기·글꼴 저장을 D 화면에 연결했다(PR64). 초안 보존·명시 재조회·응답 유실 시 자동 재시도 금지와 비식별 React props 경계를 지켰다. PR66에서 삭제한 한 줄의 반복 재조회 재제출 회귀를 먼저 확인해 수정했다. 독립 PASS, Node24/26 단위265·빌드 경계7·운영12·fixture12, DB178·인증/기록33·이미지6 통과를 수락했다. 화면 PNG·실제 프런트·서버 로그인 배포는 후속이다.
- 개발 앱 배포·콜백 검증 계획 보완 (2026-11-08): PR59 R4·PR62의 독립 검토(P0/P1 없음)를 수락했다. C1 게시 증거와 C2 전환 관문·불변 이미지 연결을 구체화하고, query 전달은 B4 오류 응답과 별도로 메모리 observer가 실제 수신 바이트를 대조하도록 보완했다. 실제 서비스 설정 반영은 격리 검증·별도 예외 승인 뒤 진행한다.
- F6b 개발 앱 배포 도구 소스 (2026-11-08): 검토된 PR60의 엄격한 dev 전용 명령·불변 이미지/환경 릴리스·정적 복귀·콜백 로그 차단 프런트 설정과 환경 대조 CI를 통합했다. 독립 PASS와 배포 계약106·Node 대조29 통과를 수락했다. 서버 설치·실제 프런트 검증·앱 배포는 후속이다.
- F6a1 앱 이미지 기반 (2026-11-05): 소스 빌드의 네트워크를 차단한 standalone Docker 이미지·운영 기동 wrapper·liveness/readiness·앱 Pool 상한과 전용 이미지 CI를 추가했다(PR58). 독립 PASS와 실제 이미지 6/6(강화 기동·시험 모드 거부·PG18 migration·app role readiness)을 확인했다. registry 게시·프런트 조합·설치 helper 전환·서버 배포는 후속이다.
- F4 B4 인증 HTTP·D 화면 (2026-11-05): 로그인 시작·콜백·로그아웃·탈퇴·복구 route와 로그인·탈퇴 확인·복구 화면, 설정의 계정 영역을 추가했다(PR57). 기본 탈퇴 gate는 닫고 복구는 유지하며 공식 Google·Kakao 버튼을 사용한다. 보류된 native form navigation을 관측하는 RED 도구를 보완했고, 최종 통합 CI·독립 검토는 PR에 기록한다. 실제 공급자 자격·서비스 DB·Next 배포·기록 저장 화면은 별도 연결한다.
- 기록 저장 액션 S3a (2026-11-05): 인증 설정·Origin·요청 사용자 확인 뒤 기존 F3 기록 CRUD·한 줄·글꼴 저장을 호출하는 Server Actions 5개를 추가했다(PR52 `24721ae`, 제품1파일·RED 시험 변경0). 독립 검토 PASS, Node24/26 단위223·DB178·빌드 경계4·운영 경계6·E2E12·배포 계약42 통과를 수락했다. 화면·실제 로그인·서비스 DB·앱 배포는 아직 연결하지 않았다.
- 개발 현황·인증 시안 게시 준비 (2026-11-05): `/status/`에서 브라우저 기록장·화면 시안·연결 중인 기능을 구분하고 dev 첫 화면에 진입점을 추가했다. D 로그인·탈퇴·복구 아트보드의 3폭 캡처 9장과 독립 PASS를 수락하고 공식 공급자 에셋·복구 상태를 핸드오프에 반영했다. 정본과 게시 사본을 대조했으며 실제 게시 결과는 PR50에 기록한다. `/try/` 저장 파일·키는 변경하지 않았다. 실제 Next 앱의 로그인·서버 저장·dev 앱 배포는 별도 실사용 전환 계획으로 진행 중이다.
- F4 B3 요청별 viewer·DAL (2026-11-04): 세션 쿠키와 계정 활성 상태·현재 세대 검사, async 기록 문맥·page/layout 경계를 구현했다(PR45 GREEN `7acef57`, 제품 6파일·시험 변경 0). 실제 사용자는 기록 연결 전 안내만 보고 fixture만 작성 UI를 쓴다. CI에서 Node 24·26 각각 단위 206·빌드 경계 4·운영 경계 6·E2E 12, PG18.6 DB 170·root 42가 통과했고 독립 검토 PASS(P0·P1 없음)를 메인이 수락했다. RED의 요청별 DB 호출 카운터 누적을 `bccb7f7`에서 고쳐 기대값을 유지했다. 실제 로그인·발급 route·PG 화면 저장·서비스 DB·Next 배포는 후속이다.
- 개발 체험판 `/try/` 구현 (2026-11-04): 정적 이미지에 D 테마 브라우저 저장 기록장을 추가했다(PR43 GREEN `2f3e61b`, `frontend/public/try/` 4파일·dev 첫 화면 주 링크·별도 preview workflow, 시험 변경 0). 서울 기준 빈 오늘, 조각 작성·수정·확인 후 삭제, 하루 한 줄, 달력 날짜 보기, 기록 글꼴 3종, JSON 내려받기·확인 후 전체 지우기, 저장 실패 시 초안 유지, 손상 문서 비덮어쓰기, 다른 탭 변경 알림을 제공한다. CI에서 저장 단위 18·실제 브라우저 10, Node 24·26 단위 196·빌드 경계 4·운영 경계 6·E2E 12, DB 165를 통과했다. 독립 GREEN 검토 PASS(P0·P1 없음, 선택 P2 3건)를 수락했다. dev 자동배포·실제 게시 검증은 PR43에 기록한다. 기록은 같은 브라우저에만 남고 실계정과 합쳐지지 않으며, Next 앱의 실제 로그인·서버 저장은 별도다.
- 개발 체험판 우선 계획 (2026-11-04): 사용자가 dev에서 먼저 써보기를 원해 `/try/`에 D 테마·브라우저 저장 기록장을 먼저 제공하는 계획을 추가했다. 작성·수정·삭제·하루 한 줄·날짜별 보기·글꼴·내려받기를 검증한 뒤 개발 도메인에 게시한다. 브라우저 저장은 빠른 체험을 위한 임시 기본값이며 이 항목은 계획 작성 당시(구현·게시 전) 기록이다. 실제 계정·서버 저장 개발은 병행한다.
- F4 B2 OIDC 어댑터·인증 처리 함수 (2026-11-04, RED 2026-11-03): `auth/oidc.ts`(openid-client 6.8.9 discovery·PKCE S256·state·nonce·ID Token 서명 검증 필수, `sub`만 반환)와 `auth/handlers.ts`(로그인 시작·callback·로그아웃·탈퇴·복구 처리 함수, 설정 오류 503·Origin 우선·쿠키 효과 표·F3/L2 호출)를 추가했다(PR41 GREEN `db5d213`, 제품 2파일, 시험 변경 0). mock issuer 시험과 CI에서 Node 24·26 단위 178·빌드 경계 4·운영 경계 6·E2E 12, DB 165를 통과했고 독립 검토(P0·P1·P2 없음)를 수락했다. dev에 통합했다. HTTP route·요청별 DAL·화면이 없어 실제 로그인은 아직 꺼져 있다.
- F4 B1 인증 모드·설정·쿠키 codec (2026-11-03): 고정 사용자와 실제 인증의 동시 설정·운영 단계 mock issuer를 거부하는 순수 모드 검사(`next.config.ts` 연결), 공급자 목록·자격·세션 설정을 판정하는 `loadAuthConfig`, 로그인 진행(10키)·복구(6키) 쿠키 codec(앱 10분·iron TTL 600), 로그인 뒤 이동 경로 허용 목록을 추가했다(PR39 GREEN `25365e7`, 제품 7파일, 시험 변경 0). CI에서 Node 24·26 단위 162·빌드 경계 4·운영 경계 6·E2E 12, DB 138을 통과했고 독립 검토(P0·P1·P2 없음)를 수락해 dev에 통합했다. OAuth 호출·요청별 DAL·route·화면이 없어 실제 로그인은 아직 꺼져 있다.
- F4 B0 OIDC 패키지 준비 (2026-11-03): `openid-client` 6.8.9를 고정했다(lock 추가는 `jose` 6.2.15·`oauth4webapi` 3.8.8뿐). Node 24.22.2·26.13.0에서 실제 import와 계획에서 쓸 10개 export를 확인하고, CI에서 단위 122·빌드 경계 4·운영 경계 6·E2E 12·DB 138·root 42를 통과했다. 독립 검토를 수락해 dev에 통합했다. 실제 OAuth·route·요청별 DAL·복구 쿠키·화면은 후속(B1~B5)이다.
- F4b/c 실제 로그인 연결 계획 수립 (2026-11-03): `docs/plans/PLAN_mvp-oidc-integration.md`에 Google·Kakao OIDC callback·flow/복구 쿠키·요청별 DAL·탈퇴/복구 route·D 상태 화면·mock issuer 시험·Kakao PKCE 실제 검증 절차·콘솔 설정 프롬프트 초안을 정리했다. R1에서 독립 검토(P1 2·P2 7)와 메인 구현 결정을 반영해 flow codec 형식 검사·설정 바인딩 분리, 설정 오류 503 고정 응답, 실패별 쿠키·DB 효과표, 모드 판정 순서, 중복 query 보존, 서명 검증 옵션 필수, B5 로컬 preflight 범위, 세션 비밀 JSON 형식을 보완했다. 독립 재검토 PASS(P0·P1 없음)를 수락하고 캐시 키·Windows 줄바꿈도 보완해 dev에 통합했다. 코드·패키지·설정·서비스 연결과 실제 로그인은 후속이다.
- F4 L2 계정 탈퇴·복구 도메인 (2026-11-03): `account/lifecycle.ts`(활성 확인·탈퇴 요청·복구)와 `completeSuccessfulLogin`의 `active`·`pending_deletion`·`purge_due` 결과를 추가했다. users 잠금 뒤 DB 시각으로 720시간 기한을 판정하고, 중복 탈퇴 불변·복구 재지급 없음·purge 경합 시 쓰기 0을 PG18 실제 시험으로 확인했다(DB 138, Node 24·26 앱 회귀). 독립 GREEN 검토를 수락해 dev에 통합했다. 실제 OAuth·HTTP·요청별 DAL·복구 쿠키·화면·삭제 실행 주기·서비스 DB는 후속이다.
- F4 L1 계정 수명주기 스키마 (2026-11-03): `0002_account_lifecycle`로 사용자 상태·탈퇴 시각·삭제 기한·세션 세대 열과 일관성 제약, app 열 UPDATE 권한, 원장 owner 전용 삭제 예외, PUBLIC을 회수한 전용 role 삭제 함수 2개, 빈 CI 전용 down을 추가했다. 권한·NULL·기한·down/rollback 시험을 포함해 DB 119개와 Node 24·26 앱 회귀(단위 122)·독립 SQL 검토를 통과해 dev에 통합했다. 실제 서비스 DB에는 적용하지 않았다.
- 계정 수명주기 구현 계약 (2026-11-03): `docs/plans/PLAN_account-lifecycle.md` §9~§13에 lifecycle API·로그인 union·잠금 순서, migration 0002 파일 계약, purge role 경로(meta 열 확장 A 채택·목록 상한 1~1000), TEST_PATTERNS 기준 RED/GREEN 소유, L1·L2 slice를 정했다. R6에서 pending CHECK·로그인 0행 분기·NULL 인자 거부·GUC 비움·harness 목록을 보완했다. 구현·SQL·실행은 없다.
- F4a 봉인 세션·서버 전용 경계 (2026-11-03): 설정 검증, 정확한 5키 payload·7일 만료·쿠키·Origin helper와 `server-only` 경계를 추가했다. Node 24·26 CI와 독립 검증에서 단위 122·빌드 경계 4·DB 99개 및 기존 앱 회귀를 통과했다. 실제 OAuth·요청별 상태 대조·탈퇴·복구·삭제는 후속이다.
- F4a 세션 패키지 준비 (2026-11-03): `iron-session` 9.0.1을 고정하고 Node 24·26의 설치·기존 앱 회귀(단위 103·DB 99·운영 경계 6·E2E 12)를 검증했다. 실제 세션·로그인 구현은 후속이다. README·데이터 계약·기반 계획에 Google·카카오와 탈퇴 30일 정책의 확정 상태를 동기화했다.
- 사용자 확정 반영과 계정 수명주기 계획 (2026-11-03): Google·Kakao 로그인 둘 다, 계정 탈퇴 30일 복구 뒤 삭제를 PRD·MVP·기술 결정·AGENTS 상태에 반영했다. `docs/plans/PLAN_account-lifecycle.md`(탈퇴·30일 경계·복구·purge·원장 삭제 경로)를 추가했다. 메인 기술 결정 R4로 세션 `gen` 키 5개·DAL 매 요청 검사, 잠금 뒤 `clock_timestamp()` 경계, purge 함수 PUBLIC 회수·전용 role, 복구 쿠키 계약을 채택했다(사용자 확정과 구분). 공급자 간 계정 연결은 미정이며, 구현·SQL·설치는 없다.
- F4 인증·세션·첫 로그인 지급 연결 계획 (2026-11-03): `docs/plans/PLAN_mvp-authentication.md`. 메인 기술 기본값(openid-client 6.8.9·iron-session 9.0.1 S1·절대 7일·`server-only`)과 R2 세션·설정·Origin 계약, F4a 단계별 파일 소유를 문서로 기록했다. 공급자는 사용자 선택 대기이며, 구현·설치·스키마·환경 변경은 없다.
- F3 slice ③ 개인 꾸미기·설정 코어 (2026-11-02): D manifest의 형식·크기·획·점 검증과 렌더용 필터, 본인 소유 private 버전 저장·적용, 기록 글꼴 저장을 추가했다. 단위 103·DB 99개와 앱 회귀를 CI에서 검증하고 비정상 배열 예외를 회귀 시험으로 수정했다. 편집기·실제 화면 저장·로그인 연결은 후속이다.
- F3 slice ② 기록 저장 코어 (2026-11-02): 조각·하루 정리의 PG CRUD, 소유권·버전 충돌 처리와 월별 읽기, IANA 서울 날짜 계산을 추가했다. 단위 83·DB 88개와 앱 회귀를 CI에서 검증했으며 실제 화면 저장 연결은 후속이다.
- F3 slice ① 지급 코어 (2026-11-02): 공급자 중립 계정 해석, 감정덩어리 10개 1회 지급의 원자성·동시성·잔액 조회, UI 공유 타입과 직접 server import 경계를 추가했다. 단위 81·DB 69개와 앱 회귀를 CI에서 검증했으며 실제 로그인 연결은 F4다.
- F3 도메인·PostgreSQL 저장 계획 (2026-11-02): 첫 로그인 지급의 동시성·원자성, 기록 CRUD·소유권·버전 충돌, 개인 꾸미기·폰트 저장의 공개 계약과 역할을 나눈 TDD 순서를 정의했다. 실제 OAuth·세션·앱 배포는 후속이며 이 항목은 계획이다.
- F2 PostgreSQL 18 스키마·migration 실행기 (2026-11-02): 8개 테이블, app 최소 권한, 원장 append-only·첫 지급 1회/10개 제약, 체크섬·트랜잭션 잠금·빈 CI DB 전용 down을 추가했다. 단위 71·DB 57개와 앱 회귀를 CI에서 검증했으며 실제 앱 저장·로그인 지급 연결은 F3·F4다.
- PostgreSQL 18 일회용 DB 시험 환경 (2026-11-02): 정확한 버전의 `pg`와 CI 서비스 컨테이너, 비특권 role 검증·실행별 DB 생성/정리 도구·환경 시험을 추가했다. DB 생성 후 권한 설정에 실패해도 해당 DB를 정리하는 회귀를 검증한다. 이 항목은 환경 준비이며 제품 구현은 위 F2 항목에 기록한다.
- PostgreSQL 데이터 계약·F2 구현 계획 (2026-11-02): 서비스 전용 스키마·8개 MVP 테이블·소유권·원장 권한·첫 로그인 1회 지급 제약, 격리 DB 시험·체크섬·잠금·빈 CI DB에서만 가능한 down과 데이터 보존 복귀 절차. 문서 단계이며 실제 DB·계정은 생성하지 않았다.
- Next.js F1 앱 골격 (2026-11-02): `app/`에 D 화면·작성/수정·기록 글꼴의 메모리 시안, 읽기 전용 diary 저장 port, 날짜·폰트 검증, 로컬 예시 사용자 운영 차단, Konva 클라이언트 호환 시험을 추가했다. Node 26·24의 앱 전용 CI를 분리했으며 로그인·DB·영구 저장·실제 꾸미기 편집기는 후속이다. 기존 정적 dev 배포와 운영 준비중 페이지는 현재 빌드 경로를 유지한다.
- 기술 구성 결정·PRD 분석·shaping·MVP 범위와 Next.js 기반 구현 계획, 하루 꾸미기·마켓·감정덩어리 확장 설계 (2026-11-02). 첫 성공 로그인 10개 1회 지급과 후속 마켓 구매 1개 사용을 구분하고, 실제 인증·DB·저장소·배포 전환의 의존성을 기록했다.
- D 선택안의 개별 조각 수정·기록 글꼴 설정 프로토타입과 디자인 핸드오프 (2026-11-02). 수정은 같은 조각의 글·이미지만 바꾸고 시각·개수는 유지하며 취소할 수 있다. 고딕·명조·손글씨 선택은 기록 본문에만 적용한다. 현재 값은 메모리에서만 유지되고 영구 저장은 앱 구현 단계다.
- D 실제 화면·마우스 클릭을 담은 9:16 20초 홍보영상과 공개 플레이어 `/promo/`, MP4·편집 가능한 HyperFrames 소스 (2026-11-02). 확정 카피를 사용하고 사용자 승인 80 Sunra 크레딧으로 생성한 연주곡을 포함한다.
- 디자인 시안 D 따뜻한 조각 모음 추가 (2026-11-02, 선택 대기): 사용자 요청 "C안의 UI에 A안의 컬러만 적용". `docs/design/concepts/d-warm-pieces/`는 C 사본에서 색 값·식별·토큰 카드만 바꿈(A 팔레트 값만 사용). 비교판을 4안(데스크톱 2열 A·B / C·D)으로, 리뷰 바에 D 전환 링크 추가, 게시 사본·README·dev 안내 문구를 4안으로 정정.
- 디자인 시안 3안 정적 비교판 (2026-11-02, 선택 대기): `docs/design/concepts/`(정본)와 게시 사본 `frontend/public/design/` → dev `/design/`. A 따뜻한 기록장·B 차분한 일기장·C 조각 모음, 같은 샘플 하루, 저장 없음. 계획 `docs/plans/PLAN_design-preview.md`, 스토리보드·브리프 초안 `docs/product/04~05`. dev 안내 페이지에 시안 링크를 추가하고 배포 설명을 GitHub Actions로 정정.
- `docs/PRD.md` 추가 (2026-11-02): PRD·MVP **검토 초안(사용자 응답 전)**. 권고 여정 "순간 기록→하루 정리→날짜별 다시 보기", 가정, 최소 슬라이스, MVP 제외 제안, AI 직접 작성/초안 비교(결정 대기), 질문 3개, 수용 기준 초안, 미정 조건. 같은 작업에서 `AGENTS.md` §3.1에 사용자 선택(pieceofdays의 위임 가능한 기획·구현·검증은 개별 Claude Cloud 세션 우선, 메인은 계획·검토·통합·서버 확인, 다른 서비스·전역 CLI 설정 미적용)을 추가. 선택용 정적 시안 선행 비교는 사용자 요청에 따라 가정으로 표시한다.
- GitHub Actions 개발·운영 자동배포 구성 (2026-11-02): `dev` push 개발 배포, 성공한 dev를 `main`에 병합하면 운영 배포. 서비스 전용 SSH 키, SHA/tree·Compose 격리 검사, 후보 health 확인과 실패 시 이미지 복귀.
- `docs/product/UI_UX_RESEARCH_2026-11-02.md` 추가 (2026-11-02): 디자인 소스·제품 레퍼런스 조사와 잠정 추천(미확정, PRD·시안 선택 전).
- `README.md` 추가 (2026-11-02): 현재 운영(bind mount)·dev(정적 이미지) 상태, 도메인, 문서 진입, 읽기 전용 확인 명령.
- `docs/plans/PLAN_workspace-deployment-separation.md` 추가 (2026-11-02): 작업·dev·운영 경로 분리 **권고안·미적용**(비교·선행조건·이전 순서·검증·롤백).
- 도메인 초기 구성 (2026-08-20): 운영 준비중 페이지(`deploy/comingsoon/`, `docker-compose.yml` — `pieceofdays-comingsoon`) 및 dev 플레이스홀더(`frontend/`, `docker-compose.dev.yml` — `pieceofdays-frontend-dev`) 추가.
- nginx conf 원본 4종 추가 (`deploy/nginx/99-pieceofdays*.conf`): canonical 도메인 `pieceofdays.com`, `pieceofdays.co.kr`(+www)·`www.pieceofdays.com` 은 301 리다이렉트, `dev.pieceofdays.com` 은 접근제한(+noindex) dev 프록시.
- `deploy/README.md`: 배포 절차, 도메인 canonical 정책, 인증서 발급 절차, 실서비스 전환 절차 문서화.
- Codex 작업용 `AGENTS.md` 템플릿 추가: `$karpathy-guidelines`, PRD 기반 계획 산출물, 디자인/개발/운영 검증 흐름 정의.

### Changed
- 개발 현황 안내 (2026-11-08): 계정 기록 화면·합성 PNG15·실제 프런트 조합 검증 완료를 문서와 `/status/`에 반영했다. 현재 사용 가능한 브라우저 저장 체험판과 아직 준비 중인 실제 로그인·서버 저장을 구분한다.
- 사용자 선택 반영 (2026-11-02): 기본 디자인 D, TypeScript·React/Next.js + PostgreSQL + 전용 이미지 저장소·Konva, 개인용 하루 꾸미기 포함 MVP. 마켓·구매·정산은 후속으로 구분하고 현재 프로토타입·앱 구현 예정 상태를 README·AGENTS·PRD에 맞췄다.
- GitHub 저장소 이름 변경 반영 (2026-11-02): 사용자가 `kindsr/pieceofdays`를 `kindsr/devscent-pieceofdays-main`으로 바꿈. `scripts/ops/deploy.py`의 `REPOSITORY`와 공개 문서의 현재 주소를 `https://github.com/kindsr/devscent-pieceofdays-main.git`으로 정정. 서비스명·도메인·컨테이너·브랜치는 그대로.
- 운영 릴리스 경로 계약 변경 (2026-11-02): `scripts/ops/deploy.py`의 `STATE`를 홈 기준 `deployment/devscent-pieceofdays-main`으로 변경(로직·검증 정책 불변). 작업 트리 밖 설치본·서버 디렉터리·배포 설정 이전은 자동으로 바뀌지 않으며 메인이 별도 반영한다.
- 공개 문서의 서버 운영 정보 축소 (2026-11-02): README·deploy/README·AGENTS·CLAUDE·plans에서 서버 절대/홈 경로, 설정·설치·백업·인증서 경로와 운영 명령을 제거하거나 논리 역할·placeholder(`<source-dir>`·`<dev-dir>`·`<release-dir>`)로 바꿈. 상세 서버 절차는 비공개 운영 문서가 정본.
- Git 정본을 `kindsr/pieceofdays`로 전환하고 NAS·GitHub 초기 이력을 보존해 통합 (2026-11-02). 개발은 `~/development`, 운영은 `~/deployment/pieceofdays`의 고정 이미지로 분리하는 사용자 승인 반영.
- `CLAUDE.md`·`AGENTS.md`를 공통 정본(`../_template/`, Linux 절대경로는 AGENTS 읽기 fallback) 참조와 서비스 고유 경계만 남긴 짧은 문서로 정리 (2026-11-02). 공통 docs 사본 `docs/01~05_*.md`는 원격 master `281fc06`에서 삭제됨(정본 `_template`).
- `deploy/README.md`에 2026-11-02 점검 안내를 추가하고, 운영 bind mount라 커밋 전 호스트 편집이 즉시 반영된다는 사실을 명시 (2026-11-02).
- `docs/02_DESIGN_GUIDE.md`를 2.0.0으로 갱신하고 PRD 분석, shaping, MVP, 스토리보드, 와이어프레임, high-fidelity 설계 산출물 계약과 서비스별 디자인 콘셉트 패밀리를 추가.
- `docs/02_DESIGN_GUIDE_v2.md`를 2.1.0으로 갱신하고 devscent.com 마케팅 표면과 제품 설계 가이드의 역할 경계를 명확화.

### Fixed
- 기기 시험의 탐색·응답 증거 순서 (2026-11-10): 로그인 start의 대기 문서 load와 저장·수정 뒤 서버 재조회 완료 status를 기다린 뒤 다음 화면으로 이동한다. UUID 사례는 실제 UI POST의 원서버 응답 본문을 확보해 같은 바이트를 전달하고 HTTP/RSC·브라우저 응답 완료·UUID·요청 수를 검사한다. 제품·기존35개 의도/수량·재시도0을 유지하며 실제 CI 결과로 판정한다.
- RSC 보안 시험의 응답 증거 수집 (2026-11-10): 기존 UUID 비직렬화 검사가 본문 수집 부재로 실패한 뒤, 실제 UI의 Server Action 응답·본문 완료를 확인하고 다음 페이지로 이동하도록 시험을 보강했다. 기존 보안 단언은 유지하며 실제 누출 검출이나 간헐 실패 확정으로 해석하지 않는다.
- dev 불변 이미지 참조 호환성 (2026-11-09): digest로 pull한 정확한 요청 주소가 Docker `RepoTags`에도 표시되면 배포가 거부되던 조건을 회귀 시험으로 재현하고 수정했다. 그 주소 하나만 예외로 허용하며 일반 태그·다른 digest/저장소·혼합/잘못된 자료형 거부와 manifest/config·archive 검증은 유지한다. 설치 helper 반영과 실제 전환 검증은 소스 CI와 별도로 수행한다.
- migration 경계 검사 (2026-11-02): 잘못된 접속 URL을 포함해 실패 코드를 1로 통일하고, UTF-8 BOM이 검사 전에 제거되는 문제를 회귀 시험 후 수정했다. PG18 RESTRICT 삭제 거부 시험은 정책을 유지하며 정확한 SQLSTATE `23001`로 정정했다.
- Next.js 작성 창의 브라우저 뒤로/앞으로 동작·초안 보존과 특정 날 한 줄 반영 후 포커스 (2026-11-02). 운영 모드에서 예시 데이터·Konva 시험 화면이 노출되지 않고 로컬 사용자 플래그로 시작할 수 없음을 별도 CI 시험으로 검증한다.
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
