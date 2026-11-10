# PLAN — 개발 사진 경로의 외곽 gateway 제안

- 상태: 검토 가능한 공개 source snippet·비공개 정확 diff 준비 완료, 후보 CI 검증 단계. 실제 shared nginx·TLS·서버 변경0, 운영 domain/production 변경0.
- 선행 source: 사진 앱b0e4039, helper/front 후보6d98f25. 기존 [사진 계획](PLAN_private-photo-moments.md)의 inner 경계와 구분한다.
- 이유: main이 실제 개발 gateway 파일을 읽었고 사진 전용 location은 아직 없었다. generic upstream은 이미 `$pieceofdays_dev_web`다. 실제 상속 body limit·전체 chain 동작은 미검증이며 inner9MiB/로그0를 outer 준비 완료로 세지 않는다.

## 1. review 가능한 최소 제안

- 공개 가능한 신규 source snippet `deploy/nginx/snippets/dev-private-photos.conf`에 정확 두 location만 둔다: `= /photos/upload`는9m, `^~ /photos/`는1m. 각 access_log off·error_log /dev/null crit. 기존 `$pieceofdays_dev_web`·generic proxy 헤더/timeout을 재사용한다. source config와 시험 하네스를 분리하며 실제 서버에 자동 설치되는 파일은 아니다.
- Basic/IP·server headers·upstream 변수 정의·기존 callback exact2/단일 no-referrer·callback safe JSON·generic/static·다른 domain·TLS는 바꾸지 않는다. 사진 location에 add_header를 추가해 기존 server 보안 header 상속을 끊지 않는다.
- 실제11341f7 CI의 사진401 응답에서 앱과 outer server의 `X-Content-Type-Options`가 겹쳐 `nosniff, nosniff`로 관측됐다. 사진 두 location은 정확 `proxy_hide_header X-Content-Type-Options;` 한 개씩만 사용해 upstream 중복을 제거하고 기존 server의 `nosniff always` 한 값을 상속한다. 다른 hide·보안값 변경은 허용하지 않으며 단일nosniff 검사는 유지한다. main이 실제 include의해당지시문과hash를읽기확인했고실제반영직전동일성을다시확인한다.
- main은 실제 동결 config의 SHA256과 generic proxy block을 대조해 비공개 제안 사본/정확 diff를 준비한다. 공개 repo에 실제 경로·포트·자격을 싣지 않는다. 제안이 검토됐다는 이유로 실제 파일을 적용하거나 reload하지 않는다.

## 2. RED와 후보 검증

- 기존 front14 관련 사례 내부에 outer→front→observer의 정확9MiB 길이/hash·chunked/초과413·사진prefix1m, 실Next 로그인/Origin 거부·앱중단502를 추가한다. 사진 id/query/referer/cookie marker의 outer·front 정상/거부/장애 로그0와 기존 sink별 양성 대조를 확인한다. 외곽 Basic/IP 거부에서도 사진 marker0을 요구한다.
- RED는 아직 snippet을 포함하지 않는 기존 outer fixture에서 요청이 막히거나 marker가 기록되는 의도 실패를 먼저 확인한다. 시험 작성자는 source snippet의 optional loader만 준비하며 부재 시 원outer를 유지하고 명시hash assert로 실패한다. 그 뒤 별도 작성자가 source snippet만 추가한다. 원callback fragment의 바이트/hash와 기존 단언은 보존한다.
- 예측14건을 새 성공으로 선언하지 않는다. 같은 immutable image의 image6·front14·원문preview10을 실제 CI에서 확인하고 source/runner 독립 검토를 거친다. fixture는 공개 snippet을 원문으로 사용하고 hash를 대조한다.

### 준비와 관측 근거

- 관측RED ca8a02f의 [CI42883415502](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42883415502)는 front14=9pass/5fail·skip0, image6/원문preview10 PASS였다. missing hash·사진 로그·nosniff 중복은 모두 미구현 실패이며 선행 실패 뒤9MiB 등은 미도달로 구분했다. 앞선113의 hide 전면금지/단일nosniff 충돌은 별도 기록하고 정확hide1개만 허용하도록 고쳤다.
- 후속 d8f085c는 경로/optional loader 준비다. 후보가 없으면 기존 outer bytes와 missing-hash 실패가 유지되며 행위 단언은 바꾸지 않았다. 이 준비 commit을 관측된 RED head라고 보고하지 않는다.
- 공개 source snippet은35줄·SHA256 `cd87bde7055d11f07abbb3c08b9d2a70fb0437ecc30b9d992ef1c9a4a7c47b77`이다. 독립 source 검토에서 정확 두 location과 기존 proxy11개·인증/IP/헤더 상속 보존을 확인했다. 실제 include의 `nosniff always` 유지가 필수 전제이며, 실제 적용 전 원본/include hash를 다시 확인한다.
- main은 비공개 동결 원본과 제안 사본·정확 diff를 준비했다. 삽입한 두 블록을 제거하면 원본 bytes가 정확히 복원되고, 들여쓰기 외 공개 snippet 내용은 같다. 실제 파일 변경·nginx 검사/reload·전체 HTTPS 검증은 아직0이다.
- f45ced8의 outer/front 및 image CI는 각각6/14/원문10을 끝까지 통과했다. 별도 앱 auth는 기존UUID/RSC의 browser_finished 단계 ERR_ABORTED로40pass/1fail이므로 전체GREEN으로 세지 않는다. 공식 Playwright source에서 decoded body와 원본 프레이밍 헤더가 함께 전달되는 경로를 확인해 시험 한 사례의 프레이밍만 보완한다. 기존 완료/보안 단언은 유지하고 실제 취소 원인은 미확정으로 남기며 후속 같은SHA CI로 판정한다.

## 3. 실제 반영 경계

- 현재 프로젝트 AGENTS §3은 다른 서비스·공용 nginx·TLS를 임의로 바꾸지 않도록 한다. 이 단계는 실제 반영 전 구체 검토 자료만 준비한다. 실제 shared gateway의 개발 vhost 두 location 추가는 main이 적용 권한을 확인한 뒤 별도 진행한다.
- 실제 적용 때에는 동결 원본/hash·정확 delta·`nginx -t`·reload 후 새 연결 안정 확인·전체 chain 합성 marker 로그 검증과 복귀 자료가 필요하다. 이 문서는 해당 명령의 실행 허가나 완료 증거가 아니다.
- 실제 S3 HTTPS/전용 bucket·자격/삭제 소비·DB0003/0004·승인 상한·Google B5/실기기/활성화는 여전히 별도다. dev 정적/OFF·dev/main push 보류를 유지한다.
