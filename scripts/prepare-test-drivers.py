"""Fetch pinned H2/DuckDB fixtures; no production DB or credentials required."""
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent.parent
for release in json.loads((root / 'tests/driver-fixtures.json').read_text())['drivers'].values():
    for file in release['files']:
        destination = root / '.runtime-cache/maven/repository' / file['path']
        if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == file['sha256']:
            continue
        with urllib.request.urlopen('https://repo.maven.apache.org/maven2/' + file['path'], timeout=120) as response:
            data = response.read(file['size'] + 1)
        if len(data) != file['size'] or hashlib.sha256(data).hexdigest() != file['sha256']:
            raise RuntimeError('Invalid JDBC test fixture: ' + file['path'])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
print('Pinned test drivers ready')
