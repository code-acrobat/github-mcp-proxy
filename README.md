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

## Install

Prerequisites: `node`, and `gh` logged in (`gh auth status` must succeed on
the host).

```sh
cp github-mcp-proxy.mjs github-mcp-proxy.sh ~/.local/bin/
chmod +x ~/.local/bin/github-mcp-proxy.mjs ~/.local/bin/github-mcp-proxy.sh

github-mcp-proxy.sh up        # starts it in the background (nohup)
github-mcp-proxy.sh status    # prints pid + probes the port (exit 1 = down)
github-mcp-proxy.sh down
```

Log: `/tmp/opencode/github-mcp-proxy.log` (startup lines only, no per-request
logging). It is started by hand on purpose: no systemd unit, and it dies on
reboot or logout, so run `up` again after one.

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

## Production safeguards

A hobby setup is one personal token and one human at the keyboard. For
production repositories, keep a human approving each next step instead of
building hard tool denials:

- **Ask is already the default.** opencode asks before a tool runs when no
  permission rule matches, so no `permissions` block is needed: every
  create, merge, or push call waits for you. Prefer staying on `ask` over
  `deny` rules as long as a human approves the next step; add a deny only
  for something nobody should ever run.
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

## License

[MIT](./LICENSE) — free to use, copy, modify, merge, publish, distribute;
without warranty.
