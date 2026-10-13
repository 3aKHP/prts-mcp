// Build/test tooling only. Released programs do not execute Node.
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const targets = JSON.parse(readFileSync(join(root, 'packaging/native/targets.json')));
export const bins = ['prts-mcp', 'prts-mcp-ts', 'prts-mcp-ts-bun', 'prts-mcp-ts-stdio', 'prts-mcp-ghcr'];
export const id = process.argv[2];
export const config = targets[id];
if (!config) throw new Error(`Usage: node tools/native/<build|pack|audit|probe>.mjs <${Object.keys(targets).join('|')}>`);
// Cross builds cannot silently masquerade as native runtime evidence.
if (process.platform !== config.os || process.arch !== config.arch) {
  throw new Error(`${id} requires a native ${config.os}/${config.arch} host; got ${process.platform}/${process.arch}`);
}
export const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
export const out = resolve(root, 'artifacts/native', id);
export const stage = join(out, 'payload');
export const suffix = config.os === 'win32' ? '.exe' : '';
export const release = join(root, 'target', config.target, 'release');
export const flags = `-C target-cpu=${config.cpu}${config.crt === 'static' ? ' -C target-feature=+crt-static' : ''}`;
export const buildEnv = { ...process.env, RUSTFLAGS: flags,
  ...(config.deploymentTarget ? { MACOSX_DEPLOYMENT_TARGET: config.deploymentTarget } : {}) };
export function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, env: buildEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}
export function json(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
export function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
// PowerShell single-quoted literals preserve Unicode and do not expand $ or
// backticks; only the embedded quote needs escaping. Never pass through a shell.
export function psLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }
