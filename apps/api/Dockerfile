FROM node:24-alpine AS base
RUN npm install -g pnpm@12.3.4
WORKDIR /app

FROM base AS builder

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/dto/package.json ./packages/dto/
COPY packages/events/package.json ./packages/events/
COPY apps/api/package.json ./apps/api/
COPY apps/call-controller/package.json ./apps/call-controller/
COPY apps/web/package.json ./apps/web/

# The root workspace holds the Prisma CLI, so it is selected alongside the API.
RUN pnpm install --frozen-lockfile --filter @repo/api... --filter iziphone

COPY packages/db ./packages/db
COPY packages/dto ./packages/dto
COPY packages/events ./packages/events
COPY apps/api ./apps/api

RUN pnpm --filter @repo/db db:generate
RUN pnpm --filter @repo/db build
RUN pnpm --filter @repo/dto build
RUN pnpm --filter @repo/events build
RUN pnpm --filter @repo/api build

FROM base AS runner

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/dto/package.json ./packages/dto/
COPY packages/events/package.json ./packages/events/
COPY apps/api/package.json ./apps/api/
COPY apps/call-controller/package.json ./apps/call-controller/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile --prod --filter @repo/api... \
  && rm -rf /root/.local/share/pnpm /root/.cache /root/.npm

COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/dto/dist ./packages/dto/dist
COPY --from=builder /app/packages/events/dist ./packages/events/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

USER node

ENV NODE_ENV=production

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
