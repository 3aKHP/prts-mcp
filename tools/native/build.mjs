import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, config, id, out, run, flags, json, version } from './common.mjs';

mkdirSync(out, { recursive: true });
if (config.os === 'linux') {
  // A native container shares the host CPU; no QEMU/cross toolchain is used.
  run('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${root}:/work`, '-w', '/work',
    '-e', 'CARGO_HOME=/work/.native-cache/cargo', '-e', 'RUSTUP_HOME=/work/.native-cache/rustup',
    '-e', `RUSTFLAGS=${flags}`, '-e', `PRTS_NATIVE_TARGET=${config.target}`, '-e', `PRTS_NATIVE_ID=${id}`,
    config.builder, 'bash', 'tools/native/linux-build.sh'], { stdio: 'inherit' });
} else {
  run('rustup', ['toolchain', 'install', '1.89.0', '--profile', 'minimal'], { stdio: 'inherit' });
  run('cargo', ['+1.89.0', 'check', '--locked', '--bins', '--target', config.target], { stdio: 'inherit' });
  run('cargo', ['test', '--locked', '--target', config.target, '--lib', '--test', 'native_text_corpus',
    '--test', 'regex_corpus', '--test', 'story_index', '--example', 'package_data'], { stdio: 'inherit' });
  run('cargo', ['build', '--locked', '--release', '--bins', '--example', 'package_data', '--target', config.target], { stdio: 'inherit' });
  writeFileSync(join(out, 'cargo-metadata.json'), run('cargo', ['metadata', '--locked', '--format-version', '1',
    '--filter-platform', config.target]));
  writeFileSync(join(out, 'rust-sysroot.txt'), run('rustc', ['--print', 'sysroot']).trim());
  json(join(out, 'compiler.json'), { rustc: run('rustc', ['-vV']), msrvCheck: '1.89.0',
    cCompiler: config.os === 'win32' ? run('clang-cl', ['--version']) : run('cc', ['--version']), flags });
}
// A moved checkout must not accidentally reuse metadata from another build.
const meta = JSON.parse(readFileSync(join(out, 'cargo-metadata.json')));
if (!meta.packages.some(p => p.name === 'prts-mcp' && p.version === version)) {
  throw new Error('Native build metadata does not identify the current product');
}
