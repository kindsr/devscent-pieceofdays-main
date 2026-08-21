# pieceofdays 배포 구성 (준비중 단계)

> 전체 워크플로우는 `~/server-runbook/15_DEV_PROD_WORKFLOW_RUNBOOK.md` 참고.

## 현재 상태 (2026-08-20)

| 구분 | 도메인 | 내용 | 소스 |
|---|---|---|---|
| 운영 | https://pieceofdays.com | 정적 "준비중" 페이지 (`pieceofdays-comingsoon`) | `~/projects/devscent-pieceofdays-main` (master) |
| 운영(보조) | https://pieceofdays.co.kr (+www), https://www.pieceofdays.com | 301 → https://pieceofdays.com | nginx conf 에서 처리 |
| 개발 | https://dev.pieceofdays.com | dev 스택 (`pieceofdays-frontend-dev`, 자동배포) | `~/development/devscent-pieceofdays-main` (dev) |

- 두 스택 모두 호스트 포트 게시 없음 — 공용 nginx → `edge` 네트워크로만 접근.
- nginx conf: `/opt/infra/nginx/conf/services-enabled/99-pieceofdays.conf`, `99-pieceofdays-dev.conf`
  (원본은 이 디렉터리의 동명 파일).

## 도메인 정책 (canonical: pieceofdays.com)

- `pieceofdays.com` 을 canonical 도메인으로 사용한다.
- `pieceofdays.co.kr`(+www), `www.pieceofdays.com` 은 nginx 에서
  `301 https://pieceofdays.com$request_uri` 로 경로/쿼리를 보존한 채 리다이렉트한다.
- 이유: 중복 콘텐츠 방지(SEO), 세션/쿠키 도메인 단일화, 분석·로그 단일화,
  OAuth 콜백 등 외부 연동 URI 단순화.
- 인증서는 도메인별 2장 (`pieceofdays.com` = com+www / `pieceofdays.co.kr` = co.kr+www)
  으로 발급해 갱신 실패 영향을 서로 분리한다. 갱신은 공용 certbot 크론이 일괄 처리.

## 운영(준비중 페이지) 배포

```bash
cd ~/projects/devscent-pieceofdays-main
docker compose up -d
```

준비중 페이지 내용 수정은 `deploy/comingsoon/html/index.html` 편집 후 커밋만 하면 됨
(볼륨 마운트라 컨테이너 재시작 불필요).

## dev 배포

`~/development/devscent-pieceofdays-main` 에서 `dev` 브랜치에 push → 1분 내 자동배포.
로그: `~/development/ops/dev_autodeploy.log` / 빌드 로그: `dev_autodeploy.build.log`

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

## 실서비스 전환 시 (개발 완료 후)

1. `docker-compose.yml` 을 실제 앱 스택(web/api, loopback 포트는 `04_PORT_EXPOSURE_POLICY.md` 에서 확정)으로 교체
2. `deploy/nginx/99-pieceofdays.conf` 의 proxy 대상을 앱 컨테이너로 변경 후 재설치
   (canonical/리다이렉트 블록 구조는 그대로 유지)
3. `pieceofdays-comingsoon` 컨테이너 제거, 운영 문서(`02_SERVICE_INVENTORY.md` 등) 갱신
