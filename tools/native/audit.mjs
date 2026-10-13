import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stage, bins, suffix, config, run, json } from './common.mjs';

const results = [];
for (const name of bins) {
  const path = join(stage, 'bin', name + suffix);
  let dependencies, details;
  if (config.os === 'linux') {
    const headers = run('readelf', ['-h', path]);
    assert.match(headers, config.arch === 'x64' ? /Advanced Micro Devices X86-64/ : /AArch64/);
    dependencies = [...run('readelf', ['-d', path]).matchAll(/Shared library: \[([^\]]+)\]/g)].map(m => m[1]);
    const allowed = /^(libc\.so\.6|libm\.so\.6|libgcc_s\.so\.1|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|ld-linux-x86-64\.so\.2|ld-linux-aarch64\.so\.1)$/;
    assert.ok(dependencies.length && dependencies.every(d => allowed.test(d)), `Unexpected ELF dependencies: ${dependencies}`);
    const symbolVersions = run('readelf', ['--version-info', path]);
    assert.doesNotMatch(symbolVersions, /GLIBC_PRIVATE|GLIBC_ABI_/, 'Unsupported private/new glibc ABI dependency');
    const versions = [...symbolVersions.matchAll(/GLIBC_(\d+)\.(\d+)/g)]
      .map(m => [Number(m[1]), Number(m[2])]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
    const max = versions.at(-1);
    assert.ok(max && (max[0] < 2 || max[0] === 2 && max[1] <= 28), `Requires GLIBC_${max?.join('.')}`);
    assert.doesNotMatch(run('readelf', ['-n', path]), /x86-64-v[234]/, 'CPU baseline must not require x86-64-v2/v3/v4');
    details = { maximumGlibcSymbol: max.join('.') };
  } else if (config.os === 'win32') {
    const headers = run('dumpbin', ['/headers', path]);
    assert.match(headers, /8664 machine \(x64\)/i);
    const imports = run('dumpbin', ['/dependents', path]);
    dependencies = [...new Set([...imports.matchAll(/^\s+([\w.-]+\.dll)\s*$/gim)].map(m => m[1].toLowerCase()))];
    assert.ok(dependencies.length, 'Could not read PE imports');
    const system = /^(kernel32|ntdll|ws2_32|userenv|bcrypt|advapi32|crypt32|ncrypt|secur32|iphlpapi|psapi|shell32|ole32|gdi32|user32|dbghelp)\.dll$|^api-ms-win-(core|security)-[\w-]+\.dll$/;
    assert.ok(dependencies.every(d => system.test(d)), `Non-system or CRT DLLs: ${dependencies}`);
    details = { crt: 'static; no vcruntime/msvcp/ucrt DLL import', peHeaders: headers };
  } else {
    const headers = run('lipo', ['-archs', path]).trim();
    assert.equal(headers, config.arch === 'x64' ? 'x86_64' : 'arm64');
    dependencies = run('otool', ['-L', path]).split('\n').slice(1).map(s => s.trim().split(' ')[0]).filter(Boolean);
    assert.ok(dependencies.length && dependencies.every(d => d.startsWith('/usr/lib/') || d.startsWith('/System/Library/')),
      `Non-system Mach-O dependency: ${dependencies}`);
    const commands = run('otool', ['-l', path]);
    const minimum = commands.match(/\bminos\s+([\d.]+)/)?.[1] ?? commands.match(/\bversion\s+([\d.]+)/)?.[1];
    assert.equal(minimum, config.deploymentTarget, 'Mach-O deployment target');
    run('codesign', ['--verify', '--strict', path]);
    details = { deploymentTarget: minimum, architecture: headers, signing: 'local/ad-hoc; no notarization claim' };
  }
  results.push({ binary: name + suffix, dependencies, ...details });
}
json(join(stage, 'ABI.json'), { platform: config.target, binaries: results });
console.log(`ABI/dependency audit passed: ${results.length} binaries (${config.target})`);
