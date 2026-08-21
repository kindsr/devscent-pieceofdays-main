# 신규 서비스 도메인 초기 구성 프롬프트 (준비중 페이지 + dev 도메인)

> **용도**: 화면설계까지 끝난(아직 앱 코드가 없는) 신규 서비스에서,
> 운영 도메인에는 "준비중" 페이지를 띄우고 `dev.<도메인>` 개발 환경을 연결하는
> 일련의 구조를 한 번에 구성한다.
>
> **사용법**: 아래 프롬프트 블록의 `<...>` 플레이스홀더를 채운 뒤,
> 해당 프로젝트 루트(`~/projects/devscent-<서비스명>-main`)에서 Claude Code 에 붙여넣는다.
>
> **전제 조건**:
> 1. 레포가 `~/projects/devscent-<서비스명>-main` 에 존재하고 origin(사내 git) 이 설정돼 있다.
> 2. 운영 도메인 A 레코드(apex, 필요시 www)가 서버 고정 IP를 가리킨다.
>    (`dev.<도메인>` A 레코드는 나중에 등록해도 됨 — 등록 전까지 HTTP 부트스트랩으로 대기)
> 3. 공용 인프라: nginx(`/opt/infra/nginx/`), Docker `edge` 네트워크, certbot 갱신 크론.
>
> **참조 구현**: `~/projects/devscent-match-main` (matseon.com, 2026-08-20 구성)
> **절차 원본**: `~/server-runbook/15_DEV_PROD_WORKFLOW_RUNBOOK.md` §7 (새 프로젝트 dev 환경 추가)

---

## 프롬프트 (복사해서 사용)

```
신규 서비스의 도메인 초기 구성을 해줘. 현재 이 프로젝트는 화면설계까지 끝났고 앱 코드는
아직 없는 상태다. 운영 도메인에는 "준비중" 페이지를 띄우고, dev 도메인으로 개발 진행 상황을
확인할 수 있게 해줘.

## 파라미터
- 서비스명(짧은 이름, 컨테이너/컨피그 접두사): <서비스명>        (예: matseon)
- 운영 도메인: <도메인>                                          (예: matseon.com)
- www 포함 여부: <yes/no>
- dev 도메인: dev.<도메인>
- nginx conf 번호: <NN>  (/opt/infra/nginx/conf/services-enabled/ 에서 비어있는 번호 확인)
- 서비스 한 줄 소개(준비중 페이지 문구용): <소개 문구>

## 준수 사항 (프로젝트 CLAUDE.md + 운영 정책)
- 기존 서비스 nginx conf 수정 금지 — 신규 파일만 추가한다.
- 호스트 포트 게시 없음: 두 스택 모두 edge 네트워크 전용 (0.0.0.0 바인딩 금지).
- docker compose down/restart 금지 — 신규 컨테이너 up 과 nginx reload 만 사용.
- 참조 구현 ~/projects/devscent-match-main 의 파일 구조/패턴을 그대로 따른다.
- 절차 상세는 ~/server-runbook/15_DEV_PROD_WORKFLOW_RUNBOOK.md §7 을 따른다.

## 작업 순서

### 1. 레포 파일 생성 (master)
- deploy/comingsoon/html/index.html — 준비중 페이지.
  docs/02_DESIGN_GUIDE*.md 의 디자인 토큰(다크 배경 #08090c, 전경 #e6e4df, 민트 #34d399)을
  따르고, 서비스명과 소개 문구를 넣는다. <meta name="robots" content="noindex, nofollow"> 필수.
- docker-compose.yml — <서비스명>-comingsoon (nginx:stable-alpine, 위 html 을 :ro 볼륨 마운트,
  edge external 네트워크, expose 80, 호스트 포트 없음, healthcheck).
- frontend/Dockerfile + frontend/public/index.html — dev 플레이스홀더 정적 페이지
  (DEV ENVIRONMENT 배지 + "dev 브랜치 push 시 1분 내 자동배포" 안내, noindex).
- docker-compose.dev.yml — <서비스명>-frontend-dev (build ./frontend, edge 전용, expose 80).
- deploy/nginx/ 에 conf 원본 4종:
  - <NN>-<서비스명>.conf            (HTTP: ACME + https 리다이렉트 / HTTPS: comingsoon 프록시)
  - <NN>-<서비스명>-http-bootstrap.conf       (인증서 발급 전용 HTTP 블록)
  - <NN>-<서비스명>-dev.conf        (HTTPS 에 접근제한: satisfy any + allow 본인IP +
    allow 192.168.0.0/16 + deny all + basic auth dev.htpasswd + X-Robots-Tag noindex.
    기존 *-dev.conf 에서 allow IP 를 복사)
  - <NN>-<서비스명>-dev-http-bootstrap.conf
- deploy/README.md — 배포 절차, dev HTTPS 활성화(DNS 등록 후) 절차, 실서비스 전환 절차.
- CHANGELOG.md [Unreleased] 에 기록 후 master 커밋·푸시.

### 2. 운영 준비중 페이지 기동
- docker compose up -d → edge 내부에서 <서비스명>-comingsoon 응답 확인
  (docker run --rm --network edge busybox wget -q -O - http://<서비스명>-comingsoon:80/).

### 3. 공용 nginx 연결 + 인증서
- 부트스트랩 conf 2종을 nginx 컨테이너 경유로 설치:
  docker cp → docker exec nginx chown 1000:1000 → nginx -t → nginx -s reload.
- certbot 발급 (08 런북 §7-8 명령): -d <도메인> [-d www.<도메인>].
- 성공하면 풀 conf 로 교체 후 reload. 검증: http→https 301, https 200, 준비중 페이지 타이틀.
- dev.<도메인> DNS 가 아직 없으면: dev 는 부트스트랩 상태로 두고 잔여 작업으로 보고.
  DNS 가 있으면 dev 인증서 발급 + 풀 conf 교체까지 진행.

### 4. dev 환경 구성 (08 런북 §7)
- ~/development/ 에 클론, dev 브랜치 생성·푸시.
- docker compose --project-directory ~/development/devscent-<서비스명>-main
  -f docker-compose.dev.yml -p <서비스명>-dev up -d --build → edge 내부 응답 확인.
- 자동배포 등록 — 순서 중요:
  1) git rev-parse origin/dev > ~/development/ops/.state/<서비스명>.deployed  (상태 시드 먼저)
  2) ~/development/ops/dev_autodeploy.projects 에 한 줄 추가:
     <서비스명>|~/development/devscent-<서비스명>-main|dev|docker-compose.dev.yml|<서비스명>-dev
- 다음 크론 틱에서 dev_autodeploy.log 에 에러 없는지 확인.
- (DB 는 앱 개발 착수 시 §7-5 대로 생성 — 이 단계에서는 만들지 않는다.)

### 5. 운영 문서 갱신
- ~/server-runbook/02_SERVICE_INVENTORY.md 정식 등록 표에 2행(준비중 페이지 / dev) + 비고 추가.
- ~/server-runbook/03_OPS_CHANGELOG.md 에 오늘 날짜 항목(커밋 해시, 검증 결과, 잔여 작업 포함).
- ~/server-runbook/15_DEV_PROD_WORKFLOW_RUNBOOK.md §2 서비스 표에 dev 도메인 행 추가.
- 호스트 포트를 안 쓰므로 04_PORT_EXPOSURE_POLICY.md 할당은 불필요(신규 포트 생기면 그때 등록).

### 6. 완료 보고
- 확인 URL, 컨테이너 상태, 커밋 해시.
- 잔여 작업(예: dev DNS A 레코드 등록 → deploy/README.md 절차 실행)을 명시.
```

---

## 이후 단계 메모

- **앱 개발 착수 시**: `docker-compose.dev.yml` 의 플레이스홀더를 실제 앱(web/api)으로 교체하고
  dev 브랜치에 push 하면 자동배포가 이어진다. DB 는 08 런북 §7-5(createdb + 덤프) 참조.
- **정식 오픈 시**: `docker-compose.yml` 을 실제 앱 스택으로 교체(호스트 포트가 필요하면
  `04_PORT_EXPOSURE_POLICY.md` 에서 loopback 포트 확정), nginx conf 의 proxy 대상 변경,
  comingsoon 컨테이너 제거, 운영 문서 갱신.
