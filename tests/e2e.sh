#!/bin/bash
# Live: walks all three profiles through the installed proxy and asserts
# block/forward behavior (deny_tools, deny_calls arg matching, malformed
# entry handling), then restores the shipped rules.
# Needs: proxy files installed in ~/.local/bin, `gh` logged in on the host,
# network reachability for the forwarded probes. Exit 0 = all green.
set -u
cd "$(dirname "$0")/.."
BIN="$HOME/.local/bin"
S=skills/github-mcp-proxy-rules
P=http://127.0.0.1:3719/mcp
LOG=${GITHUB_MCP_PROXY_LOG:-/tmp/opencode/github-mcp-proxy.log}
FAIL=0

restart() {
  "$BIN/github-mcp-proxy.sh" down >/dev/null 2>&1
  "$BIN/github-mcp-proxy.sh" up >/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    "$BIN/github-mcp-proxy.sh" status >/dev/null 2>&1 && break
    sleep 0.3
  done
  grep 'rules:' "$LOG" | tail -1
}

probe() { curl -s -X POST "$P" -H 'content-type: application/json' -d "$1"; }

check() { # label, body, blocked|forward
  out=$(probe "$2")
  case "$3" in
    blocked)
      if echo "$out" | grep -q 'blocked by github-mcp-proxy policy'; then
        echo "PASS $1 -> blocked"
      else
        echo "FAIL $1 -> expected block, got: $out"; FAIL=1
      fi ;;
    forward)
      if echo "$out" | grep -q 'blocked by github-mcp-proxy policy'; then
        echo "FAIL $1 -> unexpectedly blocked: $out"; FAIL=1
      else
        echo "PASS $1 -> forwarded"
      fi ;;
  esac
}

APPROVE='{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"APPROVE","body":"lgtm"}}}'
COMMENT='{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"COMMENT","body":"lgtm"}}}'
MERGE='{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"merge_pull_request","arguments":{"owner":"o","repo":"r","pullNumber":1}}}'
PUSHMAIN='{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"push_files","arguments":{"owner":"o","repo":"r","branch":"main","message":"x","files":[]}}}'
PUSHFEAT='{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"push_files","arguments":{"owner":"o","repo":"r","branch":"feature","message":"x","files":[]}}}'
GETPR='{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_pull_request","arguments":{"owner":"o","repo":"r","pullNumber":1}}}'

# ship current files, then walk the profiles
cp github-mcp-proxy.mjs github-mcp-proxy.sh github-mcp-proxy.rules.json "$BIN/"
echo "== hobby (shipped) =="
restart
check "hobby approve" "$APPROVE" blocked
check "hobby comment" "$COMMENT" forward
check "hobby merge" "$MERGE" forward

echo "== corporate-agentic =="
cp "$S/profiles/corporate-agentic.json" "$BIN/github-mcp-proxy.rules.json"
restart
check "agentic approve" "$APPROVE" blocked
check "agentic merge" "$MERGE" blocked
check "agentic push main" "$PUSHMAIN" blocked
check "agentic get_pr" "$GETPR" forward

echo "== corporate-assisted =="
cp "$S/profiles/corporate-assisted.json" "$BIN/github-mcp-proxy.rules.json"
restart
check "assisted approve" "$APPROVE" blocked
check "assisted push main" "$PUSHMAIN" blocked
check "assisted push feature" "$PUSHFEAT" forward
check "assisted merge" "$MERGE" forward

echo "== malformed deny_tools entry is dropped, not applied =="
printf '%s' '{"schema":"test","deny_tools":["merge_pull_request",42]}' > "$BIN/github-mcp-proxy.rules.json"
restart | sed 's/^/  log: /'
check "malformed-file merge still blocked (valid entry kept)" "$MERGE" blocked

echo "== restore hobby =="
cp github-mcp-proxy.rules.json "$BIN/"
restart
check "restore approve" "$APPROVE" blocked
check "restore merge" "$MERGE" forward

exit $FAIL
