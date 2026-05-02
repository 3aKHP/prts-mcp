import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import AdmZip from "adm-zip";

export interface JsonStore {
  exists(path: string): boolean;
  readText(path: string): string;
  readJson<T = unknown>(path: string): T;
  describe(): string;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error(`Unsafe dataset path: ${path}`);
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new Error(`Unsafe dataset path: ${path}`);
  }
  return parts.join("/");
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class DirectoryStore implements JsonStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private resolvePath(path: string): string {
    const root = resolve(this.root);
    const target = resolve(this.root, normalizePath(path));
    if (!isInsideRoot(root, target)) {
      throw new Error(`Unsafe dataset path: ${path}`);
    }
    return target;
  }

  resolveForDiagnostics(path: string): string {
    return this.resolvePath(path);
  }

  exists(path: string): boolean {
    const target = this.resolvePath(path);
    return existsSync(target) && statSync(target).isFile();
  }

  readText(path: string): string {
    const target = this.resolvePath(path);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`Dataset file not found: ${path}`);
    }
    return readFileSync(target, "utf-8");
  }

  readJson<T = unknown>(path: string): T {
    return JSON.parse(this.readText(path)) as T;
  }

  describe(): string {
    return `directory:${this.root}`;
  }
}

export class ZipStore implements JsonStore {
  readonly zipPath: string;

  constructor(zipPath: string) {
    this.zipPath = zipPath;
  }

  private zip(): AdmZip {
    return new AdmZip(this.zipPath);
  }

  exists(path: string): boolean {
    const innerPath = normalizePath(path);
    if (!existsSync(this.zipPath)) return false;
    return this.zip().getEntry(innerPath) !== null;
  }

  readText(path: string): string {
    const innerPath = normalizePath(path);
    const entry = this.zip().getEntry(innerPath);
    if (!entry) {
      throw new Error(`Dataset zip entry not found: ${path}`);
    }
    return entry.getData().toString("utf-8");
  }

  readJson<T = unknown>(path: string): T {
    return JSON.parse(this.readText(path)) as T;
  }

  describe(): string {
    return `zip:${this.zipPath}`;
  }
}

export class FallbackStore implements JsonStore {
  readonly primary: JsonStore;
  readonly fallback: JsonStore;

  constructor(primary: JsonStore, fallback: JsonStore) {
    this.primary = primary;
    this.fallback = fallback;
  }

  private storeFor(path: string): JsonStore | null {
    if (this.primary.exists(path)) return this.primary;
    if (this.fallback.exists(path)) return this.fallback;
    return null;
  }

  exists(path: string): boolean {
    return this.storeFor(path) !== null;
  }

  readText(path: string): string {
    const store = this.storeFor(path);
    if (store === null) {
      throw new Error(`Dataset file not found in fallback chain: ${path}`);
    }
    return store.readText(path);
  }

  readJson<T = unknown>(path: string): T {
    return JSON.parse(this.readText(path)) as T;
  }

  describe(): string {
    return `fallback:${this.primary.describe()} -> ${this.fallback.describe()}`;
  }
}
