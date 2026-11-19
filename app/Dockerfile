# syntax=docker/dockerfile:1@sha256:7b32114e84ca21aeb2d6f871a0b62b3a0762193f75d9afd048ee4cbe889f3148
# 앱 이미지(PLAN_dev-app-deployment §4, F6a1). 격리 CI에서만 빌드한다. 배포 helper는 이 Dockerfile을 실행하지 않는다.
# - 네트워크 단계는 package 파일만 보는 `npm ci --ignore-scripts`뿐이고, 소스 빌드는 `--network=none`이다.
# - 기반 이미지는 linux/amd64 단일 manifest digest로 고정한다. 기존 정적·운영 Dockerfile과 무관하다.
FROM node:26.13.0-bookworm-slim@sha256:cd820d60a7f3ae057389f3e1bcf1a0ac09dd57c428fe14f191dcbc5c56ac5fe2 AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN --network=none npm run build

FROM node:26.13.0-bookworm-slim@sha256:cd820d60a7f3ae057389f3e1bcf1a0ac09dd57c428fe14f191dcbc5c56ac5fe2 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# 기동 wrapper와 원본 순수 모드 검사(변경 없이 복사)
COPY --from=build /app/runtime-startup.mjs ./runtime-startup.mjs
COPY --from=build /app/src/server/runtime-mode.ts ./src/server/runtime-mode.ts
# 고정 migrate CLI: 원래 상대 배치 유지 → 기본 경로 ../../../migrations = /app/migrations
COPY --from=build /app/src/server/db/migrate-cli.ts /app/src/server/db/migrate.ts /app/src/server/db/sql-policy.ts ./src/server/db/
COPY --from=build /app/migrations ./migrations
# 직접 Node로 실행하는 사진 cleanup과 공유 순수 core. Next 번들/server-only alias를 요구하지 않는다.
COPY --from=build /app/src/server/photos/cleanup-cli.mjs /app/src/server/photos/cleanup-core.mjs /app/src/server/photos/config-core.mjs /app/src/server/photos/blob-store.s3-core.mjs ./src/server/photos/
# 직접 Node로 실행하는 story worker CLI(의존성 0). 컨테이너 안 127.0.0.1:3000 내부 route만 부른다(PLAN_ai-story-live-generation §4.8).
COPY --from=build /app/src/server/stories/worker-cli.mjs ./src/server/stories/
# migrate CLI(ESM import "pg")가 쓰는 pg 런타임 의존성 전체(lock 기준 14개). standalone trace의 부분 복사를 보완한다.
COPY --from=deps /app/node_modules/pg ./node_modules/pg
COPY --from=deps /app/node_modules/pg-cloudflare ./node_modules/pg-cloudflare
COPY --from=deps /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=deps /app/node_modules/pg-int8 ./node_modules/pg-int8
COPY --from=deps /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=deps /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=deps /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=deps /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=deps /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=deps /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=deps /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=deps /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=deps /app/node_modules/split2 ./node_modules/split2
COPY --from=deps /app/node_modules/xtend ./node_modules/xtend
ARG POD_SHA POD_TREE POD_MIGRATIONS_LATEST
LABEL org.opencontainers.image.source="https://github.com/kindsr/devscent-pieceofdays-main" \
      org.opencontainers.image.revision="${POD_SHA}" \
      pod.tree="${POD_TREE}" \
      pod.migrations.latest="${POD_MIGRATIONS_LATEST}"
USER node
EXPOSE 3000
CMD ["node", "runtime-startup.mjs"]
