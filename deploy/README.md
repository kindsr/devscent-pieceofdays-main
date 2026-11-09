# pieceofdays GitHub Actions 배포

2026-11-02 사용자 승인으로 이 서비스는 GitHub dev/main 자동배포를 사용한다. 공통 수동 운영 배포 규칙의 서비스별 예외다.
전환 계획과 수락 기준은 [PLAN](../docs/plans/PLAN_github-actions-deployment.md)이다. 아래 기록은 구축 계약이며 실제 성공은 Actions 실행·서버 기록·HTTPS로 판정한다.

이 문서는 공개 저장소용 요약이다. 서버 경로·설정 파일·설치·접속·백업·인증서·프록시의 상세 운영 절차는
비공개 운영 문서가 정본이며 메인 담당이 관리한다. 이 저장소에 서버 내부 값을 다시 적지 않는다.

## 반영 흐름

2026-11-08 [PR70](https://github.com/kindsr/devscent-pieceofdays-main/pull/70)의 C1 이미지 게시 소스를 통합하고 [실제 dev 게시](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42484654242)를 완료했다. 같은 SHA의 필수 앱 검사와 같은 이미지 ID의 이미지6·프런트14·preview10, 실제 push·raw manifest/config 검증·logout·최종5outputs를 확인했다. 서버에서도 익명 full pull·manifest 생바이트 hash/config·이미지 라벨을 대조했다. **현재 개발 배포는 계속 정적 방식**이다. 전용 DB migration 2·앱 역할 접속·검토 helper 설치·dev 외곽 콜백 반영을 완료했으며, OAuth 설정과 최종 환경·실제 앱 콜백 검증 뒤 별도 [C2 PR72](https://github.com/kindsr/devscent-pieceofdays-main/pull/72)에서 앱으로 전환한다. PR72의 source/CI PASS를 실제 dev 활성화 성공으로 세지 않는다.

1. GitHub 작업 브랜치에서 개발하고 `dev`에 반영한다.
2. `dev` push가 Actions의 검사와 개발 배포를 실행한다. URL은 `https://dev.pieceofdays.com`이다.
3. 개발 검증을 마친 `dev`를 PR로 `main`에 병합한다. Actions가 운영 배포를 실행하며, 서버는 해당 소스 tree가 성공한 개발 배포와 같은지 확인한다.
4. 운영은 소스 bind mount 없이 서버의 릴리스 영역에 둔 고정 이미지로 `https://pieceofdays.com`을 제공한다.

`app/`에 앱·DB 기반이 있지만 현재 배포는 준비중/정적 시안 페이지다. 개발 정적 이미지에는 `frontend/public/try/`의 브라우저 저장 체험판(`/try/`)이 같은 이미지·같은 `COPY public`으로 함께 들어간다. 기록은 사용자 브라우저에만 저장되며 서버 DB·secret·포트·Compose·배포 권한·절차·복귀는 바뀌지 않는다. 체험판의 독립 검토 PASS를 수락했으며 dev 자동배포·실제 게시 검증은 PR43에 기록한다. 앱 배포 전환은 F6에서 별도로 검토한다. 개발·운영 Compose project는 각각 `pieceofdays-dev`·`devscent-pieceofdays-main`, 컨테이너는 기존 이름을 유지한다.

## GitHub와 배포 경계

2026-11-08 F6b: [PR60](https://github.com/kindsr/devscent-pieceofdays-main/pull/60)의 dev 앱 전용 `deploy-app`·`revert-static` 소스와 환경 검사 CI를 통합했다. 독립 검토 PASS와 배포 계약 106개·Node 환경 대조 29개 통과를 수락했다. 메인이 원본을 보존하고 검토된 helper를 설치해 dev·production probe를 확인했다. 실제 배포 설정과 실행 컨테이너는 그대로이며 앱 전환은 C2에서 별도로 진행한다.

- GitHub 정본: `https://github.com/kindsr/devscent-pieceofdays-main.git`(2026-11-02 `kindsr/pieceofdays`에서 이름 변경). 서버 체크아웃 origin과 설치된 배포 프로그램의 `REPOSITORY`도 같은 주소여야 한다.
  F6a2는 2026-11-08 [PR65](https://github.com/kindsr/devscent-pieceofdays-main/pull/65)의 실제 격리 nginx/Next·콜백 fixture·기록 보존 검사로 통합했다(이미지6·프런트14·원문 preview10, skip0). 서버 설치·실제 외곽 설정 반영·앱 전환은 이 CI와 별도다.
- GitHub 호스팅 러너만 사용한다. 배포 job은 `dev` 또는 `production` 환경을 선택하며 각 환경은 `dev`·`main` 브랜치에만 허용된다.
- 접속 정보와 키는 환경별 GitHub Secrets에 둔다. 값은 문서에 적지 않는다. PR 검사에는 배포 키가 없다.
- 서버 키는 환경별로 분리하고 고정 환경 강제 명령으로 제한한다. 일반 쉘을 제공하지 않는다.
- 검토한 `scripts/ops/deploy.py`만 작업 트리 밖에 설치한다. 저장소 수정은 설치본을 자동 갱신하지 않으며, 설치본 반영은 메인이 검토·검증 후 별도로 한다.
- 배포 프로그램은 서비스 공통 파일 잠금 안에서 SHA·tree·상태를 검사한다. 실행 Compose는 신뢰된 프로그램이 생성하며 다른 서비스·호스트 마운트·포트·특권을 허용하지 않는다.

## 복귀

- 이미지 교체 후 health·HTTPS 본문·이미지 ID가 일치해야 성공한다. 실패하면 직전 동결 Compose/이미지로 복귀하고 복귀 자체도 검증한다.
- 첫 교체 전에 복귀 자료가 없으면 배포를 거부한다. 전환 전 동결 자료는 서버 밖으로 공개하지 않는다.
- 소스 작업 체크아웃에서 `docker compose up/build/pull`로 운영을 직접 변경하지 않는다. 자동 배포와 수동 작업의 경합을 만들지 않는다.
- 개발 전용 DB는 게시된 고정 이미지로 migration `status→up→status`를 완료해 버전 2를 확인했다. 사용자 선택은 C 등급(기록 손실 허용·복구 시간 보장 없음)이며 첫 야간 백업 포함·로컬 checksum 일치·NAS 검증 성공 로그를 확인했다. 복원은 미실행이다. 자동 배포는 migration을 실행하지 않고 저장소 승인 상한과 이미지 버전을 대조한다. 운영 DB·앱 전환은 이번 범위가 아니다.

## 도메인

canonical은 `pieceofdays.com`이며 `.co.kr`(+www)·`www.pieceofdays.com`은 경로·쿼리를 보존한 301이다.
dev는 접근 제한+noindex다. 자동 배포는 DNS·TLS·공용 프록시 설정을 바꾸거나 인증서를 발급하지 않는다.
저장소의 `deploy/nginx/` 파일은 초기 구성 원본이며, 설치·발급 절차는 비공개 운영 문서를 따른다.
