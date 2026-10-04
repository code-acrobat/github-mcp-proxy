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

## Alternatives

The `omac-gh` skill from the skill marketplace does a similar job, but it
needs marketplace access and lives inside a model session. This repo is the
plain-file stand-in: same job (GitHub access for sandboxed sessions), no skill
install, and you can read the whole thing in one sitting.

## License

[MIT](./LICENSE) — free to use, copy, modify, merge, publish, distribute;
without warranty.
