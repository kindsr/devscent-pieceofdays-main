# PLAN — 운영 OAuth 등록용 공개 페이지 준비

- 작성: 2026-11-09. 기준 소스 `dev` `1add4d03409af90763a74c89d29bdfc2eb164074`.
- 상태: **준비 계획. 공개 페이지·콘솔 등록·운영 로그인 개통 전.** 운영 주체와 개인정보 문의 이메일은 사용자 확인 대기다.
- 범위: 운영 홈페이지의 서비스 설명·정책 링크, 개인정보처리방침·이용약관, 개발/운영 OAuth 등록값과 게시 검증. 운영 DB·앱 배포·로그인 활성화는 별도 전환 범위다.

## 1. 등록할 주소와 현재 상태

아래 주소는 준비할 목표값이다. 현재 운영에서 동작하는 로그인 주소나 게시된 정책 페이지로 안내하지 않는다. 서비스 정본 도메인 `pieceofdays.com`을 사용하며 callback 끝에 `/`를 붙이지 않는다.

| 항목 | 운영 등록값 | 2026-11-09 확인 |
|---|---|---|
| 홈페이지 | `https://pieceofdays.com/` | HTTP200, 준비중 안내와 간단한 설명. privacy/terms 링크 없음 |
| 개인정보처리방침 | `https://pieceofdays.com/privacy/` | HTTP404, 새 공개 페이지 필요 |
| 이용약관 | `https://pieceofdays.com/terms/` | HTTP404, 새 공개 페이지 필요 |
| Google redirect URI | `https://pieceofdays.com/auth/google/callback` | 현재 운영 HTTP404. 앱 전환 뒤 처리할 목표 경로 |
| Kakao redirect URI | `https://pieceofdays.com/auth/kakao/callback` | 현재 운영 HTTP404. 앱 전환 뒤 처리할 목표 경로 |
| Google 승인 도메인 | `pieceofdays.com` | 소유권 확인·콘솔 등록 상태 별도 확인 필요 |

개발용 redirect URI는 각각 `https://dev.pieceofdays.com/auth/google/callback`, `https://dev.pieceofdays.com/auth/kakao/callback`이다. 개발 접근 제한이 있는 페이지를 운영용 privacy/terms 링크로 제출하지 않는다. 정책 문서는 운영 도메인에서 로그인 없이 읽을 수 있어야 한다.

## 2. 공급자 등록 기준

### Google

- [OAuth 2.0 정책](https://developers.google.com/identity/protocols/oauth2/policies)은 개발·시험·운영 tier마다 별도 Cloud 프로젝트를 요구한다. 개발 키를 운영에 복사하거나 같은 프로젝트의 client만 나눠 충분하다고 안내하지 않는다.
- 같은 정책은 운영 앱의 공개 홈페이지, 기능 설명, 이용약관·개인정보처리방침 링크와 소유권이 확인된 도메인을 요구한다.
- [브랜딩 안내](https://support.google.com/cloud/answer/15549049?hl=en)에 따라 홈페이지·동의 화면의 개인정보처리방침 URL을 일치시키고, Google 데이터 접근·사용·저장·공유 내용을 실제 동작에 맞게 공개한다. support email은 콘솔이 허용하는 계정/그룹 중 실제 확인하는 주소를 선택한다.
- 현재 서버 OIDC 요청의 scope는 `openid` 하나다. 이메일·프로필·Drive·Gmail 등 권한을 추가하지 않는다. 앱 이름/로고의 브랜딩 검증과 sensitive/restricted scope 검증은 구분하며, 필요한 검증은 콘솔의 현재 판정으로 확인한다.
- 웹 서버 OAuth client의 redirect URI는 위의 정확한 경로로 등록한다. [공식 웹 서버 OAuth 안내](https://developers.google.com/identity/protocols/oauth2/web-server)를 따른다. 현재 구현에 없는 브라우저 SDK용 origin·logout callback을 임의 필수값으로 추가하지 않는다.

### Kakao

- [카카오 로그인 설정](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)에 따라 로그인 ON·정확한 redirect URI를 준비한다. 이 앱은 ID token을 사용하므로 OpenID Connect ON과 REST API client secret도 필요하다.
- 개발·운영 자격은 분리한다. 별도 앱/지원되는 테스트 앱 등 콘솔의 실제 구성을 확인하고, 개발 설정이 운영에 자동 반영된다고 가정하지 않는다.
- 기본 로그인과 카카오싱크는 구분한다. 현재 확정 범위는 Google·Kakao OIDC 로그인이다. 카카오싱크·채널 연결·추가 개인정보 권한을 기본 필수로 늘리지 않는다.
- 카카오싱크 간편가입을 선택하면 [싱크 설정](https://developers.kakao.com/docs/ko/kakaosync/prerequisite)의 서비스 약관 등록·동의 내역·탈퇴/연결 해제 조건을 별도로 설계한다. 기본 OIDC 로그인에 싱크 동작이 이미 구현됐다고 안내하지 않는다.

## 3. 공개 문안에 반영할 사실과 미정 항목

| 항목 | 현재 기준 |
|---|---|
| 서비스 범위 | 개인의 일상 기록·하루 정리. 아직 제공하지 않는 사진·그리기·마켓·AI 전송을 운영 기능으로 약속하지 않음 |
| 소셜 로그인 식별 | provider와 subject로 계정 식별. 현재 `openid` 요청·`sub` 사용. 이메일/이름/프로필 수집을 임의로 문안에 추가하지 않음 |
| 토큰 처리 | 토큰을 받아 검증한 뒤 앱에는 subject만 반환하며 토큰을 영속 저장하는 구현은 없음. 실제 공급자 토큰의 추가 claim까지 전혀 수신하지 않는다고 단정하지 않음 |
| 쿠키 | 앱 세션 7일, 로그인 flow/복구 10분. host 전용 HttpOnly·SameSite=Lax·HTTPS Secure 속성 등 실제 구현을 문안과 대조 |
| 사용자 기록 | 계정 저장 구현에 조각·하루 한 줄·설정 등이 있음. 실제 앱 활성화 뒤 저장할 항목도 방침에 반영하며 현재 운영이 계정 기록을 이미 받는다고 설명하지 않음 |
| 계정 탈퇴 | 사용자가 정한 정책은 30일 복구 기간 뒤 삭제. 실제 탈퇴 gate·삭제 운영·백업 삭제 반영 검증은 별도이므로 즉시 이용 가능한 기능으로 공개하지 않음 |
| 운영 주체·문의 | 공개할 정확한 운영 명칭과 개인정보 문의 이메일은 사용자 답변 대기 |
| 책임자·연령·보유/삭제 상세 | 개인정보 보호 담당 공개 방식, 이용 연령/아동 처리, 운영 자료·접속 로그·백업의 보유/삭제 정책을 확정해야 함. dev C등급을 운영 정책으로 복사하지 않음 |
| 제공/위탁·국외 처리 | 실제 인프라·계약·데이터 흐름을 확인한 뒤 기재. 소셜 공급자 이름만 보고 제3자 제공/위탁 여부·국가·보유기간을 만들어 넣지 않음 |
| 가입 동의 | 정책 링크 공개와 서비스 약관 동의 흐름은 별도다. 공급자 로그인 동의를 자체 서비스 약관 동의로 자동 간주하지 않고 화면·버전·확인 방식의 구현 범위를 정함 |

개인정보처리방침은 현재 [개인정보보호위원회 작성지침 안내](https://pipc.go.kr/np/cop/bbs/selectBoardList.do?bbsId=BS217&mCode=G010030030)와 실제 처리 내용을 대조해 작성한다. 확인되지 않은 운영자·보유기간·삭제 완료 보장을 넣은 임시 문안을 최종 정책으로 게시하지 않는다.

## 4. 구현·게시 순서

1. 운영 주체·문의 연락처와 정책 미정 항목을 정리해 공개 문안을 확정한다. 홈페이지에는 서비스 설명과 privacy/terms 링크를 둔다. 기존 준비중 상태는 사실대로 표시한다.
2. 현재 운영 정적 이미지의 `deploy/comingsoon/html/index.html`과 새 `privacy/index.html`, `terms/index.html`을 준비한다. 계정/DB/OAuth 호출 없이 읽을 수 있는 HTML로 제공한다. 문의는 확인한 연락처를 페이지에 표기하고 별도 contact 폼을 만들지 않는다.
3. 개발 화면은 공개된 운영 canonical 정책 URL로 연결할 수 있다. dev 자체에도 같은 경로를 제공할지는 파일·경로 소유를 별도로 정한다. 현재 F6b의 `STATIC_DIRECTORIES`/프록시 허용 목록에는 privacy/terms가 없어 frontend 파일만 추가하면 앱 front에서 404다. dev 경로 추가가 필요할 때만 helper 상수·배포/프런트 계약의 RED/GREEN을 별도 배정한다. 운영 정적 페이지 준비를 위해 dev helper 권한을 넓히지 않는다.
4. 운영 정적 후보 이미지에서 페이지·링크·한글/모바일·접근성·원문 일치를 확인한다. `deploy/comingsoon/html/`은 dev `frontend/public/` build context에 자동 포함되지 않으므로 dev URL의 기존 응답을 운영 페이지 검증으로 대체하지 않는다. 운영 게시에는 기존 GitHub Actions·같은 dev source tree 승격 계약을 따른다. 준비중 사이트의 noindex 정책·TLS·공용 nginx·운영 앱 배포 설정을 이 계획으로 바꾸지 않는다.
5. 운영 페이지를 실제 공개한 뒤 Google 브랜딩/승인 도메인·웹 client, Kakao 운영 앱 등록값에 같은 URL을 사용한다. 소유권·support email·키 발급/검증은 실제 콘솔에서 확인하며 키 값은 비공개 환경 파일로만 받는다.
6. 운영 로그인은 별도 앱 전환 계획·개발 실로그인/저장 검증·운영 데이터 보존/삭제 준비를 마친 뒤 활성화한다. callback 404를 감추는 준비중 응답/stub을 만들어 로그인 준비 완료로 판정하지 않는다.

## 5. 완료 기준

- 운영 홈페이지와 privacy/terms가 익명 HTTPS200 HTML이고, 홈페이지·동의 화면 URL이 일치한다. dev 접근 제한·404·오류 HTML을 정책 URL로 제출하지 않는다.
- 연락처·데이터 처리·동의·삭제 설명이 실제 기능과 일치하고 정책 버전/시행일을 기록한다. 미정 문구가 남은 초안을 최종 정책으로 게시하지 않는다.
- 운영 정적 이미지에 포함되며 향후 앱 front에서도 같은 경로가 유지되는지 확인한다. 실제 접근·링크 검증 없이 파일 존재만으로 완료 처리하지 않는다.
- 향후 운영 앱 전환에도 공개 서비스 소개 홈을 유지한다. 현재 Next `/`는 비로그인 사용자를 로그인 화면으로 보내므로, root를 그대로 운영 공개 홈으로 간주하지 않는다. 공개 홈/계정 기록장 경로와 브랜딩 homepage URL은 운영 앱 전환 계획에서 함께 정한다.
- 개발/운영 client와 키를 분리하고 callback URI의 scheme·host·path가 실행 설정과 정확히 일치한다. 정책 페이지 준비와 실제 로그인 성공은 각각 기록한다.

## 6. 검증·배포 영향·복귀

- 이번 문서 변경은 `git diff --check`와 현재 코드/공식 요구사항 대조로 검증한다. 제품·CI·HTML·schema·자격·서버 변경은 없고 공유 호스트에서 앱/DB 시험을 실행하지 않는다.
- 후속 페이지 구현은 기존 Actions의 root 배포 계약·Compose 검사를 유지하고 정적 이미지의 HTML·링크·익명 GET과 모바일 화면을 확인한다. 운영 게시 뒤 `/`·`/privacy/`·`/terms/`의 HTTP 상태·본문과 소스를 대조한다. callback은 현재 404라는 사실과 앱 전환 뒤의 정상/오류 흐름을 따로 확인한다.
- 별도로 dev helper 경로 추가를 선택한다면 `tests/test_deploy_app.py`와 `app/tests/front-contract.test.mjs`의 격리 CI에서 먼저 새 정책 경로의 실패를 확인한 뒤 구현한다. 새 경로만 허용하고 기존 금지 경로·Host/Origin·콜백 로그/헤더·`/try/` 보존 회귀를 유지한다. 설치 helper는 검토 뒤 메인이 별도 반영하며 저장소 변경이 설치본을 자동 수정하지 않는다.
- 이번 공개 페이지 단계의 DB migration은 없다. 실제 client secret 생성·운영 실행 설정·운영 앱 활성화는 이 문서/페이지 배포의 부수 효과로 실행하지 않는다.
- 첫 정적 게시 실패는 기존 배포 helper의 직전 동결 이미지 검증·복귀 절차를 따른다. source 수정은 해당 변경을 되돌리는 커밋으로 처리하며 현재 서비스의 dev 검증/같은 tree 승격을 생략하지 않는다. 출시 전까지 실제 운영 로그인은 비활성 상태로 유지한다.
- 공개한 정책의 버전·시행 기록과 가입 동의 증거를 페이지 파일 복귀와 함께 지우지 않는다. 이후 실제 로그인까지 공개한 시점의 복귀는 정책 URL을 계속 제공하는 운영 앱 전환 계획에서 따로 정한다.

이 계획 작성으로 제품·정책 페이지·인증 scope·계정 동의·서버·운영 배포를 변경하지 않는다. 다음 구현 파일과 검증은 문안·소유 범위를 정한 뒤 별도 배정한다.
