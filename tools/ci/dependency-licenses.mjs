import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'contracts/dependency-licenses.json';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = p => `${p.name}@${p.version}`;

/** Full locked registry graph, including dev/build and platform dependencies. */
export function inventory(metadata, channel) {
  const packages = metadata.packages
    .filter(p => p.source?.startsWith('registry+'))
    .map(p => ({ name: p.name, version: p.version, license: p.license, repository: p.repository }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const counts = new Map();
  for (const p of packages) {
    if (!p.license) throw new Error(`${key(p)}: missing license expression; review upstream metadata`);
    counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  }
  return {
    toolchain: `${channel} (rust-toolchain.toml)`,
    lockfile: 'Cargo.lock (committed)',
    lock_package_count: packages.length,
    source: 'cargo metadata --locked --format-version 1 (full registry dependency graph)',
    license_summary: Object.fromEntries([...counts].sort(([a], [b]) => compare(a, b))),
    packages,
  };
}

export function problems(document, generated) {
  const issues = [];
  const old = new Map(document.packages.map(p => [key(p), p]));
  const current = new Map(generated.packages.map(p => [key(p), p]));
  for (const [id, pkg] of current) {
    if (!old.has(id)) issues.push(`added: ${id}`);
    else if (JSON.stringify(old.get(id)) !== JSON.stringify(pkg)) issues.push(`changed: ${id}`);
  }
  for (const id of old.keys()) if (!current.has(id)) issues.push(`removed: ${id}`);
  for (const field of Object.keys(generated)) {
    if (field !== 'packages' && JSON.stringify(document[field]) !== JSON.stringify(generated[field])) {
      issues.push(`changed: ${field}`);
    }
  }
  for (const item of document.flagged ?? []) {
    const pkg = current.get(key(item));
    if (!pkg || pkg.license !== item.license) issues.push(`review flagged entry: ${key(item)}`);
  }
  return issues;
}

export function run(root, metadata, { write = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  const path = join(root, FILE);
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const channel = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml: missing channel');
  const generated = inventory(metadata, channel);
  const issues = problems(document, generated);
  if (write) {
    const review = issues.filter(p => p.startsWith('review flagged entry:'));
    if (review.length) throw new Error(review.join('\n'));
    // Keep human dispositions, notes, vendored components and other manual fields.
    writeFileSync(path, JSON.stringify({ ...document, ...generated, recorded_at: issues.length ? date : document.recorded_at }, null, 2) + '\n');
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--write')) throw new Error('Usage: node tools/ci/dependency-licenses.mjs [--write]');
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }));
    const write = args.includes('--write');
    const issues = run(ROOT, metadata, { write });
    if (issues.length) console.log(issues.join('\n'));
    if (!write && issues.length) {
      console.error('Run node tools/ci/dependency-licenses.mjs --write and review the changes.');
      process.exitCode = 1;
    } else console.log(write ? 'DEPENDENCY_LICENSES_WRITTEN' : 'DEPENDENCY_LICENSES_PASS');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
