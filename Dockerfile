FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/configuration-api/package.json apps/configuration-api/package.json
COPY apps/configuration-worker/package.json apps/configuration-worker/package.json
RUN pnpm install --frozen-lockfile

COPY apps/configuration-api apps/configuration-api
RUN pnpm build:api

FROM node:22-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
ENV NODE_ENV=development PORT=3000
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/configuration-api/package.json apps/configuration-api/package.json
COPY apps/configuration-worker/package.json apps/configuration-worker/package.json
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=build /app/apps/configuration-api/dist apps/configuration-api/dist
COPY apps/configuration-worker/src apps/configuration-worker/src
COPY db/migrations db/migrations
COPY scripts/migrate.mjs scripts/migrate.mjs

EXPOSE 3000
CMD ["node", "apps/configuration-api/dist/main.js"]
