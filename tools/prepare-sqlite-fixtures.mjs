// Build-time conversion only. The frozen TS oracle keeps its original files.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(root, 'target/release/examples/data_compiler' + (process.platform === 'win32' ? '.exe' : ''));
execFileSync('cargo', ['build', '--locked', '--release', '--example', 'data_compiler'], {cwd:root, stdio:'inherit'});
for (const name of readdirSync(join(root, '.runtime/fixtures'))) {
  if (!/^(minimal-gamedata-v[12]|empty-gamedata-v1|full-story-r2|minimal-images-v1|activated-minimal-v1)$/.test(name)) continue;
  const fixture = join(root, '.runtime/fixtures', name);
  const work = join(root, '.runtime/sqlite-fixtures', name);
  rmSync(work, {recursive:true, force:true});
  mkdirSync(work, {recursive:true});
  let input = fixture;
  let target = fixture;
  if (name === 'activated-minimal-v1') {
    const pair = JSON.parse(readFileSync(join(fixture, '.gamedata_pair.json')));
    input = join(work, 'source');
    mkdirSync(join(input, 'zh_CN/gamedata'), {recursive:true});
    cpSync(join(fixture, 'gamedata', pair.excel_data_root, 'zh_CN/gamedata/excel'), join(input, 'zh_CN/gamedata/excel'), {recursive:true});
    cpSync(join(fixture, 'gamedata-levels', pair.levels_data_root, 'zh_CN/gamedata/levels'), join(input, 'zh_CN/gamedata/levels'), {recursive:true});
    target = join(fixture, 'gamedata');
  }
  const db = join(work, 'zh_CN.sqlite');
  execFileSync(compiler, ['--input', input, '--output', db, '--source-version', name, '--allow-incomplete'], {cwd:root, stdio:'inherit'});
  mkdirSync(join(target, 'database'), {recursive:true});
  cpSync(db, join(target, 'database/zh_CN.sqlite'));
}
