import assert from 'node:assert/strict';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { verifyInventory } from '../npm/common.mjs';

// Check file types before reading checksums, so links cannot escape the payload.
export function verifyExactInventory(dir) {
  assert(lstatSync(dir).isDirectory(), 'Payload root must be a regular directory');
  const actual = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert(entry.isFile(), `Non-regular payload entry: ${file}`);
        actual.push(relative(dir, file).split('\\').join('/'));
      }
    }
  }
  visit(dir);
  const files = verifyInventory(dir);
  assert.equal(new Set(files).size, files.length, 'Duplicate payload checksum record');
  assert.deepEqual(actual.sort(), [...files, 'SHA256SUMS'].sort(), 'Unlisted or missing payload files');
  return files;
}
