# syntax=docker/dockerfile:1.7
#
# GAMEE Backend — Multi-stage Docker Build
#
# NOTE: build context must be the REPO ROOT (not backend/), since this image
# also bundles the compiled games/sdk replay verifier that the verification
# worker shells out to at runtime. See docker-compose.yml's api-gateway
# service and .github/workflows/ci.yml for the matching `context: .` /
# `file: backend/Dockerfile` build invocation.

# Stage 1: Build the Go binary
# Must match (or exceed) the `go 1.25` directive in backend/go.mod — official
# golang images set GOTOOLCHAIN=local, so unlike a local dev machine or CI's
# actions/setup-go (which can silently auto-download a newer toolchain),
# there's no fallback here if this tag is older than go.mod requires.
FROM golang:1.25-alpine AS go-builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /app

# Cache go module downloads.
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy source and build.
COPY backend/ .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=1.0.0" \
    -trimpath \
    -o /app/server \
    ./cmd/server

# Stage 2: Build the games SDK + replay verifier (Node.js, run by the
# verification worker via `node sdk/run.js --input <tmpfile>`).
FROM node:22-alpine AS games-builder

WORKDIR /games
COPY games/package*.json games/tsconfig*.json ./
RUN npm ci
COPY games/ .
RUN npm run build

# Stage 3: Runtime image
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata nodejs npm

# Create non-root user.
RUN adduser -D -h /app gamee

WORKDIR /app

# Copy the Go binary.
COPY --from=go-builder /app/server /app/server

# Copy the compiled games SDK + verifier entry point. config.go's default
# VerifierScriptPath ("../games/sdk/run.js", relative to WORKDIR /app)
# resolves to /games/sdk/run.js — so it must land exactly there.
COPY --from=games-builder /games/dist /games/dist
COPY --from=games-builder /games/sdk/run.js /games/sdk/run.js
COPY --from=games-builder /games/node_modules /games/node_modules
COPY --from=games-builder /games/package.json /games/package.json

# Set ownership.
RUN chown -R gamee:gamee /app /games

USER gamee

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["/app/server"]
