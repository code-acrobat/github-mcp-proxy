# Rules vs live tools/list validation.
# Usage: jq -n --slurpfile R <rules.json> --slurpfile L <tools/list response.json> -f validate.jq
($L[0].result.tools | map({key: .name, value: .inputSchema}) | from_entries) as $S
| [
    ($R[0].deny_tools[]? | select($S[.] == null) | "deny_tools: unknown tool \(.)"),
    ($R[0].deny_calls[]? | select($S[.tool] == null) | "deny_calls: unknown tool \(.tool)"),
    ($R[0].deny_calls[]? | select($S[.tool] != null) | . as $r
      | ($r.if // {}) | to_entries[] | . as $p
      | select($S[$r.tool].properties[$p.key] == null)
      | "\($r.tool): unknown argument \($p.key)"),
    ($R[0].deny_calls[]? | select($S[.tool] != null) | . as $r
      | ($r.if // {}) | to_entries[] | . as $p
      | ($S[$r.tool].properties[$p.key].enum // []) as $e
      | select(($e | length) > 0 and ($e | index($p.value) | not))
      | "\($r.tool): \($p.key)=\($p.value) not in enum \($e)")
  ]
| if length == 0 then "rules valid against live schema" else .[] end
