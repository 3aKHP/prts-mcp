import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

// Windows cannot represent Unix execute bits. Canonicalize only the tiny,
// generated entry packages so every native runner tests the same published bytes.
export function canonicalEntry(bytes) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString().replaceAll('\0', '').trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid entry tar size');
    if (/^package\/bin\/[^/]+\.cjs$/.test(name)) {
      assert(header[156] === 0 || header[156] === 48, 'Entry bin must be a regular file');
      header.write('0000755\0', 100, 8, 'ascii');
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const packed = gzipSync(tar, { level: 9 });
  packed[9] = 255; // Portable gzip OS byte, independent of the build host.
  return packed;
}
