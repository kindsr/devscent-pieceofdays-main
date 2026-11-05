# PLAN — F6-dev: 개발 도메인에 Next 앱 배포 (S4)

- **상태:** 계획 초안(2026-11-05)이다. 메인 검토·수락 전이다. 이 문서는 코드·CI·Compose·배포 프로그램·서버를 바꾸지 않았고 권한을 늘리지 않는다.
- **BASE:** `dev` `e49b0c3ad79a32f16f8f33ca003aef9b57f43540`(작성자가 fetch로 확인). 함께 읽은 것: PR46 HEAD `6034fdf209ed716cb0079971beb327b8d019786d`의 [실사용 전환 계획](https://github.com/kindsr/devscent-pieceofdays-main/blob/6034fdf209ed716cb0079971beb327b8d019786d/docs/plans/PLAN_dev-usable-app.md) §6·§8과 `PLAN_dev-diary-actions.md`(PR46 독립 재검토 중이며 수정하지 않는다).
- **범위:** [실사용 전환 계획](https://github.com/kindsr/devscent-pieceofdays-main/blob/6034fdf209ed716cb0079971beb327b8d019786d/docs/plans/PLAN_dev-usable-app.md)의 S4(F6-dev)다. 운영(main) 앱 전환, 공용 nginx·TLS·다른 서비스 변경은 범위 밖이다.
- **표기:** [사실] 코드로 확인 / [메인] 메인이 준 확정 제약 / [제안] 이 계획의 선택(검토 필요) / [미확인] / [미정]
- **논리 키 표기:** 서버 내부 경로·계정·네트워크 실명·키는 공개 문서에 쓰지 않는다. 아래 `‹…›`는 비공개 런북이 값을 갖는 논리 키다.

## 1. 현재 사실 [사실]

**`scripts/ops/deploy.py`(설치본은 저장소 밖, 메인이 수동 반영)**

- **명령:** `probe <env>`, `deploy <dev|production> <40hex>`. 키별 `--allowed-environment`와 다른 env를 요청하면 거부한다.
- **Compose 허용 범위:** 서비스 1개, `expose ["80"]`, 고정 `HEALTH`(`wget http://127.0.0.1:80/`), `edge` 외부 네트워크만 쓴다. hardening 값도 고정이다.
- **빌드:** 저장소 Dockerfile 내용이 `FROM nginx:stable-alpine` + `COPY <dir>/ …`과 정확히 같아야 한다. 그다음 helper 자체 신뢰 Dockerfile로 `docker build --network=none --pull`한다.
- **배포 순서:**
  1. 후보 컨테이너를 `--network none --read-only`로 확인
  2. 릴리스 기록 `{sha, tree, image_id, serving_html_sha256, compose_path, compose_sha256}` 작성
  3. pending 기록 → 교체 → HTTPS 본문 해시 확인
  4. 실패하면 직전 기록으로 복귀
- **운영 승격:** `dev-current.json`이 같은 tree로 성공한 경우에만 허용한다.
- **현재 정적 런타임:** `read_only`, nginx용 `tmpfs`만 쓴다. `cap_drop`·`no-new-privileges`는 허용되지만 현재 쓰지 않는다.

**workflow·Compose·앱**

- **`.github/workflows/deploy.yml`:** `dev`·`main` push에서 계약 시험 뒤 SSH로 `probe`·`deploy`를 호출한다. 배포 job은 저장소 코드를 checkout하지 않는다.
- **`docker-compose.dev.yml`:** `pieceofdays-frontend-dev` 하나(정적 nginx, `edge`).
- **`frontend/public/`:** `index.html`, `try/`, `design/`, `promo/`.
- **`app/`:**
  - `next.config.ts`에 `output` 설정이 없다(standalone 아님). health route가 없다. `next/image`·`next/font`·원격 이미지를 쓰지 않는다.
  - 런타임에 읽는 env는 다음뿐이다:
    - 세션: `POD_AUTH_SESSION_SECRETS`, `POD_AUTH_BASE_URL`
    - 공급자: `POD_AUTH_PROVIDERS`, `POD_AUTH_GOOGLE_CLIENT_ID`·`_SECRET`, `POD_AUTH_KAKAO_CLIENT_ID`·`_SECRET`
    - 시험 전용: `POD_AUTH_MOCK_OIDC_ISSUER`, `POD_LOCAL_FIXTURE`
    - DB: `POD_DATABASE_URL`(앱), `POD_MIGRATE_DATABASE_URL`(migrate CLI만)
  - `POD_WITHDRAWAL_ENABLED`는 PR46 계획의 S2 계약이며 아직 코드에 없다.
- **`app/package-lock.json`:**
  - install script가 있는 패키지는 `fsevents`(macOS optional)뿐이다.
  - `@next/swc-linux-x64-gnu`·`-musl` 16.4.3과 `sharp` 0.35.5(optional)·`@img/sharp-linux-x64`가 lock에 있다. 그래서 `npm ci --ignore-scripts`로 설치해도 리눅스 x64 빌드에 필요한 바이너리가 lock에서 온다.
- **migrate CLI:** `node src/server/db/migrate-cli.ts`는 `POD_MIGRATE_DATABASE_URL`만 읽고 `status|up|down`을 실행한다. down은 빈 CI 전용이다.

## 2. 선택안 요약 [제안]

| 결정 | 선택 | 대안과 이유 |
|---|---|---|
| 앱 이미지 빌드 장소 | **격리 GitHub Actions runner**에서 빌드·검증. 공유 서버에서는 npm·Next build를 하지 않는다 | 서버 빌드(현행 정적 방식 확장)는 공유 호스트에서 npm·source를 실행하므로 금지 |
| 이미지 전달 | **A. SSH 스트림(권장 최소안):** CI가 `docker save` tar를 기존 dev SSH 강제 명령의 stdin으로 보낸다. helper가 크기 상한 안에서 받아 `docker load`하고, 요청한 image ID와 정확히 같은지 확인 | **B. GHCR digest pull:** content-addressed라 깔끔하지만 workflow `packages: write`와 서버의 registry pull 자격이 **새 권한**이다(현재 승인 범위 밖, 따로 승인 필요). A는 새 credential이 없다 |
| 프런트 | 기존 정적 nginx 컨테이너를 dev 앞단에 유지한다. `/try/`·`/design/`·`/promo/`·`/status/`는 지금처럼 정적으로 주고, 정해진 Next 경로만 내부 네트워크로 프록시 | Next `public/` 복사만으로는 디렉터리 index·origin 보존을 보장하지 못함(PR46 §6) |
| nginx 설정 출처 | **helper 상수**(설치본 안). 저장소의 nginx 설정을 받지 않는다 | 저장소가 프록시 규칙을 바꾸지 못하게 함 |
| 비밀값 전달 | 저장소 밖 고정 env 파일을 helper가 검사한 뒤 **Compose `secrets`(읽기 전용 파일 마운트)**로 넣고, 앱은 `node --env-file=/run/secrets/pod_app_env server.js`로 읽음 | `env_file`/`environment`는 `docker inspect` `Config.Env`에 값이 노출됨 |
| 런타임 | Next **production** standalone(`next build` 결과, `node server.js`). fixture·mock은 기존 코드가 운영 phase에서 거부 | `next dev`는 금지 |
| migration | **메인이 교체 전에** 같은 앱 이미지의 migrate 명령을 migrator 자격으로 수동 실행(`up`만). helper는 SQL·migration을 실행하지 않음 | 서버에서 source·npm 실행 없음 |

## 3. 대상 구성 (dev 앱 모드)

```
인터넷 ─HTTPS→ 공용 edge nginx(변경 없음) ─→ pieceofdays-frontend-dev (정적 nginx, :80)
                                               ├─ /try/ /design/ /promo/ /status/  → 정적 파일(지금과 같음)
                                               └─ 허용 경로만 proxy → pieceofdays-app-dev (:3000, Next production)
                                                                         ├─ ‹db_network›: 공용 PG18의 dev 전용 DB(app role만)
                                                                         └─ 앱 전용 egress bridge(OIDC 공급자 HTTPS)
```

| 컨테이너 | 네트워크 | 포트 | 실행 사용자 | 파일시스템·권한 |
|---|---|---|---|---|
| `pieceofdays-frontend-dev` | `edge`(외부, 기존) + `pieceofdays-dev-front`(`internal: true`, helper 템플릿이 생성) | expose 80, host port 없음 | nginx 기본(현행과 같음) | `read_only`, tmpfs `/var/cache/nginx`·`/var/run`(현행). `cap_drop ALL`은 nginx worker setuid와 충돌할 수 있어 이번에는 현행 유지 [미확인: unprivileged nginx 전환은 후속] |
| `pieceofdays-app-dev` | `pieceofdays-dev-front` + `‹db_network›`(외부) + `pieceofdays-dev-egress`(전용 bridge, 다른 컨테이너 없음) | expose 3000, host port 없음 | **배포 사용자의 숫자 uid:gid**(helper가 `os.getuid()/getgid()`로 고정, 0이면 거부) | `read_only: true`, tmpfs `/tmp`(size 64m, mode 1777)·`/app/.next/cache`(size 64m, 같은 uid, mode 0700), `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, volume·bind·privileged·devices 없음(secret 파일 마운트 하나만) |

- **egress:** OIDC discovery·token·JWKS 요청에 HTTPS egress가 필요하다. 전용 bridge 하나만 붙인다. 목적지를 443·공급자 호스트로 더 좁힐지(방화벽·egress proxy)는 메인 운영 결정이다 [미정].
- **DB:**
  - 공용 PG18 안의 dev 전용 database와 role 4개를 둔다: owner, migrator, app, purge. 예산은 5이고 1개는 예비다. 다른 서비스 role은 공유하지 않는다.
  - Next에는 **app role URL만** 준다.
  - migrator·owner·purge 자격은 이 컨테이너와 env 파일에 넣지 않는다.
  - PG host port는 쓰지 않는다.
  - 생성·`pod_meta.db_environment` 행·`purge_role`은 메인 런북 몫이다(F2·L1 계약).

## 4. 앱 이미지 (F6a, CI·저장소 작업)

**새 파일 `app/Dockerfile`(CI 전용, helper는 저장소 Dockerfile을 실행하지 않는다)**

```dockerfile
# syntax=docker/dockerfile:1.10  ← RUN --network 사용. 정확한 frontend 버전·digest는 F6a에서 고정
FROM node:26.13.0-bookworm-slim@sha256:‹digest› AS deps         # glibc: lock의 @next/swc-linux-x64-gnu와 맞춤
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund                  # 네트워크 허용 단계: package 파일만 보임

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN --network=none npm run build                                  # 소스 빌드는 네트워크 없음

FROM node:26.13.0-bookworm-slim@sha256:‹digest› AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrate/migrations
COPY --from=build /app/src/server/db/migrate-cli.ts /app/src/server/db/migrate.ts /app/src/server/db/sql-policy.ts ./migrate/
LABEL org.opencontainers.image.source="https://github.com/kindsr/devscent-pieceofdays-main" \
      org.opencontainers.image.revision="‹build-arg SHA›"
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

- **standalone 출력:** `app/next.config.ts`에 `output: "standalone"`을 추가한다. 기존 fixture·auth 모드 거부 호출은 그대로 둔다.
- **`app/.dockerignore`:** `node_modules`, `.next`, `tests`, `.env*`, `test-results`, `playwright-report`, `docs`를 제외한다. 이미지에 `.env*` 파일이 없어야 한다(Next standalone은 cwd의 `.env*`를 읽는다).
- **migrate 파일 경로:** migrate CLI의 상대 import·기본 migrations 경로가 이미지 배치에서도 맞는지 F6a RED에서 확인한다. 맞지 않으면 CLI의 `--migrations-dir` 인자로 해결하고 코드 변경은 최소화한다 [미확인].
- **health route(신규, 서버 전용):**
  - `app/src/app/healthz/route.ts`: GET → 200 `ok`. DB·env를 읽지 않는다. liveness용.
  - `app/src/app/healthz/ready/route.ts`: GET → 앱 role로 `SELECT 1`(2초 timeout). 성공 200, 실패·미설정 503. 본문은 고정 문자열이고 오류 원문은 쓰지 않는다.
  - 두 경로 모두 `Cache-Control: no-store`이며 프런트 프록시 허용 목록에 **넣지 않는다**(내부 전용).
- **[미확인] 빌드 시 네트워크:** Next 16 build가 `--network=none`에서 외부 접속(글꼴·telemetry·swc 다운로드)을 시도하지 않는지. 시도하면 실패하므로 CI에서 바로 드러난다. 지금 코드는 `next/font`·원격 이미지를 쓰지 않는다.
- **[미확인] 서버 CPU 아키텍처:** runner는 amd64다. 서버가 amd64인지 메인이 확인한다.

## 5. 프런트 이미지와 프록시 (helper가 서버에서 network-none 빌드)

dev 앱 모드의 프런트 이미지는 helper가 지금처럼 서버에서 `--network=none`으로 만든다. npm은 없다. helper는 임시 context에 아래 두 가지만 둔다.

- 고정 source의 `frontend/public/` 복사본(symlink 거부)
- helper 상수 `DEV_FRONT_NGINX_CONF`를 쓴 `default.conf`

신뢰 Dockerfile은 정확히 다음 세 줄이다.

```
FROM nginx:stable-alpine@sha256:‹pinned›
COPY public/ /usr/share/nginx/html/
COPY default.conf /etc/nginx/conf.d/default.conf
```

운영의 정적 경로(`nginx:stable-alpine` + `--pull`)는 바꾸지 않는다.

**`DEV_FRONT_NGINX_CONF` 계약** (정확한 문자열은 F6b에서 고정하고 단위 시험으로 고정):

- **정적:** `location /try/`·`/design/`·`/promo/`·`/status/`는 `root /usr/share/nginx/html`, 기본 `index index.html`, nginx 기본 디렉터리 redirect 동작을 지금 정적 이미지와 같게 둔다(CI에서 응답 비교, §8).
- **proxy 허용 목록(정확히):** `= /`, `= /login`, `= /days`, `^~ /days/`, `= /settings`, `^~ /auth/`, `^~ /account/`, `^~ /_next/`. 그 밖은 `return 404`.
  - `/healthz*`·`/dev/`는 공개하지 않는다.
- **proxy 헤더:**
  - `proxy_pass http://pieceofdays-app-dev:3000`
  - 고정값: `proxy_set_header Host dev.pieceofdays.com`, `X-Forwarded-Host dev.pieceofdays.com`, `X-Forwarded-Proto https`
  - 요청 Host·`$http_host`·`$host`를 앱에 전달하지 않는다(Host 주입 차단).
  - `Origin`·`Cookie`는 그대로 전달한다.
  - `proxy_cache` 없음, `client_max_body_size 1m`, `proxy_read_timeout 30s`.
- **보안 근거 [사실]:**
  - 앱의 redirect·Origin 기준은 `POD_AUTH_BASE_URL`이다. Host 헤더로 만들지 않는다.
  - Server Actions의 Origin·Host 대조가 고정 Host와 맞는다.
  - `__Host-` 쿠키는 브라우저 기준 HTTPS에서 Secure로 저장된다.
- **localStorage 보존:**
  - origin(`https://dev.pieceofdays.com`)·경로(`/try/`)·`try/` 파일을 그대로 둔다.
  - Next는 `Clear-Site-Data`를 보내지 않는다(PR46 §7).

## 6. 배포 helper 확장 (F6b, 저장소 RED/GREEN → 메인 수동 설치)

**명령 문법(dev 키 전용):**

| 명령 | 동작 |
|---|---|
| `deploy-app dev <40hex sha> sha256:<64hex image id>` | stdin으로 앱 이미지 tar를 받아 앱 모드로 배포 |
| `revert-static dev` | 마지막 정적 성공 기록으로 되돌리고 모드를 static으로 |
| `deploy dev <sha>`(기존) | 모드가 **static일 때만** 허용. app 모드에서는 거부(정적 compose가 앱을 지우는 사고 방지) |
| `production` | 기존 문법·상수·흐름을 그대로 둔다. `deploy-app production …`·`revert-static production`은 문법에서 거부. production 키(`--allowed-environment production`)로는 앱 명령이 열리지 않는다 |

**설정(신뢰 config의 dev 항목에만 추가):**

- 키: `app_mode_enabled: true`, `app_env_file`(‹app_env_file›), `db_network`(‹db_network›), `app_health_url`(`https://dev.pieceofdays.com/try/`), `app_image_max_bytes`(예: 1 GiB)
- 기존 `trusted_file` 규칙을 적용한다: 경로의 모든 부모가 root 또는 배포 사용자 소유이고, group·other 쓰기가 없다.
- env 파일 권한은 `0600`.
- production 항목에 이 키들이 있으면 거부한다.

**env 파일 검사 `validate_app_env(text) -> dict`**

- 형식: `KEY=VALUE` 한 줄씩, 따옴표·export·주석·빈 줄 규칙 고정.
- 필수 키(정확히):
  - `POD_AUTH_SESSION_SECRETS`(JSON 번호 맵, 각 값 ≥ 32자)
  - `POD_AUTH_BASE_URL`(정확히 `https://dev.pieceofdays.com`)
  - `POD_AUTH_PROVIDERS`(`^(google|kakao)(,(google|kakao))*$`, 중복 없음)
  - `POD_DATABASE_URL`(`postgresql://` 또는 `postgres://`, 사용자 = ‹app_role›, 호스트 = ‹db_host›, DB = ‹dev_db›, query 없음)
- 선택 키:
  - `POD_AUTH_GOOGLE_CLIENT_ID/SECRET`, `POD_AUTH_KAKAO_CLIENT_ID/SECRET`: PROVIDERS에 있으면 필수, 없으면 금지
  - `POD_WITHDRAWAL_ENABLED`: 있으면 정확히 `1`. 없으면 탈퇴가 닫힌다(PR46 계약). purge 운영 준비 전에는 넣지 않는다
- 금지 키(있으면 거부): `POD_LOCAL_FIXTURE`, `POD_AUTH_MOCK_OIDC_ISSUER`, `POD_MIGRATE_DATABASE_URL`, `NODE_ENV`, `NODE_OPTIONS`, 그 밖 모든 키.
- 오류 메시지에는 키 이름만 넣고 값은 넣지 않는다(시험으로 고정).
- helper는 이 파일을 Compose `secrets.pod_app_env.file`로만 참조한다. env로 펼치거나 출력하지 않는다.

**이미지 검사 `validate_app_image(inspect, sha)`**

- `Config.User`가 비어 있지 않고 `root`/`0`이 아님.
- 라벨: `revision == sha`, `source ==` 저장소 URL.
- `ExposedPorts == {"3000/tcp": {}}`, `Volumes`가 비어 있음.
- `Config.Env` 키가 `{PATH, NODE_VERSION, YARN_VERSION, NODE_ENV=production, NEXT_TELEMETRY_DISABLED=1, PORT=3000, HOSTNAME=0.0.0.0}` 안에 있고 `POD_*`가 없음.
- `Architecture ==` ‹server_arch›.
- `Healthcheck`·`Entrypoint`·`Cmd`는 무시하고, helper 템플릿이 `entrypoint: ["node"]`, `command: ["--env-file=/run/secrets/pod_app_env", "server.js"]`, 앱 `healthcheck`를 직접 지정한다.

**런타임 템플릿 `runtime_compose_app(front_id, app_id, uid, gid, settings)`** — §3 표 그대로의 정확한 dict. 서비스 2개, 네트워크 4개(`edge` 외부, front `internal`, `‹db_network›` 외부, egress), `secrets` 1개.

- 앱 health: `["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`, interval 30s, timeout 5s, retries 3, start_period 20s.
- 프런트 health: `wget -q -O /dev/null http://127.0.0.1:80/try/`.

**흐름 `deploy_app(sha, image_id, settings)`** — 기존 `deploy()`와 같은 lock·phase·pending 구조를 쓴다.

1. 인자 형식 확인 → `assert_latest("dev", sha)`
2. stdin → `‹state›/incoming/<uuid>.tar`(0600, 상한 초과 시 중단)
3. `docker load -i` → `docker image inspect <image_id>`의 Id가 요청과 같음 → `validate_app_image`
4. 고정 source clone(기존 방식)으로 tree 계산, `frontend/public`으로 프런트 이미지 network-none 빌드
5. **후보 검사:**
   - 프런트: `--network none --read-only`로 `/try/` 해시 확인
   - 앱: `--network none --read-only --tmpfs … --cap-drop ALL --security-opt no-new-privileges --user uid:gid`로 env 없이 `/healthz` 200. 비밀값·DB 없이 liveness만 확인
   - 직전 기록의 후보 검사(복귀 가능성)
6. `validate_app_env`
7. 릴리스 기록 작성: `{mode:"app", sha, tree, front_image_id, app_image_id, try_html_sha256, compose_path, compose_sha256, env_sha256, timestamp}`. `env_sha256`은 값이 아니라 파일 해시다.
8. pending 기록 → `compose up -d --no-build --pull never --remove-orphans`(두 서비스) → 검증:
   - 두 컨테이너 Image·Running·healthy
   - 앱 안에서 `/healthz/ready` 200(DB 연결)
   - 프런트 안 `/try/` 해시
   - 공개 HTTPS `app_health_url` 본문 해시
   - 공개 `https://dev.pieceofdays.com/login` 200 + `Cache-Control`에 `no-store`(redirect 따라가지 않음)
9. 성공하면 `dev-current.json`을 쓰고 pending을 지운다. 실패하면 직전 기록으로 `compose up --remove-orphans` → 그 기록 형식의 검증 → 복귀를 기록한다.
10. `dev-static-last.json`은 static 모드 성공 때만 갱신한다(`revert-static`의 대상).

- **기록 호환:**
  - `validate_record(record, "dev")`는 `mode`가 없거나 `static`이면 기존 검사, `app`이면 앱 검사를 한다.
  - production의 `validated_dev_tree`는 dev 성공·같은 tree만 본다(기존). 다만 **dev 앱 성공은 운영 앱 전환의 근거가 아니다.** 운영은 계속 정적 comingsoon이고 운영 앱 전환은 별도 계획이다.
- **이미지 보존:** current와 previous의 이미지만 보존을 보장한다. 오래된 이미지 정리는 메인 수동 작업이다(helper가 지우지 않는다).
- **출력:** 기존처럼 실패 시 `phase + 예외 클래스`만 stderr에 쓴다. 자식 프로세스 출력·env 값·DB URL은 내보내지 않는다.

## 7. workflow 변경 (F6c, 저장소)

- **`app-validation.yml`(F6a):** `app-image` job을 추가한다. 동작:
  1. BuildKit으로 `app/Dockerfile` 빌드
  2. 이미지 inspect 단언(§6 `validate_app_image`와 같은 조건)
  3. 이미지에 `.env*`·`tests/`가 없음 확인
  4. read-only·cap-drop·non-root·network-none 후보로 `/healthz` 200, `/healthz/ready` 503(DB 없음)
  5. PG18 서비스 + `ci-only-*` 가짜 env로 `/healthz/ready` 200
  6. **프런트+앱 조합 E2E**(아래 §8)

  Secrets 없음, 배포 없음.
- **`deploy.yml`:**
  - **dev:** 기존 배포 job을 dev 앱 배포로 바꾼다. 같은 runner에서 이미지 빌드(F6a와 같은 Dockerfile) → image ID 계산 → `docker save <id> | ssh … "deploy-app dev $SHA $ID"`.
  - **production:** 바꾸지 않는다(정적 `deploy production <sha>`).
  - 새 GitHub 권한·secret은 없다(기존 `dev` environment의 SSH 자격만). GHCR(B안)을 택하면 `packages: write`와 서버 pull 자격이 새 승인 대상이다.
- **전환 순서:** F6c는 F6b 설치본 반영·서버 준비(§9)가 끝난 뒤 병합한다. 그 전까지 dev push는 기존 정적 배포를 그대로 쓴다.

## 8. 게시 기준 (검증 증거)

| 구분 | 확인 | 장소 |
|---|---|---|
| 단위(RED) | §6 모든 함수: 문법(dev 키만, production 거부, app 모드에서 `deploy dev` 거부), env 키·값·오류에 값 미포함, 이미지 검사, 런타임 dict 정확 일치, nginx 상수(허용 경로·고정 헤더·`$host` 미사용), 두 기록 형식, stdin 상한, 기존 static·production 상수 불변 스냅샷 | `tests/test_deploy_app.py`(신규), 기존 `tests/test_deploy.py` 회귀 |
| 이미지 | §7 app-image job | CI |
| 프런트+앱 E2E | 같은 compose 네트워크로 프런트·앱 이미지 실행: 기존 preview E2E 10 통과(nginx 경유), `/try/`에 기록 → `/`(Next) 방문 → `/try/` 재방문 시 기록 유지, `/try`·`/try/`·`/design/d-warm-pieces/` 응답이 현 정적 이미지와 같음, `/dev/konva-smoke`·`/healthz` 404, Host 위조 요청에도 Location·Origin 기준이 `https://dev.pieceofdays.com`, Origin 없는 POST `/auth/logout` 403·고정 Origin 303, `/login`·`/`의 `Cache-Control: no-store`, 공급자 미설정 시 `/login` "준비 중"·POST start 503 | CI. mock issuer는 운영 이미지에서 거부되므로 OAuth 흐름 자체는 S2의 mock E2E(`next dev`)가 증명한다 |
| 서버 게시(메인) | §6 8단계 자동 검증 + 메인 독립 확인: 정확 SHA·두 image ID, HTTPS `/try/` 기존 기록 유지, `/login`, Google 실로그인(B5) 뒤 `__Host-pod_session` 속성(Secure·HttpOnly·Path=/·Lax), 로그아웃, 콜백 오류 안내 | dev 서버 |

- 정적 dev의 성공 이력은 앱 모드의 근거가 아니다. 앱 모드의 첫 성공 기록이 생겨야 G2 게시로 본다.

## 9. 메인 서버 작업 (비공개 런북, 값은 공개하지 않음)

1. 공용 PG18에 dev 전용 DB·role 4개(예산 5), `pod_meta.db_environment`(name=`dev`, app/owner/purge role) 준비
2. migrator 자격으로 **같은 앱 이미지**의 migrate 명령 `status` → `up` 실행. 예시는 `docker run --rm --network ‹db_network› ‹migrator env 전달› <app image> node migrate/migrate-cli.ts up`이며 정확한 형태는 F6a 결과를 따른다. 공유 호스트에서 npm·source를 실행하지 않는다.
3. `‹app_env_file›` 작성(0600, §6 키 규칙). 값은 채팅·Cloud·저장소에 남기지 않는다.
4. 앱 egress 범위 결정(§3).
5. F6b helper를 검토한 뒤 설치본에 수동 반영하고 config dev 항목을 추가(production 항목 불변).
6. dev 접근 제한 방식이 OAuth callback·쿠키와 호환되는지 확인 [미확인].
7. DB 백업 등급·RPO·RTO는 런북에서 따로 정한다. 공용 nightly 백업이 있어도 서비스 restore probe까지 증명된 것은 아니다. 이 계획은 승인됐다고 쓰지 않는다.

## 10. 복귀

| 상황 | 동작 |
|---|---|
| 첫 앱 배포 실패 | helper가 직전 **정적** 기록으로 `--remove-orphans` 복귀(앱 컨테이너 제거) → 정적 검증 |
| 이후 앱 배포 실패 | 직전 **앱** 기록(프런트·앱 image ID 둘 다)으로 복귀 |
| 앱 모드를 끄기 | `revert-static dev`(dev 키) → 마지막 정적 성공 기록. 그 뒤 `deploy.yml` dev를 정적으로 되돌리는 PR |
| DB | 되돌리지 않는다. migration은 확장 단계만. 원장은 삭제하지 않는다 |
| 브라우저 기록 | `/try/` 파일·origin·키 불변이라 영향 없음 |
| 중단된 배포 | 기존 pending 복구 흐름을 두 기록 형식 모두에 적용 |

## 11. slice·의존·파일 소유

| slice | 파일 | 선행 | 병행 |
|---|---|---|---|
| **F6a 앱 이미지** | RED: `app/tests/*`(health route 단위), CI 이미지 단언 스크립트(`tests/` 또는 `app/tests/`). GREEN: `app/Dockerfile`, `app/.dockerignore`, `app/next.config.ts`(`output` 1줄), `app/src/app/healthz/route.ts`, `app/src/app/healthz/ready/route.ts`, `.github/workflows/app-validation.yml`(app-image job) | 없음 | S1·S2·S3·F6b |
| **F6b helper** | RED: `tests/test_deploy_app.py`. GREEN: `scripts/ops/deploy.py`(기존 static·production 동작 불변) | 없음 | F6a |
| **F6c 배포 전환** | `.github/workflows/deploy.yml`(dev만), `docker-compose.dev.yml`은 그대로(앱 모드 compose는 helper 템플릿이므로) | F6a·F6b 통합, §9 1~6 완료 | — |
| **G2 첫 앱 게시** | — | F6c, S2(B4) 통합, B5 Google, 사용자 콘솔 | — |

- `deploy/README.md`·`AGENTS.md` 등 상태 문서 갱신은 각 통합 단계에서 메인·문서 담당이 한다.
- `.claude/tdd.conf`의 `TEST_PATTERNS`(`tests/*`, `app/tests/*` 등)에 RED 파일이 들어간다. GREEN은 시험을 바꾸지 않는다.
- 공유 서버에서는 시험·빌드·FullCheck를 실행하지 않는다.

## 12. 남은 입력·미확인

- **사용자(콘솔, 값은 채팅으로 받지 않음):** Google dev OAuth 클라이언트, redirect `https://dev.pieceofdays.com/auth/google/callback`(계획안), 테스트 사용자 등록. Kakao는 B5 이후.
- **메인 확인:**
  - 서버 아키텍처
  - nginx·node 기반 이미지 digest 고정값
  - egress 범위
  - 접근 제한 호환
  - 백업 등급
  - 이미지 전달 A안 수락 여부(B안이면 새 권한 승인 필요)
- **[미확인]:**
  - Next 16 standalone의 read-only 루트에서 `/app/.next/cache`·`/tmp` 외 쓰기 경로
  - `--network=none` 빌드 성공
  - migrate CLI의 이미지 내 경로
  - app role의 `pod_meta.schema_migrations` 읽기 권한(readiness에서 migration 버전까지 볼지)
  - unprivileged nginx 전환

  모두 F6a·F6b CI에서 확인할 항목이다.
- **이 작성자가 하지 않은 것:** 코드·시험·npm·Next·Docker·DB·서버·FullCheck 실행. Cloud에는 `_template`·`hc`·서버가 없어 읽거나 실행하지 않았다.
