# Migrating from 2.5 to 2.6

PRTS-MCP 2.6.0 upgrades both implementations to MCP SDK v2 and adds support for the `2026-07-28` protocol era. It does not remove the established legacy protocol path. Existing 2.5 clients can continue using their current initialize/session behaviour without configuration changes.

## Choose one protocol era per connection

Legacy clients continue to send `initialize`, receive and reuse `Mcp-Session-Id` on Streamable HTTP, then use the normal tools protocol. This is the compatibility path and remains supported throughout the 2.x line.

Modern clients may opt into the `2026-07-28` envelope. On HTTP this path is stateless: use the modern request envelope for `server/discover`, `tools/list`, and `tools/call`; do not send `Mcp-Session-Id`, and do not rely on an initialize handshake. A request that claims the modern protocol but omits its required modern envelope is rejected instead of being silently routed as legacy.

For stdio, the first request on a process connection selects the protocol era. Start a separate stdio process when switching between legacy and modern modes; do not attempt to change eras later on the same connection.

## Client rollout

Keep current clients on legacy first. Enable a strict-modern client only after it successfully discovers the server, lists tools, and performs an ordinary tool call against the intended endpoint. An auto-negotiating client should be verified both in its normal mode and with its modern mode forced, because protocol autodetection is a client behaviour rather than a server guarantee.

The wire field names remain MCP-standard camelCase, including `structuredContent`, `isError`, and `mimeType`. The Python SDK v2 API uses snake_case while constructing these results internally; this is not a client-side schema change.

## Artwork form handling

`operator_artwork` now recognizes `阿米娅(近卫)` and `阿米娅(医疗)` as artwork-specific form aliases. This is deliberately limited to this tool: general operator lookup behaviour has not changed. An opaque `artwork_id` returned by `operator_artwork(action="list")` belongs to one exact normalized operator form. Pass it only back to `get` for that same form; the base form and sibling form are rejected before any local image read or MediaWiki request.

## Operations and observability

The TypeScript server's `/debug/metrics` endpoint remains opt-in (`PRTS_METRICS_ENABLED=true`) and exposes aggregate process, cache, request, tool, and session counters only. Do not reverse-proxy it publicly. It must never expose MCP arguments, results, authorization material, session IDs, image base64, or resource bodies.

Run the six-session memory benchmark only against an isolated loopback canary, never the stable production service. The documented canary assets set a soft cgroup pressure limit of 1 GiB and a hard limit of 1.5 GiB; a failed benchmark or consumer acceptance gate means remove the temporary route and stop the canary while leaving the stable service untouched.

## Removal horizon

2.x retains the legacy protocol path. Any 3.x removal decision requires a documented deprecation period, telemetry that demonstrates client migration, and successful real-consumer modern acceptance. Version 2.6.0 is an additive compatibility release, not a forced protocol cutover.
