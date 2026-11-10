# 개발 사진 gateway 제안

`dev-private-photos.conf`는 기존 개발 `server` 안에 넣는 검토용 location 조각이다. 독립 server/http 설정이 아니며, `services-enabled`에 그대로 배치하거나 저장소 push만으로 자동 설치하지 않는다. 실제 적용은 [제안 계획](../../../docs/plans/PLAN_private-photo-gateway-proposal.md)의 운영 경계를 따른다.

기존 `$pieceofdays_dev_web` upstream 변수·server Basic/IP 제한과 보안 헤더 include가 전제다. 두 location은 보안 헤더를 재선언하지 않으며, upstream의 `X-Content-Type-Options`만 숨겨 기존 server의 `nosniff always` 한 값을 상속한다. 이 전제가 다른 설정에 재사용하지 않는다.

격리 front CI는 이 파일 원문과 SHA256을 실제 nginx fixture에 연결한다. 실제 설치 전에는 동결 원본·기존 header include·정확 diff·복귀 자료를 대조하고 실제 nginx 검사·reload 후 HTTPS/전체 로그를 별도로 확인한다. 운영 domain·TLS·다른 서비스·실제 저장소/DB·앱 활성화는 이 파일에 포함되지 않는다.
