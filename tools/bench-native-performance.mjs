import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT=resolve(ROOT,'artifacts/native-performance');
const value = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag)+1] : undefined;
const cpuSet = value('--cpus') ?? '2-5';
const beforeBin = value('--before-bin');
const kinds = beforeBin ? ['ts', 'rust-before', 'rust'] : ['ts', 'rust'];

const DATA=resolve(ROOT,'.runtime/fixtures/full-story-r2');
const ZIP=resolve(DATA,'storyjson/zh_CN.zip');
const scenarioDefs=[
 ['p8-amiya-30',{pattern:'阿米娅'}],
 ['amiya-5',{pattern:'阿米娅',max_results:5}],
 ['p4-rhodes-5',{pattern:'罗德岛',max_results:5}],
 ['rhodes-30',{pattern:'罗德岛',max_results:30}],
 ['no-match',{pattern:'PRTS_BENCH_NO_MATCH_7f814e'}],
 ['lookahead',{pattern:'阿米娅(?=。)',max_results:30}],
];
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const out={created_at:new Date().toISOString(),method:'offline pinned data; 5 rotated fresh processes/implementation; 10 warmups + 100 calls/scenario; HTTP legacy; content channel; OS page cache retained; no sync; all servers share the same CPU affinity',cpu_affinity:cpuSet,cpu:readFileSync('/proc/cpuinfo','utf8').match(/model name\s*:\s*(.*)/)?.[1],zip_sha256:hash(ZIP),rust_binary_sha256:hash(resolve(ROOT,'target/release/prts-mcp-rust')),before_binary_sha256:beforeBin?hash(resolve(beforeBin)):null,cold:[],hot:[],equality:[]};
let active;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const quantile=(a,q)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*q)-1];
const stats=a=>({n:a.length,min:Math.min(...a),p50:quantile(a,.5),p95:quantile(a,.95),max:Math.max(...a)});
function rss(pid){const t=readFileSync(`/proc/${pid}/status`,'utf8');return Object.fromEntries(['VmRSS','VmHWM'].map(k=>[k,Number(t.match(new RegExp(k+':\\s+(\\d+)'))?.[1])*1024]));}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function start(kind){
 const p=await port();const env={PATH:process.env.PATH,HOME:resolve(OUT,'home'),GAMEDATA_PATH:DATA,STORYJSON_PATH:ZIP,GITHUB_MIRRORS:'',IMAGES_ENABLED:'false',HOST:'127.0.0.1',PORT:String(p),PRTS_OUTPUT_CHANNEL:'content'};
 const command = kind === 'ts' ? ['bun',resolve(ROOT,'.reference/ts-v2.8.1/ts/dist/server-bun.js')]
   : [kind === 'rust-before' ? resolve(beforeBin) : resolve(ROOT,'target/release/prts-mcp-rust'),'--transport','http'];
 const c=spawn('taskset',['-c',cpuSet,...command],{env,stdio:['ignore','ignore','pipe']});
 active=c;let stderr='';c.stderr.on('data',d=>stderr+=d);
 const url=`http://127.0.0.1:${p}`;
 let ready=false;for(let i=0;i<400;i++){try{if((await fetch(url+'/health')).ok){ready=true;break;}}catch{}if(c.exitCode!==null)throw Error(stderr);await sleep(25);}if(!ready)throw Error('server readiness timeout');
 let sid,id=0;
 const post=async body=>{const t=performance.now();const r=await fetch(url+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});sid=r.headers.get('mcp-session-id')??sid;const text=await r.text();const ms=performance.now()-t;if(!r.ok)throw Error(r.status+' '+text);const data=text.split('\n').find(l=>l.startsWith('data: '))?.slice(6);return {ms,body:data?JSON.parse(data):text?JSON.parse(text):null};};
 await post({jsonrpc:'2.0',id:id++,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'story-investigation',version:'1'}}});
 await post({jsonrpc:'2.0',method:'notifications/initialized'});
 return {c,call:args=>post({jsonrpc:'2.0',id:id++,method:'tools/call',params:{name:'search_stories',arguments:args}}),stop:async()=>{c.kill('SIGTERM');await new Promise(r=>c.once('exit',r));active=null;}};
}
function save(){writeFileSync(resolve(OUT,'http-results.json'),JSON.stringify(out,null,2)+'\n');}
try{
 mkdirSync(resolve(OUT,'home'),{recursive:true});
 for(let round=0;round<5;round++)for(const kind of [...kinds.slice(round%kinds.length),...kinds.slice(0,round%kinds.length)]){const s=await start(kind);try{const r=await s.call({pattern:'阿米娅'});if(r.body?.result?.isError||!r.body?.result?.content)throw Error('tool failed');out.cold.push({kind,round,ms:r.ms,...rss(s.c.pid),result_sha256:createHash('sha256').update(JSON.stringify(r.body.result)).digest('hex')});console.log('cold',kind,round,r.ms.toFixed(1));}finally{await s.stop();}save();}
 if(new Set(out.cold.map(r=>r.result_sha256)).size !== 1) throw Error('cold result mismatch');
 const expected=new Map();
 for(const kind of kinds){
  const s=await start(kind);
  try{
   await s.call({pattern:'阿米娅'});
   const control=[];for(let i=0;i<100;i++){const r=await s.call({pattern:'',max_results:1,context_lines:0});control.push(r.ms);}out.hot.push({kind,scenario:'empty-1-control',...stats(control),samples_ms:control});
   for(const [name,args] of scenarioDefs){
    const first=await s.call(args);if(first.body?.result?.isError)throw Error('tool failure');
    if(kind==='ts')expected.set(name,first.body.result);else{const equal=isDeepStrictEqual(expected.get(name),first.body.result);out.equality.push({kind,scenario:name,equal});if(!equal)throw Error('result mismatch '+name);}
    for(let i=0;i<10;i++)await s.call(args);
    const samples=[];for(let i=0;i<100;i++){const r=await s.call(args);samples.push(r.ms);if(!isDeepStrictEqual(first.body.result,r.body.result))throw Error('unstable output '+name);}
    const row={kind,scenario:name,args,...stats(samples),samples_ms:samples,...rss(s.c.pid)};out.hot.push(row);console.log('hot',kind,name,row.p50.toFixed(2),row.p95.toFixed(2));save();
   }
  }finally{await s.stop();}
 }
 console.log('summary',JSON.stringify({cold:Object.fromEntries(kinds.map(k=>[k,stats(out.cold.filter(x=>x.kind===k).map(x=>x.ms))])),hot:out.hot.map(({samples_ms,...r})=>r),equality:out.equality}));save();
}finally{active?.kill('SIGTERM');}
