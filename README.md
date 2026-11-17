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
| `github-mcp-proxy.sh`  | control script: `up`, `down`, `status`; sources `~/.config/github-mcp-proxy/env` if present |
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
github-mcp-proxy.sh check     # release / inventory / policy drift (exit 1 = drift)
github-mcp-proxy.sh stamp     # re-baseline after installing a profile or changing policy
```

Opt-in: extra upstream toolsets for every client of this proxy (the
default set has no Actions tools), and a host-enforced read-only mode:

```sh
mkdir -p ~/.config/github-mcp-proxy
cat > ~/.config/github-mcp-proxy/env <<'EOF'
GITHUB_MCP_TOOLSETS=default,actions
GITHUB_MCP_READONLY=1
EOF
github-mcp-proxy.sh down && github-mcp-proxy.sh up   # env is read at up
```

`GITHUB_MCP_TOOLSETS` is a comma list forwarded upstream as the
`x-mcp-toolsets` header; `default` keeps the standard set, and the
remaining names come from the upstream server (`actions`, `git`, `orgs`,
`governance`, `code_security`, ...; `all` enables everything). When the
key is present it overrides a client-supplied header: the configured
list is a hard ceiling a client can never expand - a present-but-empty
value still blocks client headers (upstream then serves its default
toolsets). When the key is absent, a client header passes through
unchanged. Without the opt-in the proxy forwards upstream's default
toolsets, as before.

`GITHUB_MCP_READONLY=1` injects `x-mcp-readonly: true` for every
session. Upstream then registers only read tools: with
`default,actions` that is 31 of the 50 tools, and every write-shaped
tool is gone (`push_files`, `issue_write`, `merge_pull_request`,
`actions_run_trigger`, the `create_*`/`delete_*` tools). The header is
overwritten, never merged, so no client can lift it - unlike deny
rules, which only fail open on drift. Writes return only by editing the
env file and running `down && up`: an explicit, host-side opt-in. The
flag is proxy-wide; to keep one writable session while another stays
read-only, run a second instance on another `PORT` (own env, own
rules file) and point only trusted clients at it.

`GITHUB_MCP_SCOPE` optionally narrows which repositories sessions can
touch: a comma list of `owner` or `owner/repo` entries, e.g.
`GITHUB_MCP_SCOPE=your-login`. When set, every `owner`/`org`/
`organization` a `tools/call` names must match an entry - all of them,
so a call that carries two subjects (`fork_repository` names the source
owner and the destination `organization`) is refused unless both are in
scope. Calls without any subject are refused too, except `get_me`;
`create_repository` reaches the authenticated account only when it names
an `organization` that is in scope, so it cannot create a personal repo
around the boundary. The free-text query tools (`search_issues`,
`search_pull_requests`) are refused outright while a scope is active:
their query can name any repository, which no argument check can
confine. That takes the roaming `search_*` tools and the global advisory
readers with it, which is the point: an agent steered at someone else's
repository fails locally instead of fetching it. Bare `owner` entries
cover all of that owner's repos plus its org-wide tools; `owner/repo`
narrows repo calls to one repository (org-wide tools then need a bare
entry alongside, e.g. `you/you-repo,you`). The key present with an empty
or separator-only value stays active with an empty allowlist: every
repository call is refused (deny-all) rather than silently unscoped,
while `get_me` keeps working so the misconfiguration is obvious at first
use. Like readonly this is host-side and cannot be
lifted by a client; unlike readonly, `tools/list` stays unchanged (the
proxy never filters responses) - out-of-scope tools simply refuse when
called. Hobby baseline: `GITHUB_MCP_SCOPE=<your-login>`.

Log: `~/.local/state/github-mcp-proxy/github-mcp-proxy-<port>.log` (`XDG_STATE_HOME`, per port; `GITHUB_MCP_LOG` overrides — startup lines and blocked calls,
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

## Schema lock (deny rules that cannot drift silently)

Deny rules match tool *names*, so a renamed or newly added upstream tool would
quietly disarm them. The rules therefore carry the identity and **tool
inventory** they were generated against, and the proxy verifies both at startup
— with the same policy headers a client gets, because the registered inventory
depends on them:

```json
{ "schema": "github-mcp-server@remote-<build>",
  "tools": ["add_issue_comment", "…"],
  "snapshot": { "toolsets": "default,actions", "readonly": false } }
```

Any of these locks the endpoint — every `tools/call` is refused, single or in a
batch, while `tools/list` and `initialize` still pass so the lock can be cleared:

- no rules file, an unparsable one, no `schema` stamp, or no `tools` snapshot;
- the policy changed since the stamp (`toolsets` / `readonly` — the surface is
  different, so the rules must be re-confirmed);
- the live tool inventory differs from the snapshot (the message names what was
  added and removed);
- the upstream is unreachable at startup (3 attempts), or a pin mismatches
  (`GITHUB_MCP_UPSTREAM_VERSION`).

A **new upstream release is not a lock**: the endpoint publishes every ~2 weeks
and most releases touch no tool, so a release newer than the stamp only prints a
note at startup (`upstream published vX, rules were stamped vY — inventory
unchanged, so nothing is refused`). The rules are re-baselined when the
*interface* changes, which is exactly what the inventory check watches.
`github-mcp-proxy.sh check` prints release, inventory and policy drift side by
side for the maintenance pass.

Clearing a lock is one command, and it is deliberate — the point is that a human
looks at the inventory diff before the rules are accepted again:

```sh
github-mcp-proxy.sh stamp      # re-baseline identity + inventory + policy
github-mcp-proxy.sh down && up
```

If a session reports blocked GitHub calls, the repair is three commands —
`github-mcp-proxy.sh check`, `stamp`, `down && up` — with the reasoning and the
exceptions written up in [AGENTS.md](AGENTS.md#drift-and-recovery-the-advice-a-session-can-follow)
so an agent can follow it without a human who knows the project.

`GITHUB_MCP_SCHEMA_LOCK=off` restores the old behaviour (identity check only,
rules forwarded as written); the rules-drift skill remains the offline review of
what a new inventory means for the deny lists. Profiles under
`skills/github-mcp-proxy-rules/profiles/` ship **without** a snapshot on
purpose: they are templates for a policy you have not chosen yet, so the first
start asks for a stamp instead of firing on someone else's settings.

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
  (`~/.local/state/github-mcp-proxy/`, mode 700, startup lines only) is
  per user.
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
unconfigured proxy behaves exactly as before. Request bodies fail closed:
a JSON-RPC batch containing any `tools/call` is checked call by call and
a denied call blocks the whole batch, and a non-empty body that does not
parse as JSON is refused. Only the MCP path is guarded; shell
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

```sh
cp skills/github-mcp-proxy-rules/profiles/hobby.json ~/.local/bin/github-mcp-proxy.rules.json
github-mcp-proxy.sh down && github-mcp-proxy.sh up   # rules load at up
```

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
- **Scope sessions to your own repositories.** `GITHUB_MCP_SCOPE`
  refuses out-of-scope calls and roaming `search_*` tools (see Install).
- **Ask before variable lookups.** Actions secrets are write-only (the
  API never returns their value), but Actions *variables* are plain text:
  `gh variable list` and `gh api` print them with a normal token. Unless
  every project keeps sensitive values out of variables, pin
  `{ "action": "shell", "resource": "gh variable *", "effect": "ask" }`
  and the same for `gh api *variables*` so a later broad `shell` allow
  rule cannot wave them through.
- **Ask before triggering pipelines.** A manual gate exists so a human
  decides when a run proceeds; an agent pressing its own gate defeats the
  point. The default toolset has no workflow-trigger tool, but the Actions
  opt-in (`GITHUB_MCP_TOOLSETS`, see Install) adds `actions_run_trigger`,
  which runs, reruns, and cancels workflows - opencode's default `ask`
  already covers it, and `GITHUB_MCP_READONLY=1` is stronger still (the
  tool is never registered at all) - and the shell always has one: pin
  `{ "action": "shell", "resource": "gh workflow run *", "effect":
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

Development notes (architecture invariants, generation bumps,
contribution rules) live in [AGENTS.md](./AGENTS.md).

## Related projects

- [kubernetes-mcp-proxy](https://github.com/code-acrobat/kubernetes-mcp-proxy):
  the same loopback-policy idea for the Kubernetes MCP server, with a
  harder guarantee set (namespace scoping, response filtering, startup
  schema lock) and a thorough published adversarial test (its
  `ADVERSARIAL-TESTS.md`). This proxy and its GitLab sibling were set up
  on the same principles; an equivalent adversarial pass for both is
  planned.

## License

[MIT](./LICENSE) — free to use, copy, modify, merge, publish, distribute;
without warranty.
