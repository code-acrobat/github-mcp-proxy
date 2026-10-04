#!/bin/bash
# up | down | status for the GitHub MCP loopback proxy (github-mcp-proxy.mjs)
set -u
SELF=github-mcp-proxy.mjs
PORT=3719
LOG=/tmp/opencode/github-mcp-proxy.log

pid() { pgrep -f "[g]ithub-mcp-proxy\.mjs"; }

case "${1:-}" in
  up)
    if [ -n "$(pid)" ]; then echo "already running (pid $(pid))"; exit 0; fi
    mkdir -p "$(dirname "$LOG")"
    nohup node ~/.local/bin/"$SELF" >>"$LOG" 2>&1 &
    sleep 0.3
    [ -n "$(pid)" ] && echo "up (pid $(pid)), log $LOG" || { echo "start failed, see $LOG"; exit 1; }
    ;;
  down)
    if [ -z "$(pid)" ]; then echo "not running"; exit 0; fi
    kill $(pid); echo "stopped"
    ;;
  status)
    if [ -z "$(pid)" ]; then echo "down"; exit 1; fi
    printf 'up (pid %s), port %s: %s\n' "$(pid)" "$PORT" \
      "$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X POST http://127.0.0.1:$PORT/mcp || echo unreachable)"
    ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
