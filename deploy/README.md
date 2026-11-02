# pieceofdays GitHub Actions 배포

2026-11-02 사용자 승인으로 이 서비스는 GitHub dev/main 자동배포를 사용한다. 공통 수동 운영 배포 규칙의 서비스별 예외다.
전환 계획과 수락 기준은 [PLAN](../docs/plans/PLAN_github-actions-deployment.md)이다. 아래 기록은 구축 계약이며 실제 성공은 Actions 실행·서버 기록·HTTPS로 판정한다.

## 반영 흐름

1. GitHub 작업 브랜치에서 개발하고 `dev`에 반영한다.
2. `dev` push가 Actions의 검사와 개발 배포를 실행한다. 개발 경로는 `~/development/devscent-pieceofdays-main`, URL은 `https://dev.pieceofdays.com`이다.
3. 개발 검증을 마친 `dev`를 PR로 `main`에 병합한다. Actions가 운영 배포를 실행하며, 서버는 해당 소스 tree가 성공한 개발 배포와 같은지 확인한다.
4. 운영 실행 자료는 `~/deployment/pieceofdays`에 둔다. 소스 bind mount 없이 고정 이미지로 `pieceofdays.com`을 제공한다.

앱은 아직 없으며 현재 준비중/개발 안내 페이지를 배포한다. 개발·운영 Compose project는 각각 `pieceofdays-dev`·`devscent-pieceofdays-main`, 컨테이너는 기존 이름을 유지한다.

## 서버와 GitHub 설정

- GitHub 정본: `https://github.com/kindsr/devscent-pieceofdays-main.git`(2026-11-02 `kindsr/pieceofdays`에서 이름 변경). 서버의 두 체크아웃 origin과 설치된 배포 프로그램의 `REPOSITORY`도 같은 주소여야 한다.
- GitHub 호스팅 러너만 사용한다. 배포 job은 `dev` 또는 `production` 환경을 선택하며 각 환경은 `dev`·`main` 브랜치에만 허용된다.
- 각 환경의 `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY`는 GitHub Secrets에 둔다. 값은 문서에 적지 않는다.
- 서버 키는 환경별로 분리하고 `authorized_keys`에서 `restrict`와 고정 환경 강제 명령을 건다. PTY·포워딩·일반 쉘을 제공하지 않는다.
- 검토한 `scripts/ops/deploy.py`만 `~/deployment/bin/pieceofdays-deploy.py`에 설치한다. 설정은 `~/deployment/pieceofdays/deploy.json`이며 후보 저장소가 설치본을 자동 갱신하지 않는다.
- 배포 프로그램은 서비스 공통 파일 잠금 안에서 SHA·tree·상태를 검사한다. 실행 Compose는 신뢰된 프로그램이 생성하며 다른 서비스·호스트 마운트·포트·특권을 허용하지 않는다.
- 기존 1분 폴링 목록의 pieceofdays 한 줄만 제외한다. 공유 크론·다른 서비스는 유지한다.

## 최초 전환과 복귀

- 전환 전 Git 번들·현행 이미지 ID·Compose·서빙 HTML 해시를 `~/backups/pieceofdays/github-actions-20261102T124526Z/`에 보관했다.
- 운영 HTML은 기존 nginx base 위에 COPY한 독립 복귀 이미지를 준비하고, dev는 기존 실행 이미지로 동결한 bootstrap 기록을 사용한다. 첫 교체 전에 복귀 자료가 없으면 배포를 거부한다.
- 이미지 교체 후 health·HTTPS 본문·이미지 ID가 일치해야 성공한다. 실패하면 직전 동결 Compose/이미지로 복귀하고 복귀 자체도 검증한다.
- `~/projects`에서 `docker compose up/build/pull`로 운영을 직접 변경하지 않는다. 자동 배포와 수동 작업의 경합을 만들지 않는다.
- DB·migration은 현재 없다. 앱·DB를 추가할 때는 백업·확장/수축 migration·호환성 관문을 먼저 설계한다.

## 도메인과 인증서

canonical은 `pieceofdays.com`이며 `.co.kr`(+www)·`www.pieceofdays.com`은 경로·쿼리를 보존한 301이다.
dev는 접근 제한+noindex다. nginx upstream 이름을 유지하므로 이번 전환에서 DNS·TLS·공용 nginx 설정을 바꾸지 않는다.
운영 nginx dev conf의 `security-headers.inc` 차이는 별도 현황이며 이번 원격 전환에 섞지 않는다.

아래 절은 초기 발급 기록이다. 자동 배포는 인증서 발급이나 nginx 설정 복사를 실행하지 않는다.

## 인증서 발급 절차 (기록)

```bash
# 운영 도메인 2장
docker run --rm -v /opt/infra/nginx/certbot/www:/var/www/certbot \
  -v /opt/infra/nginx/certbot/conf:/etc/letsencrypt certbot/certbot \
  certonly --webroot -w /var/www/certbot \
  -d pieceofdays.com -d www.pieceofdays.com --non-interactive --agree-tos

docker run --rm -v /opt/infra/nginx/certbot/www:/var/www/certbot \
  -v /opt/infra/nginx/certbot/conf:/etc/letsencrypt certbot/certbot \
  certonly --webroot -w /var/www/certbot \
  -d pieceofdays.co.kr -d www.pieceofdays.co.kr --non-interactive --agree-tos

# dev 도메인
docker run --rm -v /opt/infra/nginx/certbot/www:/var/www/certbot \
  -v /opt/infra/nginx/certbot/conf:/etc/letsencrypt certbot/certbot \
  certonly --webroot -w /var/www/certbot -d dev.pieceofdays.com --non-interactive --agree-tos
```

발급 후 부트스트랩 conf → 풀 conf 교체 (services-enabled 는 root 소유 → nginx 컨테이너 경유):

```bash
cd ~/projects/devscent-pieceofdays-main
docker cp deploy/nginx/99-pieceofdays.conf nginx:/etc/nginx/conf.d/services-enabled/99-pieceofdays.conf
docker cp deploy/nginx/99-pieceofdays-dev.conf nginx:/etc/nginx/conf.d/services-enabled/99-pieceofdays-dev.conf
docker exec nginx chown 1000:1000 /etc/nginx/conf.d/services-enabled/99-pieceofdays.conf /etc/nginx/conf.d/services-enabled/99-pieceofdays-dev.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```
