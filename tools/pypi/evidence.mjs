import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const requiredChecks = ['pip-command','module','empty-transport','invalid-transport','uvx','pipx','http-parent-exit','legacy-upgrade','missing-native','uninstall'];
export function verifyPypi(directory, id, version, commit, nativeSha256) {
  const receipt = JSON.parse(readFileSync(join(directory,'package.json')));
  const evidence = JSON.parse(readFileSync(join(directory,'pypi-evidence.json')));
  assert.equal(receipt.schema,'prts-mcp-pypi/v1');
  assert.equal(receipt.productVersion,version);assert.equal(receipt.commit,commit);assert.equal(receipt.platform,id);
  assert.equal(receipt.nativeSha256,nativeSha256);
  for(const [key,value] of Object.entries(receipt)) assert.deepEqual(evidence[key],value);
  // Evidence adds acceptance fields; its schema intentionally has its own name.
  assert(evidence.native);assert.equal(evidence.arch,id.endsWith('arm64')?'arm64':'x64');
  assert.deepEqual(evidence.checks,requiredChecks);
  assert(!/[\\/]/.test(receipt.filename));
  execFileSync(process.platform==='win32'?'python':'python3', ['tools/pypi/inspect.py',join(directory,'wheels',receipt.filename),join(directory,'package.json')], {stdio:'inherit'});
  return receipt;
}
