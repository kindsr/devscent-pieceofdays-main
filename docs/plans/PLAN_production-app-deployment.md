# 운영 앱 승격

2026-11-18 사용자 요청: 검증된 dev 앱을 운영에 배포한다. 개발 기록은 보존하고,
운영은 별도 DB·역할·세션 키·사진 버킷·worker token으로 시작한다.
Google만 활성화하고 AI 공급자 키는 이 서비스 전용 기존 키를 사용한다.

## 1. 범위와 현재 상태

- 기준 `55d9765`: 이야기 수정·재생성까지 dev 배포 완료. 운영은 아직 준비중 정적 이미지다.
- 현재 main 배포는 정적 배포 명령이며 dev 앱 기록을 승격 근거로 거부한다.
  단순 병합으로 운영 앱 완료를 주장하지 않는다.
- 공개 소개·약관·개인정보 문안 신설, Google 콘솔 게시 심사, dev 개인 자료 이전은
  이번 변경에 포함하지 않는다. 실제 Google 로그인 완료는 기술 점검과 구분한다.
- 탈퇴 gate는 현재처럼 닫힌 상태를 유지한다. 활성화는 30일 purge 배선 검증과 함께 한다.
- 운영 기능은 로그인·기록·사진·동의 기반 수동/정시 AI 이야기·부분 수정·재생성이다.

## 2. 승격 명령과 신뢰 경계

- 새 문법 `deploy-app production <main SHA>`, `revert-static production`.
  dev 기존 명령·인자·상수·동결 기록은 호환 유지한다.
- 서버가 최신 main을 clean clone하고 실제 tree를 계산한다.
  dev-current가 app/success이고 pending이 없으며 동일 tree여야 한다.
  이 검사는 준비 때와 전환 직전에 반복한다.
- 앱은 그 dev 기록의 로컬 app image ID·manifest/config digest를 그대로 사용한다.
  production에서 registry 조회·pull·앱 재빌드나 migration 자동 실행은 없다.
- 이미지 revision은 검증된 dev SHA, 운영 배포 SHA는 main SHA일 수 있다.
  운영 기록에는 `app_source_sha`를 추가해 image validation과 과거 운영 복원 시에도
  원래 이미지 revision을 검증한다. dev 기록의 키 집합은 바꾸지 않는다.
- image tree·정확한 배포 image ID·승격 tree·migration label을 검증한다.
  운영 신뢰 config의 `approved_migrations`보다 높은 이미지는 전환 전에 거부한다.
- 기존 production Actions job은 원격 명령만 새 승격 명령으로 교체한다.
  environment·SSH 강제 명령·concurrency·권한은 유지한다.

## 3. 환경 분리

- 기존 dev 상수/함수 기본값을 유지하고 환경별 map과 명시적 env 인자를 추가한다.
  전역 변수를 실행 도중 바꾸지 않는다.
- 운영 front 서비스/컨테이너는 기존 edge upstream 이름 `pieceofdays-comingsoon`,
  앱은 `pieceofdays-app`, `pieceofdays-prod-front`/`pieceofdays-prod-egress`는 dev와 다른 전용 네트워크다.
  app은 front+db+egress, front만 edge에 연결하며 host port는 없다.
- front는 동일 source tree의 정적 자료와 운영 origin/upstream/relay conf로 빌드한다.
  dev front conf 바이트와 dev 응답 계약은 유지한다.
- 운영 env는 origin `https://pieceofdays.com`, 운영 DB/role과 정확히 일치해야 한다.
  dev용 DB·버킷·HTTP flag는 운영에서 거부한다. 비밀 값은 출력하지 않는다.
- 앱 Pool에 선택적 `POD_DATABASE_POOL_MAX`를 추가한다. 미설정=기존 5,
  설정 시 정규 10진수 1..5만 허용한다. import 시 env/접속은 없다.
  운영 helper는 이 값이 필수이고 서버 `app_pool_max=3`과 같은지 검사한다.
  운영 app role 상한 4=pool3+readiness1, migrator1, purge1이다.
  공유 서버의 다른 역할/접속 한도는 변경하지 않는다.

## 4. 사진 HTTPS

- 앱 사진 parser의 dev HTTP 예외는 넓히지 않는다. 사진 코어·서명·재시도 계약 불변.
- 운영 S3 endpoint는 정확히 `https://pieceofdays.com/`, 버킷 `pieceofdays-photos`.
  별도 IAM 사용자가 해당 버킷 ListBucket 및 photos/* Get/Put/Delete만 가진다.
  anonymous 접근을 허용하지 않는다.
- 운영 edge의 정확한 HTTPS vhost에 `/pieceofdays-photos/` relay를 추가한다.
  front 8081은 원문 method/request_uri 전체 정규식으로 소문자 UUID.jpg와
  각 method에 대응하는 x-id query만 허용한다. 그 외는 403이다.
- Host·원문 URI를 보존하고 URI 없는 변수 proxy_pass, buffering off, request buffering off,
  5m, access_log off, error_log crit를 사용한다. local hide/add_header는 추가하지 않는다.
- 운영 callback·사진 앱 경로도 로그 off/기존 보안 헤더 상속을 적용한다.
  업로드 앱 경로는 9m, 사진 읽기는 1m이다. HTTP redirect·TLS·다른 서비스는 유지한다.
- 운영 photo cleanup은 전용 front+db+egress, edge/host port 없이 HTTPS를 사용한다.
  dev 소비자와 환경은 변경하지 않는다.

## 5. 복귀

- 첫 앱 전환 직전 기존 정적 production 기록/이미지를 static-last로 동결한다.
- 전환 실패는 직전 이미지·동결 env/compose로 복귀하고 실제 health/body를 확인한다.
  정적 복귀 시 같은 project에서 --remove-orphans로 새 앱만 제거한다.
- 복귀 실패는 pending을 보존하고 성공으로 보고하지 않는다.
- 수동 복귀는 운영 enable=false 후 `revert-static production`이며 DB·버킷은 보존한다.
  사용자 응답 대기·시간 경과만으로 자동 복귀하지 않는다.
- 새 helper로 정적 복귀를 마친 뒤에만 구 helper/config를 복원한다.

## 6. 역할과 검증

1. RED 담당은 신규 production helper 시험, 기존 문법의 정당한 기대 변경,
   pool unit·env parity·workflow 명령 기대·2-hop 사진 fixture를 소유한다.
   명시적 기능 부재 단언으로 실패를 확인하고 type/import/env 실패는 RED로 세지 않는다.
2. GREEN 담당은 deploy.py·workflow·pool 코드·운영 nginx/snippet·IAM 정책만 수정한다.
   동결 RED·기존 dev conf·사진 parser는 수정하지 않는다.
3. 독립 reviewer는 실제 diff와 동일 SHA의 Actions 원문을 확인한다.
   host에서 npm 설치/앱/DB/browser 시험은 실행하지 않는다.
4. 필수 RED: 문법·env 교차 거부·compose 망/이름·source/image/tree/migration fence·
   immutable dev 근거·복귀/멱등·dev 바이트 호환·pool 형식·서명 2-hop 왕복/거부/비기록.
5. GREEN 후 dev에 반영해 동일 이미지 image/front/preview 및 기존 unit/DB/auth를 검증한다.
   성공한 dev와 같은 tree만 main에 병합한다.
6. 메인은 비공개 운영 DB/IAM/env·설치 helper·nginx를 백업/검증하고 반영한다.
   fresh DB status→up→status, 실제 HTTPS·Google start/flow cookie/expired callback·
   로그 양성 대조·사진 IAM/합성 객체 왕복·내부 worker 외부404·dev 불변을 점검한다.
7. 운영 story/photo 소비자는 현재 release/enable/health·deploy.lock을 검사한다.
   동의 기본 off·동의 epoch·계정/input/lease fence·사용량·재시도0을 유지한다.
   개인 사용자 자료를 smoke나 CI로 보내지 않는다.

## 7. 진행

- [x] 현재 dev/production 기록·설치 helper hash 읽기 확인
- [x] 공개 소스 조사 3개와 main Google 운영 URI 수락 preflight(실로그인 아님)
- [x] RED 작성·동일 SHA CI에서 유효 실패 회수(866cc5d, root156/구조128/unit384/parity29/front14)
- [ ] GREEN·독립 source/CI·dev 배포
- [ ] 운영 DB/IAM/env/helper/nginx·후보 점검
- [ ] 동일 tree main 승격·실제 운영 점검·소비자·기록 동기화
