# AGENTS.md

Guidance for agents working on this repository. User-facing documentation
is [README.md](./README.md) (what the proxy is, install, opencode/omac
setup, security notes, profiles); this file covers how the code fits
together and how to change it safely. Both are meant to stand alone -
link across instead of copying text.

## Repo map

| path | what it is |
|------|------------|
| `github-mcp-proxy.mjs` | the proxy: node, zero dependencies, stdlib only |
| `github-mcp-proxy.sh` | `up` / `down` / `status`; `up` runs the installed copy `~/.local/bin/github-mcp-proxy.mjs` |
| `github-mcp-proxy.rules.json` | committed default rules (= `hobby` profile); this is what installs |
| `skills/github-mcp-proxy-rules/` | install skill: `SKILL.md` (setup flow incl. drift check), `profiles/` (hobby, corporate-assisted, corporate-agentic), `validate.jq`, `tools-list@<tag>.json` snapshot |
| `tests/` | `validate.sh` (offline), `e2e.sh` (live) |
| `.github/workflows/ci.yml` | CI: syntax checks + offline test only |

## Drift and recovery (the advice a session can follow)

The proxy refuses every `tools/call` when its rules no longer match the running
upstream. That is a lock, not a crash: `initialize` and `tools/list` still answer,
so the repair works from inside the locked state. **If a session reports blocked
GitHub calls, this is the whole procedure — no maintainer needed:**

```sh
github-mcp-proxy.sh status     # exit 1 / "down" -> start it first
tail -3 /tmp/opencode/github-mcp-proxy.log   # the exact lock reason
github-mcp-proxy.sh check      # release + inventory + policy drift, exit 1 on drift
```

Then, depending on what `check` says:

| `check` says | do |
|---|---|
| **inventory drift** (`+[tool]` / `-[tool]`) | re-stamp: `github-mcp-proxy.sh stamp && github-mcp-proxy.sh down && up`. Read the diff the stamp prints: a **new** tool is worth a look — if it writes or touches repositories, add it to `deny_tools` **before** stamping (a second `stamp` afterwards is harmless). |
| **policy drift** (`readonly` / `toolsets` changed) | expected when you flipped `GITHUB_MCP_READONLY` or the toolsets — re-stamp and restart. |
| **release note only** (newer release, inventory identical) | nothing is blocked; re-stamp when convenient. |
| **identity change** (upstream renamed itself) | re-stamp; the stamp records the new name. |
| **`stamp` fails** | it needs a reachable upstream and a logged-in `gh` (`gh auth status`). The lock does not block this path. |

Verify after repairing: `github-mcp-proxy.sh check` exits 0 and the log line is
`schema ok: <n> tools match the rules snapshot`.

**If the installed copy is older than the repo** (a release changed the rules
format, the control script, or `--stamp` itself), refresh it first — the
installed `~/.local/bin/github-mcp-proxy.{mjs,sh,rules.json}` is a copy, not a
link:

```sh
# tngomac users: re-running the component does both steps in one go
~/tngomac_workspace/tngomac/bin/install.sh github
# standalone installs: copy the three files from the clone, then stamp as above
```

Rule of thumb for agents: **`check` → read the diff → `stamp` → `down && up` →
`check` exits 0.** Never widen the toolset or drop `GITHUB_MCP_READONLY` as a
"fix" for a lock.

## Invariants (do not regress)

- **Schema lock = fail closed.** Rules carry `schema` (upstream identity),
  `tools` (inventory) and `snapshot` (policy fingerprint); any mismatch, missing
  stamp, unparsable rules or an unreachable upstream at startup denies every
  `tools/call` until `--stamp` + restart. `GITHUB_MCP_SCHEMA_LOCK=off` is the
  documented, explicit escape — never the default.


- **Request flow:** buffer body -> browser guard (`Origin` or
  `Sec-Fetch-Site` present -> 403 text/plain) -> JSON parse -> policy
  check -> inject `Authorization: Bearer $(gh auth token)` -> forward raw
  bytes. A present `GITHUB_MCP_TOOLSETS` (even empty) injects
  `x-mcp-toolsets` and `GITHUB_MCP_READONLY=1` injects
  `x-mcp-readonly: true`; both overwrite any client header (the host
  owns policy; a configured toolset list is a hard ceiling, clients
  cannot expand it), and a present `GITHUB_MCP_SCOPE` (even empty =
  deny-all) refuses out-of-scope `tools/call` inside `blockedReason`:
  *every* `owner`/`org`/`organization` argument must match an entry
  (`fork_repository`'s destination org included), subject-less calls are
  refused except `get_me`, `create_repository` needs an in-scope
  `organization`, and the free-text query tools (`search_issues`,
  `search_pull_requests`) are refused outright - their query can name
  any repository.
  Content-length stays intact; SSE
  responses stream through unbuffered. Blocked calls get a local `200`
  JSON-RPC error
  (`code: -32000`) and one log line, and never reach upstream (the
  blocked path skips the token lookup).
- **Batches and unparseable bodies fail closed.** A batch containing any
  `tools/call` is ruled on call by call; one denied call blocks the whole
  batch (local `-32000`, `id: null`). A non-empty body that does not
  parse as JSON is refused the same way; an empty body (the SSE `GET`)
  forwards untouched. The old pass-through let a denied call ride in
  hidden inside an array; the three proxy siblings keep this request
  handling in lockstep.
- **Startup schema lock is an identity check only.** On start the proxy
  `initialize`s the endpoint and requires it to answer as
  `github-mcp-server` with a `serverInfo.version` present. It does NOT
  compare that version against the `schema` tag: the hosted endpoint
  reports a commit hash (`github-mcp-server/remote-<sha>`), and newer
  hashes are expected to pass - the latest release tag is sufficient,
  deploy-hash churn does not break the interface. A successful
  `initialize` that answers with a different name or no version locks
  every `tools/call` (local `-32000`) until restart; `initialize` and
  `tools/list` keep passing so the new schema can still be captured. An
  unreachable endpoint does not lock (the per-request 502 surfaces it).
  Re-evaluating tool schemas against a new release tag stays the offline
  process in "Working on rules" below - not a runtime comparison.
- **Rules load once at startup.** Edit the rules file, then `down` +
  `up`. No reload endpoint, no per-request file reads.
- **Deny rules fail open** (missing file = forward all; malformed entries
  are dropped and logged; upstream drift silently disarms a rule). This
  is accepted, which is why the drift check in the skill and
  `tests/validate.sh` exist - keep them in sync with any grammar change.
- **`pid()` in the control script is anchored on purpose:**
  `^(.*/)?node [^ ]*/github-mcp-proxy\.mjs$`. An unanchored pattern
  matched shells running `node --check` (and `down` killed them); a plain
  `^node` misses the mise shim exec path. Keep argv[1] exact.
- `validate.jq` is the single canonical validator: the skill runs it via
  `-f`, tests run the same file. Do not inline a second copy.

## Working on rules or a new schema generation

The rule grammar, profile contents, and the setup-skill flow are
documented in README "Call filtering" / "Profiles" and in the skill
itself; read those instead of restating them here.

- Tool schemas come from the tagged upstream release recorded in the
  rules file's `schema` field (currently `github/github-mcp-server@v1.14.0`).
- Ground truth for drift is a live `tools/list` probe through the running
  proxy (the hosted endpoint moves between releases); the release feed is
  only an early warning.
- On a generation change: run the skill's check step (probe -> diff
  against the snapshot -> `validate.jq` clean), update the rules, save
  the new normalized snapshot as `tools-list@<tag>.json`, bump `schema`,
  and move the generation tag (`schema-<tag>`).

## Verify before committing

```sh
node --check github-mcp-proxy.mjs
for f in github-mcp-proxy.sh tests/*.sh; do bash -n "$f"; done
node github-mcp-proxy.mjs --selftest   # policy logic: scope args, subjects, empty scope
tests/validate.sh   # offline: no network, no proxy
tests/e2e.sh        # live: installs files to ~/.local/bin, walks all
                    # three profiles, restores the shipped rules; needs
                    # `gh` logged in; exit 0 = all green
```

CI runs the first two on every push/PR. The e2e stays local: CI must
never hold a `gh` credential.

## House rules

- No new dependencies, no framework, no speculative structure - one file
  doing the minimum is the point.
- Keep personal and machine-specific paths out of the repo (sane generic
  examples like `~/.local/bin` are fine); grep the diff before
  committing.
- Push only on explicit request; generation tags go with their push.
- README and AGENTS.md both stay readable standalone - when behavior
  changes, update the one that owns that fact (user-facing -> README,
  development-facing -> this file) and cross-reference the other.
