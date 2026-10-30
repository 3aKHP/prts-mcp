"""Shared v2 contract cases for both legacy implementations; no live downloads."""
import base64
import copy
import json
from pathlib import Path

import pytest
from prts_mcp.data.images import parse_index
from prts_mcp.data.images_v2 import validate
from prts_mcp.sync import images_sync, images_v2
from prts_mcp.sync.generation_store import active_generation, save_meta

FIXTURE = Path(__file__).resolve().parents[2] / 'tests/fixtures/images-v2/world.json'


@pytest.fixture
def world(monkeypatch):
    raw = json.loads(FIXTURE.read_text())
    state = dict(raw, latest='26-01-01', offline=False, corrupt=None)
    def releases(*a, **k):
        if state['offline']:
            return None
        return [{'tag_name':tag,'created_at':'2099-01-01','assets':[]} for tag in raw['indexes']
                if tag.removeprefix('images2-') <= state['latest']]
    def small(url, **kwargs):
        tag = url.split('/download/')[1].split('/')[0]
        return json.dumps(raw['indexes'][tag]).encode()
    def stream(url, dest, **kwargs):
        key = url.split('/download/')[1]
        data = base64.b64decode(raw['assets'][key])
        Path(dest).write_bytes(b'bad' if state['corrupt'] == key else data)
    monkeypatch.setattr(images_sync, 'list_releases', releases)
    monkeypatch.setattr(images_sync, '_download_small', small)
    monkeypatch.setattr(images_v2, 'stream_cascading', stream)
    return state


def test_fresh_delta_delete_rotation_and_empty_delta(tmp_path, world):
    for version in ['26-01-01', '26-02-01', '26-04-01', '26-04-02']:
        world['latest'] = version
        result = images_sync.sync_images(tmp_path)
        assert result.status == 'updated', result.error
        gen = active_generation(tmp_path)
        parsed = parse_index(json.loads((gen/'index.json').read_text()))
        assert parsed.schema_version == 'akdp-images/v2'
        assert set(parsed.artworks) == ({'a','b'} if version == '26-01-01' else {'a','c'})
        assert not (gen/'a.original.png').exists()
        if version != '26-01-01':
            assert not (gen/'b.large.png').exists()
    assert images_sync.sync_images(tmp_path).status == 'up_to_date'


def test_original_both_directions_and_v1_volume_migration(tmp_path, world):
    old = tmp_path/'.releases/legacy'
    old.mkdir(parents=True)
    index = copy.deepcopy(world['indexes']['images2-26-01-01'])
    index['schemaVersion']='akdp-images/v1'
    (old/'index.json').write_text(json.dumps(index))
    save_meta(tmp_path,dict(schemaVersion='akdp-images/v1',currentVersion='26-01-01',generation_root='.releases/legacy',shardsSynced=[]))
    assert images_sync.sync_images(tmp_path,include_original=True).status == 'updated'
    assert (active_generation(tmp_path)/'a.original.png').is_file()
    assert images_sync.sync_images(tmp_path,include_original=False).status == 'updated'
    assert not (active_generation(tmp_path)/'a.original.png').exists()


@pytest.mark.parametrize("failure", ["corrupt", "missing"])
def test_bad_zip_failure_offline_and_no_v1_downgrade(tmp_path, world, monkeypatch, failure):
    images_sync.sync_images(tmp_path)
    before = active_generation(tmp_path)
    world['latest']='26-02-01'
    part=world['indexes']['images2-26-02-01']['deltaParts'][0]['file']
    key='images2-26-02-01/'+part
    saved=world['assets'][key]
    if failure == 'corrupt':
        world['corrupt']=key
    else:
        world['assets'].pop(key)
    assert images_sync.sync_images(tmp_path).status == 'offline_fallback'
    assert active_generation(tmp_path) == before
    world['corrupt']=None
    world['assets'][key]=saved
    assert images_sync.sync_images(tmp_path).status == 'updated'
    world['offline']=True
    assert images_sync.sync_images(tmp_path).status == 'offline_fallback'
    monkeypatch.setattr(images_sync,'list_releases',lambda *a,**k:[dict(tag_name='images-99-01-01',assets=[])])
    assert images_sync.sync_images(tmp_path).status == 'offline_fallback'


def test_shared_validator_rejects_bad_parts_and_paths(world):
    raw=world['indexes']['images2-26-01-01']
    assert validate(raw)
    for key, bad in [('file','../escape.zip'),('bytes',2147483648),('sha256','bad'),('group',None)]:
        invalid=copy.deepcopy(raw)
        invalid['baselineParts'][0][key]=bad
        assert not validate(invalid)
        assert parse_index(invalid) is None
