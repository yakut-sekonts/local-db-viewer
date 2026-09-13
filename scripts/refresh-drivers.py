"""Resolve public JDBC releases in CI. End-user devices download only pinned JARs."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
CENTRAL = 'https://repo.maven.apache.org/maven2/'


def version_key(value):
    return tuple(int(item) for item in re.findall(r'\d+', value))


def latest_version(definition):
    artifact = definition['maven']
    path = artifact['group'].replace('.', '/') + '/' + artifact['artifact'] + '/maven-metadata.xml'
    with urllib.request.urlopen(CENTRAL + path, timeout=45) as response:
        metadata = ET.fromstring(response.read(2 * 1024 * 1024))
    pattern = artifact.get('versionPattern', r'^\d+(?:[._-]\d+)*(?:[.-](?:Final|GA|RELEASE))?$')
    versions = [node.text for node in metadata.findall('./versioning/versions/version') if re.fullmatch(pattern, node.text or '', re.I)]
    if not versions:
        raise RuntimeError('No stable Maven versions')
    return max(versions, key=version_key)


def resolve(definition, version, cache, mvn):
    artifact = definition['maven']
    with tempfile.TemporaryDirectory(prefix='driver-', dir=cache) as temporary:
        work = Path(temporary)
        classifier = artifact.get('classifier')
        shaded = classifier in ('all', 'standalone') or artifact['artifact'].endswith('full-bundle')
        extra = f'<classifier>{escape(classifier)}</classifier>' if classifier else ''
        if shaded:
            extra += '<exclusions><exclusion><groupId>*</groupId><artifactId>*</artifactId></exclusion></exclusions>'
        logging = '<dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.19</version></dependency>' if definition['id'] == 'clickhouse' else ''
        (work / 'pom.xml').write_text(f'''<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>dev.localdbviewer</groupId><artifactId>resolve-driver</artifactId><version>1</version><dependencies><dependency><groupId>{escape(artifact['group'])}</groupId><artifactId>{escape(artifact['artifact'])}</artifactId><version>{escape(version)}</version>{extra}</dependency>{logging}</dependencies></project>''')
        settings = work / 'settings.xml'
        settings.write_text(f'<settings><mirrors><mirror><id>central-only</id><mirrorOf>*</mirrorOf><url>{CENTRAL}</url></mirror></mirrors></settings>')
        repository = cache / 'repository'
        command = [mvn, '-B', '-q', '-s', str(settings), f'-Dmaven.repo.local={repository}', '-f', str(work / 'pom.xml'), 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath', '-DincludeScope=runtime', '-Dmdep.pathSeparator=|', f'-Dmdep.outputFile={work / "classpath.txt"}']
        result = subprocess.run(command, capture_output=True, text=True, timeout=300)
        if result.returncode:
            raise RuntimeError('Maven resolution failed: ' + result.stdout[-1600:] + result.stderr[-600:])
        paths = [Path(item) for item in (work / 'classpath.txt').read_text().strip().split('|')]
        if not paths or len(paths) > 250:
            raise RuntimeError('Invalid dependency count')
        files = []
        contains_driver = False
        for path in paths:
            relative = path.relative_to(repository).as_posix()
            if not path.name.endswith('.jar') or path.stat().st_size > 512 * 1024 * 1024:
                raise RuntimeError('Invalid JDBC artifact')
            with zipfile.ZipFile(path) as archive:
                contains_driver |= definition['className'].replace('.', '/') + '.class' in archive.namelist()
            files.append(dict(path=relative, size=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        if not contains_driver:
            raise RuntimeError('Driver class absent from resolved JARs: ' + definition['className'])
        if sum(file['size'] for file in files) > 1024 ** 3:
            raise RuntimeError('Driver dependency closure exceeds 1 GiB')
        # Verify class linkage and URL recognition on the CI Java runtime.
        java = str(Path(os.environ['JAVA_HOME']) / 'bin/java') if os.environ.get('JAVA_HOME') else 'java'
        probe = subprocess.run([java, str(ROOT / 'scripts/DriverProbe.java'), definition['className'], definition['url'], *map(str, paths)], capture_output=True, text=True, timeout=45)
        if probe.returncode or 'DRIVER_OK' not in probe.stdout:
            raise RuntimeError('Driver class loading failed: ' + probe.stderr[-1000:])
        release = dict(version=version, files=files)
        release['key'] = hashlib.sha256(json.dumps(release, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return release


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=str(ROOT / 'drivers/catalog-lock.json'))
    parser.add_argument('--previous')
    parser.add_argument('--only', default='')
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    cache = ROOT / '.runtime-cache/maven'; cache.mkdir(parents=True, exist_ok=True)
    output = Path(args.output)
    previous_path = Path(args.previous) if args.previous else output
    catalog = json.loads(previous_path.read_text()) if previous_path.exists() else dict(format=1, drivers={})
    definitions = [item for item in json.loads((ROOT / 'drivers/definitions.json').read_text()) if item.get('maven') and (not args.only or item['id'] in args.only.split(','))]
    errors = []
    def update(definition):
        identifier = definition['id']
        try:
            version = latest_version(definition)
            previous = catalog['drivers'].get(identifier)
            if previous and version_key(previous['version']) >= version_key(version):
                print(identifier, previous['version'], 'unchanged', flush=True); return identifier, previous
            release = resolve(definition, version, cache, os.environ.get('MAVEN_BIN', 'mvn'))
            print(identifier, version, len(release['files']), 'JARs', flush=True)
            return identifier, release
        except Exception as error:
            errors.append(identifier)
            print(identifier, str(error), flush=True)
            return identifier, catalog['drivers'].get(identifier)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for identifier, release in pool.map(update, definitions):
            if release:
                catalog['drivers'][identifier] = release
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    if errors:
        message = 'Unresolved drivers (previous versions preserved): ' + ', '.join(errors)
        if args.allow_partial:
            print('::warning::' + message)
            missing = [item['id'] for item in definitions if item['id'] not in catalog['drivers']]
            if missing: raise SystemExit('Missing verified drivers: ' + ', '.join(missing))
        else:
            raise SystemExit(message)


if __name__ == '__main__':
    main()
