#!/usr/bin/env bash
# Keeps the beta stack alive: if the backend or frontend stops answering,
# re-runs beta-up.sh start (idempotent — only restarts what's down).
# Run detached:  nohup ./scripts/watchdog.sh >> ~/.gamee-dev/logs/watchdog.log 2>&1 &
# Stop:          pkill -f 'scripts/watchdog.sh'
set -u
cd "$(dirname "$0")/.."

INTERVAL=60

while true; do
  ok=1
  curl -sf -m 5 http://localhost:8080/health >/dev/null || ok=0
  curl -sf -m 5 -o /dev/null http://localhost:3000 || ok=0
  if [ "$ok" = 0 ]; then
    echo "[watchdog] $(date -Is) service down — running beta-up.sh start"
    ./scripts/beta-up.sh start
  fi
  sleep "$INTERVAL"
done
