import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function shellProbe({program,env,cwd,version,label='native'}) {
  const clean={...env}; delete clean.HOST;delete clean.PORT;
  // Shell launch needs the host's PATH, even when the native archive probe clears it.
  clean.PATH=process.env.PATH;
  const shells=process.platform==='win32'?['powershell.exe','pwsh']:['bash','zsh'];
  for(const shell of shells) {
    const config=join(cwd,`${label}-${shell} shell config 中文.toml`);
    const args=process.platform==='win32'
      ? ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./shell-probe.ps1',import.meta.url)),'-Program',program,'-ConfigPath',config,'-ExpectedVersion',version]
      : [...(shell==='bash'?['--noprofile','--norc']:['-f']),fileURLToPath(new URL('./shell-probe.sh',import.meta.url)),program,config,process.execPath,version];
    const output=execFileSync(shell,args,{env:clean,cwd,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
    assert.match(output,/CLI_SHELL_PASS/);
  }
  return shells;
}
