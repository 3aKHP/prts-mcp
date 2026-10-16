import assert from 'node:assert/strict';

// Exercise a real stdio process, including npm/npx and Windows .cmd shells.
export async function stdio(child, version, name = '阿米娅') {
  let buffer = '', stderr = '', serial = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve,reject) => {
    child.once('error', reject);
    child.once('close', (code,signal) => resolve({code,signal}));
  });
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc,'2.0');
        pending.get(message.id)?.resolve(message);
      } catch (error) { for (const waiter of pending.values()) waiter.reject(error); }
    }
  });
  let timer;
  const timeout = new Promise((_,reject) => {
    timer = setTimeout(() => reject(new Error(`MCP stdio timed out: ${stderr}`)),process.platform === 'win32' ? 600000 : 180000);
  });
  const call = async (method,params) => {
    const id = ++serial;
    const reply = new Promise((resolve,reject) => pending.set(id,{resolve,reject}));
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    return Promise.race([reply,timeout]);
  };
  try {
    const hello = await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'npm-package-probe',version:'1'}});
    assert.equal(hello.result.serverInfo.version,version);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await call('tools/list',{});
    assert.equal(listed.result.tools.length,23);
    const basic = await call('tools/call',{name:'get_operator_basic_info',arguments:{name}});
    assert(!basic.error && !basic.result.isError,JSON.stringify(basic));
    assert.match(JSON.stringify(basic.result),new RegExp(name));
    child.stdin.end();
    assert.deepEqual(await Promise.race([closed,timeout]),{code:0,signal:null});
    assert.equal(buffer.trim(),'');
    return {tools:23,chineseTool:true,eofExit:0};
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
