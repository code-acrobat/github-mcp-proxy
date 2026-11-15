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
  wait_up
  grep 'rules:' "$LOG" | tail -1
}

# `up` returns once the pid exists, but the proxy only listens after its
# startup schema-lock probe upstream, so poll until the port accepts.
wait_up() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if (exec 3<>/dev/tcp/127.0.0.1/3719) 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "FAIL proxy did not start listening on 3719"
  FAIL=1
  return 1
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

check_list() { # label, list, grep pattern, present|absent
  case "$4" in
    present)
      if echo "$2" | grep -q "$3"; then echo "PASS $1"; else echo "FAIL $1 -> $3 missing"; FAIL=1; fi ;;
    absent)
      if echo "$2" | grep -q "$3"; then echo "FAIL $1 -> $3 present"; FAIL=1; else echo "PASS $1"; fi ;;
  esac
}

# full MCP session dance -> raw tools/list JSON. Extra args go on every
# request, so callers can probe client-header behavior (e.g. -H 'x-mcp-readonly: true')
tools_list() {
  local H SID
  H=$(mktemp)
  curl -s -D "$H" -o /dev/null -X POST "$P" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' "$@" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
  SID=$(grep -i '^mcp-session-id:' "$H" | tr -d '\r' | awk '{print $2}'); rm -f "$H"
  curl -s -o /dev/null -X POST "$P" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $SID" "$@" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  curl -s -X POST "$P" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $SID" "$@" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
}

APPROVE='{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"APPROVE","body":"lgtm"}}}'
COMMENT='{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"COMMENT","body":"lgtm"}}}'
MERGE='{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"merge_pull_request","arguments":{"owner":"o","repo":"r","pullNumber":1}}}'
PUSHMAIN='{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"push_files","arguments":{"owner":"o","repo":"r","branch":"main","message":"x","files":[]}}}'
PUSHFEAT='{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"push_files","arguments":{"owner":"o","repo":"r","branch":"feature","message":"x","files":[]}}}'
GETPR='{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_pull_request","arguments":{"owner":"o","repo":"r","pullNumber":1}}}'
LI1='{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"list_issues","arguments":{"owner":"o","repo":"repo1"}}}'
LI2='{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"list_issues","arguments":{"owner":"o","repo":"repo2"}}}'
LIX='{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"list_issues","arguments":{"owner":"x","repo":"repo1"}}}'
ORGADV='{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"list_org_repository_security_advisories","arguments":{"org":"o"}}}'
SEARCH='{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"password"}}}'
GETME='{"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"get_me","arguments":{}}}'
MKREPO='{"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"create_repository","arguments":{"name":"n"}}}'
BATCHGET='[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_pull_request","arguments":{"owner":"o","repo":"r","pullNumber":1}}}]'

# install-level env: the tests own it (each section writes what it wants)
# and the user's file is put back on exit
ENVF="$HOME/.config/github-mcp-proxy/env"
ENVSAVE=$(mktemp) HADENV=0
[ -r "$ENVF" ] && { cp "$ENVF" "$ENVSAVE"; HADENV=1; }
restore_env() {
  if [ "$HADENV" = 1 ]; then cp "$ENVSAVE" "$ENVF"; else rm -f "$ENVF"; fi
  rm -f "$ENVSAVE"
}
trap restore_env EXIT
mkdir -p "$(dirname "$ENVF")"
: > "$ENVF"   # profile walk runs on upstream defaults, whatever the user had

# ship current files, then walk the profiles
cp github-mcp-proxy.mjs github-mcp-proxy.sh github-mcp-proxy.rules.json "$BIN/"
echo "== hobby (shipped) =="
restart
check "hobby approve" "$APPROVE" blocked
check "hobby comment" "$COMMENT" forward
check "hobby merge" "$MERGE" forward
BATCHPING='[{"jsonrpc":"2.0","id":1,"method":"ping"}]'
BATCHAPPROVE='[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"APPROVE","body":"lgtm"}}}]'
check "hobby batch ping forwards" "$BATCHPING" forward
check "hobby batch hiding approve blocked" "$BATCHAPPROVE" blocked
check "hobby unparseable body refused" '{not json' blocked

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

echo "== GITHUB_MCP_TOOLSETS opt-in (host-forced, hard ceiling) =="
printf 'GITHUB_MCP_TOOLSETS=default,actions\n' > "$ENVF"
restart
grep 'toolsets:' "$LOG" | tail -1
LIST=$(tools_list)
check_list "toolsets opt-in -> actions_list exposed" "$LIST" actions_list present
# ceiling: a client asking for other toolsets must not change the set
LIST=$(tools_list -H 'x-mcp-toolsets: git')
check_list "env toolsets override client header" "$LIST" actions_list present
check_list "client cannot expand toolsets" "$LIST" get_repository_tree absent

echo "== empty GITHUB_MCP_TOOLSETS still blocks client headers =="
printf 'GITHUB_MCP_TOOLSETS=\n' > "$ENVF"
restart
LIST=$(tools_list -H 'x-mcp-toolsets: git')
check_list "empty configured toolsets -> client header ignored" "$LIST" get_repository_tree absent

echo "== GITHUB_MCP_READONLY =="
printf 'GITHUB_MCP_TOOLSETS=default,actions\nGITHUB_MCP_READONLY=1\n' > "$ENVF"
restart
grep 'readonly' "$LOG" | tail -1
LIST=$(tools_list)
check_list "readonly -> reads stay" "$LIST" get_file_contents present
check_list "readonly -> push_files gone" "$LIST" push_files absent

echo "== GITHUB_MCP_SCOPE =="
printf 'GITHUB_MCP_SCOPE=o/repo1\n' > "$ENVF"
restart
grep 'scope:' "$LOG" | tail -1
check "scope own repo" "$LI1" forward
check "scope other repo of owner" "$LI2" blocked
check "scope foreign owner" "$LIX" blocked
check "scope org-wide needs bare owner" "$ORGADV" blocked
check "scope roaming search" "$SEARCH" blocked
check "scope get_me allowed" "$GETME" forward
check "scope create own repo" "$MKREPO" forward

echo "== empty GITHUB_MCP_SCOPE denies rather than unscopes =="
printf 'GITHUB_MCP_SCOPE=\n' > "$ENVF"
restart
grep 'scope:' "$LOG" | tail -1
check "empty scope -> repo call denied" "$LI1" blocked
check "empty scope -> get_me still allowed" "$GETME" forward

echo "== schema lock covers batched tools/call =="
STUBPORT=$((39100 + RANDOM % 500))
STUBF=$(mktemp)
cat > "$STUBF" <<'EOS'
require("http").createServer((q, res) => {
  let b = ""
  q.on("data", (c) => (b += c))
  q.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "not-github-mcp", version: "0" } } }))
  })
}).listen(Number(process.argv[2]))
EOS
node "$STUBF" "$STUBPORT" & STUBPID=$!
sleep 0.3
printf 'GITHUB_MCP_URL=http://127.0.0.1:%s/mcp\n' "$STUBPORT" > "$ENVF"
restart
grep 'schema LOCKED' "$LOG" | tail -1
check "lock single tools/call" "$GETPR" blocked
check "lock batch tools/call" "$BATCHGET" blocked
kill "$STUBPID" 2>/dev/null
rm -f "$STUBF"

echo "== restore env =="
trap - EXIT   # restore once, explicitly, so the trailing restart sees the real env
restore_env
restart

exit $FAIL
