from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish import missing_files, prepare, verify, candidate


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.receipts = [dict(filename=f"wheel-{i}.whl", version="3.2.2", sha256=str(i) * 64) for i in range(5)]

    def remote(self, receipts):
        return dict(info=dict(version="3.2.2", requires_python=">=3.11", requires_dist=None), urls=[dict(filename=r["filename"], digests=dict(sha256=r["sha256"]), yanked=False) for r in receipts])

    def test_first_and_partial_upload_only_prepare_missing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for r in self.receipts:
                (directory / r["filename"]).write_bytes(b"immutable fixture")
            output = directory / "upload"
            names = prepare(directory, self.receipts, None, output)
            self.assertEqual(len(names), 5)
            names = prepare(directory, self.receipts, self.remote(self.receipts[:2]), output)
            self.assertEqual(len(names), 3)
            self.assertEqual(sorted(p.name for p in output.iterdir()), names)
            self.assertEqual(missing_files(self.receipts, self.remote(self.receipts)), [])

    def test_conflicting_digest_yank_extra_file_and_metadata_fail_closed(self):
        for change in [lambda r: r['urls'][0]['digests'].update(sha256='bad'), lambda r: r['urls'][0].update(yanked=True), lambda r: r['urls'][0].update(filename='unexpected.whl'), lambda r: r['info'].update(requires_dist=['unexpected']), lambda r: r['info'].update(version='3.2.1')]:
            remote = self.remote(self.receipts)
            change(remote)
            with self.assertRaises(ValueError):
                missing_files(self.receipts, remote)

    def test_visibility_delay_partial_release_and_timeout(self):
        states = iter([None, self.remote(self.receipts[:3]), self.remote(self.receipts)])
        verify(self.receipts, fetch=lambda v: next(states), sleep=lambda n: None)
        with self.assertRaises(TimeoutError):
            verify(self.receipts, fetch=lambda v: None, timeout=0)

    def test_disabled_publisher_cannot_reach_tag_or_network_checks(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'RUST_PYPI_PUBLISH_ENABLED': 'false'}):
            with self.assertRaisesRegex(ValueError, 'disabled'):
                candidate()

    def test_downstream_completion_requires_success_when_pypi_enabled(self):
        import re
        from common import ROOT
        workflow = (ROOT / '.github/workflows/release-rust.yml').read_text()
        expression = workflow.split('  publish-non-npm:', 1)[1].split('if: >-', 1)[1].split('runs-on:', 1)[0].strip()
        for enabled in ['true', 'false', '']:
            for result in ['success', 'skipped', 'failure', 'cancelled']:
                values = {'github.ref_type': 'tag', 'vars.RUST_NON_NPM_PUBLISH_ENABLED': 'true',
                          'vars.RUST_PYPI_PUBLISH_ENABLED': enabled, 'needs.publish-pypi.result': result,
                          'needs.native.result': 'success', 'needs.cargo-source.result': 'success',
                          'needs.publish-crates.result': 'success', 'needs.publish-npm.result': 'success'}
                converted = expression.replace('always()', 'True')
                converted = re.sub(r'(?:github|vars|needs)\.[\w.-]+', lambda m: repr(values[m[0]]), converted)
                converted = converted.replace('&&', ' and ').replace('||', ' or ')
                actual = eval(' '.join(converted.split()), {'__builtins__': {}}, {})
                expected = result == 'success' or (enabled != 'true' and result == 'skipped')
                self.assertEqual(actual, expected, (enabled, result))

    def test_pypa_generated_action_is_ignored_but_source_changes_are_not(self):
        import subprocess
        from common import ROOT
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            (root / '.gitignore').write_text((ROOT / '.gitignore').read_text())
            subprocess.run(['git', '-C', str(root), 'add', '.gitignore'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], check=True)
            generated = root / '.github/.tmp/.generated-actions/run-pypi-publish-in-docker-container/action.yml'
            generated.parent.mkdir(parents=True)
            generated.write_text('generated action')
            status = lambda: subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=normal'], text=True)
            self.assertEqual(status(), '')
            (root / '.github/unrelated.yml').write_text('unexpected source')
            self.assertIn('.github/', status())
            (root / '.gitignore').write_text('modified source')
            self.assertIn(' M .gitignore', status())
