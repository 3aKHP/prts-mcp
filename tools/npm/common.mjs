// Distribution build/test tooling; production npm only executes runtime.cjs.
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
export const targets = JSON.parse(readFileSync(join(root, 'packaging/native/targets.json')));
export const pin = JSON.parse(readFileSync(join(root, 'packaging/npm/data-release.json')));
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};
export const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function verifyInventory(dir) {
  const files = [];
  for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match, 'Invalid checksum record');
    const dest = resolve(dir, match[2]);
    const rel = relative(resolve(dir), dest);
    assert(rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.includes(':'));
    assert.equal(sha(dest), match[1], `Payload checksum: ${match[2]}`);
    files.push(match[2]);
  }
  return files;
}
export function verifyNotices(dir) {
  const inventory = readJson(join(dir, 'THIRD-PARTY.json'));
  const files = [inventory.rustStandardLibrary, inventory.nativeRegexp,
    ...inventory.packages.flatMap(pkg => pkg.notices.map(name => `licenses/${pkg.name}-${pkg.version}/${name}`))];
  // Reading each notice also catches dangling references after npm filtering.
  for (const file of files) readFileSync(join(dir, file));
  return files.length;
}
export function run(command, args, options = {}) {
  // On Windows execute npm's JS CLI through Node rather than interpolating a
  // .cmd command line. File paths/arguments remain an argv array.
  if (command === npm && process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    return execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  }
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}
