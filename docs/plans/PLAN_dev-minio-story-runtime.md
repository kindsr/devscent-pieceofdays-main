# PLAN — dev MinIO와 AI 실행 환경 연결

- 2026-11-11 사용자 지시: 실제 AI 생성/dev 배포를 진행하고 kindsrNAS MinIO 관련 ops 정본을 확인한다. 월 한도는 원문상 사용자 확보 후 정하는 방향이며, 사용자별 입력 의미인지 확인 중이다. 이 단계는 MinIO transport와 실행 자격 준비다. 실제 이야기 생성·정시 실행·최종 dev 개통은 후속 통합 검증으로 구분한다.
- 문서/실측상 공용 MinIO는 서버 내부 HTTP이고 NAS는 그 볼륨의 백업 대상이다. dev 전용 비공개 버킷/계정만 추가한다. 운영 버킷·공유 MinIO 설정·재시작·공용 nginx/TLS/DNS·다른 서비스는 변경하지 않는다. 기존 app의 edge 격리는 유지한다.

## 1. transport와 자격 계약

1. 기존 front 이미지의 public80 정책은 바이트 보존하고 별도 내부8081 server를 덧붙인다. 기존 front는 이미 edge와 서비스 전용 internal front망에 있으므로 새 컨테이너/네트워크/host port는 만들지 않는다. 다른 edge 컨테이너는 이미 MinIO API에 직접 도달할 수 있고, 추가 listener가 인증을 우회하지 않는다. 익명 접근은 MinIO 전용 정책으로 거부한다.
2. relay는 `pieceofdays-photos-dev/photos/<소문자UUID>.jpg` 경로만 GET/HEAD/PUT/DELETE로 전달한다. 그 외 버킷/접두/경로/메서드/인코딩 우회는403이다. SDK의 x-id query는 메서드에 맞는 GetObject/PutObject/DeleteObject 또는 query 없음만 허용한다. query 중복/다른 값은403이다. HEAD는 query 없음 또는 GetObject만 허용한다.
3. `Host $http_host`와 원래 request URI/본문/서명 헤더를 유지하고 HTTP1.1, buffering/request-buffering off, 5m body limit, access_log off·error_log /dev/null crit를 쓴다. Docker DNS resolver127.0.0.11와 변수 proxy_pass로 시작 시 MinIO 부재/주소 변경이 public80 기동을 막지 않게 한다. local proxy_hide_header/add_header는 추가하지 않는다.
4. 내부 endpoint는 `http://<front_subnet의+11 IPv4>:8081/` 하나다. 앱 config는 명시 `POD_PHOTOS_INTERNAL_DEV_HTTP=1`, NODE_ENV=production, 정확 dev POD_AUTH_BASE_URL, 정규형 RFC1918 IPv4의 끝 octet11·port8081·root만 허용한다. helper는 settings로 계산한 front IP의 endpoint와 dev 버킷 이름까지 정확 비교한다. flag 없는 기존 HTTPS·격리 시험 loopback 예외는 유지한다. flag 오타/사진 미설정/HTTPS와 flag 혼용은 거부한다. production 운영 origin·이름 기반 alias·다른 내부 주소/포트·userinfo/query/fragment/path는 허용하지 않는다.
5. helper app env allowlist에 사진 flag와 AI 실행 자격 `ANTHROPIC_API_KEY`, `POD_STORY_WORKER_TOKEN`만 추가한다. AI 둘은 함께 없거나 함께 있어야 한다. API키는 기존 adapter와 같은 visible ASCII1..4096 범위(기존 env 파일의 공백/#/quote 금지 보존), token은 lowerhex64(32bytes)다. 새 env 값을 이미지 라벨/로그/명령 원문에 넣지 않는다. 실제 key/live env 투입은 검증된 helper와 이야기 소비자가 준비된 뒤 main이 수행한다.

## 2. RED/GREEN와 파일 소유

- RED 작성자: `app/tests/unit/photo-storage.test.ts`의 config 기대 확장(필요 시 같은 범위의 신규 unit 파일), `tests/test_deploy_app.py`, `app/tests/deploy-env-parity.test.mjs`, `app/tests/front-contract.test.mjs`, `app/tests/support/front-harness.mjs`의 기존 사례 확장. 새로운 기능의 존재/허용 값을 명시 assert로 먼저 검사하며 syntax/import/env 오류를 유효 RED로 세지 않는다. 기존 strict front14/원문preview10·parity29·publisher128 개수는 유지하고 testcase를 삭제/skip하지 않는다. mock 자격만 사용한다.
- front의 기존14 사례 안에서 relay nginx syntax/허용 경로의 실제 SDK PUT/GET/DELETE 및 missing GET, 메서드/query/다른 버킷 거부, unsigned403·비기록을 격리 저장소/observer로 검증한다. 필요한 격리 하네스 배선은 본인 소유 파일 안에만 추가하고 public/운영 설정은 조회하지 않는다. 실제 서비스 MinIO의 IAM/백업 상태는 main ops 검증이다.
- GREEN 작성자: `app/src/server/photos/config-core.mjs`, `scripts/ops/deploy.py`와 `infra/minio/pieceofdays-photos-dev-policy.json`, `infra/minio/README.md`. 테스트/공통 auth/adapter/DB/기존 public80·외곽 snippet/서비스 배포 설정/권한은 직접 변경하지 않는다. main은 계획/CHANGELOG 기록과 합쳐 feature만 commit/push한다.
- 정책: bucket 전용 `s3:ListBucket`, `photos/*`의 GetObject/PutObject/DeleteObject만. anonymous none, 다른 bucket·prefix 권한0. List 권한은 없는 객체의 GET을 NoSuchKey로 구별하여 삭제 소비가 완료되도록 필요하다. multipart/관리자 권한은 없다.
- 모든 앱/DB/Docker 시험은 기존 격리 Actions에서만 실행한다. 서버의 source로 npm/브라우저/DB 시험을 실행하지 않는다. main 운영 smoke는 전용 dev namespace와 공개된 합성 데이터로만 수행한다. 각 실패의 실제 이유·미도달 범위를 보고한 뒤 수정한다.
- helper와 실제 front의 RED/GREEN을 누락하지 않도록 PR base는 dev로 둔다(두 workflow의 기존 branch filter 조건). source/test를 바꾸지 않고 feature base에서 실행되지 않은 root/front 검사를 PASS로 세지 않는다. PR은 draft이며 dev 병합·활성화는 최종 이야기/운영 준비 뒤 main이 수행한다.

## 3. 반영과 복귀

source GREEN·독립 검토·같은 SHA CI 후 main이 설치 helper를 잠금/백업/원자 교체하고 dev bucket/IAM·해당 env를 준비한다. source만 고친 것을 설치 완료로 세지 않는다. AI key를 기존 Claude CLI 셸에 export하지 않는다. 실제 dev 전환은 이야기 생성/동의/예약·서비스 DB 연속 migration·불변 게시 이미지와 기존 B5/30분 사후 검증을 함께 준비한 뒤 시작한다.

복귀는 새 helper가 새 env를 읽을 수 있을 때 enableoff→revert-static→정적 실검증을 먼저 수행하고, 그 뒤 구 helper를 복원한다. 새 env를 참조하는 앱 current가 남아 있는데 구 helper부터 복원하면 키 allowlist 검증이 복귀를 막을 수 있다. 설치 직후 정적 상태에서 probe/복귀 경로를 확인한다. 사용자 사진·버킷·DB는 삭제하지 않는다. 전용 smoke 객체만 즉시 제거하고, NAS 백업에 남은 사본을 앱 삭제 완료로 확대하지 않는다.

사진 cleanup 소비자는 공개 앱과 별도 일회 컨테이너로 실행한다. 같은 불변 앱 이미지·read-only cleanup env(정확 dev BASE_URL/사진5/내부flag와 purger URL)를 쓰고 front internal network로 create한 뒤 기존 DB망에만 추가 연결한다. MinIO는 front relay로 접근하며 app에 purger 자격을 주거나 edge에 추가 가입시키지 않는다. 배포와 같은 서비스 잠금 아래 .10/.11 주소 할당 충돌·동시 배포를 피하고 자기 컨테이너만 제거한다. main이 실제 파싱/연결/삭제를 확인한 뒤 전용 정기 작업을 배선한다.
