# github-mcp-proxy

A small loopback bridge (one node file, no dependencies) that gives an
opencode session the GitHub MCP server without any credential in config,
environment, or sandbox.

```
opencode / omac sandbox
        |  http://127.0.0.1:3719/mcp        (all it can reach)
        v
github-mcp-proxy.mjs  (runs on the HOST)
        |  adds "Authorization: Bearer $(gh auth token)" per request
        v
https://api.githubcopilot.com/mcp/
```

The token lives in the host keyring (`gh auth token`), is read at request
time, and is never written to disk or passed into the sandbox.

## Files

| file | what it is |
|------|------------|
| `github-mcp-proxy.mjs` | the proxy: node, no dependencies, listens on `127.0.0.1:3719/mcp` |
| `github-mcp-proxy.sh`  | control script: `up`, `down`, `status` |
| `github-mcp-proxy.rules.json` | call rules: `tools/call` requests matching a rule are answered locally, never forwarded |
| `skills/github-mcp-proxy-rules/` | install skill: three rule profiles plus the schema drift check (see "Call filtering") |
| `tests/` | `validate.sh` (offline rule validation) and `e2e.sh` (live profile walk) |
| `.github/workflows/ci.yml` | CI: syntax checks + offline rule validation on every push/PR |

## Install

Prerequisites: `node`, and `gh` logged in (`gh auth status` must succeed on
the host).

```sh
cp github-mcp-proxy.mjs github-mcp-proxy.sh github-mcp-proxy.rules.json ~/.local/bin/
chmod +x ~/.local/bin/github-mcp-proxy.mjs ~/.local/bin/github-mcp-proxy.sh

github-mcp-proxy.sh up        # starts it in the background (nohup)
github-mcp-proxy.sh status    # prints pid + probes the port (exit 1 = down)
github-mcp-proxy.sh down
```

Log: `/tmp/opencode/github-mcp-proxy.log` (startup lines and blocked calls,
no per-request logging). It is started by hand on purpose: no systemd unit,
and it dies on reboot or logout, so run `up` again after one.

Optional, for the guided rules setup (profiles, schema drift check):

```sh
cp -r skills/github-mcp-proxy-rules ~/.agents/skills/
```

Quick check (any machine, host or sandbox):

```sh
curl -s -X POST http://127.0.0.1:3719/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# -> HTTP 200 with a JSON-RPC result = token lookup and upstream both worked
# 502 "token lookup failed: ..." = gh is not logged in on the host
```

## Configure opencode.json

Point the `github` MCP entry at the loopback URL instead of
`https://api.githubcopilot.com/mcp/`:

```json
"mcp": {
  "github": {
    "type": "remote",
    "url": "http://127.0.0.1:3719/mcp",
    "enabled": true
  }
}
```

This is the shape used in the standard user config
`~/.config/opencode/opencode.json` (the same entry works in a project's
`opencode.json`). No headers, no token, no OAuth: the URL is the whole entry.

Note: `opencode mcp list` inside a cold session can print "No MCP servers
configured" even when the config is loaded (known v2 quirk). To see what the
session really loaded, run `opencode debug config`.

Enable it per project, not everywhere: not every project is a GitHub project,
and a disabled entry costs nothing. If the `opencode.json` travels with the
repo, leave `github` out of projects that don't need it (or commit it with
`"enabled": false` as the default) so collaborators without a running proxy
aren't handed a dead `127.0.0.1` entry.

Other forges: GitLab and Bitbucket/Atlassian offer their own MCP servers,
hosted or self-hosted. Where yours needs a token your client cannot hold
cleanly, the same pattern works: a small host-side proxy on loopback that
injects the token, plus the matching port grant in omac. Only the upstream URL
and the token command change.

## Making it reachable in omac (port forwarding)

The sandbox is network-filtered. The one grant it needs is the loopback port,
in the machine policy `~/.config/omac/sandbox-profiles/default.json`:

```json
"network": {
  "open_port": [3719],
  "mode": "filtered"
}
```

`open_port` is the omac equivalent of a forwarded port: the sandboxed process
may connect to `127.0.0.1:3719` and nothing else on that port's terms.

Verify from inside the sandbox:

```sh
omac sandbox run -- curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3719/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# -> 200 (without the grant you get curl exit 7, connection refused)
```

## Why the session cannot use `gh` directly

Three independent walls, so the proxy is the only road to GitHub:

1. **No credential in the sandbox.** `environment.allow_vars` in the policy
   lists no `GH_TOKEN` / `GITHUB_TOKEN`, and `~/.config/gh` (where `gh` keeps
   its login) is not in `filesystem.read`. `gh auth token` inside the sandbox
   has nothing to read.
2. **No network to GitHub.** `network.mode: filtered`, `allow_domain` lists
   the npm registries and `api.githubcopilot.com`. `api.github.com` is not on
   the list, so `gh api ...` is denied (the network prompt would have to be
   answered approvingly first, and it still has no token to send). The
   `api.githubcopilot.com` entry only matters for processes *inside* the
   sandbox; it lets them reach the MCP endpoint but they have no token to
   authenticate with. The proxy itself runs on the host, where the omac policy
   does not apply, so dropping that entry is safe and tightens the rule.
3. **No OAuth workaround.** `opencode mcp auth github` fails inside the
   sandbox anyway: the callback server must bind an OS-assigned port, which
   the per-port sandbox rules reject.

So the session reaches `127.0.0.1:3719` only, and the token is injected on
the host side, per request, where `gh` and the keyring live.

## Scope and maturity

Deliberately minimal. Treat it as a tool you read and run, not a product:

- **No version pinning.** It runs whatever `node` and `gh` are on your `PATH`
  and talks to whatever GitHub serves today.
- **No update checks, no releases.** `git pull` is the upgrade path; there are
  no tags, no changelog, no npm package (installation is copying two files).
- **No CI/CD toolchain.** Nothing automated runs on this repo: no tests, no
  linters, no release pipeline. What you push is what you ran locally.
- **No auto-restart.** One plain background process, no systemd unit; it dies
  on reboot or logout (see Install).

## Security notes

Safe by design:

- The token is read from your host keyring per request (`gh auth token`),
  never written to disk, never placed in config, environment, or the sandbox.
- The listener binds loopback only, and client-supplied `Authorization`
  headers are stripped before forwarding.

Assume the following:

- **The port is open to everything on this machine.** There is no
  authentication on `127.0.0.1:3719`: any process running as you can use the
  proxy as an authenticated GitHub client, with everything your `gh` login is
  allowed to do. Requests carrying a browser `Origin` or `Sec-Fetch-Site`
  header are rejected with 403, so web pages cannot drive the proxy; that is
  header sniffing, not real authentication.
- **Single-user machine assumption.** Do not run this on a shared or
  multi-user host.
- **The proxy runs with your privileges and calls `gh` from `PATH`.** Only
  start it from a shell you trust.
- Requests are forwarded with no rate or size limit, so a local process can
  spend your GitHub API quota.
- Failure replies can contain the `gh` error text; the log
  (`/tmp/opencode/github-mcp-proxy.log`, startup lines only) sits in a
  world-searchable directory.
- Run it on the host, outside any sandbox: inside a sandbox there is no keyring
  access, and the design stops making sense.

- **The connection can be cut at any time.** During long unattended agent
  sessions, run `github-mcp-proxy.sh down`: GitHub tools fail with connection
  refused instead of being a channel a prompt injection can drive, for every
  session at once and immediately. Bring it back with `up` when you are done.
  (Toggling `"enabled"` in the config gives the same reduction per session;
  killing the proxy is the global kill switch.) Expect connection-error noise
  in sessions that keep the tool list around.

- **The cut is host-side; a nested sandboxed session cannot undo it.** Inside
  an omac sandbox there is no token material at all (no keyring, no
  `~/.config/gh`, no `GH_TOKEN`), so a nested session cannot stand up a
  working proxy of its own: it can read the script and run `node`, but `gh
  auth token` finds nothing and the upstream answers 401. The kill switch
  bounds sessions inside the sandbox; anything running outside a sandbox with
  your privileges can run `up` again (or call `gh` directly), as always.

In short: every MCP client you point at this port holds your GitHub identity
while it is connected. Keep that set small and trusted, and keep the
connection window short.

## Call filtering

opencode permissions match tool *names*, not arguments, so a dangerous
option has no seat there. The proxy checks every `tools/call` request
against `github-mcp-proxy.rules.json` (next to the script) and, on a
match, answers locally with a JSON-RPC error — the call never reaches
GitHub:

```json
{
  "deny_calls": [
    {
      "tool": "pull_request_review_write",
      "if": { "event": "APPROVE" },
      "reason": "PR approvals are human-only"
    }
  ]
}
```

A rule matches when `tool` is the exact tool name and every pair in `if`
equals the call's arguments. The shipped rule blocks PR approvals, which
stay a browser action: `event` can be `APPROVE`, `REQUEST_CHANGES`, or
`COMMENT` (GitHub REST docs), and the tool schema comes from the tagged
upstream release recorded in the rules file, not from probing this proxy.

The name-level tier `deny_tools` blocks whole tools regardless of
arguments (`"deny_tools": ["merge_pull_request", "push_files", ...]`)
and is checked before `deny_calls`. That is the whole grammar:
`schema`, `deny_tools`, `deny_calls`.

Rules load at `up`: edit the file, then `down` + `up` to apply. A missing
or broken rules file means no rules — everything forwards, so an
unconfigured proxy behaves exactly as before. JSON-RPC batches and
unparseable bodies also pass through. Only the MCP path is guarded; shell
`gh` bypasses it, same threat model as the rest of this proxy. Blocked
calls land in the log.

The rules file records which upstream schema generation the rules were
written against (`github/github-mcp-server@v1.14.0`): tool names and
arguments come from that tagged release of GitHub's MCP server source.
Startup sanity-checks the rules file itself - malformed entries are
dropped and logged instead of silently never matching.

### Keeping rules in sync

Deny rules fail open when upstream drifts: a renamed tool or argument
makes its rule silently stop matching, and calls start forwarding again.
So the repo keeps a normalized `tools/list` snapshot per generation
(`skills/github-mcp-proxy-rules/tools-list@v1.14.0.json` - names,
argument types, enums, required lists; icons and descriptions stripped so
the diff stays readable) and the install skill re-checks on every run:

1. probe `tools/list` through the running proxy,
2. diff against the snapshot and report new / changed / removed tools,
3. validate every rule against that live schema (unknown tools, unknown
   `if` arguments, values dropped from an enum) until it comes back clean,
4. install the agreed rules, bump the `schema` field, refresh the
   snapshot.

Ground truth is the live probe, not the release feed: the hosted endpoint
can move between releases. `gh api repos/github/github-mcp-server/
releases/latest` is only an early warning; the last commit whose rules
and snapshot matched a generation is tagged `schema-v1.14.0`.

### Profiles

`skills/github-mcp-proxy-rules/` ships three ready-made profiles (and
installs as an agent skill via `cp -r` into `~/.agents/skills/`, where
the skill walks through the check above):

| profile | blocks |
|---------|--------|
| `hobby` | PR approvals |
| `corporate-assisted` | approvals + direct push/commit/delete on `main`/`master` (PR flow stays the only road, even for tokens that could bypass branch protection) |
| `corporate-agentic` | whole tools: merge, push, commit, delete, create repo - plus approvals; the safety net under broad permission pins |

## Production safeguards

A hobby setup is one personal token and one human at the keyboard. For
production repositories, keep a human approving each next step instead of
building hard tool denials in the client:

- **Ask is already the default.** opencode asks before a tool runs when no
  permission rule matches, so no `permissions` block is needed: every
  create, merge, or push call waits for you. Prefer staying on `ask` over
  `deny` rules as long as a human approves the next step; add a deny only
  for something nobody should ever run.
- **The few hard denials live in the proxy, not in permission rules.**
  opencode permissions match tool names, so they cannot express "approve
  is human-only" or "push, but never to `main`". The proxy's rules file
  can: it matches arguments, ships three profiles (see "Profiles" - the
  assisted one closes the bypass hole for tokens that could write past a
  ruleset), and the setup skill re-validates every rule against the live
  `tools/list` so a renamed tool cannot silently disarm one. Ask stays
  the default for everything the rules do not name.
- **Keep merge rights on the forge, not in the client.** On GitHub: a
  ruleset on `main` requiring a pull request and at least one approving
  review (the PR author cannot approve their own PR), "Allow auto-merge"
  disabled in repo settings, and a read-only workflow token. These hold
  even when an `ask` is clicked through without much thought.
- **Skip draft-only rules; keep CI in the loop.** Draft PRs often sit
  outside the pipeline checks that should pass before a human reviewer is
  bothered. Open a real PR, let CI go green, and state "human review
  required" in the description instead.
- **Token scope is the ceiling.** A `gh` login carrying `repo` and
  `workflow` can edit Actions workflow files and push to every repository
  you can. For production use a fine-grained PAT limited to the target
  repositories (no workflow access); everything above narrows who may
  merge, not what the token can do elsewhere.
- **Ask before variable lookups.** Actions secrets are write-only (the
  API never returns their value), but Actions *variables* are plain text:
  `gh variable list` and `gh api` print them with a normal token. Unless
  every project keeps sensitive values out of variables, pin
  `{ "action": "shell", "resource": "gh variable *", "effect": "ask" }`
  and the same for `gh api *variables*` so a later broad `shell` allow
  rule cannot wave them through.
- **Ask before triggering pipelines.** A manual gate exists so a human
  decides when a run proceeds; an agent pressing its own gate defeats the
  point. The GitHub MCP has no workflow-trigger tool, but the shell does:
  pin `{ "action": "shell", "resource": "gh workflow run *", "effect":
  "ask" }` and `{ "action": "shell", "resource": "gh api *actions*",
  "effect": "ask" }` (dispatches, reruns, cancels).

This is a baseline, not a final, thought-through process. It reflects one
setup and one set of assumptions; every enterprise has its own rules, and
each tool and permission your organization grants needs a thorough
inspection of its own before you rely on advice like this.

## Alternatives

The `omac-gh` skill from the skill marketplace does a similar job, but it
needs marketplace access and lives inside a model session. This repo is the
plain-file stand-in: same job (GitHub access for sandboxed sessions), no skill
install, and you can read the whole thing in one sitting.

## Tests

- `tests/validate.sh` - offline. Rebuilds a `tools/list` response from the
  committed snapshot and runs the skill's `validate.jq` over the shipped
  rules and all three profiles (must come back valid), plus a broken rules
  file (every failure class must be reported). No network, no proxy.
- `tests/e2e.sh` - live. Installs the current files, walks all three
  profiles through the running proxy asserting block/forward behavior
  (name tier, argument tier, malformed entries), restores the shipped
  rules. Needs the install in `~/.local/bin` and a reachable upstream;
  exit 0 = all green.

CI (`.github/workflows/ci.yml`) runs the syntax checks and the offline
test on every push and pull request. The e2e stays local on purpose: it
needs a logged-in `gh` with GitHub MCP access on the host, and CI must
not hold that credential.

## License

[MIT](./LICENSE) — free to use, copy, modify, merge, publish, distribute;
without warranty.
