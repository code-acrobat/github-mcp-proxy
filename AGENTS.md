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

## Invariants (do not regress)

- **Request flow:** buffer body -> browser guard (`Origin` or
  `Sec-Fetch-Site` present -> 403 text/plain) -> JSON parse -> policy
  check -> inject `Authorization: Bearer $(gh auth token)` -> forward raw
  bytes. Content-length stays intact; SSE responses stream through
  unbuffered. Blocked calls get a local `200` JSON-RPC error
  (`code: -32000`) and one log line, and never reach upstream (the
  blocked path skips the token lookup).
- **JSON-RPC batches and unparseable bodies pass through untouched** -
  deliberate; never "fix" this by buffering or rewriting them.
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
