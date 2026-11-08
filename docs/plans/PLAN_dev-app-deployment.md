# PLAN — F6-dev: 개발 도메인에 Next 앱 배포 (S4) — R4

- **2026-11-08 통합 상태:** PR59 R4의 독립 계획 PASS를 수락했고 C1/C2 트리거 단언을 구분했다. PR60 F6b 소스와 PR65 F6a2 검증을 통합했다. F6a2 exact `03b4182`는 격리 CI에서 같은 불변 이미지 ID의 이미지6·프런트14·원문 preview10 전부를 통과했다. F6c1 구현·실제 이미지 게시·서버 설치/DB·OAuth·C2 전환은 아직 남아 있다. 아래 작성 당시 사실과 현재 구현은 README·해당 PR의 정확 SHA를 함께 대조한다.

- **상태:** R2 계획이다(2026-11-05). R1(`4c3fb8a`) 독립 검토의 P1 2건과 운영 예산·deadline을 메인이 보완했다(§14).
  - **R3 초안(F6c 부트스트랩·같은 SHA 검증):** §7·§9·§11·§15를 고쳤다. F6c를 F6c1(게시만)·F6c2(dev 앱 전환)로 나눈다. R3는 메인 결정 Q1~Q4(2026-11-05)를 반영했다. **R4는 R3 독립 검토(P1 2·P2)를 메인이 수락한 결정을 반영했다(§15.1):** 불변 artifact 연결 알고리즘, F6a2 무조건 선행, C1 완료 판정, dev 앱 배포 전용 concurrency. 재검토 전이며 구현은 없다. F6a1·F6b 고정 계약(§4~§6: 모드·helper·env)은 바꾸지 않았다.
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
    - `setTimeout`으로 전체 2초 타이머와 connect/query 작업을 경합시키고 만료 시 즉시 고정 503을 반환한다. 모든 경로에서 타이머를 해제하고 client 종료를 시작한다. `client.end()` 대기로 응답 deadline을 늘리지 않으며 종료 거부·late rejection은 처리해 원문 로그·unhandled rejection을 남기지 않는다. 연결/쿼리 정리와 남은 소켓 0을 격리 시험한다.
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

- 키: `app_mode_enabled`, `app_env_file`(‹app_env_file›, live 원본), `db_network`(‹db_network›), `app_health_url`(`https://dev.pieceofdays.com/try/`), `app_role`·`db_host`·`dev_db`(URL 검사의 기대값), `server_arch`(정확히 `amd64`), `front_subnet`·`egress_subnet`(비공개 고정값). uid:gid는 요청/config에서 받지 않고 실행 사용자의 `os.getuid()/getgid()`만 쓰며 0이면 거부한다.
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
- 전용 front·egress 네트워크에는 각각 `ipam:{config:[{subnet:settings의 고정값}]}`을 둔다. 두 값은 정규화된 RFC1918 IPv4 /24이고 서로 겹치지 않는다. 기본 주소 풀 소진에 의존하지 않으며 기존 이름의 전용 네트워크가 있으면 IPAM 불일치 시 수정하지 않고 거부한다. 공용 edge·DB망은 외부 참조를 유지한다. 실제 값은 메인이 호스트/다른 네트워크와의 비중첩을 확인해 비공개 설정에만 넣고 적용 직전에 재확인한다.
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

**`app-image-validation.yml` — 전용 `app-image` job 추가(F6a)**

- app 경로·해당 workflow를 바꾸는 PR 및 dev/main push에서 실행한다. 기존 `app-validation.yml`의 auth-e2e job과 파일 소유가 겹치지 않도록 전용 workflow로 둔다. 권한은 `contents: read`, Secrets·environment 없음, 이미지 push 없음.
- 단계:
  1. BuildKit 빌드
  2. `validate_app_image`와 같은 조건 단언(RepoDigests 제외)
  3. `.env*`·`tests/` 부재 확인
  4. network-none·read-only 후보로 `/healthz` 200, `/healthz/ready` 503
  5. PG18 서비스 + 가짜 env로 `/healthz/ready` 200
  6. 이미지 안 `migrate-cli.ts status`·`up`을 실제 PG18에 실행
  7. 프런트+앱 조합 E2E는 F6a2로, S2·F6b 통합 뒤 이 job을 확장해 검증한다(§8). F6a1의 독립 이미지 검증은 1~6단계이며 이 단계에서 미구현 auth 화면을 요구하지 않는다. **F6a2는 F6c1의 무조건 선행이다(§7.1·§11).**

**F6c: 게시(F6c1)와 전환(F6c2)을 나눈다 [R3, 메인 결정 반영]**

나누는 이유:
- §9의 migration gate는 **게시된 앱 이미지(digest)**로 먼저 실행해야 한다.
- R2처럼 같은 push에서 게시와 dev 배포를 함께 하면, migration을 실행할 이미지가 배포 순간에야 생긴다(순환).
- 그래서 먼저 게시만 하는 단계를 두고, 메인 준비가 끝난 뒤 전환한다.

#### 7.0 공통 job `workflow-contracts` (F6c1부터)

`deploy.yml`에 workflow 구조 계약 시험 job을 둔다(§7.3).

| job | 조건 | 권한·secret | 하는 일 |
|---|---|---|---|
| `workflow-contracts`(신규) | push·PR | `contents: read`. secret·`packages` 권한·environment 없음 | 고정 commit의 checkout(`persist-credentials: false`)·setup-node 26.13.0 → `npm ci --ignore-scripts`(app) → `node --test tests/deploy-workflow.test.mjs`. tap 요약에서 0건·skip이면 실패 |

기존 정적 `deploy` job은 `needs: validate` 그대로 둔다. production 경로는 이 job을 기다리지 않는다.

**허용 action 집합(메인 결정, 정확히 이 3개 commit):** 저장소에 이미 있는 고정값만 쓴다.
- `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`(v4, 루트 `deploy.yml`의 기존 `validate`)
- `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803`(v6, 새 job에 사용)
- `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38`(v6.5)

새 job은 v6 checkout·v6.5 setup-node를 쓴다. 이 밖의 action·tag 참조·marketplace action은 없다.

#### 7.1 F6c1 — dev push에서 이미지 게시만 (기존 정적 dev 자동배포 유지)

| job | 조건 | 권한·secret | 하는 일 | 하지 않는 일 |
|---|---|---|---|---|
| `build-dev-app`(신규) | `github.event_name == 'push' && github.ref == 'refs/heads/dev'`, `needs: [validate, workflow-contracts]` | job 수준 `permissions: {contents: read, packages: write}`(R2에서 승인한 단일 publisher 권한). workflow 수준은 `contents: read` 그대로. environment·배포 SSH secret 없음 | 아래 단계 | SSH·배포 |

**`build-dev-app` 단계 (순서 고정, R4 불변 artifact 연결)**

모든 단계는 실패하면 닫힌다(fail closed). 캐시·우회·"알 수 없는 저장소면 건너뜀"은 없다.

1. **checkout·SHA 확인:** v6 고정 checkout, `persist-credentials: false`. `git rev-parse HEAD`가 `github.sha`와 같아야 한다.
2. **준비:** setup-node(v6.5 고정) 26.13.0, `npm ci --ignore-scripts`. `docker version`의 서버 버전과 `docker info`의 저장소 종류(image store·storage driver)를 기록한다.
3. **로컬 빌드(registry 접근 없음):**
   - 명령: `docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load --metadata-file <tmp>/meta.json -t <로컬 임시 tag>`
   - 라벨은 이 checkout의 `sha`·`tree`·latest migration이다.
   - metadata에서 `containerimage.config.digest`를 읽는다. 키가 없거나 `sha256:<64 hex>`가 아니면 실패한다. 이 값을 **M**이라 한다.
4. **불변 이미지 ID 확정:**
   - 빌드 **뒤에** `docker image inspect --format '{{.Id}}' <로컬 임시 tag>`로 실제 로컬 image ID를 얻는다. 이 값을 **ID**라 한다(`sha256:<64 hex>` 아니면 실패).
   - 이후 시험·export·tag는 모두 tag가 아닌 **ID**를 대상으로 한다. 엔진 ID가 config digest와 같다고 가정하지 않는다(§14).
5. **ID → config 증명(Docker 저장소와 독립):**
   - `docker image save <ID> -o <tmp>/tested.tar`로 정확히 그 ID만 임시 archive에 내보낸다.
   - Python stdlib `tarfile`로 **필요한 멤버만 이름으로 읽는다**(`extractall`·디스크 추출 없음, 링크·절대경로·`..` 멤버는 읽지 않고 실패).
   - 지원 형식: 최상위 `manifest.json`이 **항목 정확히 1개**이고 그 `Config`가 archive 안 정규 파일 1개를 가리키는 형식. 다음이면 실패한다: `manifest.json` 없음, 항목 0개·2개 이상, `Config` 키 없음, 가리키는 멤버 없음, config JSON의 `os`/`architecture`가 `linux`/`amd64`가 아님(플랫폼 모호), 그 밖의 모르는 배치.
   - `sha256(config 바이트)` = **C**. **C == M**이어야 한다. 이 값을 **시험한 config digest**로 쓴다.
   - config의 라벨 `pod.migrations.latest`가 checkout에서 계산한 latest migration과 같아야 한다. output `migrations_latest`는 **이 시험한 이미지의 라벨 값**을 쓴다.
   - 실제 CI 시도로 archive 형식·metadata 형식·runner 저장소 종류를 확인하기 전에는 "지원"이라고 주장하지 않는다. 확인된 형식 밖이면 실패한다.
6. **필수 이미지 검사(같은 ID, registry login 전):** `POD_IMAGE_TEST_IMAGE=<ID>`(변하는 tag 아님)로 모든 시험을 실행한다.
   - **(a) F6a1 실제 이미지 시험 6건:** `tests/image-contract.test.mjs`, PG18 서비스. tap 요약이 6/6/0/0/0/0이어야 한다.
   - **(b) F6a2 실제 front+app 조합 검사 전부(무조건):**
     - 실제 프록시 HTTP·개인정보(헤더·no-store·Host 위조) 사례와 `/try/` 기록 보존 사례(§8 조합 E2E)
     - 기존 preview E2E 10건을 **변경 없이** 실제 front(nginx) 경유로 실행
   - (b)의 고정 명령은 app 작업 디렉터리의 `node --test --test-reporter=tap tests/front-contract.test.mjs`다(F6a2 PR65, 2026-11-08 수락). 내부에서 `playwright.front-preview.config.ts`를 써 원문 preview10을 실행한다. F6a1과 같은 `POD_IMAGE_TEST_IMAGE` 불변 ID·일회용 PG18/network 계약을 사용한다. front14/pass14·preview10/pass10·fail/skip/cancel/todo0을 모두 확인한다.
   - 이름 붙은 필수 계약: **"게시 job은 F6a2의 조합 검사 명령을 하나도 빼지 않고 같은 ID로 실행한다."**
   - 시험 뒤 `docker image inspect <ID>`가 여전히 같은 ID를 돌려줘야 한다.
7. **게시:**
   - push용 tag `ghcr.io/kindsr/devscent-pieceofdays-main-app:dev-<sha>`를 **ID에서** 만든다(`docker tag <ID> <tag>`).
   - push 전에 `docker image inspect --format '{{.Id}}' <tag>`가 **ID**와 같아야 한다.
   - token은 `docker login ghcr.io --password-stdin` 단계의 env에만 명시해 넘긴다. 그 뒤 push한다.
   - push 뒤 `docker image inspect`의 `RepoDigests`에서 **이 repo(`ghcr.io/kindsr/devscent-pieceofdays-main-app`) 항목만** 고른다. `@sha256:<64 hex>` 참조가 **정확히 1개**여야 한다. 이 값이 **manifest digest D**다.
   - `docker buildx imagetools inspect --raw <repo>@D`로 다음을 확인한다.
     - 단일 manifest(index 아님)다. mediaType을 기록한다.
     - 원문 바이트 sha256 == D.
     - `.config.digest` == C == M.
   - 정리: `docker logout ghcr.io`를 하고 runner의 docker 설정 파일을 지운다.
8. **outputs·run summary:**
   - outputs: `sha`, `tree`, `manifest_digest`(D), `config_digest`(C), `migrations_latest`. 마지막 단계에서만 쓰고 모두 정규식을 통과해야 한다.
   - run summary: Docker 서버 버전·저장소 종류, metadata 키 목록, 시험한 ID, config hash C(= M), push mediaType, manifest digest D, `migrations_latest`. 비밀값·서버 경로는 없다.

**재실행·tag 덮어쓰기**
- 같은 SHA를 재실행하면 3~7을 **처음부터 다시** 한다(다시 빌드·새 ID·전체 시험). 이전 run의 로컬·registry 이미지를 재사용하지 않는다.
- config 검사를 모두 통과한 경우에만 push한다. `dev-<sha>` tag는 덮어써질 수 있다. 배포·증명의 기준은 tag가 아니라 **그 run의 digest D와 config C**다.

**권한 경계와 잔여 위험(메인 수락)**
- 이 job은 `npm ci`·빌드·시험으로 저장소 코드를 실행한다. 같은 job에 `packages: write` `GITHUB_TOKEN`이 있다.
- **단계 순서는 격리가 아니다.** 같은 job의 저장소 코드가 token에 닿을 수 있는 잔여 위험을, 검토를 거친 dev publisher와 이 저장소 `GITHUB_TOKEN` 범위 안에서 **명시적으로 수락**한다.
- 그 범위 안에서 하는 것:
  - 배포 SSH secret은 이 job에 없다(environment 없음).
  - token은 login 단계 env에만 명시하고 `persist-credentials: false`로 둔다.
  - logout·설정 파일 삭제를 한다.
  - 시험한 ID → archive config C → metadata M → 게시 manifest config가 모두 같아야 한다.
- PR에는 `packages: write`를 주지 않는다. 사전 push 증거를 얻으려고 dev 밖의 게시 branch를 추가하지 않는다. 더 넓은 격리 설계는 범위 밖이다.

**GHCR 패키지**
- 현재 이 이름의 기존(연결 안 된) GHCR 패키지는 없다고 본다. 첫 게시가 패키지를 만들며 **기본 비공개**다.
- 공개 전환은 사용자 또는 현재 인증으로 한다(§9-A 2). PAT·scope 확대는 없다.

**C1 gate 순서(메인 결정)**
- **PR 소스 수락:** 구조 시험(§7.3)과, PR secret 0으로 할 수 있는 로컬 빌드 + export 연결(3~6, push 없음) 확인까지다. PR 수락은 운영 C1 수락이 아니다.
- **첫 검토된 dev push = C1 후보 게시**(기존 승인 범위). 첫 dev 시도는 실패해 닫힐 수 있다. 그때도 기존 정적 dev 배포는 그대로 동작한다.
- **C1 완료:** 실제 dev 게시 run 기록에 D·C·M·ID·mediaType이 모두 있고 7의 대조가 통과했을 때만이다.
- **F6c2는 이 완료 증거 전에 시작·활성화하지 않는다.**

**F6c1에서 같은 SHA 검증 범위**
- 자동으로 묶이는 것: `validate`·`workflow-contracts`와 6의 이미지·조합 검사.
- `app-validation.yml`은 아직 별도 workflow다. 게시만 하고 활성화하지 않으므로 안전하다.
- 메인은 §9-B 2의 수동 migration 전에 같은 SHA의 `app-validation` push run 성공을 확인한다.

**`app-image-validation.yml`의 dev push 트리거(Q2)**
- F6c1에서 제거할 수 있는 조건: 게시 job이 그 workflow의 **모든 명령**과 F6a2 조합·프록시·preview 10을 같은 ID로 실행할 때.
- 하나라도 빠지면 dev push 트리거를 유지한다. PR 트리거는 항상 유지한다.
- `preview-validation.yml`은 따로 호출하지 않는다(Q4). F6a2가 같은 10건을 실제 front에서 더 엄격하게 실행하기 때문이다.

#### 7.2 F6c2 — 같은 SHA의 필수 검증을 모두 기다린 뒤 dev 앱 전환

**선택: 재사용 workflow(`workflow_call`)**

| 기준 | 재사용 workflow(선택) | Actions API 조회 gate |
|---|---|---|
| 같은 SHA | 같은 run 안에서 caller의 `github.sha`·checkout으로 실행 | `head_sha`·event·workflow 조회. PR·merge ref와 혼동할 위험 |
| path filter | `workflow_call`에는 path filter가 없다. 문서만 바뀐 push도 항상 실행·판정 | 문서 push에는 대상 run이 없다. 무한 대기하거나 "없음=성공"이 된다 |
| 권한·secret | 호출 job은 `contents: read`, secret 전달 없음 | 배포 쪽에 `actions: read`와 polling이 필요 |
| 외부 action | 없음 | 없음 |

**`deploy.yml`(F6c2)**

| job | 조건 | 권한·secret | 하는 일 | 하지 않는 일 |
|---|---|---|---|---|
| `validate`·`workflow-contracts` | push·PR | `contents: read` | 7.0과 같다 | — |
| `app-checks`(신규) | push to `dev`만 | `permissions: {contents: read}`, `uses: ./.github/workflows/app-validation.yml`, `secrets` 없음 | `app-validation.yml`의 **필수 job 전부**를 같은 SHA로 1회: Node 24/26 `app`(lint·typecheck·unit·build·빌드 경계·fixture 거부·prod smoke·E2E), `db`, **`auth-e2e`(현재 20건, 이후 S3b 기록 사례 포함)**, 그때 파일에 있는 그 밖의 모든 job. **callee의 어떤 job도 `if`로 건너뛸 수 없다**(§7.3 단언) | 배포 |
| `build-dev-app` | push to `dev`, **`needs: [validate, workflow-contracts, app-checks]`** | 7.1과 같다 | 7.1과 같다(불변 ID 연결 + 6의 필수 검사 전부 + 게시) | SSH |
| `deploy-dev-app`(신규) | push to `dev`, `needs: [validate, workflow-contracts, app-checks, build-dev-app]` | `environment: dev`, 기존 dev SSH secret, **`concurrency: {group: pieceofdays-dev-app-deployment, cancel-in-progress: false}`**, **`timeout-minutes: 30`** | 아래 migration 확인 → outputs 정규식·`sha == github.sha` → SSH `probe dev` → `deploy-app dev <sha> <tree> <manifest_digest> <config_digest>` | checkout, 저장소 Dockerfile·스크립트·npm·docker build 실행 |
| `deploy`(기존 정적) | **push to `main`만**(dev 조건 제거), `needs: validate` 그대로 | `environment: production` | 정적 `deploy production <sha>` | 단계·secret·명령 불변 |

**migration 승인 gate (Q1, 메인 결정)**
- 저장소 변수(secret 아님) `POD_DEV_APPROVED_MIGRATIONS`가 승인된 최대 migration 버전이다.
- **저장소 수준에만 둔다.** `deploy-dev-app`는 `environment: dev`를 쓰므로 같은 이름의 dev environment 변수가 있으면 그 값이 우선한다. 같은 이름의 environment 변수를 만들지 않으며, 메인이 활성화 전에 dev environment에 그 이름이 없음을 확인한다(§9-A 3).
- `deploy-dev-app`는 SSH 전에 다음을 검사한다.
  - 값이 `^[1-9][0-9]*$`가 아니거나 미설정이면 실패한다.
  - `migrations_latest`(같은 run 게시 job output, 양의 정수)가 그 값보다 크면 실패한다.
- 메인은 그 SHA의 게시 digest로 `status → up → status`를 끝낸 뒤에만 이 변수를 처음 만들거나 올린다. DB 변경은 확장(additive)만이다. 자동 migration·down은 없다.
- **표준 절차:** 변수를 올린 뒤 tree가 같은 새 dev push(필요하면 빈 commit)를 만든다. 그 새 run에서 모든 검사·outputs·변수 평가가 처음부터 이뤄진다.
- **실패 job 재실행:** 재실행 때 `vars` 재평가가 실제로 증명된 뒤에만 허용한다. 첫 활성화의 조건은 아니다.
- 변수 조회에 Actions API·추가 권한은 쓰지 않는다(`vars` 문맥).

**`app-validation.yml`(F6c2, 같은 PR에서 함께 바꾼다)**
- `on.workflow_call: {}`을 추가한다(inputs·secrets 없음).
- `push.branches`를 **`[main]`**으로 줄인다. `pull_request`는 그대로다.
- 이 파일은 B4(auth-e2e) 담당과 겹친다. F6c2 착수 전에 메인이 소유를 조정한다.

**concurrency·cancel**
- 호출된 workflow의 group `app-validation-${{ github.ref }}`(cancel true)는 caller의 dev ref로 평가된다.
- dev push 독립 트리거를 같은 PR에서 없애므로, 같은 group끼리 서로 취소하지 않는다.
- 더 새 dev push는 이전 run의 `app-checks`를 취소한다. 그러면 이전 run의 게시·배포는 `needs` 실패로 실행되지 않는다. helper `assert_latest`도 오래된 SHA를 거부한다.
- caller에는 workflow 수준 concurrency가 없어 caller·callee group 교착이 없다.
- **dev 앱 배포 전용 group `pieceofdays-dev-app-deployment`(cancel false)를 새로 둔다.** production `deploy`의 기존 `pieceofdays-deployment` group은 바꾸지 않는다.
- GitHub concurrency는 같은 group에 실행 중 1개와 **대기 1개**만 둔다. 새 run이 대기에 들어오면 기존 대기 run은 취소되고 가장 최근 것으로 바뀐다. 그래서 엄격한 FIFO가 아니며 중간 SHA는 배포되지 않을 수 있다(최신 SHA가 우선, helper `assert_latest`와 같은 방향).
- dev 앱과 production 정적 배포가 서로 다른 group이므로 GitHub 쪽에서는 동시에 돌 수 있다. 환경 간 직렬화는 실제 서버 helper의 `flock`이 한다. 이것도 순서 보장(FIFO)이 아니라 상호 배제다.

**C2 활성화 gate**
- §9-A 5의 조건과 함께, 실제 gateway에서 OAuth callback 호환이 안전함을 확인해야 한다: callback이 앱에 도달하고, 인가 code·state가 gateway·앱 로그에 남지 않는다.
- edge 설정 계획은 PR62(dev-edge-callback, 메인 준비)다. edge 한정 예외는 fixture 증명 뒤 사용자 승인이 필요하다. 바깥 edge의 실제 설정은 이 계획에서 바꾸지 않는다.
- 첫 C2 실제 run이 `app-checks`의 모든 callee job 실행·성공과 두 concurrency group 동작을 증명해야 C2 완료다. 구조 시험만으로 완료라고 하지 않는다.

**정적 dev와 `/try/`**
- C2 뒤 dev push는 정적 `deploy` job을 실행하지 않는다(정적 dev 갱신 중지). 정적 job은 main 전용이다.
- `/try/`·`/design/` 등 정적 front는 그 뒤 **현재 앱 배포의 front**(helper가 같은 SHA의 `frontend/`로 빌드, §5)가 제공한다.

**path filter·중복**
- `deploy.yml`은 path filter가 없다. 문서만 바뀐 dev push에서도 검사 → 게시 → 배포가 항상 판정된다. 건너뜀을 성공으로 세지 않는다.
- dev push에서 app 검사는 호출 1회, 이미지·조합 검사는 게시 job 1회다(F6a2 조합 검사 포함, 무조건).

**바뀌지 않는 것**
- PR 검사(`validate`·`workflow-contracts`·`app-validation` PR·`app-image-validation` PR·`preview-validation`)
- main push(`app-validation` 독립 run, 정적 production `deploy`, `needs: validate`)
- 없음: 새 marketplace action, `workflow_dispatch`, `pull_request_target`, PAT, 서버 registry 자격

#### 7.3 workflow 구조 시험 (Q3, 메인 결정)

- **RED:** 신규 `app/tests/deploy-workflow.test.mjs` 파일 하나만(node:test).
  - app lock에 이미 있는 `js-yaml`(4.3.2, `@eslint/eslintrc`의 dev 의존, 경로 `app/node_modules/js-yaml`, ESM export `dist/js-yaml.mjs`)으로 `deploy.yml`·`app-validation.yml`(·Q2 조건에 따라 `app-image-validation.yml`)을 파싱한다.
  - js-yaml 4는 YAML 1.2라서 `on:` 키를 문자열로 읽는다.
  - **새 dependency는 없다.** `js-yaml`을 못 불러오면 실패한다(skip 없음).
  - 기존 root stdlib 시험(`unittest discover`)에 PyYAML import를 넣지 않는다. 전역 패키지가 있다고 가정하지 않는다.
- **단언:**
  - 트리거, workflow·job 권한 집합, `if`, `needs` 집합, `environment`.
  - SSH secret은 `deploy-dev-app`·`deploy`에만 있다.
  - token 참조는 게시 job의 login 단계 env에만 있다.
  - `deploy-dev-app`에 checkout·npm·node·docker build가 없다.
  - `workflow-contracts`·`build-dev-app`의 checkout은 `persist-credentials: false`다.
  - action은 §7.0의 허용 집합 3개 commit만이다. `workflow_dispatch`·`pull_request_target`이 없다.
  - `deploy-dev-app`: group `pieceofdays-dev-app-deployment`·cancel false·`timeout-minutes: 30`. production `deploy`의 group은 `pieceofdays-deployment` 그대로.
  - `app-validation.yml`의 어떤 job에도 `workflow_call`·dev push에서 건너뛸 수 있는 `if`가 없다.
  - 게시 job: `POD_IMAGE_TEST_IMAGE`는 inspect로 얻은 ID 값이고 tag 문자열이 아니다. `docker image save`·config 대조·`RepoDigests` 단계가 login·push 단계 앞뒤의 정해진 순서에 있다. PR 조건에서는 `packages: write`·login·push가 없다.
  - 구조 시험은 실제 동작(archive 형식·concurrency·`vars` 우선순위)을 증명하지 않는다. 그것은 첫 실제 dev run의 기록으로 확인한다.
  - production `deploy`는 F6c2의 `if` 외에는 이전과 같고 `needs: validate`다.
  - F6c1에서는 기존 `app-validation` 트리거(`pull_request`·push `[dev, main]`, `workflow_call` 없음)를 유지한다. F6c2에서만 `workflow_call`(secrets 없음) 추가와 push `[main]` 전환을 단언한다. C1 RED가 C2 전용 변경을 미리 요구하지 않는다(2026-11-08 독립 검토 P2 보완).
  - migration gate의 정규식·비교가 SSH 단계보다 앞에 있다.
- **GREEN:** F6c1은 `deploy.yml`(+Q2 조건 충족 시 `app-image-validation.yml`)과 §7.1 5의 stdlib archive 검사 스크립트(경로는 RED 전에 메인이 고정), F6c2는 `deploy.yml`·`app-validation.yml`. 구현은 실제 CI run으로 확인한다.
- 이 계획 작업은 병행 중인 S3b UI 작업을 막지 않는다(파일 겹침 없음).

#### 7.4 C1 archive·manifest 검사 CLI (2026-11-08 메인 고정)

신규 `scripts/ci/verify-image-archive.py`는 Python 표준 라이브러리만 쓴다. 서버에서는 실행하지 않고 격리 CI가 입력 파일을 검사한다. RED는 `app/tests/deploy-workflow.test.mjs` 하나에 구조 계약과 의미 있는 archive/manifest 양성·음성 사례를 둔다.

- `archive --metadata FILE --archive FILE --sha SHA --tree TREE --migrations-latest N`: §7.1 5의 안전한 단일 Docker save archive에서 config 생바이트 C와 metadata M을 대조하고 플랫폼·source/revision/tree/migration 라벨을 확인한다. 디스크 추출은 없고 링크·절대/상위 경로·중복 멤버·중복 JSON 키·모르는 배치는 거부한다.
- archive 성공 JSON은 `{config_digest, migrations_latest, metadata_keys}`다. `migrations_latest`는 이미지 라벨에서 확인한 canonical 양의 정수 **문자열**(예: `"1"`)이며 CLI 입력과 같아야 한다. `metadata_keys`는 정렬된 문자열 배열이다. 0·음수·선행 0·지수·공백은 허용하지 않는다.
- `manifest --manifest FILE --manifest-digest D --config-digest C`: 원문 생바이트 hash D·단일 schema2 manifest·config C를 검사한다. 허용 mediaType/config/layer 형식은 기존 helper의 `validate_app_manifest` 계약과 같다. 성공 JSON은 `{manifest_digest, config_digest, media_type}`다.
- 두 명령의 실패는 종료1과 고정 `verify-image:` 진단만 내보내며 입력 원문·파일 경로는 출력하지 않는다. digest·SHA/tree·양의 버전 형식도 검사한다.
- RED의 음성 사례는 단순 script 부재·TypeError를 의도한 거부로 세지 않는다. PR의 local build/export 증거와 dev의 실제 게시 D/C/M/ID 증거는 계속 분리한다. 임시 RED 검증 workflow는 별도 verify branch에서만 쓰고 dev에 통합하지 않는다.
- app-image의 PR·dev push paths는 기존 `app/**`·자기 workflow에 `.github/workflows/deploy.yml`·`scripts/ci/verify-image-archive.py`·`scripts/ops/deploy.py`·`frontend/public/**`를 더한 정확한 6개다. PR trial 전체의 권한·environment·Secrets/token·registry login/push 부재와 허용 action을 RED에서 검사한다. 기존 dev push 검사는 유지한다.

#### 7.5 현재 CI의 실제 exporter 지원 확인 (2026-11-08)

PR70 exact `8c4ed8f`의 [격리 PR trial](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42483997649)에서 구조92·실제 archive C=M·같은 ID의 이미지6/프런트14/원문 preview10을 skip0으로 통과했다. 이 증거는 실제 GHCR 게시 D가 아니다.

- Docker29.4.2의 containerd image store에서 자동 load 경로는 필수 metadata M을 내보내지 않았다. M 누락을 허용하거나 ID를 C로 간주하지 않았다.
- 작업 전용 `docker-container` builder와 `moby/buildkit:v0.34.2@sha256:97719ccb2ac86fb44fd36f330a6d302f63dddd5326f3ada24f9c05ccac0d9098`(linux/amd64)를 명시한다. 고유 run/attempt 이름과 생성 성공 flag로 본인 builder만 정리하며 기존 default builder를 변경하지 않는다.
- 기존 build flags에 명시적 Docker file output을 더하고 그 **동일 파일을 실제 `docker image load`**한다. metadata M은 exporter의 원래 필드이며 합성하지 않는다. 이후 tag inspect의 ID → ID save archive → config C=M → 같은 ID 검사 흐름은 그대로다.
- 실측 Buildx v0.38.1·BuildKit v0.34.2에서 M이 존재하고 현재 Docker save의 단일 manifest/regular config 배치가 고정 CLI를 통과했다. 실제 engine ID와 C는 서로 달랐다. 다른 형식/버전에 대한 지원을 추정하지 않으며 필수 proof 실패 시 계속 게시를 거부한다.
- source·PR proof 독립 검토는 PASS다. 첫 dev 게시의 D/C/M/ID/mediaType·최종 outputs·credential cleanup을 확인하기 전에는 C1 완료나 C2 착수를 선언하지 않는다.

## 8. 게시 기준

| 구분 | 확인 | 장소 |
|---|---|---|
| 단위(RED) | §6 함수 전부: 문법(dev 키만, production 거부, app 모드의 `deploy dev` 거부), env 키·값·오류에 값 없음, 이미지 검사, compose 정확 일치, nginx 상수(허용 경로·고정 헤더·`$host` 미사용), 앱 기록 경로 필드 금지·동결 env 검증·회전 시 새 릴리스, **`validated_dev_tree`의 앱 기록 거부**와 정적 같은 tree 허용 유지, 기존 static·production 상수 불변 스냅샷. A안이면 §6.6 archive 사례 | `tests/test_deploy_app.py`(신규), `tests/test_deploy.py` 회귀 |
| 이미지 | §7 `app-image` job | CI |
| 조합 E2E(운영 이미지) | **(a) 공급자 미설정:** `/login` "준비 중", POST `/auth/logout`은 Origin 유무와 무관하게 **503**(B2 계약: 설정 오류가 Origin보다 먼저)<br>**(b) 가짜 HTTPS 구성**(PROVIDERS=google, 가짜 자격, PG18): Origin 없음 → 403, 정확한 Origin → 303<br>**공통:** preview E2E 10(nginx 경유), `/try/` 기록 → `/` 방문 → `/try/`에서 유지, `/try`·`/try/`·`/design/d-warm-pieces/` 응답이 현 정적 이미지와 같음, `/dev/konva-smoke`·`/healthz` 404, Host 위조에도 Location 기준 `https://dev.pieceofdays.com`, `/login`·`/` `no-store` | CI. OAuth 흐름 자체는 S2의 mock E2E(`next dev`)가 증명한다(운영 이미지는 mock을 거부) |
| 서버 게시 | §6.7 8단계 자동 검증 + 메인 독립 확인: 정확 SHA·두 image ID·digest, `/try/` 기존 기록 유지, `/login`, Google 실로그인(B5) 뒤 `__Host-pod_session` 속성, 로그아웃, 콜백 오류 안내 | dev 서버 |

- 정적 dev 성공은 앱 모드의 근거가 아니다. 앱 모드의 첫 성공 기록이 생겨야 G2 게시다.

## 9. 메인 서버 작업 (비공개 런북)

**사용자 확인(2026-11-05):**
- 실제 앱 로그인과 서버 저장(A안)을 원한다.
- Google·Kakao OAuth 키는 아직 준비되지 않았다. 메인이 비공개 안내를 전달했다.
- dev 데이터는 C등급으로 본다. 손실을 허용하고 RTO는 없다.
- 이 문서는 키 값·서버 경로를 쓰지 않는다.

**9-A. 순서(부트스트랩) [R3 제안]**

| 단계 | 내용 | 완료 판정 |
|---|---|---|
| 0 | F6a1(PR58)·F6b GREEN 통합 | 각 독립 검토 수락 |
| 1 | **F6c1 병합**(F6a2 통합 뒤) → 첫 dev push가 C1 후보로 `dev-<sha>`를 게시한다(§7.1 3~7). 실패하면 닫히고 정적 dev는 그대로다 | **C1 완료:** run summary에 ID·C=M·D·mediaType과 대조 통과. 같은 SHA의 `app-validation` push run 성공을 메인이 확인. 소스 통합만으로는 완료가 아니다 |
| 2 | 첫 게시로 생긴 비공개 패키지 1개를 저장소 소유자가 **public**으로 바꾼다. 현재 인증으로 할 수 없으면 그 항목만 사용자에게 요청한다(PAT·scope 확대 없음) | 서버에서 빈 `DOCKER_CONFIG`로 `docker pull <repo>@<digest>` 익명 성공(PAT·서버 registry 자격 없음) |
| 3 | 아래 9-B 1~7(DB·migration·env·helper 설치·네트워크). migration 뒤 **저장소 수준** 변수 `POD_DEV_APPROVED_MIGRATIONS`를 그 latest로 만든다. dev environment에 같은 이름 변수가 없음을 확인 | 9-B 각 항목, 변수 = 적용 버전 |
| 4 | OAuth dev 클라이언트 준비(사용자 콘솔, 값은 서버 env 파일로만). S2(B4) 통합 | §6.3 env 검사 통과, `/login` route 존재(§6.7 8단계) |
| 5 | C1 완료 증거 뒤 **F6c2 병합** → 다음 dev push에서 같은 SHA의 `validate`+`workflow-contracts`+`app-checks`+게시 job이 성공하고 migration gate를 통과하면 `deploy-app`. 활성화 전 실제 gateway callback 호환(§7.2 C2 gate, PR62) | §6.7 자동 검증 + §8 서버 게시 확인 + 모든 callee job·concurrency 실제 동작 |

- 1~4 동안 dev는 정적이다. 게시만 하고 활성화하지 않으므로 운영·dev 사용자 영향이 없다.
- F6c2를 되돌리면 dev는 다시 정적 push 배포가 된다. 그 전에 `revert-static dev`를 먼저 실행한다(§10).
- **OAuth 키가 없으면 F6c2 전환은 안 된다.** §6.3이 `POD_AUTH_PROVIDERS`와 자격을 필수로 요구하기 때문이다. 키 없이 앱을 먼저 띄우는 모드는 이 계획 밖이다(F6b 고정 계약 불변).

**9-B. 항목**

1. 공용 PG18에 dev 전용 DB·role 준비(§3), `pod_meta.db_environment` 행 작성.
2. **migration gate:** 9-A 1의 **게시된** 이미지 digest로 migrator 자격으로 실행한다.
   ```
   docker run --rm --read-only --user ‹deploy_uid›:‹deploy_gid› --cap-drop ALL --security-opt no-new-privileges --network ‹db_network› -v ‹migrator_env_file›:/run/secrets/migrator.env:ro <image@digest> node --env-file=/run/secrets/migrator.env src/server/db/migrate-cli.ts status
   ```
   그다음 `up`, 다시 `status`. 적용 버전이 이미지 라벨 `pod.migrations.latest`와 같아야 배포한다. 공유 호스트에서 npm·source를 실행하지 않는다. F6c2 뒤 새 migration은 §7.2 migration 승인 gate를 따른다(변수 갱신 → 같은 tree의 새 dev push).
3. `‹app_env_file›` 작성(0600, §6.3 규칙). 값은 채팅·Cloud·저장소에 남기지 않는다.
4. egress 범위, 서버 아키텍처, nginx·node·dockerfile frontend digest 고정값을 확인한다.
5. 서버 docker daemon이 `ghcr.io`에 익명 pull할 수 있는지 확인한다(9-A 2).
6. F6b helper를 검토해 설치본에 수동 반영하고, config dev 항목을 추가한다(production 항목 불변).
7. dev 접근 제한·실제 gateway가 OAuth callback·쿠키와 호환되고 인가 code를 로그에 남기지 않는지 확인한다 [미확인]. 계획은 PR62(edge 한정 예외는 fixture 증명 뒤 사용자 승인, 바깥 edge 실제 설정 불변).
8. **백업:** dev 데이터는 C등급(손실 허용·RTO 없음, 사용자 확인)이다. 공용 백업의 restore 증명은 이 단계의 선행 조건이 아니다. 동결 env 스냅샷은 일반 백업·아티팩트에 넣지 않는다(§6.4).

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
| **F6a1 앱 이미지** | RED: `app/tests/unit/runtime-health.test.ts`·`app/tests/unit/db-pool.test.ts`·`app/tests/image-contract.test.mjs`(실제 이미지 검사). GREEN: `app/Dockerfile`, `app/.dockerignore`, `app/runtime-startup.mjs`, `app/next.config.ts`(`output` 1줄), `app/src/server/db/pool.ts`(Pool 옵션), `app/src/app/healthz/route.ts`, `app/src/app/healthz/ready/route.ts`, `.github/workflows/app-image-validation.yml`(`app-image` job 1~6단계) | 없음 | S1·S2·S3·F6b |
| **F6a2 프록시 조합** | §8의 프런트+앱 E2E 시험·app-image job 확장. 정확 시험 파일은 S2/F6b 통합 SHA의 helper 상수를 읽고 RED 전에 main이 고정 | S2·F6b·F6a1 통합 | S3b |
| **F6b helper** | RED: `tests/test_deploy_app.py`·`app/tests/deploy-env-parity.test.mjs`. GREEN: `scripts/ops/deploy.py`(기존 static·production 동작 불변, §6.5 거부 추가)·`.github/workflows/deploy-app-validation.yml`(Node env 대조 전용) | 없음 | F6a |
| **F6c1 게시만** | RED: `app/tests/deploy-workflow.test.mjs`(§7.3, app lock의 `js-yaml`). GREEN: `.github/workflows/deploy.yml`(`workflow-contracts`·`build-dev-app` 추가, 기존 job 불변)·§7.1 5의 stdlib archive 검사 스크립트(경로는 메인 고정)·(Q2 조건 충족 시) `.github/workflows/app-image-validation.yml` dev push 제거 | F6a1 **및 F6a2 통합(무조건)**. F6a2가 S2·F6b 통합을 요구하므로 그 뒤다 | S3b |
| **F6c2 dev 앱 전환** | RED: 같은 시험 파일의 F6c2 사례. GREEN: `.github/workflows/deploy.yml`(`app-checks`·`deploy-dev-app`, 정적 `deploy`는 main만)·`.github/workflows/app-validation.yml`(`workflow_call`, push `[main]`). `docker-compose.dev.yml`은 그대로(앱 compose는 helper 템플릿) | **C1 완료 증거**(§7.1), §9-A 2~4, F6b·S2 통합, 저장소 수준 `POD_DEV_APPROVED_MIGRATIONS` 설정, gateway callback 호환(PR62) | — |
| **G2** | — | F6c2, S2(B4) 통합, B5 Google, 사용자 콘솔 | — |

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
  - `docker image save` archive 형식·buildx metadata 키·runner 저장소 종류(§7.1 5, 첫 실제 CI 시도로 확인 전 지원 주장 없음)
  - unprivileged nginx
- **이 작성자가 하지 않은 것:** 코드·시험·npm·Next·Docker·DB·서버·FullCheck 실행, `docker image save` 형식·registry 게시 실측. Cloud에는 `_template`·`hc`·서버가 없어 읽거나 실행하지 않았다.

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

## 15. R3 초안: F6c 부트스트랩·같은 SHA 검증 (2026-11-05)

| 메인 지적 | 대응 | 위치 |
|---|---|---|
| 게시 이미지로 migration하기 전에 같은 push가 바로 배포한다(순환) | F6c1(게시만, 정적 dev 유지) → 메인 공개·익명 pull·migration·env·helper → F6c2 전환 | §7.1, §9-A |
| dev 배포가 별도 workflow인 `app-validation`을 기다리지 않는다 | F6c2에서 `app-validation.yml`을 `workflow_call`로 같은 run·같은 SHA에서 1회 호출한다. 게시·배포 job은 `needs`로 기다린다. API gate는 path filter 때문에 채택하지 않는다 | §7.2 |
| 문서만 바뀐 push·concurrency 상호 취소 | `deploy.yml`은 path filter가 없어 항상 판정된다. dev push 독립 트리거를 같은 PR에서 없애 group 충돌을 없앤다 | §7.2 |
| 권한 | `packages: write`는 게시 job 하나에만 있고 PR·production에는 0이다. 같은 job이 저장소 코드를 실행하므로 순서는 격리가 아니며 잔여 위험은 R4에서 명시 수락했다(§15.1) | §7.1 |

**메인 결정(2026-11-05) 반영**
- **Q1:** 저장소 변수 `POD_DEV_APPROVED_MIGRATIONS`(엄격한 양의 정수, 미설정·오류면 SSH 전 실패, 이미지 latest가 더 크면 차단). 표준 절차는 변수를 올린 뒤 같은 tree의 새 dev push다. 실패 job 재실행은 동작이 증명된 뒤에만 쓴다. 추가 Actions API 권한은 없다(§7.2).
- **Q2·Q4:** 게시 job은 F6a1의 6건, F6a2의 실제 front+app 프록시·보존 사례(무조건), 변경 없는 preview 10건(nginx 경유)을 같은 SHA·같은 불변 ID로 registry login 전에 실행한다. `app-image-validation`의 dev push 제거는 이 명령을 모두 실행할 때만 한다. `preview-validation`은 따로 호출하지 않는다(§7.1).
- **Q3:** `app/tests/deploy-workflow.test.mjs` + app lock `js-yaml` 4.3.2(새 dependency 없음). 그리고 `deploy.yml`에 `workflow-contracts` job을 둔다(contents read, secret·packages 0). 게시 job은 이를 `needs`에 넣는다. 정적 production `deploy`는 `needs: validate` 그대로다(§7.0·§7.3).
- **권한 정정:** 게시 job은 저장소 코드와 `packages: write` token을 같은 job에 둔다. 순서만으로 격리된다고 주장하지 않는다. 대신 token은 login 단계 env에만 명시하고, `persist-credentials: false`, logout·설정 삭제, 같은 artifact digest 대조를 한다. 배포 SSH secret은 이 job에 없다(§7.1).

**이 초안이 하지 않은 것**
- workflow·helper·시험·제품 변경.
- registry 게시, 실제 CI run, 서버 작업.
- GitHub 재사용 workflow concurrency·`vars` 재실행 동작의 실측(문서 기반 판단, [미확인] 표시).

### 15.1 R4: R3 독립 검토(P1 2·P2) 메인 결정 반영 (2026-11-05)

| 지적 | 메인 결정·대응 | 위치 |
|---|---|---|
| P1-1 시험한 이미지와 게시 이미지 연결이 변하는 tag에 기댄다 | 빌드 뒤 inspect로 얻은 불변 ID로 모든 시험. `docker image save <ID>` archive를 stdlib로 안전하게 읽어 sha256(config) == metadata `containerimage.config.digest`. 형식 이상·다중 이미지·플랫폼 모호는 실패. ID에서 tag, push 전 tag→ID 확인, push 뒤 이 repo의 `RepoDigests` 정확히 1개 → raw manifest 해시·config 대조. 라벨 latest == checkout 계산. run summary 기록. 실제 CI 시도 전 지원 주장 없음 | §7.1 2~8 |
| P1-1 gate 순서 | PR 수락 = 구조 + 로컬 빌드·export 연결(PR secret 0). 첫 검토된 dev push = C1 후보. C1 완료 = 실제 게시 기록의 manifest·config 증명. 그 전 F6c2 착수·활성화 없음. PR `packages: write`·추가 게시 branch 없음. 첫 시도 실패 시 정적 dev 유지 | §7.1, §9-A 1·5, §11 |
| P1-2 F6a2가 조건부였다 | 무조건 선행. "존재 뒤/있으면" 문구 제거. 경로만 F6a2 뒤 메인이 고정. C2 gate에 실제 gateway callback 호환·인가 code 로그 없음 추가(PR62) | §4 아래 7, §7.1 6, §7.2, §11 |
| P2 concurrency | dev 앱 배포 group `pieceofdays-dev-app-deployment`(cancel false), production group 불변. 대기 1개 교체(FIFO 아님), 환경 간은 서버 helper `flock` | §7.2 |
| P2 token | 순서는 격리가 아님. 잔여 위험을 검토된 dev publisher·저장소 `GITHUB_TOKEN` 범위에서 명시 수락. 이전 §15 표의 모순 문구 정정 | §7.1, §15 |
| P2 승인 변수 | 저장소 수준만, 같은 이름 dev environment 변수 금지, 엄격 검증·새 dev run 표준 절차 유지 | §7.2, §9-A 3 |
| P2 app-checks | callee job에 건너뛰는 `if` 없음(구조 시험). 첫 C2 실제 run이 모든 job·concurrency를 증명 | §7.2, §7.3 |
| P2 action | 허용 집합: checkout v4(루트 기존)·checkout v6·setup-node v6.5의 기존 고정 commit | §7.0 |
| P2 재실행 | 매번 다시 빌드·새 ID 시험, config 검사 통과 시에만 push. tag가 덮어써져도 증명은 그 run의 digest | §7.1 |
| P2 기타 | `deploy-dev-app` `timeout-minutes: 30`. 기존 패키지 없음·첫 게시 비공개·공개는 사용자/현재 인증(PAT 없음). C2 뒤 정적 dev 갱신 중지, `/try/`는 현재 앱 배포의 front | §7.1, §7.2, §9-A 2 |

- F6a1·F6b 고정 계약(§4~§6 모드·helper·env)은 바꾸지 않았다.
- 새 Actions API 조회 권한은 없다. 이 개정은 Docker 빌드·registry·서버 작업을 하지 않았다.
