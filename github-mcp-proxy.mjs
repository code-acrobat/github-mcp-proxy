#!/usr/bin/env node
// GitHub MCP -> loopback bridge.
// Token stays on the host (keyring via `gh auth token`); the omac sandbox only
// ever sees http://127.0.0.1:3719/mcp and never the credential.
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

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
const parseScope = (raw) =>
  raw.split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf("/")
      return i < 0
        ? { owner: e.toLowerCase(), repo: null }
        : { owner: e.slice(0, i).toLowerCase(), repo: e.slice(i + 1).toLowerCase() }
    })
const SCOPE = parseScope(SCOPE_RAW)
// Subject-less calls allowed under a scope: get_me only. Everything else
// either names a subject (checked) or is refused.
const SCOPE_OK = new Set(["get_me"])
// Free-text query tools: the query can name any repository, so no argument
// check can confine them. Refused while a scope is active.
const SCOPE_REFUSED = new Set(["search_issues", "search_pull_requests"])
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
const RULES_FILE = join(import.meta.dirname, "github-mcp-proxy.rules.json")
let rulesCfg = null
let rulesError = null
try {
  const cfg = JSON.parse(readFileSync(RULES_FILE, "utf8"))
  rulesCfg = cfg
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
  rulesError = e.code === "ENOENT" ? "missing" : e.message
}

// ponytail: exact match on the listed arg pairs only; add a `missing:` check when a rule needs absence
const mkBlockedReason = (scopeSet, scope) => (body) => {
  if (body?.method !== "tools/call") return null
  const name = body?.params?.name
  if (denyTools.has(name)) return `denied ${name}`
  const args = body?.params?.arguments
  for (const r of denyCalls) {
    if (r.tool !== name) continue
    if (r.if && !Object.entries(r.if).every(([k, v]) => args?.[k] === v)) continue
    return r.reason || `denied ${r.tool}`
  }
  if (scopeSet) {
    if (SCOPE_REFUSED.has(name)) return `scope: ${name} takes a free-text query that can name any repository`
    const subj = ["owner", "org", "organization"]
      .map((k) => args?.[k])
      .filter((v) => typeof v === "string" && v)
    if (subj.length) {
      const repo = typeof args?.repo === "string" ? args.repo.toLowerCase() : null
      const ok = (o) => scope.some((e) => e.owner === o && (e.repo == null || repo === e.repo))
      const bad = subj.find((v) => !ok(v.toLowerCase()))
      if (bad) return `scope: ${name} targets ${bad}${args?.repo ? "/" + args.repo : ""} outside GITHUB_MCP_SCOPE`
      return null
    }
    if (!SCOPE_OK.has(name)) return `scope: ${name} has no owner/org and is outside GITHUB_MCP_SCOPE`
  }
  return null
}
const blockedReason = mkBlockedReason(SCOPE_SET, SCOPE)

if (process.argv.includes("--selftest")) {
  const call = (name, args) => ({ method: "tools/call", params: { name, arguments: args } })
  const deny = mkBlockedReason(true, parseScope("acme,acme/lib"))
  const eq = (why, want, got) => {
    if (Boolean(got) !== want) {
      console.error(`FAIL ${why}: got ${JSON.stringify(got)}, want ${want ? "blocked" : "allowed"}`)
      process.exit(1)
    }
  }
  eq("in-scope owner/repo passes", false, deny(call("list_issues", { owner: "acme", repo: "lib" })))
  eq("out-of-scope owner refused", true, deny(call("list_issues", { owner: "evil", repo: "x" })))
  eq("fork under the scoped owner passes", false, deny(call("fork_repository", { owner: "acme", repo: "lib" })))
  eq("fork into an unscoped org refused", true,
    deny(call("fork_repository", { owner: "acme", repo: "lib", organization: "evil" })))
  eq("create_repository via a scoped org passes", false, deny(call("create_repository", { name: "x", organization: "acme" })))
  eq("create_repository into the personal account refused", true, deny(call("create_repository", { name: "x" })))
  eq("search tools refused under scope", true, deny(call("search_issues", { query: "is:open", owner: "acme" })))
  eq("search query text cannot escape scope", true,
    deny(call("search_issues", { query: "repo:evil/x is:open", owner: "acme" })))
  eq("get_me stays allowed", false, deny(call("get_me", {})))
  const empty = mkBlockedReason(true, parseScope(""))
  eq("empty scope is deny-all", true, empty(call("list_issues", { owner: "acme", repo: "lib" })))
  eq("empty scope still allows get_me", false, empty(call("get_me", {})))
  eq("no scope = no scope check", false, mkBlockedReason(false, [])(call("list_issues", { owner: "evil", repo: "x" })))
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
eq("inventory diff: unchanged", true, same(inventoryDiff(["a", "b"], ["a", "b"]), { added: [], gone: [] }))
eq("inventory diff: added", true, same(inventoryDiff(["a"], ["a", "b"]), { added: ["b"], gone: [] }))
eq("inventory diff: removed", true, same(inventoryDiff(["a", "b"], ["a"]), { added: [], gone: ["b"] }))
eq("inventory formatting: short list", true, fmtList(["x"]) === "x")
eq("inventory formatting: caps long lists", true, fmtList(["1", "2", "3", "4", "5", "6", "7"]) === "1, 2, 3, 4, 5, 6 +1 more")
console.log("selftest ok")
  process.exit(0)
}

// One place speaks the session protocol: identity + inventory, with the same
// policy headers a client gets (the registered inventory depends on them).
const policyNow = () => ({ toolsets: TOOLSETS_SET ? TOOLSETS : null, readonly: READONLY })
const parseFrame = (t) => {
  const line = t.split("\n").find((l) => l.startsWith("data: "))
  return JSON.parse(line ? line.slice(6) : t)
}
const policyHeaders = (tok) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${tok}`,
  "user-agent": "github-mcp-proxy",
  ...(TOOLSETS_SET ? { "x-mcp-toolsets": TOOLSETS } : {}),
  ...(READONLY ? { "x-mcp-readonly": "true" } : {}),
})
async function openSession() {
  const h = policyHeaders(token())
  const init = await fetch(TARGET.href, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "github-mcp-proxy", version: "0" } },
    }),
    signal: AbortSignal.timeout(8000),
  })
  const sid = init.headers.get("mcp-session-id")
  const info = parseFrame(await init.text())?.result?.serverInfo
  if (!info?.version) throw new Error("upstream did not report serverInfo.version")
  const h2 = { ...h }
  if (sid) h2["mcp-session-id"] = sid
  await fetch(TARGET.href, {
    method: "POST",
    headers: h2,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {})
  const listRes = await fetch(TARGET.href, {
    method: "POST",
    headers: h2,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(15000),
  })
  const tools = parseFrame(await listRes.text())?.result?.tools
  if (!Array.isArray(tools) || !tools.length) throw new Error("upstream reported no tool inventory")
  return { info, live: tools.map((t) => t.name).filter(Boolean).sort() }
}
function inventoryDiff(snapshot, live) {
  const want = new Set(snapshot ?? [])
  const have = new Set(live)
  return {
    added: live.filter((t) => !want.has(t)),
    gone: (snapshot ?? []).filter((t) => !have.has(t)),
  }
}
function samePolicy(stamped, now) {
  if (!stamped) return true
  return (stamped.toolsets ?? null) === (now.toolsets ?? null) && Boolean(stamped.readonly) === Boolean(now.readonly)
}
function fmtList(l) {
  return l.length > 6 ? `${l.slice(0, 6).join(", ")} +${l.length - 6} more` : l.join(", ")
}

// --stamp re-baselines the rules against the live upstream: identity + inventory.
// It needs a reachable upstream but not a passing lock, so it is the recovery path.
if (process.argv.includes("--stamp")) {
  try {
    const { info, live } = await openSession()
    const cfg = rulesCfg ?? {}
    const before = Array.isArray(cfg.tools) ? cfg.tools : []
    const name = info.name || "github-mcp-server"
    cfg.schema = `${name}@${String(info.version).replace(`${name}/`, "")}`
    cfg.tools = live
    cfg.snapshot = policyNow()
    writeFileSync(RULES_FILE, `${JSON.stringify(cfg, null, 2)}\n`)
    console.log(`stamped ${RULES_FILE}: ${cfg.schema}, ${live.length} tools, policy ${JSON.stringify(cfg.snapshot)}`)
    if (before.length) {
      const { added, gone } = inventoryDiff(before, live)
      console.log(`inventory: +${added.length} [${fmtList(added) || "-"}], -${gone.length} [${fmtList(gone) || "-"}]`)
    }
    process.exit(0)
  } catch (e) {
    console.error(`stamp failed: ${e.message}`)
    process.exit(1)
  }
}

// Schema lock: the rules carry the tool inventory they were written against,
// and every tool call is refused when the live inventory differs. Deny rules
// are name-based, so a renamed or newly added tool is exactly the drift that
// would silently disarm them; the build id (remote-<sha>) churns on deploys
// that touch no tool and is recorded, not compared, unless
// GITHUB_MCP_UPSTREAM_VERSION pins it. GITHUB_MCP_SCHEMA_LOCK=off restores the
// previous behaviour (identity check only).
const normV = (v) => String(v ?? "").replace(/^v/, "")
const lockOff = /^(0|off|no|false)$/i.test(String(process.env.GITHUB_MCP_SCHEMA_LOCK ?? "").trim())
if (lockOff && rulesError) console.error(`rules unusable (${rulesError}); forwarding all calls (schema lock off)`)
const pinned = process.env.GITHUB_MCP_UPSTREAM_VERSION || null
const snapshot = Array.isArray(rulesCfg?.tools) ? rulesCfg.tools.filter((t) => typeof t === "string") : null
let lockReason = null

if (!lockOff) {
  const then = rulesCfg?.snapshot ?? null
  if (rulesError === "missing")
    lockReason = `no ${basename(RULES_FILE)} (no rules, no inventory to verify) — run github-mcp-proxy.sh stamp to generate one, or set GITHUB_MCP_SCHEMA_LOCK=off`
  else if (rulesError) lockReason = `rules unusable (${rulesError}) — fix or remove them, then restart`
  else if (!rulesCfg?.schema) lockReason = 'rules are not stamped with the upstream identity — set "schema": "<server>@<build>" via github-mcp-proxy.sh stamp'
  else if (!snapshot?.length) lockReason = 'rules carry no "tools" inventory snapshot — run github-mcp-proxy.sh stamp, then restart'
  else if (!samePolicy(then, policyNow()))
    lockReason = `policy changed since the rules were stamped (${JSON.stringify(then)} -> ${JSON.stringify(policyNow())}) — the registered inventory differs; re-stamp, then restart`
  else {
    let lastErr = null
    for (let attempt = 0; attempt < 3 && !lockReason; attempt++) {
      try {
        const { info, live } = await openSession()
        if (info.name && info.name !== "github-mcp-server") {
          lockReason = `upstream identifies as ${info.name}, expected github-mcp-server`
          break
        }
        if (pinned && normV(info.version) !== normV(pinned)) {
          lockReason = `upstream build ${info.version} != pinned GITHUB_MCP_UPSTREAM_VERSION ${pinned} — re-stamp after verifying, then restart`
          break
        }
        const { added, gone } = inventoryDiff(snapshot, live)
        if (added.length || gone.length)
          lockReason = `tool inventory changed (upstream build ${info.version}): added [${fmtList(added) || "-"}], removed [${fmtList(gone) || "-"}] — re-run the rules drift check, then github-mcp-proxy.sh stamp && down && up`
        else console.log(`schema ok: ${live.length} tools match the rules snapshot (upstream ${info.version})`)
        break
      } catch (e) {
        lastErr = e
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!lockReason && lastErr)
      lockReason = `schema check failed: upstream unreachable at startup (${lastErr.message}) — restart once it is reachable, or set GITHUB_MCP_SCHEMA_LOCK=off`
  }
}
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
