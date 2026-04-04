#!/usr/bin/env bash
# Restart the ClaudeClaw bot safely.
# Sends a Telegram notification BEFORE killing the process.
# The supervisor (scripts/supervise.sh) will auto-restart it.
#
# Usage: bash restart-bot.sh "Reason for restart"

set -e

MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "ERROR: You must provide a restart reason."
  echo "Usage: bash restart-bot.sh \"Explanation of what changed\""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Send notification via Telegram
bash "$SCRIPT_DIR/scripts/notify.sh" "🔄 <b>Restarting bot:</b> ${MESSAGE}"
NOTIFY_EXIT=$?

if [ $NOTIFY_EXIT -ne 0 ]; then
  echo "ERROR: Telegram notification failed. Refusing to restart."
  exit 1
fi

echo "Telegram notification sent. Killing bot process..."

PID_FILE="$SCRIPT_DIR/store/claudeclaw.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Killed PID $PID. Supervisor will auto-restart."
  else
    echo "PID $PID not running. Cleaning up stale pidfile."
    rm -f "$PID_FILE"
  fi
else
  # Fallback: find the process
  PID=$(pgrep -f "node dist/index.js" | head -1)
  if [ -n "$PID" ]; then
    kill "$PID"
    echo "Killed PID $PID (found via pgrep). Supervisor will auto-restart."
  else
    echo "No bot process found to kill."
  fi
fi
