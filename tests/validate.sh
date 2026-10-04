#!/bin/bash
# Offline: rule validation against a fixture rebuilt from the committed
# snapshot (skills/github-mcp-proxy-rules/tools-list@*.json). No network,
# no running proxy. Exit 0 = all green.
set -u
cd "$(dirname "$0")/.."
SKILL=skills/github-mcp-proxy-rules
JQ=$(command -v jq || echo /usr/bin/jq)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FAIL=0

# The validator reads .result.tools[].inputSchema; rebuild that shape from
# the normalized snapshot (name / props / required is all it consumes).
"$JQ" '{result: {tools: map({name, inputSchema: {properties: .props, required: .required}})}}' \
  "$SKILL"/tools-list@*.json > "$TMP/live.json"

# Positive: shipped rules and every profile must validate clean.
for f in github-mcp-proxy.rules.json "$SKILL"/profiles/*.json; do
  out=$("$JQ" -rn --slurpfile R "$f" --slurpfile L "$TMP/live.json" -f "$SKILL/validate.jq")
  if [ "$out" = "rules valid against live schema" ]; then
    echo "PASS valid: $f"
  else
    echo "FAIL valid: $f -> $out"; FAIL=1
  fi
done

# Negative: each drift failure class must be reported, not silently pass.
printf '%s' '{"deny_tools":["no_such_tool"],"deny_calls":[
  {"tool":"also_nope","if":{"x":1}},
  {"tool":"pull_request_review_write","if":{"bogus_key":"x"}},
  {"tool":"pull_request_review_write","if":{"event":"LGTM"}}]}' > "$TMP/bad.json"
out=$("$JQ" -rn --slurpfile R "$TMP/bad.json" --slurpfile L "$TMP/live.json" -f "$SKILL/validate.jq")
for want in \
  "deny_tools: unknown tool no_such_tool" \
  "deny_calls: unknown tool also_nope" \
  "pull_request_review_write: unknown argument bogus_key" \
  "pull_request_review_write: event=LGTM not in enum"; do
  case $out in
    *"$want"*) echo "PASS detect: $want" ;;
    *) echo "FAIL detect: expected <$want> in: $out"; FAIL=1 ;;
  esac
done

exit $FAIL
