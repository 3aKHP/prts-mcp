import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalEntry } from './canonical-entry.mjs';
function fixture(mode, body='same launcher\n') {
  const header=Buffer.alloc(512);header.write('package/bin/prts-mcp.cjs');header.write(mode,100);
  header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(Buffer.byteLength(body).toString(8).padStart(11,'0')+'\0',124);
  header.write('00000000000\0',136);header[156]=48;header.write('ustar\0',257);header.fill(32,148,156);
  header.write(header.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  const content=Buffer.alloc(512);content.write(body);
  return gzipSync(Buffer.concat([header,content,Buffer.alloc(1024)]));
}
test('Windows and POSIX entry mode variants emit identical portable archives',()=>{
  const unix=canonicalEntry(fixture('0000755\0')),windows=canonicalEntry(fixture('0000644\0'));
  assert.deepEqual(windows,unix);assert.equal(windows[9],255);
  const tar=gunzipSync(windows);assert.equal(tar.subarray(100,108).toString(),'0000755\0');
  assert.equal(tar.subarray(512,526).toString(),'same launcher\n');
  const checksum=parseInt(tar.subarray(148,156).toString(),8);tar.fill(32,148,156);
  assert.equal(tar.subarray(0,512).reduce((sum,b)=>sum+b,0),checksum);
});
test('different launcher contents remain different and canonicalization is idempotent',()=>{
  const one=canonicalEntry(fixture('0000644\0'));assert.deepEqual(canonicalEntry(one),one);
  assert.notDeepEqual(canonicalEntry(fixture('0000644\0','different\n')),one);
});
