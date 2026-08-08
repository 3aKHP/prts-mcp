# PRTS-MCP production metrics sampler

These files are the version-controlled source for the production-only sampler; they are not included in the npm package.

Install after deploying a TS build that provides `/debug/metrics`:

```bash
install -m 0755 ops/prts-metrics/sample-metrics.sh /opt/prts-mcp/scripts/sample-metrics.sh
install -m 0644 ops/prts-metrics/validate-sample.mjs /opt/prts-mcp/scripts/validate-sample.mjs
install -m 0644 ops/prts-metrics/metrics.conf /etc/systemd/system/prts-mcp-ts.service.d/metrics.conf
install -m 0644 ops/prts-metrics/prts-metrics-sampler.service /etc/systemd/system/
install -m 0644 ops/prts-metrics/prts-metrics-sampler.timer /etc/systemd/system/
install -m 0644 ops/prts-metrics/prts-metrics.logrotate /etc/logrotate.d/prts-mcp-metrics
systemctl daemon-reload
systemctl restart prts-mcp-ts.service
systemctl enable --now prts-metrics-sampler.timer
```

Before reloading systemd, create `/etc/prts-mcp/debug.env` with a unique `PRTS_DEBUG_TOKEN` and restrict it to the service operator. Both the server and sampler load this file; the sampler keeps the bearer token out of its process arguments. The PRTS service must listen on loopback and no reverse-proxy route may expose `/debug/metrics`. The host needs Node.js available as `node` for schema validation (the production host's supported Node runtime satisfies this). Each successful timer run appends one schema-validated JSON object to `/var/log/prts-mcp/metrics-samples.jsonl`; a failed local probe fails the oneshot unit and writes no misleading empty sample.
