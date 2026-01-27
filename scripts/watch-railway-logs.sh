#!/bin/bash
# Watch Railway logs continuously
# Usage: ./scripts/watch-railway-logs.sh [service-name] [refresh-interval]

SERVICE="${1:-}"
INTERVAL="${2:-2}"

if [ -z "$SERVICE" ]; then
  echo "📊 Watching logs from current service (refresh every ${INTERVAL}s)"
  echo "   Press Ctrl+C to stop"
  echo ""
  watch -n "$INTERVAL" 'railway logs 2>&1 | tail -50'
else
  echo "📊 Watching logs from service: $SERVICE (refresh every ${INTERVAL}s)"
  echo "   Press Ctrl+C to stop"
  echo ""
  watch -n "$INTERVAL" "railway logs --service \"$SERVICE\" 2>&1 | tail -50"
fi
