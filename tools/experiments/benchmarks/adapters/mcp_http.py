"""Real loopback HTTP MCP calls against an explicitly staged native server.

Each case starts a new process; one first call then repeated warm calls. This
small pack is a regression smoke, not the historical full workload matrix.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import sys
import time


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


class Client:
    def __init__(self, port, version):
        self.connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        self.version, self.session, self.serial = version, None, 0
        if version == '2026-07-28':
            self.rpc('server/discover')
        else:
            self.rpc('initialize', {'protocolVersion':version, 'capabilities':{},
                'clientInfo':{'name':'comparative-evaluation','version':'1'}})
            self.rpc('notifications/initialized', notify=True)

    def rpc(self, method, parameters=None, notify=False):
        self.serial += 1
        request = {'jsonrpc':'2.0','method':method}
        headers = {'Content-Type':'application/json','Accept':'application/json, text/event-stream',
                   'MCP-Protocol-Version':self.version}
        if self.version == '2026-07-28':
            parameters = dict(parameters or {})
            parameters['_meta'] = {'io.modelcontextprotocol/protocolVersion':self.version,
                'io.modelcontextprotocol/clientInfo':{'name':'comparative-evaluation','version':'1'},
                'io.modelcontextprotocol/clientCapabilities':{}}
            headers['Mcp-Method'] = method
        if parameters is not None:
            request['params'] = parameters
        if not notify:
            request['id'] = self.serial
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        self.connection.request('POST','/mcp',canonical(request),headers)
        response = self.connection.getresponse()
        data = response.read(16 * 1048576 + 1)
        self.session = response.getheader('mcp-session-id') or self.session
        if response.status >= 400 or len(data) > 16 * 1048576:
            raise ValueError('MCP HTTP failure or response limit: ' + str(response.status))
        if notify:
            return None
        text = data.decode('utf-8')
        if text.startswith(('event:', 'data:')):
            text = '\n'.join(line[6:] for line in text.splitlines() if line.startswith('data: '))
        reply = json.loads(text)
        if 'error' in reply:
            raise ValueError('MCP RPC error: ' + str(reply['error']))
        return reply['result']

    def close(self):
        self.connection.close()


def measure(case, parameters):
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0))
        port = reservation.getsockname()[1]
    work = Path.cwd() / case['id']
    work.mkdir()
    environment = dict(os.environ)
    environment.update({'HOST':'127.0.0.1','PORT':str(port),'PRTS_TRANSPORT':'http',
        'PRTS_OUTPUT_CHANNEL':'both','IMAGES_ENABLED':'false','PRTS_AUTO_SYNC_INTERVAL_SECONDS':'0',
        'XDG_DATA_HOME':str(work / 'xdg'), 'HTTP_PROXY':'http://127.0.0.1:9',
        'HTTPS_PROXY':'http://127.0.0.1:9','ALL_PROXY':'http://127.0.0.1:9',
        'NO_PROXY':'127.0.0.1,localhost'})
    environment.update(parameters['server_environment'])
    started = time.monotonic()
    server = subprocess.Popen(parameters['server_command'], cwd=str(work), env=environment,
                              stdout=sys.stderr, stderr=sys.stderr)
    client = None
    try:
        deadline = started + parameters.get('startup_seconds',10)
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise ValueError('Server exited before readiness')
            connection = http.client.HTTPConnection('127.0.0.1',port,timeout=0.2)
            try:
                connection.request('GET','/health')
                response = connection.getresponse()
                response.read()
                if response.status == 200:
                    break
            except OSError:
                pass
            finally:
                connection.close()
            time.sleep(0.02)
        else:
            raise ValueError('Server readiness deadline exceeded')
        startup_ms = (time.monotonic()-started)*1000
        client = Client(port, parameters.get('protocol','2025-06-18'))
        durations, output = [], None
        for _ in range(1 + parameters.get('warm_calls',5)):
            before = time.monotonic()
            result = client.rpc('tools/call',case['input'])
            durations.append((time.monotonic()-before)*1000)
            if result.get('isError'):
                raise ValueError('Tool returned isError')
            normalized = {key:result.get(key) for key in ('content','structuredContent')}
            if output is not None and canonical(normalized) != canonical(output):
                raise ValueError('Output changed between first and warm calls')
            output = normalized
        return {'id':case['id'],'output':output,'metrics':{
            'startup_ms':startup_ms,'first_ms':durations[0],
            'warm_ms':statistics.median(durations[1:]),'response_bytes':len(canonical(output))},
            'details':{'call_ms':durations,'protocol':client.version}}
    finally:
        if client:
            client.close()
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps({'version':1,'cases':[measure(case,request['parameters']) for case in request['cases']]}))
