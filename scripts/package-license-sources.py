"""Publishable source companion, with bounded downloads verified against the reviewed lock."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def sha256(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def download(artifact, cache, opener=urllib.request.urlopen):
    name = artifact['name']
    if Path(name).name != name or not re.fullmatch(r'[A-Za-z0-9_.+-]+', name):
        raise ValueError('Unsafe source filename')
    path = cache / name
    if path.exists() and path.stat().st_size == artifact['size'] and sha256(path) == artifact['sha256']:
        return path
    if not artifact['url'].startswith('https://'):
        raise ValueError('Source downloads require HTTPS')
    temporary = path.with_suffix(path.suffix + '.part')
    try:
        request = urllib.request.Request(artifact['url'], headers={'User-Agent': 'Local-DB-Viewer-source-distribution'})
        with opener(request, timeout=120) as response, temporary.open('wb') as output:
            received = 0
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > artifact['size']:
                    raise ValueError('Source archive exceeds pinned size: ' + name)
                output.write(chunk)
        if received != artifact['size'] or sha256(temporary) != artifact['sha256']:
            raise ValueError('Source archive integrity mismatch: ' + name)
        temporary.replace(path)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'release-assets')
    parser.add_argument('--cache', type=Path, default=ROOT / '.runtime-cache/license-sources')
    args = parser.parse_args()
    source_lock = json.loads((ROOT / 'licenses/source-lock.json').read_text(encoding='utf-8'))
    if source_lock['runtime'] != json.loads((ROOT / 'build/runtime-lock.json').read_text(encoding='utf-8')):
        raise ValueError('Sources must be reviewed for this exact runtime lock.')
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.\d+)?', version):
        raise ValueError('Invalid application version')
    # The companion must describe the actual release commit, never a dirty tree.
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=ROOT).strip():
        raise ValueError('Commit all source changes before building the source companion.')
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    artifacts = [download(a, args.cache) for a in source_lock['artifacts']]
    target = args.output / f'Local-DB-Viewer-{version}-third-party-sources.zip'
    partial = target.with_suffix('.zip.part')
    try:
        with tempfile.TemporaryDirectory() as directory:
            own = Path(directory) / f'local-db-viewer-{version}-source.tar.gz'
            subprocess.run(['git', 'archive', '--format=tar.gz', f'--prefix=local-db-viewer-{version}/', '-o', str(own), 'HEAD'], cwd=ROOT, check=True)
            entries = [(p, 'upstream/' + p.name) for p in artifacts] + [(own, own.name)]
            entries += [(ROOT / 'licenses/source-lock.json', 'source-lock.json'), (ROOT / 'THIRD_PARTY_NOTICES.md', 'README.md')]
            entries += [(p, 'build-definitions/' + p.name) for p in sorted((ROOT / 'licenses/source-build').iterdir()) if p.is_file()]
            checksums = []
            with zipfile.ZipFile(partial, 'w', compression=zipfile.ZIP_STORED) as archive:
                for path, name in entries:
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    with path.open('rb') as source, archive.open(info, 'w', force_zip64=True) as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                    checksums.append(f'{sha256(path)}  {name}')
                archive.writestr(zipfile.ZipInfo('SHA256SUMS.txt', date_time=(1980, 1, 1, 0, 0, 0)), '\n'.join(checksums) + '\n')
            partial.replace(target)
        print(target)
    finally:
        partial.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
