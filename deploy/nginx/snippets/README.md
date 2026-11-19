# 개발 사진 gateway 제안

`dev-private-photos.conf`는 기존 개발 `server` 안에 넣는 검토용 location 조각이다. 독립 server/http 설정이 아니며, `services-enabled`에 그대로 배치하거나 저장소 push만으로 자동 설치하지 않는다. 실제 적용은 [제안 계획](../../../docs/plans/PLAN_private-photo-gateway-proposal.md)의 운영 경계를 따른다.

기존 `$pieceofdays_dev_web` upstream 변수·server Basic/IP 제한과 보안 헤더 include, 상위(http) 수준의 `proxy_hide_header` 5개(`X-Powered-By`·`X-Frame-Options`·`X-Content-Type-Options`·`Referrer-Policy`·`Strict-Transport-Security`)가 전제다. 두 location은 보안 헤더를 재선언하지 않고 `proxy_hide_header`도 두지 않는다. nginx는 같은 단계에 `proxy_hide_header`가 하나라도 있으면 상위 목록 전체를 상속하지 않으므로, 상위 5개 hide를 그대로 상속해 upstream 값·배너를 숨기고 기존 server의 보안 헤더 한 값씩만 내보낸다. 이 전제를 다른 설정에 재사용하지 않는다.

이전 판(35줄, SHA256 `cd87bde7…7b77`)은 각 location에 `proxy_hide_header X-Content-Type-Options;` 한 줄을 두었다. 이 local 선언이 상위 5개 상속을 끊어 upstream의 `X-Frame-Options` 등이 중복·노출될 수 있어 삭제했다. 현재 판은 정확 두 location의 33줄이다.

격리 front CI는 이 파일 원문과 SHA256을 실제 nginx fixture에 연결한다. 실제 설치 전에는 동결 원본·기존 header include·정확 diff·복귀 자료를 대조하고 실제 nginx 검사·reload 후 HTTPS/전체 로그를 별도로 확인한다. 운영 domain·TLS·다른 서비스·실제 저장소/DB·앱 활성화는 이 파일에 포함되지 않는다.
