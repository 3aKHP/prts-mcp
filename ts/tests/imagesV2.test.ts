import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIndex } from "../src/data/images.ts";
import { parseV2, type V2Index } from "../src/data/imagesV2.ts";
import { syncImages } from "../src/sync/imagesSync.ts";
import { activeGeneration, saveMeta } from "../src/sync/generationStore.ts";

const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/images-v2/world.json", import.meta.url), "utf8")) as {indexes: Record<string,V2Index>; assets: Record<string,string>};
async function world(run: (root:string,state:{latest:string;offline:boolean;corrupt:string|null;missing:string|null;v1Only:boolean})=>Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),"lts-images-v2-"));
  const original=globalThis.fetch, mirrors=process.env.GITHUB_MIRRORS;
  const state={latest:"26-01-01",offline:false,corrupt:null as string|null,missing:null as string|null,v1Only:false};
  process.env.GITHUB_MIRRORS="";
  globalThis.fetch=(async (url:unknown)=>{
    const target=String(url);
    if(state.offline) throw new Error("offline");
    if(target.includes("api.github.com")) {
      const releases=state.v1Only?[{tag_name:"images-99-01-01",assets:[]}]:Object.keys(fixture.indexes).filter(tag=>tag.slice(8)<=state.latest).map(tag=>({tag_name:tag,created_at:"2099-01-01",assets:[]}));
      return Response.json(releases);
    }
    const key=target.split("/download/")[1];
    if(key.endsWith("/index.json")) return Response.json(fixture.indexes[key.split("/")[0]]);
    if(state.missing===key || !fixture.assets[key]) return new Response("missing",{status:404});
    return new Response(state.corrupt===key?Buffer.from("bad"):Buffer.from(fixture.assets[key],"base64"));
  }) as typeof fetch;
  try {await run(root,state);} finally {globalThis.fetch=original;if(mirrors===undefined)delete process.env.GITHUB_MIRRORS;else process.env.GITHUB_MIRRORS=mirrors;await rm(root,{recursive:true,force:true});}
}

test("v2 shared fixture: fresh, delta/delete, baseline rotation and empty delta",async()=>world(async(root,state)=>{
  for(const version of ["26-01-01","26-02-01","26-04-01","26-04-02"]){
    state.latest=version;
    const result=await syncImages(root);assert.equal(result.status,"updated",result.error??"");
    const gen=(await activeGeneration(root))!;
    const index=parseIndex(JSON.parse(await readFile(join(gen,"index.json"),"utf8")))!;
    assert.equal(index.schemaVersion,"akdp-images/v2");
    assert.deepEqual(Object.keys(index.artworks).sort(),version==="26-01-01"?["a","b"]:["a","c"]);
    await assert.rejects(readFile(join(gen,"a.original.png")));
    if(version!=="26-01-01")await assert.rejects(readFile(join(gen,"b.large.png")));
  }
  assert.equal((await syncImages(root)).status,"up_to_date");
}));

test("v2 original toggle and migration from a v1 volume",async()=>world(async(root)=>{
  const old=join(root,".releases/legacy");await mkdir(old,{recursive:true});
  await writeFile(join(old,"index.json"),JSON.stringify({...fixture.indexes["images2-26-01-01"],schemaVersion:"akdp-images/v1"}));
  await saveMeta(root,{schemaVersion:"akdp-images/v1",currentVersion:"26-01-01",generation_root:".releases/legacy",shardsSynced:[]});
  assert.equal((await syncImages(root,{includeOriginal:true})).status,"updated");
  await readFile(join((await activeGeneration(root))!,"a.original.png"));
  assert.equal((await syncImages(root,{includeOriginal:false})).status,"updated");
  await assert.rejects(readFile(join((await activeGeneration(root))!,"a.original.png")));
}));

for (const failure of ["corrupt", "missing"]) test(`v2 ${failure} ZIP keeps previous generation, offline stays available, no v1 downgrade`,async()=>world(async(root,state)=>{
  await syncImages(root);const before=await activeGeneration(root);
  state.latest="26-02-01";state[failure as "corrupt"|"missing"]="images2-26-02-01/"+fixture.indexes["images2-26-02-01"].deltaParts[0].file;
  assert.equal((await syncImages(root)).status,"offline_fallback");assert.equal(await activeGeneration(root),before);
  state.corrupt=null;state.missing=null;assert.equal((await syncImages(root)).status,"updated");
  state.offline=true;assert.equal((await syncImages(root)).status,"offline_fallback");
  state.offline=false;state.v1Only=true;assert.equal((await syncImages(root)).status,"offline_fallback");
}));

test("v2 shared validator rejects invalid paths, lengths and digests",()=>{
  const raw=fixture.indexes["images2-26-01-01"];assert.ok(parseV2(raw));
  for(const [key,bad] of [["file","../escape.zip"],["bytes",2147483648],["sha256","bad"],["group",null]] as const){
    const invalid=structuredClone(raw);(invalid.baselineParts[0] as unknown as Record<string,unknown>)[key]=bad;
    assert.equal(parseV2(invalid),null);assert.equal(parseIndex(invalid),null);
  }
});
