import { cpSync, mkdirSync, readdirSync, rmSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, out, stage, release, bins, suffix, config, id, version, flags, run, sha, json } from './common.mjs';
import { collectNotices } from './legal.mjs';

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
for (const bin of bins) {
  const dest = join(stage, 'bin', bin + suffix);
  cpSync(join(release, bin + suffix), dest);
  if (config.os !== 'win32') chmodSync(dest, 0o755);
}
for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(stage, name));
collectNotices();
writeFileSync(join(stage, 'README.txt'), `PRTS-MCP ${version} (${id})\n\n` +
  'Run bin/prts-mcp (Windows: bin/prts-mcp.exe). Streamable HTTP is the default.\n' +
  'Set PRTS_TRANSPORT=stdio for an MCP stdio client. Legacy command profiles are included.\n' +
  'No Node/Bun/Python, compiler or extra native library installation is required.\n' +
  'Game data is synchronized on first startup; use GAMEDATA_PATH/STORYJSON_PATH for existing data.\n' +
  'This development artifact is not a public stable release. Support/evidence: BUILD.json and ABI.json.\n');
json(join(stage, 'BUILD.json'), {
  product: 'prts-mcp', version, platform: id, target: config.target,
  commit: run('git', ['rev-parse', 'HEAD']).trim(),
  dirty: !!run('git', ['status', '--porcelain', '--untracked-files=normal']).trim(),
  nativeHost: { os: process.platform, arch: process.arch },
  rustToolchain: '1.96.1', minimumRustChecked: '1.89.0', rustFlags: flags,
  compilerEvidence: config.os === 'linux' ? readFileSync(join(out, 'compiler.txt'), 'utf8')
    : JSON.parse(readFileSync(join(out, 'compiler.json'))),
  builder: config.builder ?? config.runner,
  declaredBaseline: { glibc: config.glibc, crt: config.crt, cpu: config.cpu,
    macosDeploymentTarget: config.deploymentTarget, windowsMinimum: config.minimumOs },
});
// Audit before archiving; audit independently rechecks the detached binaries.
run(process.execPath, ['tools/native/audit.mjs', id], { stdio: 'inherit' });
const hashes = [];
function inventory(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name);
    if (item.isDirectory()) inventory(path);
    else if (item.isFile()) hashes.push(`${sha(path)}  ${relative(stage, path).split('\\').join('/')}`);
    else throw new Error(`Unexpected non-regular file: ${path}`);
  }
}
inventory(stage);
writeFileSync(join(stage, 'SHA256SUMS'), hashes.join('\n') + '\n');
const archive = join(out, `prts-mcp-${version}-${id}.${config.os === 'win32' ? 'zip' : 'tar.gz'}`);
rmSync(archive, { force: true });
run('tar', config.os === 'win32' ? ['-a', '-cf', archive, '-C', stage, '.'] : ['-czf', archive, '-C', stage, '.']);
writeFileSync(archive + '.sha256', `${sha(archive)}  ${relative(out, archive)}\n`);
json(join(out, 'artifact.json'), { archive, sha256: sha(archive), payloadFiles: hashes.length });
console.log(`Native archive: ${archive}`);
