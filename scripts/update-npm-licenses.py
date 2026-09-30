"""Refresh the reviewable npm license snapshot after npm ci (no network requests)."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent
README_LICENSES = {'pg-types': '2.2.0', 'pgpass': '1.0.5', 'railroad-diagrams': '1.0.0'}


def main():
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    destination = ROOT / 'licenses/npm'
    staging = ROOT / 'licenses/npm.next'
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    packages = []
    try:
        for path, entry in sorted(lock['packages'].items()):
            if not path or entry.get('dev'):
                continue
            package = ROOT / path
            metadata = json.loads((package / 'package.json').read_text(encoding='utf-8'))
            if metadata['version'] != entry['version']:
                raise ValueError('Run npm ci first: ' + path)
            name = metadata['name']
            files = []
            for directory, dirs, names in os.walk(package):
                dirs[:] = sorted(d for d in dirs if d not in {'node_modules', '.git'})
                for filename in sorted(names):
                    if re.search(r'license|licence|notice|copying|copyright', filename, re.I) and Path(filename).suffix.lower() in {'', '.txt', '.md', '.html'}:
                        files.append(Path(directory) / filename)
            if README_LICENSES.get(name) == entry['version']:
                files.append(package / 'README.md')
            if not files:
                raise ValueError('Review missing license text: ' + path)
            documents = []
            for file in files:
                relative = Path(path.removeprefix('node_modules/')) / file.relative_to(package)
                output = staging / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                data = file.read_bytes()
                output.write_bytes(data)
                documents.append({'path': 'npm/' + relative.as_posix(), 'sha256': hashlib.sha256(data).hexdigest(), 'source': entry['resolved'] + '!/' + file.relative_to(package).as_posix()})
            if name == 'railroad-diagrams':
                cc0 = ROOT / 'licenses/texts/CC0-1.0.txt'
                documents.append({'path': 'texts/CC0-1.0.txt', 'sha256': hashlib.sha256(cc0.read_bytes()).hexdigest(), 'source': 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt'})
            packages.append({'path': path, 'name': name, 'version': entry['version'], 'integrity': entry['integrity'], 'resolved': entry['resolved'], 'license': metadata.get('license') or metadata.get('licenses'), 'documents': documents})
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)
        (ROOT / 'licenses/npm-manifest.json').write_text(json.dumps({'schemaVersion': 1, 'packages': packages}, indent=2) + '\n')
        print(f'Refresh complete: {len(packages)} npm packages. Review texts and manifest before committing.')
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    main()
