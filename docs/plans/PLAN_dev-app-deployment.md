# PLAN — F6-dev: 개발 도메인에 Next 앱 배포 (S4) — R2

- **상태:** R2 계획이다(2026-11-05). R1(`4c3fb8a`) 독립 검토의 P1 2건과 운영 예산·deadline을 메인이 보완했다(§14). **재검토·메인 수락 전이다.**
  - 이 문서는 코드·CI·Compose·배포 프로그램·서버를 바꾸지 않았고 권한을 늘리지 않는다.
- **BASE:** `dev` `e49b0c3ad79a32f16f8f33ca003aef9b57f43540`.
  - 함께 읽은 것: PR46 HEAD `6034fdf209ed716cb0079971beb327b8d019786d`의 [실사용 전환 계획](https://github.com/kindsr/devscent-pieceofdays-main/blob/6034fdf209ed716cb0079971beb327b8d019786d/docs/plans/PLAN_dev-usable-app.md) §6·§8과 `PLAN_dev-diary-actions.md`.
  - R1 작성 시 현재 dev는 `f737e28`이고, 아래 소스 사실(`pool.ts` 등)은 그대로임을 확인했다.
- **범위:** [실사용 전환 계획](https://github.com/kindsr/devscent-pieceofdays-main/blob/6034fdf209ed716cb0079971beb327b8d019786d/docs/plans/PLAN_dev-usable-app.md)의 S4(F6-dev)다. 운영(main) 앱 전환, 공용 nginx·TLS·다른 서비스 변경은 범위 밖이다.
- **표기:** [사실] 코드로 확인 / [메인] 메인 확정 제약 / [제안] 이 계획의 선택(검토 필요) / [미확인] / [미정]
- **논리 키:** 서버 내부 경로·계정·네트워크 실명·키는 공개 문서에 쓰지 않는다. `‹…›`는 비공개 런북이 값을 갖는 논리 키다.

## 1. 현재 사실 [사실]

**`scripts/ops/deploy.py`**(설치본은 저장소 밖에 있고 메인이 수동 반영한다)

- **명령:** `probe <env>`, `deploy <dev|production> <40hex>`. 키별 `--allowed-environment`와 다른 env를 요청하면 거부한다.
- **Compose 허용:** 서비스 1개, `expose ["80"]`, 고정 `HEALTH`, `edge`만. 저장소 Dockerfile이 `FROM nginx:stable-alpine` + `COPY`와 정확히 같아야 하고, 실제 빌드는 helper 자체 신뢰 Dockerfile로 `--network=none --pull`이다.
- **릴리스 흐름:** 후보 → 기록 `{sha, tree, image_id, serving_html_sha256, compose_path, compose_sha256}` → pending → 교체 → HTTPS 해시 확인 → 실패 시 복귀.
- **운영 승격:** `validated_dev_tree`가 `dev-current.json`을 `validate_record(…, "dev")`로 읽은 뒤 `status == success`이고 tree가 같을 때만 허용한다.
- **배포 job(`deploy.yml`):** 저장소를 checkout하거나 실행하지 않는다. dev·production environment의 SSH secret으로 `probe`·`deploy`만 호출한다.

**앱(`app/`)**

- `next.config.ts`에 `output`이 없다(standalone 아님).
- health route가 없다.
- `next/image`·`next/font`·원격 이미지를 쓰지 않는다.
- **`server/db/pool.ts`:** `new pg.Pool({ connectionString })`이고 **옵션이 없다.**
  - 그래서 `pg-pool` 3.14.0 기본값(최대 연결 10, 연결 대기 timeout 없음)이 적용된다.
  - R1 지시의 "app Pool max 5는 기존 소스 사실"과 다르다. 현재 소스에는 max 설정이 없다. §4에서 명시 설정을 제안한다.
- **migrate CLI:** `node src/server/db/migrate-cli.ts status|up [--migrations-dir <dir>]`.
  - 기본 디렉터리는 파일 기준 `../../../migrations`, 즉 `app/migrations`다.
  - `./migrate.ts`·`./sql-policy.ts`·`pg`를 import한다.
  - 읽는 env는 `POD_MIGRATE_DATABASE_URL`뿐이다.
- **앱이 읽는 env:**
  - 세션: `POD_AUTH_SESSION_SECRETS`, `POD_AUTH_BASE_URL`
  - 공급자: `POD_AUTH_PROVIDERS`, `POD_AUTH_GOOGLE_CLIENT_ID`·`_SECRET`, `POD_AUTH_KAKAO_CLIENT_ID`·`_SECRET`
  - 시험 전용: `POD_AUTH_MOCK_OIDC_ISSUER`, `POD_LOCAL_FIXTURE`
  - DB: `POD_DATABASE_URL`
  - `POD_WITHDRAWAL_ENABLED`는 PR46의 S2 계약이며 아직 코드에 없다.
- **lock:**
  - install script가 있는 패키지는 `fsevents`(macOS optional)뿐이다.
  - `@next/swc-linux-x64-gnu`·`-musl` 16.4.3과 optional `sharp` 0.35.5·`@img/sharp-linux-x64`가 lock에 있다.

## 2. 선택안 요약 [제안]

| 결정 | 선택 | 근거·대안 |
|---|---|---|
| 앱 이미지 빌드 | 격리 GitHub Actions runner에서만 빌드한다. 공유 서버에서는 npm·Next build를 하지 않는다 | 서버에서 소스 실행 금지 |
| **이미지 전달** | **B. GHCR 공개 패키지를 digest로 pull(메인 선택)** | `docker pull <repo>@sha256:<digest>`는 레지스트리가 내용 해시를 검증하고 RepoTags를 만들지 않는다. 공개 패키지는 익명 pull이 가능하므로 서버 pull 자격이 필수는 아니다 |
| 대안 | A. SSH로 `docker save` tar 전달 | `docker load`는 tar의 manifest가 가리키는 다른 이미지·태그를 적재하는 부작용이 검사 전에 끝난다. **§6.6의 load 전 archive 검증 계약과 CI에서 고정한 단일 형식이 있을 때만** 채택한다. 이 문서 작성 중 `docker save` 실제 형식은 격리 실행으로 확인하지 못했다 [미확인] |
| 프런트 | 기존 정적 nginx를 dev 앞단에 둔다. 정적 경로는 그대로, 정해진 Next 경로만 내부 프록시 | origin·디렉터리 index·localStorage 보존 |
| nginx 설정 출처 | helper 상수(설치본). 저장소의 nginx 설정은 받지 않는다 | 프록시 규칙을 저장소가 바꾸지 못하게 |
| 비밀값 | 저장소 밖 live env 파일을 검사해 **릴리스마다 동결 복사(0600)**하고 Compose `secrets` 파일로 마운트. 앱은 `node --env-file`로 읽는다 | `docker inspect` `Config.Env` 비노출. 복귀는 그 릴리스의 동결 env로 한다(§6.4) |
| migration | 메인이 교체 전에 같은 이미지의 migrate 명령을 migrator 자격으로 수동 실행(`status` → `up`) | helper는 SQL·migration을 실행하지 않는다 |
| 운영 | dev 앱 기록은 production 승인 근거가 아니다. `validated_dev_tree`가 앱 기록을 **명시적으로 거부**한다(§6.5) | 기존 정적·운영 검증을 넓히지 않는다 |

## 3. 대상 구성 (dev 앱 모드)

```
인터넷 ─HTTPS→ 공용 edge nginx(변경 없음) ─→ pieceofdays-frontend-dev (정적 nginx :80)
                                               ├─ /try/ /design/ /promo/ /status/ → 정적(지금과 같음)
                                               └─ 허용 경로만 → pieceofdays-app-dev (:3000, Next production standalone)
                                                                   ├─ ‹db_network›: 공용 PG18의 dev 전용 DB(app role)
                                                                   └─ 앱 전용 egress bridge(OIDC 공급자 HTTPS)
```

| 컨테이너 | 네트워크 | 실행 사용자 | 파일시스템·권한 |
|---|---|---|---|
| `pieceofdays-frontend-dev` | `edge`(외부, 기존) + `pieceofdays-dev-front`(`internal: true`) | nginx 기본(현행) | `read_only`, tmpfs `/var/cache/nginx`·`/var/run`(현행). `cap_drop ALL`은 nginx worker setuid와 충돌할 수 있어 현행 유지 [미확인: unprivileged nginx는 후속] |
| `pieceofdays-app-dev` | `pieceofdays-dev-front` + `‹db_network›`(외부) + `pieceofdays-dev-egress`(전용 bridge) | 배포 사용자의 숫자 uid:gid(helper가 고정, 0이면 거부) | `read_only`, tmpfs `/tmp`(64m, 1777)·`/app/.next/cache`(64m, 같은 uid, 0700), `cap_drop [ALL]`, `no-new-privileges:true`. volume·bind·privileged·devices 없음(secret 파일 마운트 하나만). host port 없음 |

- **egress:** 목적지를 443·공급자로 더 좁힐지는 메인 운영 결정이다 [미정].
- **DB 권한·연결 예산 [메인 계산]:**
  - dev 전용 database에 role 4개(owner NOLOGIN, migrator, app, purge)와 예비 1개를 둔다. 이것은 **role 개수**이지 접속 예산이 아니다.
  - 메인이 PG18 카탈로그의 최대 연결 100·기존 LOGIN role 상한 합 64를 확인했다. 이번 동시 최대 9를 더해 73으로 관리 여유를 둔다. 다른 서비스 상한은 바꾸지 않는다.
    - app role: connection limit 6, 앱 Pool max 5 + 단발 readiness 1(§4)
    - migrator: 2(교체 전 수동 실행 때만)
    - purge: 1(아직 비활성)
    - owner: NOLOGIN
  - Next에는 app role URL만 준다. PG host port는 쓰지 않는다.

## 4. 앱 이미지 (F6a, 저장소·CI 작업)

**`app/Dockerfile`**(CI 전용. helper는 저장소 Dockerfile을 실행하지 않는다)

```dockerfile
# syntax=docker/dockerfile:‹pinned frontend›   ← RUN --network 사용. 버전·digest는 F6a에서 공식 출처로 고정
FROM node:26.13.0-bookworm-slim@sha256:‹digest› AS deps          # 기존 Node 26.13.0 유지, glibc(lock의 swc gnu)
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund                   # 네트워크 단계: package 파일만 보인다

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN --network=none npm run build

FROM node:26.13.0-bookworm-slim@sha256:‹digest› AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# migrate CLI는 원래 상대 배치를 그대로 둔다 → 기본 경로 ../../../migrations = /app/migrations
COPY --from=build /app/src/server/db/migrate-cli.ts /app/src/server/db/migrate.ts /app/src/server/db/sql-policy.ts ./src/server/db/
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/runtime-startup.mjs ./runtime-startup.mjs
COPY --from=build /app/src/server/runtime-mode.ts ./src/server/runtime-mode.ts
ARG POD_SHA POD_TREE POD_MIGRATIONS_LATEST
LABEL org.opencontainers.image.source="https://github.com/kindsr/devscent-pieceofdays-main" \
      org.opencontainers.image.revision="${POD_SHA}" pod.tree="${POD_TREE}" pod.migrations.latest="${POD_MIGRATIONS_LATEST}"
USER node
EXPOSE 3000
CMD ["node", "runtime-startup.mjs"]
```

- **`pg` 의존성:** standalone trace에는 앱이 import하는 `pg`가 들어간다고 예상하지만 [미확인], migrate CLI 경로까지 들어간다는 보장은 없다. CI가 이미지 안에서 `node src/server/db/migrate-cli.ts status`를 실제 PG18에 대해 실행해 확인한다. 실패하면 `node_modules/pg`와 그 의존 패키지를 build 단계에서 명시 `COPY`한다(정확한 목록은 lock에서 계산해 F6a에서 고정).
- **migrate 명령(고정):** 작업 디렉터리 `/app`, `node --env-file=/run/secrets/migrator.env src/server/db/migrate-cli.ts status` / `… up`. `--migrations-dir`는 쓰지 않는다(기본 `/app/migrations`).
- **`app/next.config.ts`:** `output: "standalone"` 1줄을 추가한다. 기존 모드 거부 호출은 그대로 둔다.
- **`app/runtime-startup.mjs`:** standalone의 직렬화된 nextConfig만으로는 원래 production-server 시작 검사가 다시 실행된다고 가정하지 않는다. wrapper가 원본 `src/server/runtime-mode.ts`의 `assertFixtureModeAllowed("phase-production-server", process.env)`·`assertAuthModeAllowed("phase-production-server", process.env)`를 먼저 호출하고 `await import("./server.js")`한다. Node26의 erasable TS를 그대로 사용하며 새 모드/의존성은 없다. 이미지의 실제 기본 기동으로 fixture/mock 시작 거부를 검증한다. migration CLI는 별도로 실행한다.
- **`app/.dockerignore`:** `node_modules`, `.next`, `tests`, `.env*`, `test-results`, `playwright-report`를 제외한다. 이미지에 `.env*`가 없음을 CI로 단언한다.
- **`server/db/pool.ts` 명시 설정 [메인, F6a 코드 변경]:** `new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })`. 지금은 기본값이라 최대 10이고 연결 대기 timeout이 없다. app role limit 6 안에서 Pool 5 + readiness 1을 유지한다.
- **health route(서버 전용, 쓰기 없음):**
  - `app/src/app/healthz/route.ts`: GET → 200 `ok`. DB·env를 읽지 않는다(liveness).
  - `app/src/app/healthz/ready/route.ts`: GET → **앱 Pool을 쓰지 않는** 단발 `pg.Client`(`POD_DATABASE_URL`, `connectionTimeoutMillis: 2000`, `query_timeout: 2000`)로 `SELECT 1` → 200. 실패·미설정·요청 시작부터 전체 2초 deadline이면 503이다. connect와 query의 직렬 timeout 합계를 전체 deadline으로 세지 않는다.
    - 전체 2초 타이머와 connect/query 작업을 경합시키고 만료 시 즉시 고정 503을 반환한다. 모든 경로에서 타이머를 해제하고 client 종료를 시작한다. `client.end()` 대기로 응답 deadline을 늘리지 않으며 종료 거부·late rejection은 처리해 원문 로그·unhandled rejection을 남기지 않는다. 연결/쿼리 정리와 남은 소켓 0을 격리 시험한다.
    - 본문은 고정 문자열이다. 계정·원장·metadata를 쓰지 않는다.
    - Pool과 분리하는 이유: Pool이 고갈되거나 연결 대기가 길어도 readiness가 멈추지 않게 하기 위해서다.
  - **readiness 200은 migration 완료의 증거가 아니다.** migration은 §9의 메인 gate가 따로 확인한다.
  - 두 route 모두 `Cache-Control: no-store`이고 공개 프록시 허용 목록에 없다.
- **[미확인] (모두 CI에서 확인):** `--network=none` build 성공, read-only 루트에서 `/tmp`·`/app/.next/cache` 밖 쓰기 경로, 서버 CPU 아키텍처(메인 확인).

## 5. 프런트 이미지와 프록시 (helper가 서버에서 network-none 빌드)

helper가 임시 context를 만든다. 고정 source의 `frontend/public/` 복사본(symlink 거부)과 helper 상수 `DEV_FRONT_NGINX_CONF`를 쓴 `default.conf`다. 신뢰 Dockerfile은 정확히 다음 세 줄이다(운영 정적 경로 불변).

```
FROM nginx:stable-alpine@sha256:‹pinned›
COPY public/ /usr/share/nginx/html/
COPY default.conf /etc/nginx/conf.d/default.conf
```

**`DEV_FRONT_NGINX_CONF` 계약**

- **정적:** `/try/`·`/design/`·`/promo/`·`/status/`는 root `/usr/share/nginx/html`, `index index.html`, 디렉터리 redirect를 지금 정적 이미지와 같게 둔다(CI 응답 비교).
- **proxy 허용 목록(정확히):** `= /`, `= /login`, `= /days`, `^~ /days/`, `= /settings`, `^~ /auth/`, `^~ /account/`, `^~ /_next/`. 그 밖은 `return 404`(`/healthz*`·`/dev/` 포함).
- **헤더:** `proxy_pass http://pieceofdays-app-dev:3000`. `Host`·`X-Forwarded-Host`는 `dev.pieceofdays.com`, `X-Forwarded-Proto`는 `https`로 고정한다. `$host`·`$http_host`는 쓰지 않는다. `Origin`·`Cookie`는 그대로 전달한다.
- **그 밖:** `proxy_cache` 없음, `client_max_body_size 1m`, `proxy_read_timeout 30s`.
- **localStorage:** origin·`/try/` 파일·저장 키 불변. 앱은 `Clear-Site-Data`를 보내지 않는다. 정적 응답 비교에 `/status/`도 포함한다. Next 로그인·설정에는 `/try/`·`/status/` 링크를 유지한다. `/index.html`·`/favicon.ico`·`/sample/`는 공개하지 않는다. 실제 계정 화면은 예시 이미지를 쓰지 않으며 기존 fixture 시험은 nginx 밖의 격리 Next에서 유지한다.

## 6. 배포 helper 확장 (F6b, 저장소 RED/GREEN → 메인 수동 설치)

### 6.1 명령 문법

| 명령 | 허용 키 | 동작 |
|---|---|---|
| `deploy-app dev <40hex sha> <40hex tree> sha256:<64hex manifest digest> sha256:<64hex config digest>` | dev만 | 앱 모드 배포(B안). Docker 엔진의 image ID와 config digest가 같다고 가정하지 않는다 |
| `revert-static dev` | dev만 | `dev-static-last.json`의 정적 기록으로 되돌리고 모드를 static으로 |
| `deploy dev <sha>`(기존) | dev | 모드가 **static일 때만** 허용. app 모드면 거부 |
| `deploy production <sha>`, `probe`(기존) | 기존 | 문법·상수·흐름 불변. `deploy-app production`·`revert-static production`은 문법에서 거부 |

기존 `parse_request(command)`의 반환 `(env,sha)`는 그대로다. 새 `parse_app_request(command)`는 위 정확 문법만 받아 `("deploy-app","dev",sha,tree,manifest_digest,config_digest)` 또는 `("revert-static","dev")` tuple을 반환하며 그 밖은 `ValueError`다. `main()`은 앱 명령이면 설정·registry·Docker 접근 전에 `--allowed-environment == dev`를 확인한다.

### 6.2 설정 (신뢰 config의 dev 항목에만)

- 키: `app_mode_enabled`, `app_env_file`(‹app_env_file›, live 원본), `db_network`(‹db_network›), `app_health_url`(`https://dev.pieceofdays.com/try/`), `app_role`·`db_host`·`dev_db`(URL 검사의 기대값), `server_arch`(정확히 `amd64`). uid:gid는 요청/config에서 받지 않고 실행 사용자의 `os.getuid()/getgid()`만 쓰며 0이면 거부한다.
- production 항목에 이 키가 있으면 거부한다.
- 모든 경로에 기존 `trusted_file` 규칙(부모까지 root 또는 배포 사용자 소유, group·other 쓰기 없음)을 적용한다. env 파일은 regular file, 0600, 배포 사용자 소유.
- 이미지 저장소는 helper 상수 `APP_IMAGE_REPOSITORY = "ghcr.io/kindsr/devscent-pieceofdays-main-app"`다. 요청 입력으로 바꿀 수 없다.

### 6.3 검사 함수 (공개 계약, RED가 고정)

**`validate_app_env(text, settings) -> dict`**

- 형식: UTF-8 BOM 없는 `KEY=VALUE` 줄만 받는다(키 앞뒤 공백 없음). 빈 줄·줄 전체 `#` 주석은 허용하고 `export`·중복 키·CR·NUL·LF 이외 제어문자를 거부한다.
- 값은 비어 있지 않고 앞뒤 공백이 없으며 `#`를 포함하지 않는다. `"`·`'`·backtick으로 시작하는 값은 거부한다. `{`로 시작하는 세션 JSON 안의 `"`는 허용한다. 이 부분집합은 Node `--env-file`이 원문 값을 그대로 읽는다. 새 비밀번호·세션 키는 이 문법으로 생성한다(URL 비밀번호는 percent encoding). Python 검사기와 고정 Node 26.13.0 `--env-file`의 키·값 집합 동일성을 가짜 파일로 CI 대조한다.
- Node 대조의 RED 파일은 `app/tests/deploy-env-parity.test.mjs`(node:test)다. F6b GREEN이 추가하는 `.github/workflows/deploy-app-validation.yml`에서 Node 26.13.0을 고정해 `node --test app/tests/deploy-env-parity.test.mjs`만 실행한다(npm·서버·DB·Secrets 없음). Python `tests/test_deploy_app.py`는 계속 표준 라이브러리 unittest만 쓰고 Node 부재를 skip/통과로 세지 않는다. 새 workflow는 PR 및 dev/main push의 helper·이 시험 파일·workflow 변경에만 반응하며 `contents:read`다.
- 필수 키:
  - `POD_AUTH_SESSION_SECRETS`(JSON 번호 맵, 값 ≥ 32자)
  - `POD_AUTH_BASE_URL`(정확히 `https://dev.pieceofdays.com`)
  - `POD_AUTH_PROVIDERS`(`^(google|kakao)(,(google|kakao))*$`, 중복 없음)
  - `POD_DATABASE_URL`(scheme `postgres`/`postgresql`, 사용자 ‹app_role›, 호스트 ‹db_host›, DB ‹dev_db›, query 없음)
- 선택 키:
  - 공급자별 `_CLIENT_ID`/`_SECRET`: PROVIDERS에 있으면 필수, 없으면 금지
  - `POD_WITHDRAWAL_ENABLED`: 있으면 정확히 `1`. purge 준비 전에는 넣지 않는다
- 그 밖 모든 키는 거부한다. 특히 `POD_LOCAL_FIXTURE`, `POD_AUTH_MOCK_OIDC_ISSUER`, `POD_MIGRATE_DATABASE_URL`, `NODE_ENV`, `NODE_OPTIONS`.
- 오류 메시지에는 키 이름만 넣고 값은 넣지 않는다.

**`validate_app_manifest(document, config_digest) -> None`**

- 메인은 B(GHCR)를 선택한다. CI는 `--platform linux/amd64 --provenance=false --sbom=false`로 **단일 플랫폼 manifest**를 게시한다. `manifest_digest`는 그 manifest 원문 바이트의 digest, `config_digest`는 manifest가 참조하는 config blob digest다. index·manifest list는 거부한다.
- manifest는 OCI image manifest 또는 Docker schema2이며 `schemaVersion=2`, 정확한 config digest·허용 config mediaType·양의 크기·비어 있지 않은 layer digest/크기 형식을 검사한다. CLI가 고정 저장소의 `@manifest_digest`를 읽어 검증한 문서를 사용한다. 출력에 config 원문·env를 남기지 않는다.

**`validate_app_image(inspect, sha, tree, manifest_digest, settings) -> None`**

- `Id`는 유효한 sha256 형식의 **엔진 image ID**로만 취급한다. `config_digest`와 비교하지 않는다. `RepoDigests`에 `APP_IMAGE_REPOSITORY@<manifest_digest>`가 정확히 있고 `RepoTags`는 비어 있어야 한다. fresh pull 전에 manifest/config 연결을 위 함수로 검증하고 Docker의 digest 검증으로 같은 자료를 pull한다.
- `Config.User`가 비어 있지 않고 root·0이 아님.
- 라벨 `revision == sha`, `pod.tree == tree`, `source == 저장소 URL`, `pod.migrations.latest`는 양의 정수.
- `ExposedPorts == {"3000/tcp": {}}`, `Volumes`가 비어 있음.
- env 키는 `{PATH, NODE_VERSION, YARN_VERSION, NODE_ENV=production, NEXT_TELEMETRY_DISABLED=1, PORT=3000, HOSTNAME=0.0.0.0}` 안에 있고 `POD_*`가 없음.
- `Architecture ==` ‹server_arch›.
- 이미지의 `Entrypoint`·`Cmd`·`Healthcheck`는 쓰지 않는다. 템플릿이 직접 지정한다.

**`runtime_compose_app(front_id, app_image_id, release_id, uid, gid, settings) -> dict`**

- §3 그대로의 정확한 dict다: 서비스 2개, 네트워크 4개, `secrets.pod_app_env.file`은 **해당 릴리스의 동결 env 경로**. `services`의 image 값 2개는 모두 기록한 로컬 엔진 image ID다. registry 참조를 런타임에 재해석하지 않는다.
- 앱: `entrypoint: ["node"]`, `command: ["--env-file=/run/secrets/pod_app_env", "runtime-startup.mjs"]`, `user: "<uid>:<gid>"`. 후보 기동도 같은 wrapper를 쓰며 env 없이 liveness를 확인한다.
- 앱 health: `["CMD","node","-e","fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`, 30s / 5s / 3, start_period 20s.
- 프런트 health: `wget -q -O /dev/null http://127.0.0.1:80/try/`.

### 6.4 릴리스 기록과 env 동결

- **`release_id`:** `^[0-9a-f]{40}-[0-9a-f]{32}$`(sha + uuid4 hex).
- **릴리스 디렉터리:** `‹state›/releases/dev/<release_id>/`(0700). 안에 `compose.json`과 `app.env`(0600, live 파일을 검사한 뒤 복사한 동결본)를 둔다.
- **앱 기록 형식(정확한 키):** `{mode:"app", status:"success", sha, tree, release_id, front_image_id, app_image_id, app_manifest_digest, app_config_digest, try_html_sha256, compose_sha256, env_sha256, timestamp}`. image_id 2개는 각 엔진이 돌려준 불변 image ID다. 앱의 OCI config digest와 같다고 가정하지 않는다.
  - **경로 필드는 없다.** helper가 `release_id`로만 경로를 만든다. 임의 경로는 거부한다.
- **기록을 읽을 때:** `release_id` 형식 → 디렉터리·파일이 symlink가 아닌 regular file이고 소유자가 배포 사용자, `app.env`가 0600, 부모가 신뢰 경로 → `compose.json`·`app.env`의 sha256이 기록과 일치 → `validate_app_env(동결본)` → compose가 `runtime_compose_app(…)` 결과와 정확히 같음 → 두 이미지 존재.
- **복귀:** 직전 릴리스의 **동결 env와 compose·로컬 image ID**로 올린다. live 파일이나 registry 접속에는 의존하지 않는다. 기록 읽기는 로컬 image ID·RepoDigests·라벨·구성을 검사하며 fresh 배포 때의 manifest 검증을 원격으로 반복하지 않는다. 컨테이너의 Image는 그 릴리스가 기록한 엔진 image ID와 일치해야 한다.
- **비밀값 회전:** live 파일을 바꾼 뒤 `deploy-app`을 다시 호출한다. 같은 sha·digest라도 live env 해시가 현재 기록과 다르면 **새 릴리스**를 만든다. 둘 다 같을 때만 기존 idempotent 확인을 한다.
- **보존:** helper는 릴리스 디렉터리를 지우지 않는다. 적어도 current·previous는 메인이 보존하고, 더 오래된 것은 메인이 정리한다. 동결 env는 비밀값이므로 일반 백업·PR·CI 아티팩트에 넣지 않는다(백업 처리는 메인 런북). CI는 `ci-only-*` 가짜 값만 쓴다.
- **정적 기록:** 기존 형식 그대로(`mode` 없음 = static). static 성공 때만 `dev-static-last.json`을 갱신한다.

### 6.5 운영 승격 경계 (명시 거부)

- `validated_dev_tree`는 dev 기록의 `mode`가 `"app"`이면 **다른 검사 전에** `ValueError("dev app record is not a production promotion basis")`를 낸다.
- 정적 기록의 같은 tree 허용은 그대로 둔다.
- 결과: dev가 app 모드인 동안 production(정적 comingsoon) 배포는 거부된다. 운영 반영이 필요하면 메인이 `revert-static dev`로 정적 dev 성공 기록을 다시 만들거나, 사용자가 운영 앱 전환을 요청할 때 별도 앱 계획을 세운다.
- 기존 정적·운영 검증을 앱 기록 호환을 위해 넓히지 않는다.

### 6.6 대안 A를 쓸 경우의 load 전 archive 검증 (B 채택 시 구현하지 않음)

`validate_image_archive(path, config_id, limits) -> None`은 **추출 없이** tar를 읽어 검사한다. 통과해야만 `docker load -i`를 실행한다.

- **입력 상한:** stdin을 신뢰 임시 파일(0600)로 받는다. 총 바이트·멤버 수·멤버별 크기·선언 크기 합계·읽기 시간에 상한을 둔다. 상한값은 F6b에서 고정한다.
- **멤버:** regular file과 디렉터리만 허용한다. 절대 경로·`..`·중복 이름·symlink·hardlink·device·FIFO·위험 pax 헤더(`path`·`linkpath` 재정의 등)는 거부한다.
- **지원 형식은 하나만:** CI 격리 환경에서 `docker save <config id>`(태그 없이 ID로 저장)의 실제 멤버 목록을 확인해 고정한다. 최근 Docker는 OCI layout(`oci-layout`·`index.json`·`blobs/`)과 기존 `manifest.json`을 함께 낼 수 있다 [미확인].
  - manifest는 하나, config는 하나.
  - config blob 바이트의 sha256 == 요청 `config_id`.
  - `RepoTags`는 `null` 또는 `[]`만.
  - `repositories` 파일과 그 밖의 이미지·태그·annotation 이름은 거부한다.
  - manifest가 참조하는 layer 집합과 tar 멤버 집합이 정확히 같아야 하고, 각 layer의 형식·해시가 맞아야 한다.
- **출력:** raw stdout·경로·비밀값을 내보내지 않는다.
- 이 형식을 CI에서 고정하지 못하면 A는 채택하지 않는다. "load 후 inspect로 충분하다"는 주장도 하지 않는다.

### 6.7 흐름 `deploy_app(sha, tree, manifest_digest, config_digest, settings)`

기존 `deploy()`의 lock·phase·pending 구조를 따른다. 새 공개 함수 `validate_app_record(record, settings) -> dict`는 §6.4의 로컬 검증 후 같은 record를 반환하고, `verify_app_release(record, settings) -> None`은 아래 8단계의 실제 상태를 검증한다. `revert_static(settings) -> None`은 dev 잠금 안에서 마지막 정적 성공 기록을 검증·복귀·검증한 뒤 현재 기록을 바꾼다. 기존 `validate_record(record,env)`·`verify_release(record,env,settings)`의 정적 계약은 유지한다. 앱 흐름만 record.mode로 정적/앱 함수를 분기하며 모르는 mode는 거부한다. 두 형식 복귀의 compose 호출에는 `--remove-orphans`를 써서 앱→정적 복귀 때 앱 컨테이너를 남기지 않는다.

1. 인자 형식 확인 → `assert_latest("dev", sha)`
2. 기존 방식의 고정 source clone으로 tree를 계산하고 요청 tree와 같은지 확인
3. `docker manifest inspect APP_IMAGE_REPOSITORY@<manifest_digest>`의 단일 플랫폼 문서를 `validate_app_manifest`로 검사한 뒤 같은 digest를 `docker pull --platform linux/amd64`한다.
   - `manifest inspect`는 JSON을 재직렬화할 수 있으므로 그 stdout의 해시를 manifest digest와 비교하지 않는다. 고정 digest 조회와 Docker pull의 client·registry 내용 검증에 의존한다.
   - 빈 `DOCKER_CONFIG`로 익명 pull, 시간 상한 적용
   - 비공개 패키지라 실패하면 배포 실패 → 자격 추가는 메인 결정
4. `validate_app_image`
5. `frontend/public`으로 프런트 이미지를 network-none 빌드
6. **후보 검사:**
   - 프런트: `--network none --read-only`로 `/try/` 해시
   - 앱: `--network none --read-only --tmpfs … --cap-drop ALL --security-opt no-new-privileges --user uid:gid`로 env 없이 `/healthz` 200
   - 직전 기록의 후보 검사(복귀 가능성)
7. `validate_app_env(live)` → 새 `release_id` 디렉터리에 env 동결 복사·compose 작성 → 기록 생성
8. pending(=직전 기록) → `compose up -d --no-build --pull never --remove-orphans` → 검증:
   - 두 컨테이너 Image·Running·healthy
   - 앱 안 `/healthz/ready` 200
   - 프런트 안 `/try/` 해시
   - 공개 HTTPS `app_health_url` 해시
   - 공개 `https://dev.pieceofdays.com/login` 200 + `Cache-Control`에 `no-store`(redirect 따라가지 않음)
9. 성공하면 `dev-current.json`을 쓰고 pending을 지운다. 실패하면 직전 기록(정적이면 정적 compose, 앱이면 그 릴리스 compose·동결 env)으로 `--remove-orphans` 복귀하고 검증한다.

- **출력:** 기존처럼 실패 시 phase + 예외 클래스만 stderr에 쓴다. 자식 출력·env·URL은 내보내지 않는다.

## 7. workflow (F6a·F6c)

**`app-validation.yml` — `app-image` job 추가(F6a)**

- PR·push 모두에서 실행한다. 권한은 `contents: read`, Secrets·environment 없음, push 없음.
- 단계:
  1. BuildKit 빌드
  2. `validate_app_image`와 같은 조건 단언(RepoDigests 제외)
  3. `.env*`·`tests/` 부재 확인
  4. network-none·read-only 후보로 `/healthz` 200, `/healthz/ready` 503
  5. PG18 서비스 + 가짜 env로 `/healthz/ready` 200
  6. 이미지 안 `migrate-cli.ts status`·`up`을 실제 PG18에 실행
  7. 프런트+앱 조합 E2E는 F6a2로, S2·F6b 통합 뒤 이 job을 확장해 검증한다(§8). F6a1의 독립 이미지 검증은 1~6단계이며 이 단계에서 미구현 auth 화면을 요구하지 않는다.

**`deploy.yml` (F6c, dev만 바꾸고 production job은 불변)**

| job | 조건 | 권한·secret | 하는 일 | 하지 않는 일 |
|---|---|---|---|---|
| `validate`(기존) | push·PR | `contents: read` | 계약 시험·Compose 문법 | — |
| `build-dev-app`(신규) | push to `dev`만 | `contents: read`, **`packages: write`(이 job에만, 최소 추가 권한)**. environment 없음, 배포 secret 없음 | checkout(`persist-credentials: false`) → 빌드 → 이미지 단언 → `GITHUB_TOKEN`으로 GHCR push → outputs `sha`·`tree`·`manifest_digest`·`config_digest` | 배포·SSH |
| `deploy-dev-app`(신규) | `needs: [validate, build-dev-app]` | `environment: dev`, 기존 dev SSH secret | outputs 형식을 정규식으로 검사 → SSH `probe dev` → `deploy-app dev <sha> <tree> <manifest_digest> <config_digest>` | **checkout 없음, 저장소 Dockerfile·스크립트·npm 실행 없음** |
| `deploy`(기존) | push to `main` | `environment: production` | 정적 `deploy production <sha>` | 불변 |

- **같은 run 연결:** deploy job은 `needs.build-dev-app.outputs`만 쓴다. 다른 run·다른 branch의 artifact나 이름 기반 선택은 없다.
  - `sha`가 `github.sha`와 다르면 job이 실패한다.
  - 서버 helper는 tree·manifest/config digest 연결을 다시 대조한다. 엔진 image ID는 서버에서 얻는다.
- **actions:** 새 marketplace action 없이 runner의 docker CLI·`docker login --password-stdin`을 쓴다. A안을 택하면 `actions/upload-artifact`·`download-artifact`를 공식 tag의 commit SHA로 고정하고, 같은 run의 artifact ID와 sha·tree·image ID를 연결해야 한다.
- **PR:** 배포 secret 0, `packages: write` 없음(`app-image` job만 실행).
- **메인 범위 결정:** 사용자 요청의 이 서비스 dev 앱 전환과 기존 dev 자동배포 범위에서 위 단일 build job의 `packages: write`와 공개 소스에 대응하는 앱 이미지 패키지 하나만 준비한다. 새 PAT·서버 registry 자격·다른 서비스/production 권한은 추가하지 않는다. 코드·CI·이미지 검증 뒤 F6c 전환을 수락한다. 공개 설정을 현재 인증으로 수행할 수 없으면 그 구체 항목만 사용자에게 전달하며 인증 범위를 임의로 넓히지 않는다.
- **전환 순서:** F6c는 F6a·F6b·S2(B4) 통합과 §9의 1~7이 끝난 뒤 병합한다. 그 전까지 dev push는 기존 정적 배포를 쓴다.

## 8. 게시 기준

| 구분 | 확인 | 장소 |
|---|---|---|
| 단위(RED) | §6 함수 전부: 문법(dev 키만, production 거부, app 모드의 `deploy dev` 거부), env 키·값·오류에 값 없음, 이미지 검사, compose 정확 일치, nginx 상수(허용 경로·고정 헤더·`$host` 미사용), 앱 기록 경로 필드 금지·동결 env 검증·회전 시 새 릴리스, **`validated_dev_tree`의 앱 기록 거부**와 정적 같은 tree 허용 유지, 기존 static·production 상수 불변 스냅샷. A안이면 §6.6 archive 사례 | `tests/test_deploy_app.py`(신규), `tests/test_deploy.py` 회귀 |
| 이미지 | §7 `app-image` job | CI |
| 조합 E2E(운영 이미지) | **(a) 공급자 미설정:** `/login` "준비 중", POST `/auth/logout`은 Origin 유무와 무관하게 **503**(B2 계약: 설정 오류가 Origin보다 먼저)<br>**(b) 가짜 HTTPS 구성**(PROVIDERS=google, 가짜 자격, PG18): Origin 없음 → 403, 정확한 Origin → 303<br>**공통:** preview E2E 10(nginx 경유), `/try/` 기록 → `/` 방문 → `/try/`에서 유지, `/try`·`/try/`·`/design/d-warm-pieces/` 응답이 현 정적 이미지와 같음, `/dev/konva-smoke`·`/healthz` 404, Host 위조에도 Location 기준 `https://dev.pieceofdays.com`, `/login`·`/` `no-store` | CI. OAuth 흐름 자체는 S2의 mock E2E(`next dev`)가 증명한다(운영 이미지는 mock을 거부) |
| 서버 게시 | §6.7 8단계 자동 검증 + 메인 독립 확인: 정확 SHA·두 image ID·digest, `/try/` 기존 기록 유지, `/login`, Google 실로그인(B5) 뒤 `__Host-pod_session` 속성, 로그아웃, 콜백 오류 안내 | dev 서버 |

- 정적 dev 성공은 앱 모드의 근거가 아니다. 앱 모드의 첫 성공 기록이 생겨야 G2 게시다.

## 9. 메인 서버 작업 (비공개 런북)

1. 공용 PG18에 dev 전용 DB·role 준비(§3), `pod_meta.db_environment` 행 작성.
2. **migration gate:** 배포 전에 migrator 자격으로 같은 이미지에서 실행한다.
   ```
   docker run --rm --read-only --user ‹deploy_uid›:‹deploy_gid› --cap-drop ALL --security-opt no-new-privileges --network ‹db_network› -v ‹migrator_env_file›:/run/secrets/migrator.env:ro <image@digest> node --env-file=/run/secrets/migrator.env src/server/db/migrate-cli.ts status
   ```
   그다음 `up`, 다시 `status`. 적용 버전이 이미지 라벨 `pod.migrations.latest`와 같아야 배포한다. 공유 호스트에서 npm·source를 실행하지 않는다.
3. `‹app_env_file›` 작성(0600, §6.3 규칙). 값은 채팅·Cloud·저장소에 남기지 않는다.
4. egress 범위, 서버 아키텍처, nginx·node·dockerfile frontend digest 고정값을 확인한다.
5. 서버 docker daemon이 `ghcr.io`에 익명 pull할 수 있는지 확인한다. GHCR 패키지 공개 설정은 저장소 소유자가 한다.
6. F6b helper를 검토해 설치본에 수동 반영하고, config dev 항목을 추가한다(production 항목 불변).
7. dev 접근 제한 방식이 OAuth callback·쿠키와 호환되는지 확인한다 [미확인].
8. DB 백업 등급·RPO·RTO와 동결 env 스냅샷의 백업 처리는 런북에서 따로 정한다. 공용 nightly 백업이 있어도 서비스 restore probe까지 증명된 것은 아니다. 이 계획은 승인됐다고 쓰지 않는다.

## 10. 복귀

| 상황 | 동작 |
|---|---|
| 첫 앱 배포 실패 | 직전 **정적** 기록으로 `--remove-orphans` 복귀(앱 컨테이너 제거) → 정적 검증 |
| 이후 앱 배포 실패 | 직전 **앱** 릴리스(두 image ID·동결 env·compose)로 복귀 |
| 앱 모드 끄기 | `revert-static dev` → 그 뒤 `deploy.yml` dev를 정적으로 되돌리는 PR |
| DB | 되돌리지 않는다. 확장 단계 migration만. 원장 삭제 없음 |
| `/try/` | 파일·origin·키 불변 |
| 중단된 배포 | 기존 pending 복구를 두 기록 형식에 적용 |

## 11. slice·의존·파일 소유

| slice | 파일 | 선행 | 병행 |
|---|---|---|---|
| **F6a1 앱 이미지** | RED: `app/tests/unit/runtime-health.test.ts`·`app/tests/unit/db-pool.test.ts`·`app/tests/image-contract.test.mjs`(실제 이미지 검사). GREEN: `app/Dockerfile`, `app/.dockerignore`, `app/runtime-startup.mjs`, `app/next.config.ts`(`output` 1줄), `app/src/server/db/pool.ts`(Pool 옵션), `app/src/app/healthz/route.ts`, `app/src/app/healthz/ready/route.ts`, `.github/workflows/app-validation.yml`(`app-image` job 1~6단계) | 없음 | S1·S2·S3·F6b |
| **F6a2 프록시 조합** | §8의 프런트+앱 E2E 시험·app-image job 확장. 정확 시험 파일은 S2/F6b 통합 SHA의 helper 상수를 읽고 RED 전에 main이 고정 | S2·F6b·F6a1 통합 | S3b |
| **F6b helper** | RED: `tests/test_deploy_app.py`·`app/tests/deploy-env-parity.test.mjs`. GREEN: `scripts/ops/deploy.py`(기존 static·production 동작 불변, §6.5 거부 추가)·`.github/workflows/deploy-app-validation.yml`(Node env 대조 전용) | 없음 | F6a |
| **F6c 배포 전환** | `.github/workflows/deploy.yml`(dev job 분리, production 불변). `docker-compose.dev.yml`은 그대로(앱 compose는 helper 템플릿) | F6a1·F6a2·F6b·S2 통합, §9 1~7 | — |
| **G2** | — | F6c, S2(B4) 통합, B5 Google, 사용자 콘솔 | — |

- 상태 문서 갱신 대상은 `README.md`·`app/README.md`·`deploy/README.md`·`CHANGELOG.md`·관련 계획이다. 통합 단계에서 메인·문서 담당이 한다.
- `AGENTS.md`·`CLAUDE.md`·skill은 사용자의 명시 승인 없이 수정하지 않는다.
- RED 파일은 `.claude/tdd.conf`의 TEST_PATTERNS 안에 둔다. 공유 서버에서는 시험·빌드·FullCheck를 실행하지 않는다.

## 12. 남은 입력·미확인

- **사용자(콘솔, 값은 채팅으로 받지 않음):** Google dev OAuth 클라이언트, redirect `https://dev.pieceofdays.com/auth/google/callback`(계획안), 테스트 사용자. Kakao는 B5 이후.
- **메인:**
  - B안·CI 단일 build job의 `packages: write` 범위는 R2에서 메인이 선택. 실제 공개 설정 가능 여부는 확인 필요
  - 서버 아키텍처·egress·익명 pull 가능 여부
  - digest·DB 연결 예산·Pool 수치는 R2 확정값 사용, CI에서 실제 동작 확인
  - 접근 제한 호환
  - 백업 등급
- **[미확인] (모두 F6a·F6b CI에서 확인):**
  - `--network=none` 빌드
  - read-only 쓰기 경로
  - standalone trace의 `pg`
  - `docker save` 형식(A안일 때만)
  - unprivileged nginx
- **이 작성자가 하지 않은 것:** 코드·시험·npm·Next·Docker·DB·서버·FullCheck 실행, `docker save` 형식 실측. Cloud에는 `_template`·`hc`·서버가 없어 읽거나 실행하지 않았다.

## 13. R0 → R1 대응 (메인 요청 2026-11-05)

| 지적 | 대응 |
|---|---|
| P1-1 `docker load` 부작용 | 전달 방식을 B(GHCR digest 익명 pull)로 바꿔 권장. A는 §6.6 load 전 archive 검증 계약과 CI에서 고정한 단일 형식이 있을 때만. 서버 pull 자격 단정은 정정(공개 패키지는 익명). `packages: write`는 build job 최소 추가 권한으로 명시 |
| P1-2 job 분리 | §7: build job(secret 0, environment 없음)과 deploy job(checkout·소스 실행 0, SSH secret만), 같은 run의 outputs만 연결, PR secret 0 |
| P1-3 env 동결 | §6.4: 릴리스별 0600 동결 env, 경로 없는 기록(`release_id`), 읽기 검증, 그 릴리스 env로 복귀, 회전은 새 릴리스, 스냅샷 백업·아티팩트 제외 |
| P1-4 운영 경계 | §6.5: 앱 기록은 production 근거로 명시 거부, 정적 같은 tree 허용 유지 |
| P2 연결 예산 | §3: role 수와 접속 예산 구분, 메인 계산. §1·§4: 현재 Pool이 기본값(최대 10, 대기 timeout 없음)이라는 소스 사실과 명시 설정 제안 |
| P2 migrate 경로 | §4: 원래 상대 배치 유지, 고정 명령, `pg` 포함 CI 실측과 필요 시 명시 COPY |
| P2 readiness | §4: Pool과 분리한 단발 연결 2초 deadline, 쓰기 없음, migration 증거 아님. §9: 별도 migration gate |
| P2 E2E 구분 | §8 (a) 설정 없음 503 / (b) 가짜 HTTPS 구성 Origin 403·303 |
| P2 Node | 기존 26.13.0 유지 |
| P2 문서 범위 | §11: AGENTS·CLAUDE·skill 제외 |

## 14. R2 메인 보완·확인 (2026-11-05)

- R1 독립 검토 P1-1: Node env 파서와 동일한 값이 되는 부분집합을 §6.3에 고정하고 실제 Node 대조를 RED/CI에 추가했다.
- P1-2: GHCR 단일 플랫폼 manifest·config blob digest·엔진 image ID를 분리했다. 메인이 현재 서버의 containerd image store와 amd64를 읽기 전용으로 확인했다. 저장소 모드를 바꾸지 않는다. opaque 엔진 ID를 로컬 복귀·컨테이너 대조에 쓰며 config digest와 같다고 가정하지 않는다.
- 메인 조회한 공식 registry의 amd64 manifest 고정값: Node `26.13.0-bookworm-slim@sha256:cd820d60a7f3ae057389f3e1bcf1a0ac09dd57c428fe14f191dcbc5c56ac5fe2`, nginx `stable-alpine@sha256:84ed8c0dd296c188bfc24ed506f46589e9285fb0b11cf3a04d91d524d3067e11`, Dockerfile frontend `1@sha256:7b32114e84ca21aeb2d6f871a0b62b3a0762193f75d9afd048ee4cbe889f3148`(2026-11-05 `docker manifest inspect --verbose`, linux/amd64 항목). F6a/CI는 같은 원문과 실제 동작을 확인한다. 기존 static/production Dockerfile은 그대로 둔다.
- P2: app role6/Pool5/readiness1·migrator2·purge1(미활성) 예산, 전체 readiness 2초 deadline과 소켓 정리, 기대값 config 키·실행 uid/gid 출처, migrator 실행 최소 권한, S2 선행, `/status/` 보존과 Next 링크를 고정했다.
- dev 앱 모드 동안 main 자동배포는 기존 정적 검증을 넓히지 않고 거부된다. 운영 정적 반영이 필요하면 `revert-static dev` → 해당 tree의 정적 dev 성공 확인 → main 병합 순서다. 실제 운영 앱 전환은 별도 요청·계획이며 현재 준비중 운영은 유지한다. 이 영향을 F6 통합 때 `deploy/README.md`에 기록한다.
- 앱의 `0.0.0.0:3000`은 연결된 내부 네트워크에서도 접근 가능하다. host port는 없고 각 route/action의 인증·Origin 검사로 보호한다. DB망을 인터넷 경계로 오인하지 않으며 기존 공용 네트워크·방화벽은 임의 변경하지 않는다.
- 공식 근거: [GHCR 공개 이미지 익명 접근](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Node 26 env-file](https://nodejs.org/api/cli.html#--env-filefile), [Next standalone 출력](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)(2026-11-05 조회). 설치 버전은 바꾸지 않는다.
