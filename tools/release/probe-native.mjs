import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { root, id, config, version, suffix, run, sha, json, psLiteral } from '../native/common.mjs';
import { verifyExactInventory } from '../docker/inventory.mjs';
import { verifyBundle } from './common.mjs';
import { stdio } from '../npm/mcp.mjs';
const out = join(root,'artifacts/candidate',id), receipt = JSON.parse(readFileSync(join(out,'candidate.json')));
const archive = join(out,receipt.filename);assert.equal(sha(archive),receipt.sha256);
const temp = mkdtempSync(join(tmpdir(),'prts-candidate 空格-')), installed = join(temp,'installed');mkdirSync(installed);
try {
  if(config.os==='win32')run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(installed)}`]);
  else run('tar',['-xf',archive,'-C',installed]);
  const files = verifyExactInventory(installed), dataFiles = verifyExactInventory(join(installed,'data'));
  const candidate = JSON.parse(readFileSync(join(installed,'CANDIDATE.json')));
  assert.equal(candidate.commit,receipt.commit);assert.equal(candidate.version,version);assert.equal(candidate.platform,id);
  verifyBundle(candidate.dataBundle);assert.equal(files.length,receipt.payloadFiles);assert.equal(dataFiles.length,receipt.dataFiles);
  const env = {...process.env};
  for(const key of Object.keys(env))if(/^(PATH|HOME|PRTS_|GAMEDATA_PATH|STORYJSON_PATH|IMAGES_ENABLED|LOCAL_IMAGE|ORIGINAL_IMAGE|HOST|PORT|GITHUB_TOKEN|GITHUB_MIRRORS|XDG_DATA_HOME|LOCALAPPDATA|USERPROFILE|SESSION_IDLE_TIMEOUT_MS|https?_proxy|all_proxy|no_proxy)$/i.test(key)||key.startsWith('PRTS_'))delete env[key];
  Object.assign(env,{PATH:'',HOME:join(temp,'home'),XDG_DATA_HOME:join(temp,'user'),LOCALAPPDATA:join(temp,'user'),USERPROFILE:join(temp,'profile'),
    PRTS_TRANSPORT:'stdio',IMAGES_ENABLED:'false',LOCAL_IMAGE:'false',PRTS_OUTPUT_CHANNEL:'content',PRTS_AUTO_SYNC_INTERVAL_SECONDS:'0',
    GITHUB_MIRRORS:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9',HTTP_PROXY:'http://127.0.0.1:9'});
  const executable = join(installed,'bin','prts-mcp'+suffix);
  const launch = overrides => spawn(executable,[],{cwd:temp,env:{...env,...overrides},stdio:['pipe','pipe','pipe']});
  const checks = [{case:'extracted candidate exact inventory and bundle identities',files:files.length,dataFiles:dataFiles.length}];
  checks.push({case:'empty user directory, empty PATH, offline bundled query, native inferred bin/../data and EOF',...await stdio(launch({}),version)});
  const user = join(temp,'custom-user');cpSync(join(root,'tests/fixtures/native-smoke'),user,{recursive:true});
  // The frozen fixture layout is rooted at the game-data directory itself.
  const tablePath = join(user,'zh_CN/gamedata/excel/character_table.json');
  const table = JSON.parse(readFileSync(tablePath));table.char_002_amiya.name='用户卷阿米娅';writeFileSync(tablePath,JSON.stringify(table));
  checks.push({case:'complete explicit user game data overrides installed fallback',...await stdio(launch({GAMEDATA_PATH:user,STORYJSON_PATH:join(user,'storyjson/zh_CN.zip')}),version,'用户卷阿米娅')});
  verifyExactInventory(installed);verifyExactInventory(join(installed,'data'));
  json(join(out,'candidate-evidence.json'),{platform:id,native:true,arch:process.arch,version,commit:receipt.commit,archiveSha256:receipt.sha256,
    checks,publicPublication:false,scope:'actual native candidate archive with bundled data; complete real-client upgrades/rollback remain M4'});
  console.log(`NATIVE_CANDIDATE_VERIFY_PASS: ${id} ${checks.length} checks`);
} finally {rmSync(temp,{recursive:true,force:true});}
