import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, pin, version, sha, run, readJson } from './common.mjs';

const cache = join(root, '.runtime/npm-data', pin.release_tag);
mkdirSync(cache, { recursive: true });
// Validation snapshots remain frozen; production bundle pin is a separate
// declaration, and may reuse existing bytes only after matching its checksum.
for (const asset of pin.assets) {
  if (!['manifest.json','zh_CN-excel.zip','zh_CN-levels.zip','zh_CN.zip'].includes(asset.name)) throw new Error('Unexpected pinned asset');
  const dest = join(cache, asset.name);
  const frozen = join(root, '.runtime/data', pin.release_tag, asset.name);
  if (!existsSync(dest)) {
    const pending = dest + '.partial';
    try {
      if (existsSync(frozen) && sha(frozen) === asset.sha256) cpSync(frozen, pending);
      else run('curl', ['--fail', '--location', '--retry', '3', '--max-time', '600', '--output', pending,
        `https://github.com/${pin.repo}/releases/download/${encodeURIComponent(pin.release_tag)}/${asset.name}`], { stdio: 'inherit' });
      if (sha(pending) !== asset.sha256) throw new Error(`Bundle asset checksum mismatch: ${asset.name}`);
      renameSync(pending, dest);
    } finally { rmSync(pending, { force: true }); }
  }
  if (sha(dest) !== asset.sha256) throw new Error(`Cached bundle checksum mismatch: ${asset.name}`);
}
const output = resolve(root, 'artifacts/npm-bundle/data');
const args = [join(root, 'packaging/npm/data-release.json'), cache, output];
// Native CI builds this internal helper alongside the release binaries, with
// the same target/flags. Standalone data preparation still builds it locally.
const native = process.argv[2] ? await import('../native/common.mjs') : null;
// Owned staging directory only; no user data or root data/ is changed.
rmSync(output, { recursive: true, force: true });
if (native) run(join(native.release, 'examples', `package_data${native.suffix}`), args, { stdio: 'inherit' });
else run('cargo', ['run', '--locked', '--release', '--example', 'package_data', '--', ...args], { stdio: 'inherit' });
if (readJson(join(output, 'BUNDLE.json')).productVersion !== version) throw new Error('Bundle product version mismatch');
