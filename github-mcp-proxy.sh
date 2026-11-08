#!/bin/bash
# up | down | status for the GitHub MCP loopback proxy (github-mcp-proxy.mjs)
set -u
SELF=github-mcp-proxy.mjs
PORT=3719
LOG=/tmp/opencode/github-mcp-proxy.log

# optional install-level env (GITHUB_MCP_TOOLSETS, PORT, GITHUB_MCP_URL);
# set -a so plain assignments in the file reach `nohup node`
if [ -r "$HOME/.config/github-mcp-proxy/env" ]; then
  set -a; . "$HOME/.config/github-mcp-proxy/env"; set +a
fi

# match the proxy process only: argv[0] ends in `node` (mise shim execs the
# real binary path), argv[1] is exactly this script; a shell running
# `node --check github-mcp-proxy.mjs` or an editor mentioning the file never matches
pid() { pgrep -f "^(.*/)?node [^ ]*/github-mcp-proxy\.mjs$"; }

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
    kill $(pid)
    # wait for exit: a still-dying pid makes the next `up` bail with
    # "already running" and start nothing
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(pid)" ] && break; sleep 0.2; done
    echo "stopped"
    ;;
  status)
    if [ -z "$(pid)" ]; then echo "down"; exit 1; fi
    printf 'up (pid %s), port %s: %s\n' "$(pid)" "$PORT" \
      "$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X POST http://127.0.0.1:$PORT/mcp || echo unreachable)"
    ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
