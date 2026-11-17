#!/bin/bash
# up | down | status | stamp | check for the GitHub MCP loopback proxy (github-mcp-proxy.mjs)
set -u
SELF=github-mcp-proxy.mjs
PORT=3719
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/github-mcp-proxy"

# optional install-level env (GITHUB_MCP_TOOLSETS, GITHUB_MCP_READONLY,
# GITHUB_MCP_SCOPE, PORT, GITHUB_MCP_URL);
# set -a so plain assignments in the file reach `nohup node`
if [ -r "$HOME/.config/github-mcp-proxy/env" ]; then
  set -a; . "$HOME/.config/github-mcp-proxy/env"; set +a
fi
# per port, after the env: an instance on another PORT gets its own log
LOG="${GITHUB_MCP_LOG:-$STATE/github-mcp-proxy-$PORT.log}"

# match the proxy process only: argv[0] ends in `node` (mise shim execs the
# real binary path), argv[1] is exactly this script; a shell running
# `node --check github-mcp-proxy.mjs` or an editor mentioning the file never matches
pid() { pgrep -f "^(.*/)?node [^ ]*/github-mcp-proxy\.mjs$"; }

case "${1:-}" in
  up)
    if [ -n "$(pid)" ]; then echo "already running (pid $(pid))"; exit 0; fi
    mkdir -p "$(dirname "$LOG")"
    chmod 700 "$STATE" 2>/dev/null || true
    nohup node ~/.local/bin/"$SELF" >>"$LOG" 2>&1 &
    # the pid exists before the listener does: wait for the port, not the process
    ready=""
    for _ in {1..25}; do
      curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/mcp" && { ready=1; break; }
      sleep 0.2
    done
    if [ -z "$(pid)" ]; then echo "start failed, see $LOG"; exit 1; fi
    [ -n "$ready" ] && echo "up (pid $(pid)), log $LOG" || { echo "pid $(pid) but :$PORT does not answer yet, see $LOG"; exit 1; }
    ;;
  down)
    if [ -z "$(pid)" ]; then echo "not running"; exit 0; fi
    kill $(pid)
    # wait for exit: a still-dying pid makes the next `up` bail with
    # "already running" and start nothing
    for _ in {1..10}; do [ -z "$(pid)" ] && break; sleep 0.2; done
    echo "stopped"
    ;;
  stamp)
    node "$HOME/.local/bin/$SELF" --stamp || exit 1
    echo "apply it: $0 down && $0 up"
    ;;
  check)
    node "$HOME/.local/bin/$SELF" --check
    ;;
  status)
    if [ -z "$(pid)" ]; then echo "down"; exit 1; fi
    # a real initialize: an empty POST is answered 415 by the proxy itself
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"status","version":"0"}}}') || code=unreachable
    printf 'up (pid %s), port %s: %s\n' "$(pid)" "$PORT" "$code"
    ;;
  *) echo "usage: $0 up|down|status|stamp|check" >&2; exit 2 ;;
esac
