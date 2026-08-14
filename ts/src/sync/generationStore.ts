/**
 * Images generation-filesystem store (state + update + query).
 * Mirrors python/src/prts_mcp/sync/generation_store.py.
 *
 * Owns the `.images_meta.json` pointer and the `.releases/<generation>/`
 * tree layout for the AKDP image sync: resolving the active generation,
 * atomically saving generation metadata, and pruning superseded generations.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, pruneOldTrees } from "./primitives.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
export const IMAGES_META = ".images_meta.json";

export function metaPath(root: string): string {
  return join(root, IMAGES_META);
}

export async function loadMeta(root: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(metaPath(root), "utf-8"));
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function saveMeta(root: string, meta: Record<string, unknown>): Promise<void> {
  await atomicWriteJson(metaPath(root), meta);
}

/** Synchronous active-generation resolver — shared by sync and tool layers. */
export function activeGenerationSync(imageDir: string): string | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(join(imageDir, IMAGES_META), "utf-8"));
  } catch {
    return null;
  }
  const rel = meta["generation_root"];
  if (typeof rel !== "string" || rel.length === 0) return null;
  const base = resolve(imageDir);
  const gen = resolve(base, rel);
  const relCheck = relative(base, gen);
  if (relCheck === ".." || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck)) {
    return null;
  }
  try {
    if (!statSync(gen).isDirectory()) return null;
    statSync(join(gen, "index.json"));
    return gen;
  } catch {
    return null;
  }
}

export async function activeGeneration(imageDir: string): Promise<string | null> {
  return activeGenerationSync(imageDir);
}

export async function releasesDir(imageDir: string): Promise<string> {
  const dir = join(imageDir, ".releases");
  await mkdir(dir, { recursive: true });
  return dir;
}

export function versionHash(version: string): string {
  return createHash("sha256").update(version).digest("hex").slice(0, 16);
}

export async function pruneGenerations(releasesDir: string, keep: string): Promise<void> {
  await pruneOldTrees(releasesDir, new Set([keep]), RETENTION_MS, { skipHidden: true });
}
