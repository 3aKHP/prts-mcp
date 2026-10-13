// Distribution build/test tooling; production npm only executes runtime.cjs.
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
export function run(command, args, options = {}) {
  // On Windows execute npm's JS CLI through Node rather than interpolating a
  // .cmd command line. File paths/arguments remain an argv array.
  if (command === npm && process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    return execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  }
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}
