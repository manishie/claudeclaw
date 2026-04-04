#!/usr/bin/env bash
# View recent bot logs with optional filtering.
#
# Usage:
#   bash scripts/view-logs.sh              # Last 50 lines
#   bash scripts/view-logs.sh 200          # Last 200 lines
#   bash scripts/view-logs.sh timeout      # Lines matching "timeout"
#   bash scripts/view-logs.sh error 100    # Last 100 lines matching "error"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$(dirname "$SCRIPT_DIR")/store/logs/bot.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "No log file found at $LOG_FILE"
  echo "Logs will appear after the bot restarts with the new logger."
  exit 0
fi

LINES=${2:-${1:-50}}
FILTER=""

# If first arg is not a number, treat it as a filter
if [[ "$1" =~ ^[0-9]+$ ]]; then
  LINES="$1"
elif [ -n "$1" ]; then
  FILTER="$1"
  LINES="${2:-100}"
fi

if [ -n "$FILTER" ]; then
  echo "=== Last $LINES lines matching '$FILTER' ==="
  grep -i "$FILTER" "$LOG_FILE" | tail -n "$LINES" | python3 -m json.tool --no-ensure-ascii 2>/dev/null || grep -i "$FILTER" "$LOG_FILE" | tail -n "$LINES"
else
  echo "=== Last $LINES lines ==="
  tail -n "$LINES" "$LOG_FILE" | python3 -m json.tool --no-ensure-ascii 2>/dev/null || tail -n "$LINES" "$LOG_FILE"
fi

echo ""
echo "Log file: $LOG_FILE ($(du -h "$LOG_FILE" | cut -f1))"
