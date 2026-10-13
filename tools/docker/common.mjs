// Build/test clients only; the product image runs native Rust under tini.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root, version, targets, pin, readJson, json, sha, run, verifyInventory, verifyNotices } from '../npm/common.mjs';
export { root, version, targets, pin, readJson, json, sha, run, verifyInventory, verifyNotices };
export const id=process.argv[2], config=targets[id];
assert(config?.os==='linux' && config.arch===process.arch && process.platform==='linux','Docker evidence requires the matching native Linux host');
export const arch=config.arch==='x64'?'amd64':'arm64';
const daemon=JSON.parse(run('docker',['version','--format','{{json .Server}}']));
assert.equal(daemon.Os,'linux');assert.equal(daemon.Arch,arch,'Docker daemon must also run the native target CPU');
export const out=join(root,'artifacts/docker',id);
export const image=`prts-mcp:m2c-${id}`;
export const mirrorImage=readJson(join(root,'packaging/docker/test-images.json')).mirror;
