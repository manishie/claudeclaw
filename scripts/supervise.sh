#!/usr/bin/env bash
# Supervisor wrapper for ClaudeClaw bot.
# Auto-restarts the bot when it exits. Captures logs to a file.
#
# Usage: bash scripts/supervise.sh
# Stop:  kill the supervisor PID (it will also kill the child bot)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/store/logs"
PID_FILE="$PROJECT_DIR/store/supervisor.pid"
RESTART_DELAY=3
MAX_RAPID_RESTARTS=5
RAPID_RESTART_WINDOW=60  # seconds

mkdir -p "$LOG_DIR"

# Write supervisor PID
echo $$ > "$PID_FILE"

# Cleanup on exit
cleanup() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Supervisor shutting down" >> "$LOG_DIR/supervisor.log"
  rm -f "$PID_FILE"
  # Kill child bot if running
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill "$BOT_PID" 2>/dev/null || true
    wait "$BOT_PID" 2>/dev/null || true
  fi
}
trap cleanup SIGINT SIGTERM EXIT

# Track rapid restarts to avoid crash loops
declare -a restart_times=()

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Supervisor started (PID $$)" >> "$LOG_DIR/supervisor.log"

while true; do
  # Check for rapid restart loop
  now=$(date +%s)
  # Filter to only recent restarts
  recent=()
  for t in "${restart_times[@]}"; do
    if [ $((now - t)) -lt $RAPID_RESTART_WINDOW ]; then
      recent+=("$t")
    fi
  done
  restart_times=("${recent[@]}")

  if [ ${#restart_times[@]} -ge $MAX_RAPID_RESTARTS ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] CRASH LOOP: $MAX_RAPID_RESTARTS restarts in ${RAPID_RESTART_WINDOW}s. Backing off 60s." >> "$LOG_DIR/supervisor.log"
    sleep 60
    restart_times=()
  fi

  # Rotate log if > 10MB
  LOG_FILE="$LOG_DIR/bot.log"
  if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv "$LOG_FILE" "$LOG_FILE.prev"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Log rotated" >> "$LOG_DIR/supervisor.log"
  fi

  # Start the bot
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting bot..." >> "$LOG_DIR/supervisor.log"
  cd "$PROJECT_DIR"
  node dist/index.js >> "$LOG_FILE" 2>&1 &
  BOT_PID=$!
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Bot started (PID $BOT_PID)" >> "$LOG_DIR/supervisor.log"

  # Wait for bot to exit
  set +e
  wait "$BOT_PID"
  EXIT_CODE=$?
  set -e

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Bot exited (code $EXIT_CODE)" >> "$LOG_DIR/supervisor.log"
  restart_times+=("$(date +%s)")

  # Brief delay before restart
  sleep "$RESTART_DELAY"
done
