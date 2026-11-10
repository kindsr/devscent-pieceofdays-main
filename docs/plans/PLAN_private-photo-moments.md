# PLAN — 비공개 사진으로 하루 조각 남기기

- 상태: 2026-11-10 앱 구현 후보 작성·독립 소스 검토 완료, 전체 GREEN CI 전. 사진 기능의 실제 서비스 보관/게시 성공을 뜻하지 않는다.
- 선행: [회고 시간 설정](PLAN_reflection-time-settings.md) migration0003 이후 다음번호0004 사용. 기존1~3 변경0.
- 목표: PC·휴대폰에서 사진1장+짧은 메모를 남기고, 같은 계정의 다른 기기·날짜별 화면에서 다시 읽는다. 예시 SVG나 브라우저 임시 저장으로 실제 사진을 대체하지 않는다.
- 근거: [사용자 핵심 요구](PLAN_ai-daily-story-core.md), [기존 S3 호환 비공개 버킷 선택](../product/00_TECH_STACK_DECISION.md#3-데이터저장소권한-계약).

## 1. 첫 구현의 입력·화면 계약

- 기존 텍스트 조각은 보존한다. 계정 조각 쓰기에 선택 사진1장을 더한다. 메모1~300자·기존 발생 시각/서울 날짜 정책은 그대로다.
- JPEG/PNG/WebP 원본 최대8MiB, 요청 전체9MiB(분할 전송도 실제 읽은 바이트 제한), 최대40,000,000픽셀. 실제 decode 후 긴변2560px 이내·JPEG quality85·최대4MiB로 정규화한다. 방향을 보정하고 EXIF/GPS 등 메타데이터를 제거한다. SVG/HTML/손상/위장/초과 이미지는 고정 오류로 거부한다.
- 파일 선택·파일명과 제한 안내·미리보기·선택 취소를 제공한다. 접근 가능한 이름은 파일 입력 ‘사진 1장’, 취소 버튼 ‘사진 선택 취소’, 저장 사진 img ‘조각 사진’이다. `accept`만으로 서버 검증을 대신하지 않는다. HEIC의 자동 변환을 가정하지 않고 미지원 형식 안내를 제공한다.
- 저장 확인 실패는 ‘사진 저장을 확인하지 못했어요. 고른 사진과 메모는 그대로 두었어요. 다시 시도해 주세요.’로 안내한다. 미설정은 ‘사진 저장을 준비 중이에요. 지금은 메모로 남길 수 있어요.’로 알리고 사진 입력을 닫는다. 미설정 상태에서도 기존 텍스트 기록은 사용 가능하다.
- 저장 중 중복/닫기 잠금, 실패 시 File·메모 초안 보존. 성공 후 서버 재조회가 끝나야 닫고 성공으로 표시한다. 단순 메모 수정은 기존 사진을 보존한다. 사진 교체·다중 사진·크롭은 이 단계 밖이다.
- 확인된 저장 성공 뒤의 재조회만 실패하면 기존 NotConnected 경계가 보드를 교체한다. 사진·메모는 이미 PG/S3에 확정돼 있지만 당시 입력 UI는 유지되지 않는 한계가 있다. 저장 실패/응답 불명확 상태는 이 경로로 이동하지 않고 File·메모·requestId를 유지한다. 확정 저장 후의 재조회 오류는 성공 표시로 바꾸지 않는다.
- 기존 D 디자인을 재사용한다. PC↔iPhone/Android 에뮬레이션, 키보드,375/768/1440 폭을 검증한다. 실기기와 에뮬레이션 결과를 구분한다.

## 2. 앱 API·저장 계약

| 책임 | 파일·계약 |
|---|---|
| 입력 검증 | `server/photos/normalize.ts`: 바이트를 실제 디코딩·재인코딩. 잘못된 입력은 고정 오류, 사진/파일명 원문 로그0. 동시 처리1개·시간 제한. 아래 라이브러리의 상한만으로512MB 적합성을 단정하지 않고 실제 이미지 시험 |
| 저장 설정 | `server/photos/config.ts`: 서버 전용 S3 endpoint/region/bucket/access key/secret 설정. 전부 없으면 미설정, 일부만 있으면 오류. 값/경로를 공개 진단에 싣지 않음. 실제 운영 HTTPS, 격리 CI의 loopback HTTP는 기존 시험 guard 아래만 허용 |
| 저장 port | `server/photos/blob-store.ts`, `blob-store.s3.ts`: `put/get/delete` 최소 인터페이스. 무작위 서버 생성 key, 사진 prefix, 서비스·환경 전용 버킷. 키·소유자·서명 URL·자격을 client DTO로 보내지 않음 |
| DB·쓰기 | migration0004와 `server/photos/store.pg.ts`/`create-moment.ts`: 업로드 예약 journal → 객체 저장 → 사용자 active/gen 재확인 후 조각+사진 ready 원자 확정. 외부 I/O 중 DB 사용자 lock을 계속 잡지 않음. clientRequestId+계정 유일 제약으로 재전송을 중복 저장하지 않음. 같은 id에 다른 입력은 충돌 |
| 업로드 | `app/photos/upload/route.ts`: POST. 설정·정확 Origin·매 요청 viewer·저장 설정을 확인한 뒤 bounded multipart 읽기. 검증된 사용자만 사용하며 userId/key를 클라이언트에서 받지 않음. 성공은 `{ok:true,value:{id,version}}`, 실패는 고정 코드와4xx/503. 실제 객체/DB 성공 전201 금지 |
| 조회 | `app/photos/[id]/route.ts`: GET. active/gen·소유자+ready 확인 후 private bytes. 타인/로그아웃/탈퇴 시0bytes. `Cache-Control: private, no-store`, 고정 JPEG Content-Type·nosniff. 공개 S3 URL·공용 이미지 최적화 캐시0 |
| 기존 조회 | shared `DiaryMoment`에 선택 `photo` 참조를 추가. 기존 `image: SampleImageKey|null`과 fixture는 보존. PG 조회·AccountDayBoard·MonthCalendar가 실제 `/photos/<opaque id>`와 치수만 사용. 기존 무사진 DTO 기대는 불필요하게 변경하지 않음 |

client `photo`는 `photo?: {src:string;width:number;height:number}`이며 src는 상대 `/photos/<UUID>`다. 무사진일 때 property를 생략해 기존 DTO shape를 보존한다. 별도 owner/key/hash는 client에 없다.

라이브러리 구현 기본값(메인 제안): 기존 lock의 **sharp0.35.5**를 직접 의존성으로 고정, S3는 **@aws-sdk/client-s3 3.1165.0**(2026-11-09 발행, Node>=20, Apache2). Sharp 본체 Apache2, bundled libvips LGPL3+는 기존 Next 의존성과 구분해 기록한다. 호스트 설치를 하지 않고 CI의 격리 lock 생성·정확2파일 artifact 회수/해시 대조 후 기존 `npm ci`·라이선스/의존성 검사로 검증한다.

정규화 API 근거: [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/), [방향 보정](https://sharp.pixelplumbing.com/api-operation/), [출력과 메타데이터](https://sharp.pixelplumbing.com/api-output/). S3 API는 [AWS 공식 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/)를 사용하고 서명 프로토콜을 직접 구현하지 않는다. Next [multipart Route Handler](https://nextjs.org/docs/app/api-reference/file-conventions/route#request-body-formdata)를 쓰며 기존 Server Action의 전역1MB 제한을 넓히지 않는다.

### 2.1 RED 전 공개 API 구체화

- multipart 필드는 정확 `photo`(File1개), `memo`(문자열), `requestId`(소문자 UUIDv4)다. 중복/알 수 없는 필드·잘못된 boundary·형식은400. `Content-Length` 선검사와 실제 스트림 누적9MiB 제한을 함께 적용하고, 읽기15초 초과/취소 때 reader를 정리한다. 제한 전 원본 `formData()` 호출0.
- `normalizePhoto(bytes: Uint8Array)` → `Result<{bytes: Buffer; sha256: string; width: number; height: number; contentType: "image/jpeg"}, PhotoError>`. `sha256`은 정규화 bytes의64소문자hex. 단일 정규화 slot, 겹친 호출은 `busy`, 처리5초 제한. 원본8MiB/40MP와 출력4MiB·2560px 제한을 모두 검사하며 애니메이션/여러 page는 이번 단계에서 거부한다.
- `server/photos/create-moment.ts`의 `createPhotoMoment(db, blobs, {userId,gen}, {requestId,memo,photo})` → `Result<{moment:MomentRef;replayed:boolean}, PhotoError>`. 원본 조각 쓰기와 같은 trim/300자·서울 날짜/시각을 사용한다. 사용자 상태/gen은 예약과 최종확정의 짧은 DB tx 안에서 다시 확인한다.
- 업로드 응답: 새 확정201, 같은 요청의 확정 결과 재조회200. 양쪽 `{ok:true,value:{id,version}}`. 잘못된 메모/파일/필드는400, 크기 초과413, 로그인 없음401, Origin 거부403, 다른 입력의 같은 requestId409, 처리 중/미설정/저장 오류503. 실패 JSON은 `{ok:false,error:<고정코드>}`만. 오류코드 집합: `invalid_request`, `invalid_body`, `invalid_photo`, `photo_too_large`, `not_signed_in`, `forbidden`, `conflict`, `busy`, `unavailable`.
- `parsePhotoConfig(env)` → `Result<PhotoConfig|null,"invalid_photo_config">`. 정확 env키는 `POD_PHOTOS_S3_ENDPOINT`, `POD_PHOTOS_S3_REGION`, `POD_PHOTOS_S3_BUCKET`, `POD_PHOTOS_S3_ACCESS_KEY_ID`, `POD_PHOTOS_S3_SECRET_ACCESS_KEY`다. 모두 없으면 null, 일부만 있으면 오류. endpoint는 userinfo/query/fragment 없는 root URL, 실제 실행은 HTTPS. 격리시험의 loopback HTTP는 production에서 금지한다. 비공개 반환형은 서버 안에서만 사용한다.
- blob port의 `put(key,photo,signal): Promise<void>`, `get(key,signal): Promise<Buffer|null>`, `delete(key,signal): Promise<void>`. key는 서버 생성 사진 prefix의 UUID.jpg만. get은 실제 스트림4MiB 상한·timeout을 지키고 missing만null, 기타 실패는 고정 저장 오류. SDK의 암묵적 다회 재시도를 켜지 않는다.
- `PhotoConfig`의 서버 전용 필드는 `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey` 문자열5개다. `createS3BlobStore(config)`로 위 port를 만든다. prefix는 `photos/<소문자UUID>.jpg`로 고정한다.
- private GET은 최초 권한 확인 뒤 bounded get·hash/치수 검증, 응답 직전 소유/active/gen 재확인으로 연결한다.200 이외는 사진 bytes 없는 고정 응답(401/404/503)이며 성공/실패 모두 no-store·nosniff다. 타인id/없는id는같은404, key·사진 hash·사용자 UUID를 응답하지 않는다.

### 2.2 DB·조회·삭제 공개 경계

- 신규 `0004_private_photos`는 `pod.photo_uploads`(예약·key journal), `pod.moment_photos`(확정 사진), `pod.photo_deletions`(재시도 가능한 삭제 tombstone)를 만든다. 기존 사용자8테이블은 변경 없이 보존하며, `diary_moments(id,user_id)`의 소유자 복합FK를 위한 UNIQUE만 추가한다.
- uploads 필드: `id` UUID, `user_id` nullable(계정 purge 때 SET NULL), `request_id` UUID, `fingerprint`64hex, `object_key`, `status`(staged/ready/abandoned), `lease_token`, `lease_until`, 생성/갱신 시각. object_key는 유일하고 `(user_id,request_id)`는 staged/ready에 한정한 부분 유일 제약이다. 만료 후 재시도는 이전 행을abandoned로 남기고 **새id·새key**를 예약한다. 이전 key를 재사용해 늦은 PUT/DELETE가 새 사진을 지우거나 덮게 하지 않는다. 원본 메모·사진 bytes·파일명0. 계정 purge 후 journal/key 자체가 cascade로 없어지지 않게 한다.
- moment_photos 필드: `id`(uploads FK), `user_id`, 유일한 `moment_id`, `sha256`, `mime_type`(image/jpeg), `byte_length`(1..4MiB), `width/height`(1..2560), 생성시각. `(moment_id,user_id)`는 같은 소유자의 diary_moments를 참조한다. 사용자·조각 cascade는 확정 metadata를 지우고 DELETE trigger가 journal의 key를 같은 tx의 photo_deletions에 남긴다.
- deletions는 사진 id/key·재시도시각·최근부재검증시각·시도횟수만 남기며 user FK/원문을 두지 않는다. 성공 DELETE만으로 key를 즉시 버리지 않고 늦은 PUT도 재확인할 수 있게 한다. staging TTL·업로드 lease token을 통해 사용 중인 PUT 회수와 늦은 확정 덮어쓰기를 차단한다.
- 앱은 업로드 예약/확정·조각 읽기에 필요한 SELECT/INSERT/열 UPDATE와 queue INSERT만 쓴다. queue의 cleanup용 SELECT·부재검증/시도횟수 갱신 권한은 purge role에만 부여한다. uploads/삭제 tombstone의 무조건 DELETE 권한을 주지 않는다. purge role에는 새 사진 세 테이블 batch에 필요한 SELECT/열 UPDATE·queue INSERT만 부여한다. 기존 사용자8테이블·원장·PUBLIC 권한은 넓히지 않는다. trigger 함수의 PUBLIC EXECUTE를 회수한다.
- `server/photos/read-photo.ts`의 `readPhoto(db,blobs,{userId,gen},photoId,signal?)` → `Result<{bytes:Buffer;contentType:"image/jpeg"},"not_found"|"unavailable">`. trusted caller만 사용자 문맥을 공급한다. 사진·계정·gen의 초기/최종 검증과 SHA256/길이 확인 후에만 bytes를 반환한다.
- `server/photos/cleanup.ts`의 `cleanupPhotos(db,blobs,{limit,now?})` → `{processed,deleted,failed,busy}`. purge role 확인 후1..100개 한정 batch, 외부 I/O 중 장기 DB tx0, 실패 재시도/활성 lease 건너뜀·tombstone 보존. app 역할의 직접 호출은 blob DELETE 전에 거부한다. DB 시험도 cleanup에는 별도 purge Pool(max1)을 사용한다. 운영 Node CLI도 한 batch만 실행하고 자동 스케줄 설치0. 직접 Node로 실행하는 entry는 기존 migrate-cli처럼 framework 전용 import를 요구하지 않는 별도 entry로 두고, Next 앱의 server-only 경계를 약화하지 않는다.
- CLI 경로는 `src/server/photos/cleanup-cli.mjs`, 명령은 `node .../cleanup-cli.mjs --limit <1..100>`다. 전용 `POD_PHOTO_CLEANUP_DATABASE_URL`과 사진 설정5키를 사용하고 DB meta의 purge_role로 접속했는지 확인한다. 앱 Pool의6연결 예산에 cleanup을 겹치지 않는다. 성공 stdout은 위 stats JSON1개, 실패는 고정 prefix와 exit1·원문비밀0. 자동 scheduler0이며 실제 purge credential은 앱 container의 평상시 환경에 넣지 않는다.
- 기존 purge_role의 `pod_meta` 직접 SELECT 거부는 유지한다.0004의 `pod.is_photo_cleanup_role()`만 owner SECURITY DEFINER·고정 `search_path=pg_catalog,pg_temp`로 qualified meta를 조회해 `SESSION_USER::name = purge_role` boolean을 반환한다. PUBLIC EXECUTE 회수·purge_role EXECUTE만 허용한다. CLI는 이 boolean만 사용하고 false/권한 오류이면고정exit1, 직접 meta조회/SETROLE/역할명 노출0.
- 실제 migration 목록/테이블 기대는0004·11테이블로 확장한다. migration engine의 down 데이터 보호도 새 예약/metadata/삭제목록을 포함한다. 합성 CLI fixture의 임의 latest2와 기존0001~0003은 바꾸지 않는다.

### Node CLI와 앱의 구현 공유

`config-core.mjs`·`blob-store.s3-core.mjs`·`cleanup-core.mjs`는 Next alias/프레임워크 전용 import 없는 Node용 구현으로 둔다. 설정을 인자로 받아 전역에서 자격을 읽지 않으며, 앱의 `config.ts`·`blob-store.s3.ts`·`cleanup.ts`는 server-only wrapper를 유지한다. CLI가 동일 core를 재사용해 설정/SDK/SQL 로직을 복제하거나 서버 경계를 우회하지 않는다. standalone에 CLI·필요 core를 명시 COPY하고 SDK의 Node 접근에 필요한 최소 external package 설정만 추가한다.

## 3. 보관·실패·삭제

- 사진 metadata는 user/moment 동일 소유자를 DB 제약으로 묶는다. 업로드 예약/객체 hash·치수·상태는 서버 전용이다. 원본 파일명·GPS는 저장하지 않는다.
- PUT 이전의 예약과 실패 상태를 영속 기록한다. PUT 실패/응답 손실/최종 DB 실패에도 미참조 객체를 추적하고 재시도·회수할 수 있어야 한다. 실제 저장 실패를 메모만 성공으로 바꾸지 않는다.
- idempotency fingerprint는 정규화 사진 hash+trim한 메모+계약버전1의 canonical JSON SHA256이다. 동일 계정/requestId의 과거 시도들 중 fingerprint가 다르면conflict, 같은 입력이 ready이면 동일 MomentRef, 아직 유효한 예약이면busy다. 만료 예약의 재시도는 새id·key·lease token을 채택하며 이전 시도는abandoned+삭제 추적을 유지한다. 이전 token의 늦은 확정이 새 결과를 덮지 못한다.
- 정리는 유효한 업로드 lease를 회수하지 않는다. 요청 취소/timeout 이후 늦은 PUT 가능성을 처리하려고 key journal/삭제 tombstone을 물리적 DELETE 응답만으로 즉시 제거하지 않는다. 재확인 가능한 key를 보존하고 예약 소멸·늦은 응답·계정 cascade 후에도 다시 삭제/부재 확인할 수 있어야 한다. 사용자 연결·메모 원문은 purge 후 남기지 않는다. 실제 저장소 동작과 이 경합은 별도 CI로 확인한다.
- 조각 삭제/30일 후 계정 purge의 같은 DB tx에서 객체 key를 영속 삭제 목록에 남긴다. 삭제 목록은 사용자 cascade로 사라지지 않는다. 조각 삭제 즉시 HTTP 사진 조회는 거부한다.
- pending_deletion 동안 원본을 유지하고 일반 사진 읽기는 거부한다.720h 내 복구하면 사진도 다시 읽는다. 기존 purge 함수/migration0002는 고치지 않는다.
- 서버 전용 batch cleanup이 삭제 성공 때만 목록을 완료하고, 실패/timeout은 재시도 대상으로 보존한다. 오래된 예약의 정리·실제 S3 삭제와 계정 purge 후 회수를 검증한다. 새 자동 스케줄러 설치나 삭제 보장 시간은 이 계획만으로 확정하지 않는다. 실제 운영 소비/재시도 체계가 없으면 사진 삭제/운영 활성화 완료로 세지 않는다.
- 여기서 ‘완료’는 최근 객체 부재를 검증한 상태다. key tombstone과 후속 재검사 추적을 제거/중단하는 뜻이 아니며, 늦은 PUT로 객체가 다시 관측되면 다음 batch가 다시 지운다.
- down은 CI·사용자 데이터/예약/삭제목록이 전부 빈 경우만 허용한다. 기존 기록 삭제/원장 권한 확대0. 실제 서비스에서는 앱 코드 복귀·기존 열 보존을 우선하며 자동 down0.

## 4. front·설정·운영 경계

- 현 helper의 `/photos/` 미허용·전역1m를 우회하지 않는다. 사진 prefix 전달과 정확 upload location의9MiB 상한만 추가한다. callback 로그/no-referrer·기존 static 경로/바이트·다른 제한 보존.
- storage env는 정확 키 집합을 helper에 추가해 부분 설정·잘못된 URL/버킷/비밀 형식을 거부한다. image ENV에 키를 굽지 않는다. 앱에서 모든 사진 설정이 없는 상태도 정상 기동하되 업로드는 정직한 unavailable이다.
- 실제 S3 인스턴스·전용 dev/prod 버킷/자격/통신은 메인이 비공개 운영 정본에서 별도 준비·검증한다. 공개 버킷이나 다른 서비스 버킷을 재사용하지 않는다. 실제 비용/키를 PR/로그/브라우저에 올리지 않는다.
- 저장소 helper 수정이 설치본을 바꾸지 않는다. 설치본·DB0004 적용·migration 승인 상한·정적/OFF 변경은 별도 검토·실증 단계다. 현재 dev 자동배포 보류와 production 유지.

## 5. 역할을 나눈 검증 순서

1. 앱 전용 dependency/lock 격리 CI 준비·artifact 정확검증. 제품 기능 구현 성공과 구분한다.
2. RED: 실제 정상 사진, 잘못된/초과/Unicode MIME 입력, chunked 상한, 정규화/metadata 제거, Origin/로그인/계정격리, DB/S3 단계 실패·재전송·계정변경·삭제/복구/purge, 무설정 거부를 요구로 고정. 기존 migration 목록은 실제0004까지 합법 확장하고 임의 CLI fixture2는 보존.
3. GREEN: 해당 제품만 구현·시험 byte0. 실제 일회용 S3 호환 저장소+PG의 CI 저장/조회/삭제, 두 교차 엔진의 파일 UI/다른 기기 조회를 검증한다. 메모/글꼴/회고 시간/계정 기존 검사 보존.
4. helper RED→GREEN: 정확 env·사진 prefix/상한만, root/parity와 동일 immutable 이미지의 image/front/원문 preview 회귀. 이전 고정 건수에 사례가 늘면 소비자 literal만 명시 조율하며 skip/기대 완화0.
5. 메인 실제 저장소/후보 이미지/설치본/DB/HTTPS/삭제 소비를 검증한 뒤 게시를 판단한다. mock 성공만으로 실제 사용자 사진 보관 완료를 주장하지 않는다.

### 격리 CI fixture·준비 결과

- dependency proof [PR82](https://github.com/kindsr/devscent-pieceofdays-main/pull/82) source907b265, [run42857304451](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42857304451)에서 실제 설치/Sharp 합성 decode·방향/축소/metadata 제거·S3 send0·원본hash/정리/정확2artifact를 통과했다. 메인이 ZIP raw sha256 `431d8233d90601ab0abe64ea2be11d22341c9e1ded07108c9439712fa7177c5d`·2JSON·기존 dependency version/resolved/integrity 변경0/삭제0를 직접 대조했다. 이 artifact pair만19c1746에 반영했고 호스트 설치0.
- 실제 HTTP S3 roundtrip의 CI fixture는 **SeaweedFS4.53**, linux/amd64 `chrislusf/seaweedfs:4.53@sha256:972ba30c529dfc72a6a12ed427e94d99c7b6a6e59d97bfa52be0a849f43e2cc9`다. 공식tag/source revision `4ab66fb76da83700739f5839e62fcaf15fb7d02a`·manifest rawhash/OCI label 일치를 읽기 확인했다. Apache2, `mini -dir=/data`·가짜 AWS key/secret/S3_BUCKET으로 사설 초기 bucket을 구성한다. [최종 RED CI](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42868890115)의 auth job130014508883에서 실제 Put/Get/hash/Delete/Get404·익명/잘못된 자격 거부 preflight를 통과했다. 제품 저장 성공이나 provider 운영 선택과 구분한다.
- 기존 auth globalSetup의 명시 child env allowlist에 가짜 사진 설정5키만 더하고, 소유한 loopback publish Docker fixture1개를 추적·finally 정리한다. 준비성은 HeadBucket→가짜 Put/Get/hash/Delete/Get404와 익명/잘못된 자격 거부로 확인한다. handler/UI는 실제 이 endpoint를 사용한다. mock backend만으로 이를 대체하지 않는다.
- 기존 auth callee/workflow 본문을 바꾸지 않고 같은 SHA의 필수 auth 검사에 새 사진 사례·기존 두 device 여정 사진 readback을 포함한다. Playwright config의 WebKit 기존 device 제한도 보존한다. 소유 helper·globalSetup 변경은 RED 시험 범위로 명시한다. 호스트 Docker/npm/브라우저0, 실행은 Actions만.

## 6. AI 단계와의 연결

사진·메모 원본과 AI 결과는 별도 보관한다. 이후 계정·서울 날짜의 입력 snapshot/revision을 확정해 단일 생성 adapter와 immutable 이야기 version으로 연결한다. 제공자/외부 전송 범위·동의·비용 한도 확인 전 실제 일기 전송0. 시간 설정이 저장됐다는 이유로 정시 유료 생성·알림을 켜지 않는다. 입력에 없는 사건/인물/대화를 만들어내지 않는 품질 검사와 실제 소량 생성 검증은 [핵심 계획](PLAN_ai-daily-story-core.md)의 별도 완료 기준이다.
