#!/usr/bin/env node
// Compare every chapter's metadata, every line's type/role/text and record order.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const root=new URL('..',import.meta.url).pathname;
const zip=resolve(root,'.runtime/fixtures/full-story-r2/storyjson/zh_CN.zip');
const code=`import {ZipStore} from ${JSON.stringify(resolve(root,'.reference/ts-v2.8.1/ts/dist/data/stores.js'))};
import {storySearchIndex} from ${JSON.stringify(resolve(root,'.reference/ts-v2.8.1/ts/dist/data/storySearch.js'))};
import {createHash} from 'node:crypto';
const s=new ZipStore(${JSON.stringify(zip)}), i=storySearchIndex(s),h=createHash('sha256');
for(const c of i.chapters){h.update(JSON.stringify([c.eventId,c.storyKey,c.storyCode,c.storyName]));
 for(const l of c.lines)h.update(JSON.stringify([l.type,l.role,l.text]));}
for(const r of i.records)h.update(JSON.stringify([r.chapterIndex,r.lineIndex]));
console.log(JSON.stringify({chapters:i.chapters.length,records:i.records.length,sha256:h.digest('hex')}));
s.close();`;
const run=(cmd,args)=>{
 const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:60000});
 if(r.status!==0)throw Error(r.stderr||String(r.error));
 return JSON.parse(r.stdout.trim().split('\n').at(-1));
};
const ts=run('bun',['-e',code]);
const rust=run(resolve(root,'target/release/examples/story_index_digest'),[zip]);
assert.deepEqual(rust,ts);
const result={result:'FULL_INDEX_DIGEST_PASS',compared:'all chapter metadata, all line types/roles/text, all record ordinals',ts,rust};
writeFileSync(resolve(root,'artifacts/native-performance/full-index-check.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
