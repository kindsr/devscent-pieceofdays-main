# PLAN — 개발 로그인 콜백의 게이트웨이 헤더·로그

- 상태: **수정안·격리 검증 준비, 사용자 예외 승인 전.** 실제 게이트웨이는 바꾸지 않는다.
- 범위: `dev.pieceofdays.com`의 Google·Kakao 콜백 두 경로만. 다른 서비스·운영·TLS·기존 접근 제한은 유지한다.
- 근거: B4의 callback `Referrer-Policy: no-referrer`와 F6 배포 계획 §6.1의 code·state 비기록 계약. 저장소 `AGENTS.md` §3과 F6 계획은 공용 nginx 변경을 제외하므로, 실제 서비스 설정 반영·reload에는 구체 수정안 검증 후 사용자 예외가 필요하다.

## 1. 메인 확인 사실

메인이 현재 dev 게이트웨이 설정을 읽기 전용으로 확인했다. 공통 보안 헤더가 응답에 `Referrer-Policy: strict-origin-when-cross-origin`을 더하고, 접근 로그 형식이 원문 URI·query·referrer를 기록한다. 공급자 콜백은 브라우저의 GET으로 `code`·`state`를 전달하므로, 실제 로그인을 켜면 이 값이 남을 수 있다. 앱의 `no-referrer`와 외곽 헤더가 함께 오는 상태도 피해야 한다.

서비스 프런트 nginx의 기본 로그에도 같은 문제가 있다. 이 내부 프런트는 F6b의 신뢰 설정 상수에서 별도로 고친다. 내부 시험만으로 외곽 게이트웨이가 검증됐다고 하지 않는다.

## 2. 외곽 서비스 설정 수정안

정확 경로는 `/auth/google/callback`, `/auth/kakao/callback`이다. 기존 일반 프록시는 유지하고 두 exact location만 추가한다.

- 접근 로그는 기존 JSON 필드 구조를 유지하되 `request_uri`에는 query 없는 `$uri`, `args`·`http_referer`에는 빈 문자열을 기록한다. 이 서비스의 콜백만 전용 형식을 쓴다.
- 콜백의 nginx 오류 로그는 `/dev/null`로 보낸다. upstream 실패 시에도 원문 요청 주소가 남지 않게 한다. callback HTTP 상태는 위의 안전한 접근 로그로 확인한다.
- upstream의 `Referrer-Policy`를 숨기고, 외곽에서 `no-referrer` **하나만** 보낸다. 기존 noindex·frame·type·HSTS 헤더도 이 location에 그대로 둔다.
- 기존 IP/Basic 인증 조건은 서버 수준에서 그대로 상속한다. 프록시 목적지·헤더·timeout은 현재 일반 location과 같게 둔다. 코드·query는 앱에 그대로 전달한다.
- 원본 설정의 나머지 바이트, 인증서·키 경로, 다른 서버 블록은 바꾸지 않는다. 실제 경로·수정 파일·원본 해시·복귀 사본은 비공개 런북에서 관리한다.

## 3. 검증·소유

1. 메인: 실제 원본과 제안 파일의 diff를 대조하고 두 location·안전 로그 형식 외 변경이 없는지 확인한다. 제안 파일은 저장소 밖에 둔다.
2. F6a2 시험 작성 담당: 비공개 주소·자격 없는 격리 nginx fixture에 **동일한 콜백 블록·로그 형식**을 넣는다. 가짜 Basic 인증과 실제 서비스 프런트·Next production 이미지를 사용한다. 시험·harness만 작성하며 설치하지 않는다.
3. 독립 검토 담당: fixture와 공개 계약을 대조하고 격리 CI 실행 결과를 확인한다. 이 fixture가 실제 설정 전체의 검증을 대신하지 않음을 명시한다.
4. 사용자 예외가 승인되면 메인: 원본 해시가 준비 시점과 같은지 재확인 → 비공개 복귀 사본 → 서비스 dev 설정 한 파일 반영 → 실제 `nginx -t` → 성공 때만 reload. 실패 시 즉시 원본 복원 후 syntax 검사한다. restart·다른 서비스 편집·TLS 변경은 없다.
5. 메인: 실제 HTTPS 응답 헤더·가짜 query 비기록·접근 제한을 확인한 뒤 실제 OAuth를 검증한다. 실제 code·state·cookie 값은 기록·출력하지 않는다.

격리 시험에서 반드시 확인할 것:

- Google·Kakao 각각 정상 전달과 upstream 중단에서 합성 code/state/referrer sentinel이 edge·front·Next 로그에 없다.
- 실제 production Next의 B4 오류 redirect는 도달·헤더·로그의 증거로 확인한다(실제 공급자는 호출하지 않음). flow 없는 `expired` 응답은 query를 읽기 전에도 나올 수 있으므로 전달 증거로 세지 않는다. 동일한 콜백·프록시 블록을 쓰는 별도 CI 전용 메모리 수신 observer에서 code/state sentinel과 중복·인코딩을 포함한 request-target 바이트, Origin·Cookie를 직접 대조한다. 합성 원문은 영구 로그·CI artifact에 남기지 않고 성공 여부만 출력한다.
- 콜백 응답의 `Referrer-Policy`는 정확히 한 개이고 `no-referrer`다.
- 인증 없는 요청은 기존 dev 접근 조건대로 거부되고, 시험용 인증을 넣으면 전달된다. 기존 보안 헤더는 유지된다.
- 일반 경로와 `/try/`의 동작은 그대로다. 실제 TLS·현재 사용자 IP 조건의 최종 증거는 승인 후 메인 서버 확인이다.

## 4. 게시 조건·복귀

이 수정안은 코드·CI 준비를 진행할 근거이며 실제 nginx 반영 승인이 아니다. OAuth 자격·F6a2·서비스 dev 설정 예외가 준비되기 전에는 F6c2 실로그인 전환을 완료로 표시하지 않는다.

반영 실패 시 dev 서비스 설정 원본을 복원하고 `nginx -t` 성공 뒤 reload한다. 기존 정적 dev 기록장·DB 자료를 지우지 않는다. 정확히 이 서비스 콜백의 로그 상세를 줄이는 선택이며, 다른 서비스의 로깅 정책을 바꾸지 않는다.
