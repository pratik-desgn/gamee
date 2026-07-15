#!/bin/bash
# ─── GAMEE Local Dev Startup ───
# Starts PostgreSQL + Redis + Backend in one command.
# Requires: Docker, Docker Compose, Go 1.22+
#
# Usage:
#   ./scripts/dev-start.sh        # Start all services
#   ./scripts/dev-start.sh --build # Rebuild and start
#   ./scripts/dev-start.sh --down  # Tear down
#   ./scripts/dev-start.sh --reset # Reset DB and start fresh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

case "${1:-up}" in
  up)
    echo "🔄 Starting GAMEE dev environment..."
    echo "   PostgreSQL → localhost:5432"
    echo "   Redis      → localhost:6379"
    echo "   Backend    → localhost:8080"
    echo ""
    docker compose up -d postgres redis
    echo "⏳ Waiting for databases to be ready..."
    sleep 3
    echo "✅ Databases ready!"
    echo ""
    echo "Starting Go backend (hot-reload via air or go run)..."
    if command -v air &>/dev/null; then
      cd backend && air -- --port 8080
    else
      cd backend && go run ./cmd/server
    fi
    ;;
  --build)
    echo "🔨 Building and starting..."
    docker compose up -d --build postgres redis
    sleep 3
    cd backend && go run ./cmd/server
    ;;
  --down)
    echo "🛑 Tearing down..."
    docker compose down
    echo "✅ Done"
    ;;
  --reset)
    echo "🗑️  Resetting databases..."
    docker compose down -v
    docker compose up -d postgres redis
    echo "⏳ Waiting for databases to initialize..."
    sleep 5
    echo "✅ Reset complete. DB schema seeded from init-db.sql."
    echo ""
    echo "Starting Go backend..."
    cd backend && go run ./cmd/server
    ;;
  *)
    echo "Usage: $0 [up|--build|--down|--reset]"
    exit 1
    ;;
esac
