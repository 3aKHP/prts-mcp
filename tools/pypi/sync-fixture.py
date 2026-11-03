"""Build tiny legacy JSON release assets from committed synthetic fixtures."""
from pathlib import Path
import sys
import zipfile
import json
import hashlib
from common import ROOT

declarations = json.loads((ROOT / "contracts/data-declarations.json").read_text())["datasets"]
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
fixture = ROOT / "tests/fixtures/native-smoke"
for name, source in [("zh_CN-excel.zip", fixture / "zh_CN/gamedata/excel"), ("zh_CN-levels.zip", fixture / "zh_CN/gamedata/levels")]:
    with zipfile.ZipFile(output / name, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(fixture).as_posix())
        dataset = next(d for d in declarations if d['assetName'] == name)
        for required in dataset['requiredFiles']:
            if required not in archive.namelist():
                archive.writestr(required, '{}')
(output / 'zh_CN.zip').write_bytes((fixture / 'storyjson/zh_CN.zip').read_bytes())

assets = {}
for name in ['zh_CN-excel.zip', 'zh_CN-levels.zip', 'zh_CN.zip']:
    data = (output / name).read_bytes()
    assets[name] = dict(size=len(data), sha256=hashlib.sha256(data).hexdigest())
(output / 'manifest.json').write_text(json.dumps(dict(contractVersion='prts-mcp-data/v1', assets=assets)))
