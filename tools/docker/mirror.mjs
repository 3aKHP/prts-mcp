// Containerized test fixture only; never copied into the product image.
import { createServer } from 'node:http';
import { createReadStream,readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.argv[2],releases=readFileSync(join(dir,'releases.json'));
const assets=new Map(readFileSync(join(dir,'assets.txt'),'utf8').trim().split('\n').map(line=>{
  const pos=line.indexOf(' ');return [line.slice(0,pos),line.slice(pos+1)];
}));
createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  const url=decodeURIComponent(req.url.slice(1));
  if(url.startsWith('https://api.github.com/')){res.writeHead(200,{'content-type':'application/json'}).end(releases);return;}
  const file=assets.get(url);
  if(!file){res.writeHead(404).end();return;}
  res.writeHead(200,{'content-type':'application/octet-stream'});createReadStream(join(dir,file)).pipe(res);
}).listen(8080,'0.0.0.0');
