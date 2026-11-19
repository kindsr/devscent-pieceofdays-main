# PLAN — PC·휴대폰 계정 기록 호환성

- 사용자 확정(2026-11-10): "PC, 휴대폰 전부 가능해야함".
- 기준: `8331f6252a40c9ad5221de7bd55c345f94eebdee`.
- 목표: PC와 휴대폰에서 같은 계정으로 독립 로그인하고, 저장한 서버 자료를 서로 다시 불러올 수 있다. 조각 작성·수정·날짜별 보기·기록 글꼴·로그아웃을 기기로 제한하지 않는다.
- 현재: 개발 앱의 자동배포·실제 DB readiness·전체 콜백/로그 검증은 성공했으나 실제 Google B5 검증이 끝나지 않아 정적 화면으로 복귀했다. 기기 CI를 실제 Google 로그인이나 현재 앱 개통으로 표시하지 않는다.

## 성공 기준

1. 두 브라우저 context가 쿠키나 storageState를 복사하지 않고 같은 Google mock subject로 각각 로그인한다. 같은 서버 계정이고 최초 지급은 중복되지 않는다.
2. PC 화면에서 조각을 작성한 뒤 휴대폰에서 다시 불러오면 동일 기록이 보인다. 휴대폰에서 수정한 뒤 PC에서 다시 불러오면 수정이 반영된다. 쓰기는 UI와 실제 Server Action만 사용한다.
3. 같은 날짜의 달력/기록 화면과 계정에 저장한 글꼴을 양쪽에서 확인한다. 한 기기의 로그아웃이 다른 기기의 독립 세션을 임의로 로그아웃시키지 않는다.
4. PC·휴대폰의 주요 화면·작성창에 가로 넘침이나 화면 밖 조작 요소가 없는지 기존 레이아웃 기준으로 확인한다.
5. Chromium 데스크톱↔WebKit iPhone emulation, WebKit 데스크톱↔Chromium Android emulation을 각각 실행한다. 각 여정의 두 context는 다른 엔진이며 같은 계정으로 로그인한다. 브라우저 엔진·기기 emulation 결과와 실제 PC·휴대폰/Google 공급자 결과는 구분한다.

자료는 새로고침·다시 불러오기 시점의 서버 최신 자료다. 실시간 푸시 동기화나 Google/Kakao 계정 병합을 새로 도입하지 않는다. `/try/`의 브라우저 전용 기록은 계정으로 자동 이전하지 않는다.

기기 여정은 실제 UI 저장 후 기존 SELECT helper로 확인한 기록의 날짜를 고정하고 공개 날짜 상세 경로에서 다시 불러온다. 시험 도중 서버의 오늘이 바뀌어도 정상 저장을 실패로 취급하지 않는다. 기기 간 날짜 표시의 일치를 확인하며, 서울 날짜 계산 정책은 기존 기록 시험이 맡는다.

## 최소 변경 경계

- 신규 `app/tests/e2e-auth/device.spec.ts`: 실제 mock OIDC·일회용 PostgreSQL 18과 기존 공개 helper로 기기 간 여정을 검증한다. PC는 해당 project의 browser를 사용하고 휴대폰은 반대 엔진 browser를 별도로 시작해 두 context와 함께 finally에서 정리한다. 계정·세션 주입, 직접 DB 쓰기, 외부 실제 공급자 호출, code/token/cookie 출력·artifact는 금지한다.
- `app/playwright.auth.config.ts`: 기존 Chromium project와 기존 33개 사례를 유지하고, WebKit은 신규 기기 사례만 실행한다. worker 1·재시도 0·trace/video/screenshot/HAR off를 유지한다.
- `.github/workflows/app-validation.yml`: 기존 auth-e2e job의 브라우저 설치 한 줄만 Chromium+WebKit으로 확장한다. 기존 app/DB/auth job·호출 방식·권한·실행 조건·명령은 보존한다.
- `app/tests/deploy-workflow.test.mjs`: C2 callee 전체 고정 hash는 유지한다. auth-e2e의 정확한 새 설치 명령을 요구하고 그 한 줄만 기존 Chromium 명령으로 정규화한 뒤 원래 hash와 대조한다. 임의 새 hash로 교체하지 않는다. 기존 구조 128개와 CLI 76개 구간의 수량·기대를 보존한다.
- PRD·이 계획·개발 앱 계획·changelog: 사용자 확정과 실제 실행/미실행 범위를 기록한다.
- 제품 코드 변경은 새 기기 검사가 실제 제품 결함을 드러낸 경우에만 그 실패 증거로 별도 범위를 배정한다.

## 검증 순서

1. 별도 pane이 기존 증거·공백·공개 helper·최소 범위를 읽기 검토한다.
2. RED는 신규 기기 시험·Playwright config·해당 구조 계약만 수정하고 시험 전용 커밋을 만든다. 기존 인증/기록 사례는 byte 그대로 유지한다.
3. 기존 Actions에서 새 브라우저 설치 계약의 정확한 의도 실패를 확인한다. WebKit binary 미설치로 실행하지 못한 사례는 환경 미충족으로 기록하며 제품 RED나 통과로 세지 않는다.
4. GREEN은 승인된 CI 설치 한 줄만 수정한다. RED 시험/config 바이트는 변경하지 않는다.
5. 실제 Actions의 Node24/26·DB·기존 인증/기록 33개와 신규 Chromium/WebKit 기기 사례, root108·구조128·이미지/프런트/원문 preview를 확인한다. skip·0건·이전 SHA를 성공으로 세지 않는다.
6. 독립 검토 뒤 PR을 수락한다. 개발 앱 재개는 B5 실제 공급자 검증과 기존 배포/복귀 관문을 따른다. 이번 CI 확장만으로 dev enable·배포·게이트웨이·DB·운영 main을 바꾸지 않는다.

## 실제 기기 확인과 되돌리기

- 실제 Google 검증 창에는 PC와 휴대폰 양쪽에서 로그인·기록 재조회·수정·달력·글꼴·로그아웃/재로그인을 확인한다. 사용자에게 기기 하나만 고르게 하지 않는다.
- 실제 계정 비밀번호·인가 code·token·cookie·기록 본문을 채팅·로그·CI로 받지 않는다. 결과·오류 문구·기기/브라우저 종류만 확인한다.
- 아직 실제 공급자 PKCE 음성·취소·iss/openid 검증은 남아 있으며, emulation이나 mock CI로 대체하지 않는다.
- 불필요한 앱 재개/새 검증 창을 만들지 않고 현재 정적 복귀와 enable off를 유지한다. 기기 검사 실패 시 기능 기대를 줄이지 말고 원인을 구분한다. DB/계정/기록·기존 디자인·helper alias 수정은 보존한다.

## 실행 중 확인한 기존 보안 검사의 증거 수집 보완

- 초기 GREEN `1647137`에서 신규 교차 기기 2개는 통과했으나 전체 인증35개 중 기존 UUID 비직렬화 사례가 RSC 본문 수집 부재로 실패했다([원문](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42762198765/job/129650281193)). 식별자 누출을 검출한 실패는 아니며, 뒤의 UUID 검사가 실행되지 않았으므로 보안 검사 통과로 세지 않는다.
- 별도 시험 전용 커밋은 해당 사례의 실제 키보드 작성·글꼴 선택 직전에 same-origin Server Action POST 응답을 기다린다. 성공 status·RSC content type과 완전한 본문의 UUID 비포함을 확인한 뒤 다음 페이지로 이동한다. 원래 HTML/RSC 존재·UUID·레이아웃·키보드 단언과 기존33개 수량은 유지한다. 응답 취소/늦은 이벤트의 정확한 원인은 미확정이며 간헐 실패로 단정하지 않는다.
- 신규 RED3파일은 계속 동결한다. 초기 GREEN의 시험 무변경 관문과 후속 시험 전용 교정 관문을 구분하며, 후속 tip 전체를 최초 RED 대비 시험 변경0이라고 보고하지 않는다. 교정 효과는 최종 같은 SHA의 실제 CI로 확인한다.

## 개발 적용 중 확인한 WebKit 로그인 시험 순서

- 사용자 "지금 적용해줘" 뒤 PR77을 통합한 dev `7313f6b`의 [인증 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42769721648/job/129674421713)는35개 중34개 통과, WebKit 기기 사례의 첫 로그인만 탐색 충돌로 실패했다. 자동배포는 차단됐고 정적 서버를 유지한 채 app enable을 다시 껐다. 실패를 재시도나 기기 검사 제외로 통과시키지 않는다.
- `holdStart`의 mock 결과는 브라우저에 대기 문서를 보내기 전에 확정된다. `beginLogin`은 공급자 버튼과 실제 start 요청을 유지하고, 정확한 start 문서가 load될 때까지 기다린 뒤 callback을 반환한다. 그러면 시작 POST 탐색과 뒤의 callback 탐색을 겹치지 않는다. 제품·세션 주입·쿠키 복사·mock 발급 방식·기존 단언·수량35/구조128·retry0은 바꾸지 않는다.
- 이 별도 시험 helper 교정과 신규 RED3파일의 동결은 구분한다. 실제 효과는 교정 HEAD의 전체 Actions와 이후 동일 SHA 자동배포 관문으로 확인한다. 실제 Google B5/실기기 완료와30분 복귀 기준은 그대로다.
- PR78 초기 `3fa0aec`의 [후속 CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42770416438/job/129676637888)는 시작/callback 충돌을 재현하지 않았으나35개 중33개 통과·2개 실패였다. WebKit 저장 뒤 날짜 이동은 진행 중인 루트 재조회와 충돌했고, 기존 UUID 사례는 브라우저 응답 본문 API가 자료를 회수하지 못했다. 제품 결함/정상이나 간헐 실패 원인을 추가로 단정하지 않는다.
- 후속 시험 전용 교정은 기기 사례의 생성·수정 완료 status와 canonical 조각을 후속 탐색 전에 확인한다. UUID 단일 사례는 실제 UI action POST를 한 번 전달해 원서버의 전체 본문을 확보하고, 그 동일 buffer를 브라우저에 반환한다. 기존 response waiter/status200/RSC type에 browser response finished·같은 Request의 본문·UUID 비포함 검사를 묶고, 기존 HTML/RSC/UUID/키보드/레이아웃 단언과 생성 요청1회를 유지하며 글꼴 뒤 총2회도 확인한다. body 회수 실패를 성공으로 삼거나 응답 내용을 바꾸지 않는다.
- 이번2파일 delta는 내부 읽기 전용 검토(P0/P1 없음)와 test-only 범위 gate를 통과했다. Playwright config·구조 contract의 두 frozen blob은 그대로이고, device frozen blob은 위 공개 완료 상태 단언 추가로 변경됐음을 별도로 기록한다. 최초 GREEN의 시험 무변경이나 신규 RED3파일 전부 불변을 후속 tip 전체에 주장하지 않는다. 실제 효과는 최종 HEAD CI로 확인한다.
- PR78 최종422b946의 인증35개/전체 CI는 통과했으나, 통합 dev9681853의 [실제 배포 검사](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42773246957/job/129685718414)는34/35로 WebKit의 달력 날짜 클릭 후 URL 검사가 실패했다. 기존 시작/저장 이동·UUID 사례는 이 실제 run에서 통과했고, 게시/서버 전환은 차단됐다. 결과를 이전 PR 성공으로 대체하지 않는다.
- 목록과 날짜 상세는 같은 `모아보기` 제목과 달력을 사용한다. 기존 heading 확인만으로 목록 전환 완료를 증명하지 못하는 공백을 보완해, 메뉴 클릭 뒤 정확한 `/days`와 날짜 미선택 DOM을 기다린다. 실제 날짜 클릭 뒤 기존 정확한 상세 경로와 함께 선택 DOM도 확인한다. 이3줄 추가는 독립 source 검토와 test-only 범위 gate PASS이며 기대 삭제·고정 sleep·재시도·직접 goto 대체는 없다. 지연된 목록 이동이 실제 실패 원인인지는 새 CI로 확인한다.
