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

RUN pnpm install --frozen-lockfile --filter @repo/call-controller...

COPY packages/dto ./packages/dto
COPY packages/events ./packages/events
COPY apps/call-controller ./apps/call-controller

RUN pnpm --filter @repo/dto build
RUN pnpm --filter @repo/events build
RUN pnpm --filter @repo/call-controller build

FROM base AS runner

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/dto/package.json ./packages/dto/
COPY packages/events/package.json ./packages/events/
COPY apps/api/package.json ./apps/api/
COPY apps/call-controller/package.json ./apps/call-controller/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile --prod --filter @repo/call-controller... \
  && rm -rf /root/.local/share/pnpm /root/.cache /root/.npm

COPY --from=builder /app/packages/dto/dist ./packages/dto/dist
COPY --from=builder /app/packages/events/dist ./packages/events/dist
COPY --from=builder /app/apps/call-controller/dist ./apps/call-controller/dist

USER node

ENV NODE_ENV=production

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

CMD ["node", "apps/call-controller/dist/index.js"]
