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

RUN pnpm install --frozen-lockfile --filter @repo/web...

COPY packages/dto ./packages/dto
COPY packages/events ./packages/events
COPY apps/web ./apps/web

RUN pnpm --filter @repo/dto build
RUN pnpm --filter @repo/events build

# The browser bundle is built with these URLs baked in, so they are build
# arguments rather than runtime environment variables.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_CALL_CONTROLLER_URL=http://localhost:3002
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_CALL_CONTROLLER_URL=$NEXT_PUBLIC_CALL_CONTROLLER_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @repo/web build

FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `output: 'standalone'` emits the server with only the files it needs.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/login || exit 1

CMD ["node", "apps/web/server.js"]
