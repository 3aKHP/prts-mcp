import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { root, out, stage, config } from './common.mjs';

// Retain the actual notices supplied by the locked registry sources, rather
// than guessing license text from an SPDX identifier alone.
export function collectNotices() {
  const meta = JSON.parse(readFileSync(join(out, 'cargo-metadata.json')));
  const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
  const used = new Set();
  function visit(id) {
    if (used.has(id)) return;
    used.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some(k => k.kind !== 'dev')) visit(dep.pkg);
    }
  }
  visit(meta.resolve.root);
  const licenses = join(stage, 'licenses');
  mkdirSync(licenses, { recursive: true });
  const inventory = [];
  for (const pkg of meta.packages.filter(p => used.has(p.id) && p.source).sort((a,b) => a.name.localeCompare(b.name))) {
    const source = dirname(config.os === 'linux'
      ? pkg.manifest_path.replace(/^\/work\//, `${root}/`) : pkg.manifest_path);
    const names = readdirSync(source).filter(n => /^(license|copying|copyright|notice)([.-]|$)/i.test(n));
    if (pkg.license_file && !names.includes(pkg.license_file)) names.push(pkg.license_file);
    if (!names.length) throw new Error(`${pkg.name}@${pkg.version} has no source license/notice file; review before distribution`);
    const dest = join(licenses, `${pkg.name}-${pkg.version}`);
    mkdirSync(dest, { recursive: true });
    for (const name of names) cpSync(join(source, name), join(dest, name), { recursive: true });
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, notices: names });
  }
  const rustNotices = config.os === 'linux' ? join(out, 'rust-notices')
    : join(readFileSync(join(out, 'rust-sysroot.txt'), 'utf8').trim(), 'share/doc/rust');
  if (!existsSync(join(rustNotices, 'COPYRIGHT-library.html'))) throw new Error('Rust standard-library notices are missing');
  cpSync(rustNotices, join(licenses, 'rust-standard-library'), { recursive: true });
  cpSync(join(root, 'vendor/quickjs-regexp/NOTICES.txt'), join(licenses, 'native-regexp-NOTICES.txt'));
  writeFileSync(join(stage, 'THIRD-PARTY.json'), JSON.stringify({
    scope: 'locked normal/build dependency closure; upstream notices retained; build dependencies may not be linked',
    rustStandardLibrary: 'licenses/rust-standard-library/COPYRIGHT-library.html',
    nativeRegexp: 'licenses/native-regexp-NOTICES.txt', packages: inventory,
  }, null, 2) + '\n');
}
