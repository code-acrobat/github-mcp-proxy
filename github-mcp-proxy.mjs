#!/usr/bin/env node
// GitHub MCP -> loopback bridge.
// Token stays on the host (keyring via `gh auth token`); the omac sandbox only
// ever sees http://127.0.0.1:3719/mcp and never the credential.
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execFileSync } from "node:child_process"

const PORT = 3719
const TARGET = new URL("https://api.githubcopilot.com/mcp/")
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
])

const token = () => execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()

http.createServer((req, res) => {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase()
    if (key === "host" || key === "authorization" || HOP.has(key)) continue
    headers[k] = v
  }
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
  req.pipe(up)
}).listen(PORT, "127.0.0.1", () => {
  console.log(`github mcp proxy on 127.0.0.1:${PORT} -> ${TARGET.href}`)
})
