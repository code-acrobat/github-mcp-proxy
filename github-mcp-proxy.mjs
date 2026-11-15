#!/usr/bin/env node
// GitHub MCP -> loopback bridge.
// Token stays on the host (keyring via `gh auth token`); the omac sandbox only
// ever sees http://127.0.0.1:3719/mcp and never the credential.
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PORT = Number(process.env.PORT || 3719)
const TARGET = new URL(process.env.GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/")
// Opt-in upstream toolsets (e.g. "default,actions"): injected as x-mcp-toolsets.
// Host-side policy: the key present (even empty) overrides any client header -
// a configured list is a hard ceiling a client can never expand, because the
// client may be an untrusted sandbox. Key absent = client header passes through.
const TOOLSETS_SET = process.env.GITHUB_MCP_TOOLSETS !== undefined
const TOOLSETS = (process.env.GITHUB_MCP_TOOLSETS || "").trim()
// Read-only enforcement: upstream then registers only read tools (write tools
// are never offered, so nothing can call them - stronger than deny rules,
// which fail open on drift). Forced: the client cannot lift it, because the
// client may be an untrusted sandbox; enabling writes is a host-side edit of
// GITHUB_MCP_READONLY plus a restart.
const READONLY = /^(1|true|yes|on)$/i.test((process.env.GITHUB_MCP_READONLY || "").trim())
// Repo scope: comma list of `owner` or `owner/repo` entries (e.g. "me,my-org/my-repo").
// Key present (even empty) = active: a tools/call must name an owner/org/
// organization that matches an entry, and calls without a repository subject
// are refused except the two account-true tools in SCOPE_OK; an empty list
// matches nothing, so a truncated config denies instead of unscoping. Fail
// closed regardless of upstream tool drift, unlike name-based deny rules.
const SCOPE_SET = process.env.GITHUB_MCP_SCOPE !== undefined
const SCOPE_RAW = (process.env.GITHUB_MCP_SCOPE || "").trim()
const SCOPE = SCOPE_RAW.split(",")
  .map((e) => e.trim())
  .filter(Boolean)
  .map((e) => {
    const i = e.indexOf("/")
    return i < 0
      ? { owner: e.toLowerCase(), repo: null }
      : { owner: e.slice(0, i).toLowerCase(), repo: e.slice(i + 1).toLowerCase() }
  })
const SCOPE_OK = new Set(["get_me", "create_repository"])
const FLAGS = [
  TOOLSETS_SET && `toolsets: ${TOOLSETS}`,
  READONLY && "readonly",
  SCOPE_SET && `scope: ${SCOPE_RAW}`,
].filter(Boolean).join(", ")
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
])

const token = () => execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()

// Call rules, read once at start (edit file, then down + up to apply).
// Missing file = no rules = forward everything (backward compatible).
// Startup sanity: entries must be {tool: string, if?: object, reason?: string};
// `schema` records the upstream release the rules were written against, so a
// rule from the wrong schema generation gets spotted instead of silently
// never matching.
let denyCalls = []
const denyTools = new Set()
try {
  const cfg = JSON.parse(readFileSync(join(import.meta.dirname, "github-mcp-proxy.rules.json"), "utf8"))
  const all = cfg.deny_calls ?? []
  denyCalls = all.filter((d) => typeof d?.tool === "string" && (d.if == null || typeof d.if === "object"))
  if (denyCalls.length < all.length) console.error(`rules: dropped ${all.length - denyCalls.length} malformed deny_calls entries`)
  const toolList = cfg.deny_tools ?? []
  for (const t of toolList) {
    if (typeof t === "string") denyTools.add(t)
    else console.error("rules: dropped malformed deny_tools entry")
  }
  if (denyCalls.length || denyTools.size)
    console.log(
      `rules: ${denyTools.size} deny_tools, ${denyCalls.length} deny_calls active (schema ${cfg.schema ?? "unspecified"})`,
    )
} catch (e) {
  if (e.code !== "ENOENT") console.error(`rules unusable (${e.message}); forwarding all calls`)
}

// ponytail: exact match on the listed arg pairs only; add a `missing:` check when a rule needs absence
const blockedReason = (body) => {
  if (body?.method !== "tools/call") return null
  const name = body?.params?.name
  if (denyTools.has(name)) return `denied ${name}`
  const args = body?.params?.arguments
  for (const r of denyCalls) {
    if (r.tool !== name) continue
    if (r.if && !Object.entries(r.if).every(([k, v]) => args?.[k] === v)) continue
    return r.reason || `denied ${r.tool}`
  }
  if (SCOPE_SET) {
    const subj = [args?.owner, args?.org, args?.organization].find((v) => typeof v === "string" && v)
    if (subj !== undefined) {
      const s = subj.toLowerCase()
      const repo = typeof args?.repo === "string" ? args.repo.toLowerCase() : null
      if (SCOPE.some((e) => e.owner === s && (e.repo == null || repo === e.repo))) return null
      return `scope: ${name} targets ${subj}${args?.repo ? "/" + args.repo : ""} outside GITHUB_MCP_SCOPE`
    }
    if (!SCOPE_OK.has(name)) return `scope: ${name} has no owner/org and is outside GITHUB_MCP_SCOPE`
  }
  return null
}

// Schema lock - identity check only. The hosted endpoint reports its own
// version on initialize (a commit hash, e.g. github-mcp-server/remote-<sha>).
// Newer commit hashes are expected and must NOT lock: the latest release tag
// is sufficient, deploy-hash churn does not break the interface. Re-evaluating
// tool schemas against a new tag stays the skill's offline drift check (see
// AGENTS.md "Working on rules"). This lock only fires when a successful
// initialize answers with a different server name or no version at all -
// i.e. the endpoint stopped being the GitHub MCP server. An unreachable
// initialize does not lock (the per-request 502 surfaces that instead).
let lockReason = null
try {
  let tok = null
  try { tok = token() } catch {}
  if (tok) {
    const r = await fetch(TARGET.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tok}`,
        "user-agent": "github-mcp-proxy",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "github-mcp-proxy", version: "0" } },
      }),
      signal: AbortSignal.timeout(8000),
    })
    const text = await r.text()
    const line = text.split("\n").find((l) => l.startsWith("data: "))
    const info = JSON.parse(line ? line.slice(6) : text)?.result?.serverInfo
    if (!info?.version) {
      lockReason = "upstream did not report serverInfo.version on initialize"
    } else if (info.name && info.name !== "github-mcp-server") {
      lockReason = `upstream identifies as ${info.name}, expected github-mcp-server`
    } else {
      console.log(`schema ok: upstream identifies as ${info.name ?? "github-mcp-server"} ${info.version} (identity lock; tag re-eval is the skill's drift check)`)
    }
  }
} catch {}
if (lockReason) console.log(`schema LOCKED: ${lockReason}; tools/call denied until the endpoint is back or you restart`)

http.createServer((req, res) => {
  // Browsers are not clients here: block requests carrying fetch metadata.
  if (req.headers.origin || req.headers["sec-fetch-site"]) {
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("browser requests are not allowed")
    return
  }
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const raw = Buffer.concat(chunks)
    // Buffer requests only so tools/call can be ruled on; forward raw bytes.
    // Every tools/call must face policy on its own - a denied call must not
    // ride in past the rules hidden inside a batch or behind a bad body.
    let reason = null
    let id = null
    let body = null
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString("utf8"))
      } catch {
        // Non-empty body that is not one JSON value: not a valid MCP request,
        // and unscannable = unverifiable. Refuse instead of forwarding blind.
        reason = "unparseable body"
      }
    }
    if (body && typeof body === "object") {
      if (Array.isArray(body)) {
        const calls = body.filter((m) => m && m.method === "tools/call")
        for (const c of calls) {
          const r = blockedReason(c)
          if (r) {
            reason = `batch hides a tools/call (${r})`
            break
          }
        }
        // the schema lock must hold for batches too: a locked endpoint denies
        // every tools/call, whether it arrives alone or hidden in an array
        if (!reason && lockReason && calls.length) reason = lockReason
      } else {
        reason = blockedReason(body)
        id = body?.id ?? null
        if (!reason && lockReason && body?.method === "tools/call") reason = lockReason
      }
    }
    if (reason) {
      console.log(`${new Date().toISOString()} blocked tools/call: ${reason}`)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `blocked by github-mcp-proxy policy: ${reason}` },
        }),
      )
      return
    }
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (key === "host" || key === "authorization" || HOP.has(key)) continue
      headers[k] = v
    }
    if (TOOLSETS_SET) headers["x-mcp-toolsets"] = TOOLSETS // overwrite (even empty): configured ceiling, client cannot expand
    if (READONLY) headers["x-mcp-readonly"] = "true" // overwrite: client cannot lift it
    try {
      headers.authorization = `Bearer ${token()}`
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" })
      res.end(`token lookup failed: ${e.message}`)
      return
    }
    headers["user-agent"] = "github-mcp-proxy"

    const up = https.request(
      {
        hostname: TARGET.hostname,
        port: 443,
        path: TARGET.pathname + TARGET.search,
        method: req.method,
        headers,
      },
      (ures) => {
        const rh = {}
        for (const [k, v] of Object.entries(ures.headers)) {
          if (!HOP.has(k.toLowerCase())) rh[k] = v
        }
        res.writeHead(ures.statusCode ?? 502, rh)
        ures.pipe(res) // streams SSE; never buffer
      },
    )
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
      res.end(String(e))
    })
    up.end(raw)
  })
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `github mcp proxy on 127.0.0.1:${PORT} -> ${TARGET.href}${FLAGS ? ` (${FLAGS})` : ""}`,
  )
})
