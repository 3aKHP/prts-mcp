#!/usr/bin/env node
// Verify release/runtime boundaries and vendored provenance, before packaging.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=new URL('..',import.meta.url).pathname;
const bin=resolve(root,'target/release/prts-mcp-rust');
const symbols=execFileSync('nm',['--extern-only','--defined-only',bin],{encoding:'utf8',maxBuffer:8*1024*1024});
for(const symbol of ['JS_Eval','JS_NewRuntime','JS_NewContext','JS_Call']) {
 assert(!new RegExp(`\\b${symbol}$`,'m').test(symbols),`${symbol} must not be linked`);
}
assert(/\blre_compile$/m.test(symbols) && /\blre_exec$/m.test(symbols));
const deps=execFileSync('readelf',['-d',bin],{encoding:'utf8'});
const libraries=[...deps.matchAll(/Shared library: \[([^\]]+)\]/g)].map(m=>m[1]);
const allowed=new Set(['libgcc_s.so.1','libm.so.6','libc.so.6','ld-linux-x86-64.so.2']);
assert(libraries.every(l=>allowed.has(l)),`Unexpected runtime library: ${libraries}`);
const tree=execFileSync('cargo',['tree','--locked','-e','normal'],{cwd:root,encoding:'utf8'});
assert(!/rquickjs|quickjs-sys|pcre2/.test(tree));
const source=JSON.parse(readFileSync(resolve(root,'vendor/quickjs-regexp/SOURCE.json'),'utf8'));
for(const [file,hash] of Object.entries(source.files)) {
 assert.equal(createHash('sha256').update(readFileSync(resolve(root,'vendor/quickjs-regexp',file))).digest('hex'),hash,`Vendored source changed: ${file}`);
}
const notices=readFileSync(resolve(root,'vendor/quickjs-regexp/NOTICES.txt'),'utf8');
assert(notices.includes('UNICODE LICENSE V3')&&notices.includes('Charlie Gordon')&&notices.includes('Fabrice Bellard'));
console.log(JSON.stringify({result:'NATIVE_BINARY_PASS',libraries,js_vm_symbols:false,vendored_hashes_verified:Object.keys(source.files).length},null,2));
