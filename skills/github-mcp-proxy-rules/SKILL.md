---
name: github-mcp-proxy-rules
description: Install, review, or refresh the call-filtering rules for github-mcp-proxy - pick a profile (hobby, corporate-assisted, corporate-agentic), run the schema drift check against the live GitHub MCP server, and verify the proxy after changes. Use when the user wants to set up, review, or change github-mcp-proxy allow/deny rules, or re-validate them after the GitHub MCP server changed.
---

# github-mcp-proxy rules setup

The proxy filters GitHub MCP `tools/call` requests against
`~/.local/bin/github-mcp-proxy.rules.json`. This skill discusses which
rules to install, checks them against the server's live schema, installs
one, and verifies the result. It only ever writes the rules file - opencode
permission pins live in `opencode.json` (see the repo README, "Production
safeguards").

## Why the drift check is mandatory

Deny rules fail **open**: if upstream renames a tool or an argument, the
rule silently stops matching and everything forwards again. So every
setup - including re-runs - does the check below before installing.

## Step 1 - prerequisites

- `github-mcp-proxy.sh status` must report `up` (else `up` first).
- Rules file, proxy script, and this skill directory present
  (installed copies live in `~local/bin`).

## Step 2 - discuss the profile

Ask which profile fits, explain what each blocks:

| profile | blocks | intended for |
|---------|--------|--------------|
| `hobby` | PR approvals | personal repos, you are the only reviewer |
| `corporate-assisted` | approvals + direct push/commit/delete on `main`/`master` | human approves every call; changes must go through the PR flow even if the token could bypass branch protection |
| `corporate-agentic` | whole tools: merge, push, commit, delete, create repo - plus approvals | the agent runs wide with broad permission pins; the proxy is the last gate for anything irreversible |

Custom rules are fine: start from the closest profile and edit it with the
user using the grammar at the bottom.

## Step 3 - drift check (run every time)

Early warning (optional): compare the rules' `schema` field with the
upstream release feed:

```sh
gh api repos/github/github-mcp-server/releases/latest --jq .tag_name
```

Ground truth is the live server (the hosted endpoint can move between
releases), so probe it through the proxy:

```sh
curl -sS -D /tmp/ghmcp-h -o /tmp/ghmcp-init -X POST http://127.0.0.1:3719/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rules-check","version":"0"}}}'
SID=$(grep -i '^mcp-session-id:' /tmp/ghmcp-h | tr -d '\r' | awk '{print $2}')
curl -sS -o /dev/null -X POST http://127.0.0.1:3719/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -sS -o /tmp/ghmcp-tools.raw -X POST http://127.0.0.1:3719/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
grep -q '^data: ' /tmp/ghmcp-tools.raw \
  && sed -n 's/^data: //p' /tmp/ghmcp-tools.raw > /tmp/ghmcp-tools.json \
  || cp /tmp/ghmcp-tools.raw /tmp/ghmcp-tools.json
```

**Diff against the committed snapshot** (`tools-list@v1.14.0.json` next to
this file; normalize first, icons and descriptions excluded so the diff is
only names, argument types, enums, and required lists):

```sh
jq -S '[.result.tools[] | {name,
  props: ((.inputSchema.properties // {}) | with_entries(.value =
    {type: .value.type} + (if .value.enum then {enum: .value.enum} else {} end))),
  required: (.inputSchema.required // [])}]' /tmp/ghmcp-tools.json > /tmp/ghmcp-live.norm
diff <path-to-this-dir>/tools-list@v1.14.0.json /tmp/ghmcp-live.norm
```

Report new / changed / removed tools to the user and agree any rule
changes **before** installing.

**Validate the chosen rules against the live schema** - unknown tools,
unknown `if` arguments, and values that fell out of an enum are reported
instead of silently never matching. The validator lives next to this file:

```sh
jq -n --slurpfile R <rules-file> --slurpfile L /tmp/ghmcp-tools.json \
  -f <path-to-this-dir>/validate.jq
```

Fix every reported line (adjust the rule or drop it), then re-run until it
prints `rules valid against live schema`.

## Step 4 - install and verify

```sh
cp <chosen-profile>.json ~/.local/bin/github-mcp-proxy.rules.json   # profiles/ next to this file
github-mcp-proxy.sh down && github-mcp-proxy.sh up
grep rules: /tmp/opencode/github-mcp-proxy.log | tail -1
# expect: rules: N deny_tools, M deny_calls active (schema github/github-mcp-server@...)
```

Behavior probe (must be blocked locally, never forwarded):

```sh
curl -s -X POST http://127.0.0.1:3719/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"pull_request_review_write","arguments":{"method":"create","owner":"o","repo":"r","pullNumber":1,"event":"APPROVE","body":"lgtm"}}}'
# expect: "blocked by github-mcp-proxy policy"
```

On a generation change (diff showed movement): after agreeing the new
rules, save the new normalized snapshot as `tools-list@<new-tag>.json`
next to this file, update the `schema` field in the installed rules, and
remove the stale snapshot.

## Rule grammar

```json
{
  "schema": "github/github-mcp-server@v1.14.0",
  "deny_tools": ["merge_pull_request"],
  "deny_calls": [
    { "tool": "pull_request_review_write", "if": { "event": "APPROVE" }, "reason": "PR approvals are human-only" }
  ]
}
```

- `schema` - upstream release the rules were written against (drift marker).
- `deny_tools` - tool blocked outright; checked first.
- `deny_calls` - exact tool name plus subset match on `if` (every listed
  pair must equal the call's arguments; extra arguments do not stop a
  match). First matching rule wins. `reason` lands in the error and log.
- Missing rules file = forward everything; malformed entries are dropped
  and logged at startup, never applied half-way.
- Scope: MCP path only. Shell `gh` bypasses the proxy entirely.
