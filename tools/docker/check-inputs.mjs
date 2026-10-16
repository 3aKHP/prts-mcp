import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha } from '../npm/common.mjs';
import { verifyExactInventory } from './inventory.mjs';

const dir = mkdtempSync(join(tmpdir(), 'prts-docker-inputs-'));
try {
  const payload = join(dir, 'payload');
  writeFileSync(payload, 'verified input\n');
  const record = `${sha(payload)}  payload\n`;
  writeFileSync(join(dir, 'SHA256SUMS'), record);
  assert.deepEqual(verifyExactInventory(dir), ['payload']);
  writeFileSync(join(dir, '.env'), 'unlisted fixture\n');
  assert.throws(() => verifyExactInventory(dir), /Unlisted or missing payload files/);
  rmSync(join(dir, '.env'));
  symlinkSync(payload, join(dir, 'link'));
  assert.throws(() => verifyExactInventory(dir), /Non-regular payload entry/);
  rmSync(join(dir, 'link'));
  writeFileSync(join(dir, 'SHA256SUMS'), record + record);
  assert.throws(() => verifyExactInventory(dir), /Duplicate payload checksum record/);
  writeFileSync(join(dir, 'SHA256SUMS'), record);
  writeFileSync(payload, 'changed input\n');
  assert.throws(() => verifyExactInventory(dir), /Payload checksum/);
  console.log('DOCKER_INPUTS_PASS: verified payload; rejected unlisted file, link, duplicate and tampering');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
