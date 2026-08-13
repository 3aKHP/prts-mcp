/**
 * HTTP transport for GitHub Release sync: mirrors, headers, cascading fetch.
 *
 * Mirrors python/src/prts_mcp/sync/transport.py. Extracted from data/sync
 * (P2.A): this is the repo's only HTTP-issuing tier. data/sync re-exports
 * these symbols during the P2.A→P2.B migration.
 */
import type { Dispatcher } from "undici";

const NATIVE_FETCH = globalThis.fetch;
let envProxyAgent: Dispatcher | undefined;

/** The response surface shared by the global and Undici fetch runtimes. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";

export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": GITHUB_UA };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * Parse GITHUB_MIRRORS env var into a list of proxy base URLs (trailing slash stripped).
 *
 * Unset / empty  → [] (direct only, no cascade)
 * "https://ghproxy.net"              → ["https://ghproxy.net"]
 * "https://a.example,https://b.example" → ["https://a.example", "https://b.example"]
 *
 * Mirror URL format (ghproxy-style): <mirror>/<original_url>
 * e.g. "https://ghproxy.net/https://raw.githubusercontent.com/..."
 */
export function parseMirrors(): string[] {
  return (process.env["GITHUB_MIRRORS"] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** Return [url, mirroredUrl1, mirroredUrl2, ...] */
function urlCandidates(url: string): string[] {
  return [url, ...parseMirrors().map((m) => `${m}/${url}`)];
}

async function fetchWithRuntimeProxy(
  url: string,
  options: Omit<RequestInit, "signal">,
  signal: AbortSignal,
): Promise<FetchResponse> {
  // Preserve test/in-process fetch overrides and Bun's native proxy support.
  if (
    globalThis.fetch !== NATIVE_FETCH
    || process.versions.bun
    || !(
      process.env["HTTP_PROXY"] || process.env["HTTPS_PROXY"]
      || process.env["http_proxy"] || process.env["https_proxy"]
    )
  ) {
    return globalThis.fetch(url, { ...options, signal });
  }
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  if (envProxyAgent === undefined) envProxyAgent = new EnvHttpProxyAgent();
  const response = await undiciFetch(url, {
    ...options,
    signal,
    dispatcher: envProxyAgent,
  } as Parameters<typeof undiciFetch>[1]);
  return response;
}

/**
 * fetch() wrapper that cascades through URL candidates on failure.
 *
 * - A fresh AbortSignal.timeout is created per attempt so an earlier
 *   timeout does not consume the budget for later candidates.
 * - HTTP 4xx from the direct URL propagates immediately (resource is
 *   genuinely missing — mirrors won't help).
 * - Network error or HTTP 5xx from any candidate → try the next one.
 */
export async function fetchCascading(
  url: string,
  options: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<FetchResponse> {
  const candidates = urlCandidates(url);
  let lastErr: unknown = new Error("All URL candidates failed");
  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = await fetchWithRuntimeProxy(
        candidates[i], options, AbortSignal.timeout(timeoutMs),
      );
      if (res.ok) return res;
      // Direct 404 → asset confirmed absent; record the typed error and stop
      // without trying mirrors. lastErr + break (not throw) so the typed
      // error survives to the caller even with GITHUB_MIRRORS (#100).
      if (i === 0 && res.status === 404) {
        lastErr = new AssetNotFoundError(`HTTP 404: ${candidates[i]}`);
        break;
      }
      lastErr = new Error(`HTTP ${res.status}`);
      // Other direct 4xx → the resource does not exist; mirrors cannot help.
      if (i === 0 && res.status >= 400 && res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * The direct release URL returned 404 — the asset genuinely does not exist.
 * Distinguished from a mirror 404 (mirror lacks the asset; the release may
 * still exist upstream) so manifest verification skips only on a confirmed
 * upstream 404 and stays fail-closed otherwise (#100).
 */
export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetNotFoundError";
  }
}
