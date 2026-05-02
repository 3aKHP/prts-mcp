import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Failed to allocate test port"));
      });
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(300),
      });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

test("server listens before background data sync completes", async () => {
  const port = await getFreePort();
  const dataHome = mkdtempSync(join(tmpdir(), "prts-server-startup-"));
  const localAppData = join(dataHome, "LocalAppData");
  mkdirSync(localAppData, { recursive: true });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", "./tests/fixtures/hangingFetch.ts", "src/server.ts"],
    {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      XDG_DATA_HOME: dataHome,
      LOCALAPPDATA: localAppData,
      GITHUB_MIRRORS: "",
      STORYJSON_PATH: join(dataHome, "storyjson", "missing.zip"),
    },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForHealth(port, 3_000);
    assert.equal(child.exitCode, null, stderr);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
