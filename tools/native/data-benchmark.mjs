import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import { root, release, id, out, run, config } from './common.mjs';
const pin = JSON.parse(readFileSync(join(root, 'packaging/npm/data-release.json')));
const cache = join(root, '.runtime/npm-data', pin.release_tag);
const results = {id, cpu: cpus()[0], cores: cpus().length, memory: totalmem(), samples: []};
let expected;
for (const name of ['package_data_baseline', 'package_data', 'package_data', 'package_data_baseline']) {
  const dest = join(root, 'artifacts', `data-benchmark-${name}`);
  rmSync(dest, {recursive: true, force: true});
  const start = performance.now();
  run(join(release, 'examples', name), [join(root, 'packaging/npm/data-release.json'), cache, dest], {stdio: 'inherit'});
  const elapsedMs = performance.now() - start;
  const inventory = readFileSync(join(dest, 'SHA256SUMS'), 'utf8');
  if (expected === undefined) expected = inventory;
  else assert.equal(inventory, expected, 'Full bundle inventory must match');
  results.samples.push({name, elapsedMs, receipt: JSON.parse(readFileSync(join(dest, 'BUNDLE.json')))});
  console.log('DATA_BENCHMARK', JSON.stringify({name, elapsedMs}));
  rmSync(dest, {recursive: true, force: true});
}
mkdirSync(out, {recursive: true});
writeFileSync(join(out, 'data-benchmark.json'), JSON.stringify(results, null, 2));
