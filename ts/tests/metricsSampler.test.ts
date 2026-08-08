import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validator = join(import.meta.dirname, "../../ops/prts-metrics/validate-sample.mjs");
const metrics = JSON.stringify({ schema_version: "prts-mcp.metrics/v1", sessions: { active: 0 } });

test("metrics sampler validator emits a schema-validated aggregate JSONL record", () => {
  const directory = mkdtempSync(join(tmpdir(), "prts-metrics-sampler-"));
  const events = join(directory, "memory.events");
  writeFileSync(events, "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n", "utf8");

  const result = spawnSync(process.execPath, [
    validator,
    "2026-08-08T00:00:00+00:00",
    "prts-mcp-ts.service",
    "123",
    "456",
    "789",
    "1000",
    "0",
    events,
  ], { input: metrics, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const sample = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal((sample.service as Record<string, unknown>).main_pid, 123);
  assert.equal((sample.cgroup as Record<string, unknown>).memory_current_bytes, 789);
  assert.equal((sample.metrics as Record<string, unknown>).schema_version, "prts-mcp.metrics/v1");
});

test("metrics sampler validator rejects an unexpected metrics schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "prts-metrics-sampler-"));
  const events = join(directory, "memory.events");
  writeFileSync(events, "low 0\n", "utf8");

  const result = spawnSync(process.execPath, [
    validator,
    "2026-08-08T00:00:00+00:00",
    "prts-mcp-ts.service",
    "123",
    "456",
    "789",
    "1000",
    "0",
    events,
  ], { input: JSON.stringify({ schema_version: "wrong" }), encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected metrics schema/);
});
