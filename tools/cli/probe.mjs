// Exercise installed management entry points without contacting upstream services.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function managementProbe({command,args=[],env,cwd,version,label='management'}) {
  const run = tail => execFileSync(command,[...args,...tail],{cwd,env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  assert.equal(run(['--version']).trim(),`prtsctl ${version}`);
  assert.match(run(['--help']),/config/);
  assert.match(run([]),/serve/);
  const path=join(cwd,`${label} config 中文.toml`);
  const config=tail=>run(['--config',path,...tail]);
  assert.equal(JSON.parse(config(['config','init','--dry-run','-o','json'])).dry_run,true);
  assert(!existsSync(path),'dry-run wrote the configuration');
  config(['config','init']);
  config(['config','set','HOST','127.0.0.1']);
  config(['config','set','PORT','3100']);
  assert.match(readFileSync(path,'utf8'),/PORT = 3100/);
  assert.equal(JSON.parse(config(['config','validate','-o','json'])).valid,true);
  const shown=JSON.parse(config(['config','show','--sources','-o','json']));
  assert(shown.fields.some(field=>field.key==='PORT'&&field.source==='file'&&field.value===3100));
  config(['config','unset','PORT']);
  for(const shell of ['bash','zsh','powershell'])assert(run(['completion',shell]).includes('prtsctl'));
  assert.equal(JSON.parse(run(['data','status','-o','json'])).scope,'local');
}
export function serverCliProbe({command,args=[],env,cwd,version}) {
  const run=tail=>execFileSync(command,[...args,...tail],{cwd,env:{...env,PRTS_DATA_BACKEND:'invalid-for-help'},encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  assert(run(['--version']).trim().endsWith(` ${version}`));
  assert.match(run(['--help']),/--config/);
}
