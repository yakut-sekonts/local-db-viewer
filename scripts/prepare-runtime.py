"""Download pinned JDBC artifacts and an embedded JRE; no system installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def download(artifact):
    cache = ROOT / '.runtime-cache'
    cache.mkdir(exist_ok=True)
    path = cache / artifact['name']
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == artifact['sha256']:
        return path
    temporary = path.with_suffix('.part')
    request = urllib.request.Request(artifact['url'], headers={'User-Agent': 'Local-DB-Viewer-build'})
    print('Downloading', artifact['name'], flush=True)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != artifact['sha256']:
            raise RuntimeError('SHA256 mismatch: ' + artifact['name'])
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def extract_java(artifact, destination):
    marker = destination / '.local-db-viewer-sha256'
    if marker.exists() and marker.read_text() == artifact['sha256']:
        return
    archive = download(artifact)
    with tempfile.TemporaryDirectory(dir=ROOT / '.runtime-cache') as temporary:
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as file:
                for member in file.namelist():
                    if not (Path(temporary) / member).resolve().is_relative_to(Path(temporary).resolve()):
                        raise RuntimeError('Unsafe ZIP entry')
                file.extractall(temporary)
        else:
            with tarfile.open(archive) as file:
                file.extractall(temporary, filter='data')
        homes = [p.parent.parent for p in Path(temporary).rglob('java.exe') if p.parent.name == 'bin']
        homes += [p.parent.parent for p in Path(temporary).rglob('java') if p.parent.name == 'bin']
        if len(homes) != 1:
            raise RuntimeError('Expected exactly one Java home')
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(homes[0], destination, symlinks=True)
        marker.write_text(artifact['sha256'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', choices=['mac-arm64', 'windows-x64'])
    parser.add_argument('--jars-only', action='store_true', help='Prepare only JDBC artifacts for server integration tests with JAVA_HOME')
    parser.add_argument('--compiler', action='store_true', help='Download the pinned macOS ARM64 JDK for local builds')
    args = parser.parse_args()
    if bool(args.platform) == args.jars_only:
        parser.error('Select --platform or --jars-only.')
    manifest = json.loads((ROOT / 'build/runtime-lock.json').read_text())
    common = ROOT / 'runtime/common'
    common.mkdir(parents=True, exist_ok=True)
    for artifact in manifest['jars']:
        shutil.copy2(download(artifact), common / artifact['name'])
    if args.platform:
        extract_java(manifest['java'][args.platform], ROOT / 'runtime' / args.platform)
    if args.compiler:
        extract_java(manifest['java']['compiler-mac-arm64'], ROOT / 'runtime/compiler')
    shutil.copy2(ROOT / 'build/runtime-lock.json', common / 'runtime-lock.json')
    print('Runtime ready:', args.platform or 'JDBC jars', flush=True)


if __name__ == '__main__':
    main()
