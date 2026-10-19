"""Contract, evidence, failure and lifecycle checks; no network or dependencies."""
import copy
import io
import json
import os
import signal
import subprocess
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lab import analysis, evidence, runner
from lab.bundle import extract
from lab.common import LabError, RunLock, file_hash, inventory, read_json, write_json
from lab.config import TOOLS, contract, load, orders
from lab.initialize import initialize
from lab.drivers import Driver
from lab.process import capture
from lab.schema import validate


ADAPTER = '''import json,os,sys
from pathlib import Path
r=json.load(sys.stdin)
if r['parameters'].get('fail') and r['context']['variant']=='A' and Path.cwd().name=='0001':
 print('transient fault PRIVATE-CANARY',file=sys.stderr);sys.exit(9)
print(json.dumps({'version':1,'cases':[{'id':c['id'],'metrics':{'score':r['parameters']['score']},
 'output':r['context']['seed'] if r['parameters'].get('paired') else r['context']['variant'],
 'details':{'private':'PRIVATE-CANARY'}} for c in r['cases']]}))
'''


class LabTests(unittest.TestCase):
    def setUp(self):
        self.old_mask = os.umask(0o077)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        initialize(self.root / 'private', 'local', 'function-performance')
        self.profile = self.root / 'private/environment.json'
        profile = read_json(self.profile)
        profile['limits']['min_free_mib'] = 1
        write_json(self.profile, profile)
        self.adapter = self.root / 'adapter.py'
        self.adapter.write_text(ADAPTER)
        self.benchmark = self.root / 'benchmark.json'
        write_json(self.benchmark, {'version':1,'id':'test-pack','revision':'1',
            'unit':'task-run','equivalence':'none','files':[{'source':str(self.adapter),'target':'adapter.py'}],
            'cases':[{'id':'one','input':{}},{'id':'two','input':{}}],
            'metrics':{'score':{'unit':'fraction','direction':'higher','role':'primary',
                                 'aggregate':'mean','minimum':0}}})
        self.plan = self.root / 'plan.json'
        write_json(self.plan, {'version':1,'id':'test-comparison','hypothesis':'B improves score',
            'benchmark':str(self.benchmark),'environment':str(self.profile),
            'variants':[{'id':key,'command':['{python}','{bundle}/adapter.py'],
                         'parameters':{'score':score},'files':[]} for key,score in [('A',0.5),('B',1)]],
            'design':{'rounds':2,'seed':42,'trial_seconds':2,'cooldown_seconds':0,'max_attempts':2},
            'checks':[{'variant':'B','baseline':'A','case':'aggregate','metric':'score',
                       'operator':'delta_gte','value':0.5}]})

    def tearDown(self):
        self.temporary.cleanup()
        os.umask(self.old_mask)

    def change(self, path, change):
        value = read_json(path)
        change(value)
        write_json(path, value)

    def create(self):
        return runner.create(self.plan, None, self.root / 'runs')

    def test_strict_numbers_and_unknown_fields(self):
        for raw in ('{"a":1,"a":2}', '[NaN]', '[1e309]'):
            path = self.root / 'invalid.json'
            path.write_text(raw)
            with self.assertRaises(LabError):
                read_json(path)
        with self.assertRaises(LabError):
            validate(True, {'enum':[1]})
        self.change(self.plan, lambda p:p.update(typo=True))
        with self.assertRaises(LabError):
            load(self.plan)

    def test_exclusive_metadata_is_whole_and_never_replaced(self):
        path = self.root / 'metadata.json'
        write_json(path, {'first':True}, exclusive=True)
        with self.assertRaises(FileExistsError):
            write_json(path, {'second':True}, exclusive=True)
        self.assertEqual(read_json(path), {'first':True})
        self.assertEqual(list(self.root.glob('.lab-*')), [])

    def test_profile_discovery_and_operations(self):
        with mock.patch.dict(os.environ, {'EXPERIMENT_PROFILE':str(self.profile)}):
            self.assertEqual(load(self.plan)['profile_path'], str(self.profile))
        self.change(self.profile, lambda p:p.update(ready=False))
        with self.assertRaises(LabError):
            load(self.plan)

    def test_hash_and_target_validation(self):
        for entry in ({'source':str(self.adapter),'target':'../escape'},
                      {'source':str(self.adapter),'target':'control/fake'},
                      {'source':str(self.adapter),'target':'a','sha256':'0'*64}):
            self.change(self.plan, lambda p:p.update(files=[entry]))
            with self.assertRaises(LabError):
                load(self.plan)

    def test_balanced_orders(self):
        plan = read_json(self.plan)
        self.assertEqual(orders(plan), [['A','B'],['B','A']])
        plan['variants'].append(dict(plan['variants'][0], id='C'))
        plan['design']['rounds'] = 6
        self.assertEqual(len(set(tuple(row) for row in orders(plan))), 6)
        plan['design']['orders'] = [['A','B']]*6
        with self.assertRaises(LabError):
            orders(plan)

    def test_archive_traversal_special_and_budget(self):
        for name, kind in [('../escape',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('/abs',tarfile.REGTYPE)]:
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                item = tarfile.TarInfo(name)
                item.type = kind
                archive.addfile(item)
            data.seek(0)
            with self.assertRaises(LabError):
                extract(data, self.root / 'extract', 100)

    def test_different_outputs_export_and_owned_cleanup(self):
        run = self.create()
        summary = runner.execute(run)
        self.assertTrue(summary['passed'])
        self.assertEqual(summary['estimates']['B']['aggregate']['score']['n'], 2)
        before = inventory(run / 'evidence/raw')
        runner.execute(run)
        self.assertEqual(before, inventory(run / 'evidence/raw'))
        report = json.dumps(evidence.export(run, summary))
        self.assertNotIn('PRIVATE-CANARY', report)
        self.assertNotIn(str(self.root), report)
        with self.assertRaises(OSError):
            runner.cleanup(run)
        previous = os.umask(0o022)
        try:
            evidence.archive(run, self.root / 'backup.tar.gz')
        finally:
            os.umask(previous)
        if os.name != 'nt':
            self.assertEqual((self.root / 'backup.tar.gz').stat().st_mode & 0o077, 0)
        self.assertTrue(runner.cleanup(run)['work_removed'])
        self.assertEqual(before, inventory(run / 'evidence/raw'))
        self.assertTrue(runner.cleanup(run)['work_removed'])

    def test_paired_equivalence_with_round_seeds(self):
        self.change(self.benchmark, lambda b:b.update(equivalence='output-sha256'))
        self.change(self.plan, lambda p:[v['parameters'].update(paired=True) for v in p['variants']])
        self.assertTrue(runner.execute(self.create())['passed'])

    def test_equivalence_mismatch_and_zero_baseline_reject(self):
        self.change(self.benchmark, lambda b:b.update(equivalence='output-sha256'))
        self.assertFalse(runner.execute(self.create())['passed'])
        self.change(self.benchmark, lambda b:b.update(equivalence='none'))
        self.change(self.plan, lambda p:p['variants'][0]['parameters'].update(score=0))
        self.change(self.plan, lambda p:p['checks'][0].update(operator='ratio_gte'))
        summary = runner.execute(self.create())
        self.assertFalse(summary['passed'])
        self.assertIsNone(summary['checks'][0]['observed'])

    def test_failed_attempt_retained_and_success_not_replaced(self):
        self.change(self.plan, lambda p:[v['parameters'].update(fail=True) for v in p['variants']])
        run = self.create()
        with self.assertRaises(LabError):
            runner.execute(run)
        before = inventory(run / 'evidence/raw/r0000-A/0001')
        with self.assertRaises(LabError):
            runner.execute(run)
        with self.assertRaises(LabError):
            runner.execute(run, retry_errors=True)
        summary = runner.execute(run, retry_errors=True)
        self.assertTrue(summary['passed'])
        self.assertEqual(len(summary['retained_unsuccessful_attempts']), 2)
        self.assertEqual(before, inventory(run / 'evidence/raw/r0000-A/0001'))

    def test_acceptance_rejection_does_not_trigger_retry(self):
        self.change(self.plan, lambda p:p['checks'][0].update(value=2))
        run = self.create()
        self.assertFalse(runner.execute(run)['passed'])
        before = inventory(run / 'evidence/raw')
        self.assertFalse(runner.execute(run, retry_errors=True)['passed'])
        self.assertEqual(before, inventory(run / 'evidence/raw'))

    def test_input_and_evidence_drift(self):
        run = self.create()
        runner.execute(run)
        self.adapter.write_text(ADAPTER + '\n# changed\n')
        with self.assertRaises(LabError):
            runner.execute(run)
        raw = next((run / 'evidence/raw').glob('*/*/stderr.log'))
        raw.write_text('tampered')
        with self.assertRaises(LabError):
            analysis.summarize(run)

    def test_unknown_dispatch_charged_and_never_reused(self):
        run = self.create()
        write_json(run / 'dispatches/r0000-A/0001.json', {'trial':'r0000-A',
            'attempt':1,'round':0,'variant':'A','timeout_seconds':2})
        with self.assertRaises(LabError):
            runner.execute(run)
        self.assertEqual(analysis.attempts(run)['r0000-A'][0]['elapsed_seconds'], 2)
        summary = runner.execute(run, retry_errors=True)
        self.assertTrue(summary['passed'])
        self.assertEqual(summary['retained_unsuccessful_attempts'][0]['status'], 'dispatch_unknown')

    def test_new_evidence_requires_new_archive(self):
        self.change(self.plan, lambda p:[v['parameters'].update(fail=True) for v in p['variants']])
        run = self.create()
        with self.assertRaises(LabError):
            runner.execute(run)
        evidence.archive(run, self.root / 'early.tar.gz')
        with self.assertRaises(LabError):
            runner.execute(run, retry_errors=True)
        with self.assertRaises(LabError):
            runner.cleanup(run)

    def test_cleanup_survives_source_changes_but_checks_owner(self):
        run = self.create()
        runner.execute(run)
        evidence.archive(run, self.root / 'backup.tar.gz')
        snapshot = read_json(run / 'snapshot.json')
        remote = Path(snapshot['config']['work_root']) / snapshot['identity']['key']
        owner_bytes = (remote / 'owner.json').read_bytes()
        owner = read_json(remote / 'owner.json')
        write_json(remote / 'owner.json', dict(owner,key='wrong'))
        with self.assertRaises(LabError):
            runner.cleanup(run)
        (remote / 'owner.json').write_bytes(owner_bytes)
        self.adapter.unlink()
        self.assertTrue(runner.cleanup(run)['work_removed'])

    def test_stage_failure_has_owned_cleanup(self):
        def partial(driver, run, identity, frozen):
            root = Path(driver.config['work_root']) / identity['key']
            root.mkdir(parents=True)
            write_json(root / 'owner.json', {'key':identity['key'],'job_sha256':frozen['job_sha256']})
            (root / 'bundle').mkdir()
            raise LabError('injected staging failure')
        with mock.patch.object(Driver, 'stage', partial):
            with self.assertRaises(LabError):
                self.create()
        run = next((self.root / 'runs').iterdir())
        state = read_json(run / 'state.json')
        state['phase'] = 'staging'  # Durable state left by a hard coordinator exit.
        write_json(run / 'state.json', state)
        evidence.archive(run, self.root / 'failed-stage.tar.gz')
        remote = Path(read_json(run / 'snapshot.json')['config']['work_root']) / run.name
        if os.name != 'nt':
            with RunLock(remote / '.lock'):
                with self.assertRaises(LabError):
                    runner.cleanup(run)
        self.assertTrue(runner.cleanup(run)['staging_removed'])
        self.assertEqual({path.name for path in remote.iterdir()}, {'.lock','owner.json'})

    def test_partial_metadata_keeps_attempt_and_allows_retry(self):
        for broken in ('invocation.json','result.json'):
            run = self.create()
            snapshot = read_json(run / 'snapshot.json')
            remote = Path(snapshot['config']['work_root']) / run.name
            raw = remote / 'raw/r0000-A/0001'
            raw.mkdir(parents=True)
            request = {'trial':'r0000-A','attempt':1,'round':0,'variant':'A','timeout_seconds':2}
            write_json(run / 'dispatches/r0000-A/0001.json', request)
            write_json(raw / 'invocation.json', request)
            (raw / broken).write_text('{"partial":')
            self.assertTrue(runner.execute(run, retry_errors=True)['passed'])
            self.assertEqual(analysis.attempts(run)['r0000-A'][0]['status'], 'interrupted')
            self.assertEqual((run / 'evidence/raw/r0000-A/0001' / broken).read_text(), '{"partial":')

    def test_full_length_variant_identifier(self):
        self.change(self.plan, lambda p:p['variants'][0].update(id='A'*64))
        self.change(self.plan, lambda p:p['checks'][0].update(baseline='A'*64))
        self.assertTrue(runner.execute(self.create())['passed'])

    def test_description_guardrail_and_private_preview(self):
        definitions = self.root / 'definitions.json'
        write_json(definitions, {'tool':{'description':'sample','inputSchema':{
            'properties':{'name':{'description':'name'}},'required':[]}}})
        request = {'parameters':{'definitions':str(definitions)},
                   'cases':[{'id':'one','input':{'tool':'tool','required':['name']}}]}
        result = subprocess.run([sys.executable,str(TOOLS/'benchmarks/adapters/description_coverage.py')],
            input=json.dumps(request).encode(),stdout=subprocess.PIPE,check=True)
        self.assertEqual(json.loads(result.stdout)['cases'][0]['metrics']['required_declared'],0)
        result = subprocess.run([sys.executable,str(TOOLS/'experiment.py'),'preview','--plan',str(self.plan)],
                                stdout=subprocess.PIPE,check=True)
        preview = json.loads(result.stdout)
        self.assertEqual(preview['variants'][0]['command'],['{python}','{bundle}/adapter.py'])
        self.assertIn('benchmark_parameters', preview)

    def test_large_inline_request_can_be_collected(self):
        self.change(self.benchmark, lambda b:b['cases'][0].update(input='x'*(20*1048576)))
        self.change(self.profile, lambda p:p['limits'].update(max_output_mib=1))
        self.change(self.plan, lambda p:p['design'].update(rounds=1,max_attempts=1,trial_seconds=10))
        self.assertTrue(runner.execute(self.create())['passed'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux process-group fault injection')
    def test_worker_hup_and_kill_stop_owned_descendants(self):
        code = '''import json,os,signal,subprocess,sys,time
from pathlib import Path
r=json.load(sys.stdin)
child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)'])
signal.signal(signal.SIGTERM,signal.SIG_IGN)
Path(r['parameters']['pids']).write_text(json.dumps([os.getppid(),os.getpid(),child.pid]))
time.sleep(30)
'''
        self.adapter.write_text(code)
        marker = self.root / 'pids.json'
        self.change(self.plan, lambda p:[v['parameters'].update(pids=str(marker)) for v in p['variants']])
        for number in (signal.SIGHUP,signal.SIGTERM,signal.SIGKILL):
            if marker.exists():
                marker.unlink()
            run = self.create()
            snapshot, driver = runner.verified(run)
            remote = Path(snapshot['config']['work_root']) / run.name
            request = {'trial':'r0000-A','attempt':1,'round':0,'variant':'A','timeout_seconds':2}
            write_json(run / 'dispatches/r0000-A/0001.json',request)
            worker = subprocess.Popen([sys.executable,'-B',str(remote/'bundle/control/worker.py'),
                'execute',run.name,driver.state['job_sha256']],stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            worker.stdin.write(json.dumps(request).encode()); worker.stdin.close()
            deadline = time.monotonic()+3
            while not marker.exists() and time.monotonic()<deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists())
            pids = read_json(marker)
            with self.assertRaises(LabError):
                with RunLock(remote/'.lock'):
                    pass
            os.kill(worker.pid,number)
            worker.wait(timeout=4)
            worker.stdout.close();worker.stderr.close()
            def alive(pid):
                path=Path('/proc')/str(pid)/'stat'
                try:
                    return path.read_text().split(') ',1)[1][0]!='Z'
                except (FileNotFoundError, ProcessLookupError):
                    return False
            deadline=time.monotonic()+3
            while any(alive(pid) for pid in pids) and time.monotonic()<deadline:
                time.sleep(0.02)
            self.assertFalse(any(alive(pid) for pid in pids))
            with RunLock(remote/'.lock'):
                pass
            evidence.collect(run,driver)
            self.assertEqual(analysis.attempts(run)['r0000-A'][0]['status'],'interrupted')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux descendant check')
    def test_normal_adapter_exit_stops_descendants_ignoring_term(self):
        output=self.root/'normal-exit'
        output.mkdir()
        code=('import subprocess,sys; p=subprocess.Popen([sys.executable,"-c",'
              '"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"]);'
              'print(p.pid,flush=True)')
        result=capture([sys.executable,'-c',code],b'',self.root,os.environ.copy(),output,2,1000)
        self.assertEqual(result['status'],'complete')
        path=Path('/proc')/(output/'stdout.json').read_text().strip()/'stat'
        def alive():
            try:
                return path.read_text().split(') ',1)[1][0]!='Z'
            except (FileNotFoundError, ProcessLookupError):
                return False
        deadline=time.monotonic()+2
        while alive() and time.monotonic()<deadline:
            time.sleep(0.02)
        self.assertFalse(alive())

    def test_container_owner_mismatch_prevents_commands(self):
        config = load(self.plan)
        config['profile'].update(driver='container')
        driver = Driver(config, {'container_name':'owned','key':'key','job_sha256':'job',
                                 'image_id':'sha256:expected'})
        data = [{'Config':{'Labels':{'prts.lab':'other','prts.job':'job'}},
                 'Image':'sha256:expected','State':{'Running':True}}]
        with mock.patch.object(driver,'host',return_value=json.dumps(data).encode()) as host:
            with self.assertRaises(LabError):
                driver.checked_container()
            self.assertEqual(host.call_count, 1)

    def test_timeout_and_output_limit_keep_logs(self):
        for code, status in [('import time;print("partial",flush=True);time.sleep(5)','timeout'),
                             ('print("x"*1000000)','output_limit')]:
            output = self.root / status
            output.mkdir()
            result = capture([sys.executable,'-c',code],b'',self.root,os.environ.copy(),output,0.2,1000)
            self.assertEqual(result['status'], status)
            self.assertGreater((output/'stdout.json').stat().st_size,0)
            self.assertLessEqual((output/'stdout.json').stat().st_size,1000)


if __name__ == '__main__':
    unittest.main()
