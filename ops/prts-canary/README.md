# PRTS-MCP 2.6.0 same-host canary

This is a deliberately separate service for release acceptance. It is not a
production replacement unit and it must not be enabled before the exact npm
package has been published and verified.

The unit starts the published package from
`/opt/prts-mcp-canary/node_modules/prts-mcp-ts` on `127.0.0.1:5103`. It reads
the existing GameData, StoryJson, and local image generation through explicit
paths, which prevents the canary from becoming a second auto-sync publisher.
`MemoryHigh=1G` (1 GiB) starts cgroup reclaim/throttling and
`MemoryMax=1536M` (1.5 GiB) is the hard stop. The stable
`prts-mcp-ts.service` remains unchanged throughout this phase.

## Installation and rollback material

1. Record the currently installed global package version and the active
   `prts-mcp-ts.service` unit/drop-ins. Keep the known-good 2.5.2 package and
   unit files available for rollback.
2. Create `/opt/prts-mcp-canary` owned by `ubuntu`, install the exact
   published package there with npm, and compare the downloaded tarball's
   SHA-256 and size with the release manifest before `npm install`.
3. Create `/etc/prts-mcp-canary/debug.env` with a unique `PRTS_DEBUG_TOKEN`,
   readable only by the canary operator, then install
   `prts-mcp-ts-canary.service`, run `systemctl daemon-reload`, and start only
   `prts-mcp-ts-canary.service`. Verify `/health` and `/debug/metrics`
   directly on `127.0.0.1:5103`, supplying `Authorization: Bearer` with that
   token; never publish the metrics endpoint through Nginx.
4. Temporarily include `prts-canary.nginx.conf` in the existing MCP virtual
   host, validate with root-owned `nginx -t`, and reload Nginx. The route uses
   the existing authenticated `$mcp_auth` gate at `/prts-canary/mcp`.

If any gate fails, remove the Nginx include, stop and disable the canary
service, and retain its journal plus cgroup metrics for diagnosis. Do not
modify the stable service during a failed canary.

## Acceptance gates

- strict-modern QuickQuip against the temporary route;
- Prism Vesicle in strict-modern and auto-to-modern modes;
- a real legacy session client against the stable route;
- `PRTS_BENCH_ISOLATED=true PRTS_DEBUG_TOKEN=...` loopback benchmark with 6 mixed sessions;
- cgroup `memory.current`, `memory.peak`, `memory.events`, and aggregate
  `/debug/metrics` confirm no OOM/high-limit breach and bounded short-window
  RSS growth.

Only after all gates pass should the release owner update the stable service
to the same verified package. Keep the 2.5.2 rollback package/unit material
until the post-cutover legacy and modern checks complete, then remove the
temporary Nginx route and canary unit.
