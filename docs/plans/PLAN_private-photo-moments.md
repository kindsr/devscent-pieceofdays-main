# PLAN — 비공개 사진으로 하루 조각 남기기

- 상태: 2026-11-10 구현 준비. 사진 기능의 구현/실제 저장 성공을 뜻하지 않는다.
- 선행: [회고 시간 설정](PLAN_reflection-time-settings.md) migration0003 이후 다음번호0004 사용. 기존1~3 변경0.
- 목표: PC·휴대폰에서 사진1장+짧은 메모를 남기고, 같은 계정의 다른 기기·날짜별 화면에서 다시 읽는다. 예시 SVG나 브라우저 임시 저장으로 실제 사진을 대체하지 않는다.
- 근거: [사용자 핵심 요구](PLAN_ai-daily-story-core.md), [기존 S3 호환 비공개 버킷 선택](../product/00_TECH_STACK_DECISION.md#3-데이터저장소권한-계약).

## 1. 첫 구현의 입력·화면 계약

- 기존 텍스트 조각은 보존한다. 계정 조각 쓰기에 선택 사진1장을 더한다. 메모1~300자·기존 발생 시각/서울 날짜 정책은 그대로다.
- JPEG/PNG/WebP 원본 최대8MiB, 요청 전체9MiB(분할 전송도 실제 읽은 바이트 제한), 최대40,000,000픽셀. 실제 decode 후 긴변2560px 이내·JPEG quality85·최대4MiB로 정규화한다. 방향을 보정하고 EXIF/GPS 등 메타데이터를 제거한다. SVG/HTML/손상/위장/초과 이미지는 고정 오류로 거부한다.
- 파일 선택·파일명과 제한 안내·미리보기·선택 취소를 제공한다. `accept`만으로 서버 검증을 대신하지 않는다. HEIC의 자동 변환을 가정하지 않고 미지원 형식 안내를 제공한다.
- 저장 중 중복/닫기 잠금, 실패 시 File·메모 초안 보존. 성공 후 서버 재조회가 끝나야 닫고 성공으로 표시한다. 단순 메모 수정은 기존 사진을 보존한다. 사진 교체·다중 사진·크롭은 이 단계 밖이다.
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

라이브러리 구현 기본값(메인 제안): 기존 lock의 **sharp0.35.5**를 직접 의존성으로 고정, S3는 **@aws-sdk/client-s3 3.1165.0**(2026-11-09 발행, Node>=20, Apache2). Sharp 본체 Apache2, bundled libvips LGPL3+는 기존 Next 의존성과 구분해 기록한다. 호스트 설치를 하지 않고 CI의 격리 lock 생성·정확2파일 artifact 회수/해시 대조 후 기존 `npm ci`·라이선스/의존성 검사로 검증한다.

정규화 API 근거: [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/), [방향 보정](https://sharp.pixelplumbing.com/api-operation/), [출력과 메타데이터](https://sharp.pixelplumbing.com/api-output/). S3 API는 [AWS 공식 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/)를 사용하고 서명 프로토콜을 직접 구현하지 않는다. Next [multipart Route Handler](https://nextjs.org/docs/app/api-reference/file-conventions/route#request-body-formdata)를 쓰며 기존 Server Action의 전역1MB 제한을 넓히지 않는다.

## 3. 보관·실패·삭제

- 사진 metadata는 user/moment 동일 소유자를 DB 제약으로 묶는다. 업로드 예약/객체 hash·치수·상태는 서버 전용이다. 원본 파일명·GPS는 저장하지 않는다.
- PUT 이전의 예약과 실패 상태를 영속 기록한다. PUT 실패/응답 손실/최종 DB 실패에도 미참조 객체를 추적하고 재시도·회수할 수 있어야 한다. 실제 저장 실패를 메모만 성공으로 바꾸지 않는다.
- 조각 삭제/30일 후 계정 purge의 같은 DB tx에서 객체 key를 영속 삭제 목록에 남긴다. 삭제 목록은 사용자 cascade로 사라지지 않는다. 조각 삭제 즉시 HTTP 사진 조회는 거부한다.
- pending_deletion 동안 원본을 유지하고 일반 사진 읽기는 거부한다.720h 내 복구하면 사진도 다시 읽는다. 기존 purge 함수/migration0002는 고치지 않는다.
- 서버 전용 batch cleanup이 삭제 성공 때만 목록을 완료하고, 실패/timeout은 재시도 대상으로 보존한다. 오래된 예약의 정리·실제 S3 삭제와 계정 purge 후 회수를 검증한다. 새 자동 스케줄러 설치나 삭제 보장 시간은 이 계획만으로 확정하지 않는다. 실제 운영 소비/재시도 체계가 없으면 사진 삭제/운영 활성화 완료로 세지 않는다.
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

## 6. AI 단계와의 연결

사진·메모 원본과 AI 결과는 별도 보관한다. 이후 계정·서울 날짜의 입력 snapshot/revision을 확정해 단일 생성 adapter와 immutable 이야기 version으로 연결한다. 제공자/외부 전송 범위·동의·비용 한도 확인 전 실제 일기 전송0. 시간 설정이 저장됐다는 이유로 정시 유료 생성·알림을 켜지 않는다. 입력에 없는 사건/인물/대화를 만들어내지 않는 품질 검사와 실제 소량 생성 검증은 [핵심 계획](PLAN_ai-daily-story-core.md)의 별도 완료 기준이다.
