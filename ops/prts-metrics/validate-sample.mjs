#!/usr/bin/env node
/** Validate one local metrics probe and emit the JSONL record for storage. */
import fs from "node:fs";

const [ts, serviceName, pid, rssKb, memoryCurrent, memoryPeak, swapCurrent, eventsPath] = process.argv.slice(2);
if ([ts, serviceName, pid, rssKb, memoryCurrent, memoryPeak, swapCurrent, eventsPath].some((value) => value === undefined)) {
  throw new Error("expected timestamp, service identity, cgroup fields, and memory.events path");
}

const events = Object.fromEntries(
  fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [key, value] = line.split(/\s+/, 2);
    if (!key || !/^\d+$/.test(value ?? "")) throw new Error(`invalid memory.events line: ${line}`);
    return [key, Number(value)];
  }),
);
const metrics = JSON.parse(fs.readFileSync(0, "utf8"));
if (metrics.schema_version !== "prts-mcp.metrics/v1") {
  throw new Error(`unexpected metrics schema: ${metrics.schema_version}`);
}
for (const [label, value] of Object.entries({ pid, rssKb, memoryCurrent, memoryPeak })) {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}
if (swapCurrent !== "null" && !/^\d+$/.test(swapCurrent)) {
  throw new Error(`invalid swapCurrent: ${swapCurrent}`);
}

process.stdout.write(`${JSON.stringify({
  ts,
  service: { name: serviceName, main_pid: Number(pid) },
  process: { rss_kb: Number(rssKb) },
  cgroup: {
    memory_current_bytes: Number(memoryCurrent),
    memory_peak_bytes: Number(memoryPeak),
    memory_swap_current_bytes: swapCurrent === "null" ? null : Number(swapCurrent),
    memory_events: events,
  },
  metrics,
})}\n`);
