#!/usr/bin/env bash
# beta-up.sh — bring the whole GAMEE beta stack up with one command.
#
#   ./scripts/beta-up.sh          start everything
#   ./scripts/beta-up.sh stop     stop everything this script started
#   ./scripts/beta-up.sh status   show what's running
#
# Public exposure is via Tailscale Funnel (stable URLs, survive restarts):
#   frontend  https://edith.tail5956ca.ts.net        -> localhost:3000
#   backend   https://edith.tail5956ca.ts.net:8443   -> localhost:8080
# Those URLs are baked into frontend/.env.local (NEXT_PUBLIC_*) and
# backend/.env (ALLOWED_ORIGINS) and never change, so unlike the old
# Cloudflare quick-tunnel setup there is no per-start URL capture or
# frontend rebuild. The funnel config persists in tailscaled across
# reboots; this script just re-asserts it in case it was turned off.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$HOME/.gamee-dev/run"
LOG_DIR="$HOME/.gamee-dev/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

REDIS_SERVER="$HOME/.local/bin/redis-server"
PG_DATA="$HOME/.gamee-dev/pg"
FUNNEL_HOST="edith.tail5956ca.ts.net"
WEB_URL="https://$FUNNEL_HOST"
API_URL="https://$FUNNEL_HOST:8443"

log() { printf '\033[1;35m[beta]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[beta] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

port_pid() { ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1 || true; }

stop_all() {
  log "stopping..."
  for f in "$RUN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    pid=$(cat "$f")
    kill "$pid" 2>/dev/null && log "stopped $(basename "$f" .pid) (pid $pid)" || true
    rm -f "$f"
  done
  for p in 8080 3000; do
    pid=$(port_pid "$p"); [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  log "done. (Postgres/Redis/funnel are left running — funnel just 502s until next start.)"
}

status_all() {
  pg_isready -h localhost -p 5433 >/dev/null 2>&1 && echo "postgres:  UP (5433)" || echo "postgres:  down"
  redis-cli -p 6390 ping >/dev/null 2>&1 && echo "redis:     UP (6390)" || echo "redis:     down"
  [ -n "$(port_pid 8080)" ] && echo "backend:   UP (8080)" || echo "backend:   down"
  [ -n "$(port_pid 3000)" ] && echo "frontend:  UP (3000)" || echo "frontend:  down"
  # capture first, then grep: with pipefail, `tailscale | grep -q` fails on
  # SIGPIPE when grep exits at the first match even though it matched
  fstat=$(tailscale funnel status 2>/dev/null || true)
  echo "$fstat" | grep -q 'Funnel on' && echo "funnel:    UP" || echo "funnel:    down"
  echo "share URL: $WEB_URL"
}

case "${1:-start}" in
  stop)   stop_all; exit 0 ;;
  status) status_all; exit 0 ;;
  start)  ;;
  *) die "usage: $0 [start|stop|status]" ;;
esac

# ── 1. Postgres ────────────────────────────────────────────────
if ! pg_isready -h localhost -p 5433 >/dev/null 2>&1; then
  log "starting postgres..."
  pg_ctl -D "$PG_DATA" -l "$LOG_DIR/postgres.log" start >/dev/null
  for i in $(seq 1 20); do pg_isready -h localhost -p 5433 >/dev/null 2>&1 && break; sleep 0.5; done
fi
pg_isready -h localhost -p 5433 >/dev/null 2>&1 || die "postgres did not come up (see $LOG_DIR/postgres.log)"
log "postgres OK"

# ── 2. Redis ───────────────────────────────────────────────────
if ! redis-cli -p 6390 ping >/dev/null 2>&1; then
  log "starting redis..."
  "$REDIS_SERVER" --daemonize yes --port 6390 >/dev/null
  sleep 0.5
fi
redis-cli -p 6390 ping >/dev/null 2>&1 || die "redis did not come up"
log "redis OK"

# ── 3. Tailscale funnel (idempotent; config persists in tailscaled) ──
tailscale status >/dev/null 2>&1 || die "tailscale is not up (sudo tailscale up)"
funnel_status=$(tailscale funnel status 2>/dev/null || true)
echo "$funnel_status" | grep -q "https://$FUNNEL_HOST (Funnel on)" \
  || tailscale funnel --bg --https=443 http://localhost:3000 >/dev/null
echo "$funnel_status" | grep -q "https://$FUNNEL_HOST:8443 (Funnel on)" \
  || tailscale funnel --bg --https=8443 http://localhost:8080 >/dev/null
log "funnel OK ($WEB_URL, API $API_URL)"

# ── 4. Backend ─────────────────────────────────────────────────
old=$(port_pid 8080); [ -n "$old" ] && kill "$old" 2>/dev/null && sleep 1 || true
log "building + starting backend..."
cd "$ROOT/backend"
go build -o bin/server ./cmd/server
# Source the backend .env inside the child shell only — sourcing it here
# would leak PORT=8080 into this script's environment, and Next.js honors
# PORT, so the frontend below would crash with EADDRINUSE.
setsid bash -c 'set -a; source .env; set +a; exec ./bin/server' >"$LOG_DIR/backend.log" 2>&1 &
echo $! > "$RUN_DIR/backend.pid"
for i in $(seq 1 30); do curl -s -m 2 localhost:8080/health | grep -q ok && break; sleep 1; done
curl -s -m 2 localhost:8080/health | grep -q ok || die "backend did not come up (see $LOG_DIR/backend.log)"
log "backend OK"

# ── 5. Frontend (rebuild when missing OR stale) ───────────────
# Staleness check matters: serving an old .next after source changes once
# took the whole homepage down with a hydration crash (the stale bundle
# spoke an older API contract). Any source/config file newer than the
# build marker triggers a rebuild.
old=$(port_pid 3000); [ -n "$old" ] && kill "$old" 2>/dev/null && sleep 1 || true
cd "$ROOT/frontend"
stale=""
if [ ! -f .next/BUILD_ID ]; then
  stale="first run"
elif [ -n "$(find src public package.json next.config.js tailwind.config.ts tsconfig.json "$ROOT/games/dist" -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
  # games/dist is included because prebuild (copy-gamesdk) pulls the game
  # engine from there — a games rebuild must propagate into the bundle.
  stale="sources changed since last build"
fi
if [ -n "$stale" ]; then
  log "building frontend ($stale)..."
  npm run build >"$LOG_DIR/frontend-build.log" 2>&1 || die "frontend build failed (see $LOG_DIR/frontend-build.log)"
fi
PORT=3000 setsid npm start >"$LOG_DIR/frontend.log" 2>&1 &
echo $! > "$RUN_DIR/frontend.pid"
frontend_up=""
for i in $(seq 1 30); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' localhost:3000 || true)
  echo "$code" | grep -qE '^(200|307|308)$' && { frontend_up=1; break; }
  sleep 1
done
[ -n "$frontend_up" ] || die "frontend did not come up locally (see $LOG_DIR/frontend.log)"
log "frontend OK"

# ── 6. Verify the PUBLIC path end to end ───────────────────────
log "verifying public URLs..."
code=$(curl -s -m 60 -o /dev/null -w '%{http_code}' "$API_URL/health" || echo 000)
[ "$code" = "200" ] || die "backend not reachable through the funnel (got $code)"
code=$(curl -s -m 60 -o /dev/null -w '%{http_code}' "$WEB_URL/" || echo 000)
echo "$code" | grep -qE '^(200|307|308)$' || die "frontend not reachable through the funnel (got $code)"

echo
echo "──────────────────────────────────────────────────────────────"
echo "  🎮 BETA IS LIVE — share this link (stable, never changes):"
echo
echo "      $WEB_URL"
echo
echo "  Keep this machine awake while people are playing."
echo "  './scripts/beta-up.sh stop' to shut down."
echo "──────────────────────────────────────────────────────────────"
