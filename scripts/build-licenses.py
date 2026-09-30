"""Validate locked legal evidence and build an offline license viewer for packaging."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def document_path(root, document):
    path = (root / 'licenses' / document['path']).resolve()
    if not path.is_relative_to((root / 'licenses').resolve()) or not path.is_file():
        raise ValueError('Missing/unsafe license document: ' + document['path'])
    if digest(path) != document['sha256']:
        raise ValueError('License document SHA256 mismatch: ' + document['path'])
    return path


def validate(root=ROOT):
    runtime = read_json(root / 'build/runtime-lock.json')
    jdbc = read_json(root / 'licenses/jdbc-manifest.json')
    sources = read_json(root / 'licenses/source-lock.json')
    npm = read_json(root / 'licenses/npm-manifest.json')
    lock = read_json(root / 'package-lock.json')
    if jdbc['runtime'] != runtime or sources['runtime'] != runtime:
        raise ValueError('Runtime changed: review JDBC licenses and corresponding sources before building.')
    source_names = set()
    for artifact in sources['artifacts']:
        if artifact['name'] in source_names or not re.fullmatch(r'[A-Za-z0-9_.+-]+', artifact['name']) or not re.fullmatch(r'[a-f0-9]{64}', artifact['sha256']) or not isinstance(artifact['size'], int) or artifact['size'] <= 0 or not artifact['url'].startswith('https://'):
            raise ValueError('Invalid source artifact: ' + artifact['name'])
        source_names.add(artifact['name'])
    required_sources = {'java:' + name for name in runtime['java']}
    required_sources.update(a['name'] for a in runtime['jars'] if 'GPL' in a['license'])
    required_sources.update(c['id'] for c in jdbc['components'] if 'EPL-' in c['license'])
    if sources['coverage'].keys() != required_sources:
        raise ValueError('Missing corresponding source coverage.')
    for component, names in sources['coverage'].items():
        if not names or not set(names) <= source_names:
            raise ValueError('Missing source artifact for ' + component)
    for document in sources['documents']:
        document_path(root, document)
    jars = {a['name'] for a in runtime['jars']}
    covered = set()
    ids = set()
    for component in jdbc['components']:
        if component['id'] in ids or not component['documents'] or not set(component['containers']) <= jars:
            raise ValueError('Invalid JDBC license component: ' + component['id'])
        ids.add(component['id'])
        covered.update(component['containers'])
        for document in component['documents']:
            document_path(root, document)
    if covered != jars:
        raise ValueError('Missing JDBC license coverage.')
    expected = {p: v for p, v in lock['packages'].items() if p and not v.get('dev')}
    actual = {p['path']: p for p in npm['packages']}
    if len(actual) != len(npm['packages']) or actual.keys() != expected.keys():
        raise ValueError('Production npm dependency set changed: refresh and review npm license inventory.')
    for path, package in actual.items():
        if any(package[k] != expected[path].get(k) for k in ['version', 'integrity', 'resolved']) or not package['documents']:
            raise ValueError('npm license snapshot is stale: ' + path)
        for document in package['documents']:
            document_path(root, document)
    if read_json(root / 'package.json').get('license') != 'Apache-2.0':
        raise ValueError('Project license must agree with LICENSE/NOTICE.')
    for filename in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']:
        if not (root / filename).is_file() or (root / filename).stat().st_size == 0:
            raise ValueError('Missing project notice: ' + filename)
    return runtime, jdbc, npm, lock


def verify_jars(directory, runtime):
    expected = {a['name'] for a in runtime['jars']} | {'local-db-viewer-bridge.jar'}
    actual = {p.name for p in directory.glob('*.jar')}
    if actual - expected:
        raise ValueError('Unreviewed JARs in distribution: ' + ', '.join(sorted(actual - expected)))
    for artifact in runtime['jars']:
        file = directory / artifact['name']
        if not file.is_file() or digest(file) != artifact['sha256']:
            raise ValueError('JDBC binary SHA256 mismatch: ' + artifact['name'])
    if read_json(directory / 'runtime-lock.json') != runtime:
        raise ValueError('Packaged runtime lock is stale.')


def build(root=ROOT):
    runtime, jdbc, npm, lock = validate(root)
    verify_jars(root / 'runtime/common', runtime)
    destination = root / 'runtime/legal'
    staging = root / 'runtime/legal.next'
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        for filename in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']:
            shutil.copyfile(root / filename, staging / filename)
        shutil.copytree(root / 'licenses', staging / 'licenses')
        electron = root / 'node_modules/electron'
        version = read_json(electron / 'package.json')['version']
        if version != lock['packages']['node_modules/electron']['version']:
            raise ValueError('Electron version differs from package-lock.json; run npm ci.')
        (staging / 'electron').mkdir()
        for filename in ['LICENSE', 'LICENSES.chromium.html']:
            path = electron / 'dist' / filename
            if not path.is_file() or path.stat().st_size < 100:
                raise ValueError('Electron license missing: ' + filename)
            shutil.copyfile(path, staging / 'electron' / filename)
        sections = []
        for title, components in [('JDBC', jdbc['components']), ('npm', npm['packages'])]:
            parts = ['<h2>' + title + '</h2>']
            for component in components:
                label = component.get('id') or f"{component['name']} {component['version']}"
                parts.append('<details><summary>' + html.escape(label) + '</summary>')
                parts.append('<p>' + html.escape(str(component['license'])) + '</p>')
                for document in component['documents']:
                    # No remote embeds or scripts. All legal text remains available offline.
                    data = document_path(root, document).read_text(encoding='utf-8')
                    parts.append('<p>' + html.escape(document['source']) + '</p><pre>' + html.escape(data) + '</pre>')
                parts.append('</details>')
            sections.append('\n'.join(parts))
        version_app = read_json(root / 'package.json')['version']
        page = '''<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Лицензии — Local DB Viewer</title><style>
body{background:#242629;color:#ddd;font:15px system-ui;margin:32px auto;padding:0 24px;max-width:1100px}
a{color:#8bb5ff} pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,monospace}
summary{cursor:pointer;padding:10px;border-bottom:1px solid #444}details{margin:8px 0}p{overflow-wrap:anywhere}
</style><h1>Лицензии Local DB Viewer</h1>'''
        page += '<p>Версия ' + html.escape(version_app) + ' · Apache-2.0</p>'
        page += '<p><a href="LICENSE">Apache-2.0</a> · <a href="NOTICE">NOTICE</a> · <a href="THIRD_PARTY_NOTICES.md">Уведомления и исходники</a></p>'
        page += '<h2>Java и Electron</h2><p><a href="../jre/NOTICE">Temurin NOTICE</a> · <a href="../jre/legal/java.base/LICENSE">OpenJDK GPLv2</a> · <a href="../jre/legal/java.base/ASSEMBLY_EXCEPTION">Assembly exception</a> · <a href="../jre/legal/java.base/ADDITIONAL_LICENSE_INFO">Classpath exception и дополнительные условия</a></p>'
        page += '<p>Полный набор лицензий модулей Java находится в соседнем каталоге jre/legal.</p>'
        page += '<p>Electron ' + html.escape(version) + ': <a href="electron/LICENSE">LICENSE</a> · <a href="electron/LICENSES.chromium.html">Chromium и зависимости</a></p>'
        page += '\n'.join(sections) + '</html>\n'
        (staging / 'index.html').write_text(page, encoding='utf-8')
        files = {p.relative_to(staging).as_posix(): digest(p) for p in sorted(staging.rglob('*')) if p.is_file()}
        (staging / 'distribution-manifest.json').write_text(json.dumps({'version': version_app, 'electronVersion': version, 'files': files}, indent=2) + '\n')
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)
        print(f'Legal package ready: {len(jdbc["components"])} JDBC components, {len(npm["packages"])} npm packages, Electron {version}.')
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def verify_resources(resources, root=ROOT):
    runtime, _, _, _ = validate(root)
    verify_jars(resources / 'jdbc', runtime)
    legal = resources / 'legal'
    manifest = read_json(legal / 'distribution-manifest.json')
    if manifest['version'] != read_json(root / 'package.json')['version']:
        raise ValueError('Packaged license viewer has wrong app version.')
    expected_manifest = read_json(root / 'runtime/legal/distribution-manifest.json')
    if manifest != expected_manifest:
        raise ValueError('Packaged legal manifest differs from build output.')
    for filename, expected in manifest['files'].items():
        file = (legal / filename).resolve()
        if not file.is_relative_to(legal.resolve()) or not file.is_file() or digest(file) != expected:
            raise ValueError('Missing/changed packaged legal file: ' + filename)
    jre = resources / 'jre'
    platform = 'windows-x64' if (jre / 'bin/java.exe').exists() else 'mac-arm64'
    original = root / 'runtime' / platform
    files = [original / 'NOTICE'] + [p for p in (original / 'legal').rglob('*') if p.is_file()]
    if len(files) < 10:
        raise ValueError('Original Java legal directory is missing.')
    for source in files:
        target = jre / source.relative_to(original)
        if not target.is_file() or digest(source) != digest(target):
            raise ValueError('Java legal file lost during packaging: ' + str(source.relative_to(original)))
    print(f'Packaged licenses verified, including {len(files)} Java legal files.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Check committed inventories without preparing runtime')
    parser.add_argument('--resources', type=Path, help='Verify an unpacked Electron resources directory after packaging')
    args = parser.parse_args()
    if args.resources:
        verify_resources(args.resources.resolve())
    elif args.check:
        validate()
        print('License inventories verified.')
    else:
        build()
