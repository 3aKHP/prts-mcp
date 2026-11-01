import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdio } from '../npm/mcp.mjs';

const delay = ms => new Promise(r=>setTimeout(r,ms));
export async function syncProbe({root,temp,command,launch,version}) {
  const assets=join(temp,'mirror');
  execFileSync('python',[join(root,'tools/pypi/sync-fixture.py'),assets]);
  const names=['manifest.json','zh_CN-excel.zip','zh_CN-levels.zip','zh_CN.zip'];
  const tag='data-26-10-08-04-51-28-56071834';
  const url = name => `https://github.com/3aKHP/arknights-data-pipeline/releases/download/${tag}/${name}`;
  const release=[{tag_name:tag,created_at:'2026-10-08T05:00:00Z',assets:names.map(name=>({name,browser_download_url:url(name)}))}];
  const server=createServer((req,res)=>{
    const upstream=decodeURIComponent(req.url.slice(1));
    if(upstream.startsWith('https://api.github.com/')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(release));return;}
    const name=names.find(name=>upstream===url(name));
    if(name)res.end(readFileSync(join(assets,name)));
    else {res.writeHead(404);res.end('{}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const mirror=`http://127.0.0.1:${server.address().port}`, home=join(temp,'fresh-data');
  const overrides={GAMEDATA_PATH:undefined,STORYJSON_PATH:undefined,PRTS_DATA_BACKEND:'json',
    XDG_DATA_HOME:home,LOCALAPPDATA:home,GITHUB_MIRRORS:mirror,
    HTTPS_PROXY:'http://127.0.0.1:9',HTTP_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',
    NO_PROXY:'127.0.0.1,localhost',https_proxy:'http://127.0.0.1:9',http_proxy:'http://127.0.0.1:9',all_proxy:'http://127.0.0.1:9',no_proxy:'127.0.0.1,localhost'};
  const child=launch(command,[],overrides);let stderr='';const capture=s=>stderr+=s;child.stderr.on('data',capture);
  try {
    let ready=false;
    for(let i=0;i<300;i++) {
      if(existsSync(join(home,'prts-mcp/.gamedata_pair.json'))) {ready=true;break;}
      if(child.exitCode!==null)throw new Error(stderr);
      await delay(100);
    }
    assert(ready,`First JSON synchronization failed: ${stderr}`);
    child.stderr.off('data',capture);
    await stdio(child,version);
  } finally {
    if(child.exitCode===null && child.signalCode===null)child.kill();
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
  }
  // The same installed package reads the populated default user directory offline.
  await stdio(launch(command,[],{...overrides,GITHUB_MIRRORS:'http://127.0.0.1:9'}),version);
}

export async function emptyOfflineProbe({temp,command,launch}) {
  const home=join(temp,'empty-offline');
  const child=launch(command,[],{GAMEDATA_PATH:undefined,STORYJSON_PATH:undefined,
    XDG_DATA_HOME:home,LOCALAPPDATA:home,GITHUB_MIRRORS:'http://127.0.0.1:9',
    HTTPS_PROXY:'http://127.0.0.1:9',HTTP_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',
    NO_PROXY:'127.0.0.1,localhost',https_proxy:'http://127.0.0.1:9',http_proxy:'http://127.0.0.1:9',all_proxy:'http://127.0.0.1:9',no_proxy:'127.0.0.1,localhost'});
  const closed=once(child,'close');let buffer='',error;
  const done=new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let at;
      while((at=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        if(!line.trim())continue;
        try {
          const reply=JSON.parse(line);assert.equal(reply.jsonrpc,'2.0');
          if(reply.id===1) {
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_operator_basic_info',arguments:{name:'阿米娅'}}})+'\n');
          }
          if(reply.id===2) {assert.match(JSON.stringify(reply),/数据|同步|unavailable/);child.stdin.end();resolve();}
        }catch(e){error=e;reject(e);}
      }
    });
    child.once('error',reject);
    child.once('close',()=>reject(error ?? new Error('Offline process exited before reply')));
  });
  child.stderr.resume();
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'empty-pypi-probe',version:'1'}}})+'\n');
  let timer;
  try {
    await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Empty offline probe timeout')),15000);})]);
    assert.deepEqual(await closed,[0,null]);
  }finally {clearTimeout(timer);if(child.exitCode===null && child.signalCode===null)child.kill();}
}
