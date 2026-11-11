# dev 사진 저장소(MinIO) 정책

[PLAN_dev-minio-story-runtime](../../docs/plans/PLAN_dev-minio-story-runtime.md)의 dev 전용 비공개 버킷과 앱 자격 정책이다.
공용 MinIO의 다른 버킷·운영 버킷·서버 설정·재시작·다른 서비스는 바꾸지 않는다. 실제 주소·계정·비밀값은
공개 저장소에 적지 않고 비공개 운영 런북과 비공개 app env에만 둔다. 적용은 main이 수동으로 한다.

## 범위

- 버킷: `pieceofdays-photos-dev` 하나. 익명 접근 정책은 none(공개 읽기/쓰기 0).
- 정책 [`pieceofdays-photos-dev-policy.json`](pieceofdays-photos-dev-policy.json):
  - 버킷 자체의 `s3:ListBucket`만. 없는 객체의 GET이 AccessDenied가 아니라 NoSuchKey(404)로 구별되어야
    사진 삭제 소비가 완료를 판정할 수 있다.
  - `photos/*` 객체의 `s3:GetObject`·`s3:PutObject`·`s3:DeleteObject`만.
  - 다른 버킷·접두·multipart·버킷 설정·관리자 권한은 0.
- 앱은 이 정책만 붙은 dev 전용 사용자 자격을 쓴다. 공용 root·다른 서비스 자격을 재사용하지 않는다.

## 접근 경로

- 앱은 MinIO에 직접 붙지 않는다. dev front의 내부 8081 relay(`scripts/ops/deploy.py`의
  `DEV_FRONT_RELAY_NGINX_CONF`)를 지난다. relay는 이 버킷의 `photos/<소문자 UUID>.jpg`와 메서드에 맞는
  Get/Put/DeleteObject(또는 query 없음)만 그대로 전달하고, 그 밖은 403이다. 서명·인증은 MinIO가 판정한다.
- 앱 env: `POD_PHOTOS_S3_ENDPOINT=http://<front_subnet의 +11>:8081/`, `POD_PHOTOS_S3_BUCKET=pieceofdays-photos-dev`,
  `POD_PHOTOS_INTERNAL_DEV_HTTP=1`과 region·access key·secret. helper와 앱 parser가 정확한 형태만 허용한다.

## 적용 순서(main, 예시 명령. 별칭·값은 비공개)

```sh
# 먼저 대상 버킷·계정·정책이 없는지 확인한다. 이미 있으면 키를 덮어쓰지 말고 기존 기록을 대조한다.
mc mb <alias>/pieceofdays-photos-dev
mc anonymous set none <alias>/pieceofdays-photos-dev
mc admin policy create <alias> pieceofdays-photos-dev-rw infra/minio/pieceofdays-photos-dev-policy.json
mc admin user add <alias> <dev-app-access-key> "$POD_PHOTOS_S3_SECRET_ACCESS_KEY"
mc admin policy attach <alias> pieceofdays-photos-dev-rw --user <dev-app-access-key>
```

위 비밀 변수는 main 전용 실행기가 비공개 env로 전달한다. 값을 명령 원문/로그에 넣거나 로그인용 CLI 셸에 export하지 않는다.

적용 뒤 확인한다: 익명 GET/PUT 거부, 다른 버킷 거부, `photos/` 밖 접두 거부, 없는 키 GET = NoSuchKey,
전용 smoke 객체의 PUT→GET→DELETE. smoke 객체는 즉시 지운다.

## 복귀

정책 detach·사용자 비활성으로 앱 접근을 끊는다. 사용자 사진·버킷은 지우지 않는다. NAS 백업에 남은
사본을 앱 삭제 완료로 간주하지 않는다. helper·env 복귀 순서는 PLAN §3을 따른다.
