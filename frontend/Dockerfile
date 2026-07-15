# ─── Frontend Dockerfile (Next.js) ───
#
# NOTE: build context must be the REPO ROOT (not frontend/), since this
# image bundles the compiled games SDK (src/gamesdk, copied at build time
# by scripts/copy-gamesdk.mjs) so /play can run the real deterministic
# games client-side — the same reason backend/Dockerfile needs a root
# context for games/sdk. See docker-compose.yml and
# .github/workflows/ci.yml for the matching `context: .` /
# `file: frontend/Dockerfile` build invocation.

# Stage 1: build the games SDK (same source the backend's replay verifier
# and games/playground use).
FROM node:22-alpine AS games-builder
WORKDIR /games
COPY games/package*.json games/tsconfig*.json ./
RUN npm ci
COPY games/ .
RUN npm run build

# Stage 2: build the Next.js app
FROM node:22-alpine AS builder
WORKDIR /app
COPY frontend/package*.json frontend/tsconfig*.json frontend/next.config.* ./
RUN npm ci
COPY frontend/ .
# Copy the games SDK where scripts/copy-gamesdk.mjs expects to find it
# relative to the frontend root (../games/dist) before its prebuild hook
# runs as part of `npm run build`.
COPY --from=games-builder /games/dist /games/dist
RUN npm run build

# Stage 3: Runtime
FROM node:22-alpine AS runner
RUN adduser -D -g '' nextjs
USER nextjs
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["node_modules/.bin/next", "start"]
