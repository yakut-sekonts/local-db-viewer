"""Regression checks for missing notices, stale locks and corrupt source downloads."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


legal = module('build_licenses', 'build-licenses.py')
sources = module('license_sources', 'package-license-sources.py')


class LicenseInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / 'licenses', self.root / 'licenses')
        (self.root / 'build').mkdir()
        shutil.copyfile(ROOT / 'build/runtime-lock.json', self.root / 'build/runtime-lock.json')
        for filename in ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']:
            shutil.copyfile(ROOT / filename, self.root / filename)

    def change(self, filename, mutate):
        file = self.root / filename
        value = json.loads(file.read_text())
        mutate(value)
        file.write_text(json.dumps(value))

    def test_current_inventory(self):
        runtime, jdbc, npm, _ = legal.validate(self.root)
        self.assertEqual({a['name'] for a in runtime['jars']}, {n for c in jdbc['components'] for n in c['containers']})
        self.assertTrue(any(c['id'].startswith('jakarta.annotation') for c in jdbc['components']))
        self.assertTrue(any(c['id'].startswith('lz4-java') for c in jdbc['components']))
        self.assertTrue(any(p['name'] == 'monaco-editor' for p in npm['packages']))

    def test_runtime_change_requires_review(self):
        self.change('build/runtime-lock.json', lambda v: v['jars'][0].update(sha256='0' * 64))
        with self.assertRaisesRegex(ValueError, 'Runtime changed'):
            legal.validate(self.root)

    def test_npm_update_requires_review(self):
        self.change('package-lock.json', lambda v: v['packages']['node_modules/react'].update(integrity='changed'))
        with self.assertRaisesRegex(ValueError, 'snapshot is stale'):
            legal.validate(self.root)

    def test_required_sources_cannot_disappear(self):
        self.change('licenses/source-lock.json', lambda v: v['artifacts'].pop(0))
        with self.assertRaisesRegex(ValueError, 'Missing source artifact'):
            legal.validate(self.root)

    def test_missing_or_changed_license_fails(self):
        document = json.loads((self.root / 'licenses/jdbc-manifest.json').read_text())['components'][0]['documents'][0]
        path = self.root / 'licenses' / document['path']
        path.write_text('Changed upstream license')
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            legal.validate(self.root)
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'Missing/unsafe'):
            legal.validate(self.root)

    def test_unreviewed_jar_cannot_be_packaged(self):
        directory = self.root / 'jars'
        directory.mkdir()
        (directory / 'unreviewed.jar').write_bytes(b'new dependency')
        runtime = json.loads((self.root / 'build/runtime-lock.json').read_text())
        with self.assertRaisesRegex(ValueError, 'Unreviewed JARs'):
            legal.verify_jars(directory, runtime)

    def test_document_cannot_escape_license_directory(self):
        with self.assertRaisesRegex(ValueError, 'Missing/unsafe'):
            legal.document_path(self.root, {'path': '../package.json', 'sha256': '0' * 64})

    def test_snapshot_does_not_use_git_ignored_node_modules_paths(self):
        npm = json.loads((self.root / 'licenses/npm-manifest.json').read_text())
        for package in npm['packages']:
            for document in package['documents']:
                self.assertNotIn('node_modules', Path(document['path']).parts)


class SourceDownloadTests(unittest.TestCase):
    def test_integrity_bounds_cleanup_and_cache(self):
        payload = b'locked source archive'
        artifact = {'name': 'source.tar.gz', 'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(), 'url': 'https://example.invalid/source'}
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            for wrong in [b'truncated', b'X' * len(payload), payload + b'overflow']:
                with self.assertRaises(ValueError):
                    sources.download(artifact, cache, lambda *a, **k: io.BytesIO(wrong))
                self.assertEqual(list(cache.iterdir()), [])
            result = sources.download(artifact, cache, lambda *a, **k: io.BytesIO(payload))
            self.assertEqual(result.read_bytes(), payload)
            def forbidden_network(*args, **kwargs):
                self.fail('Verified cache should not use network')
            self.assertEqual(sources.download(artifact, cache, forbidden_network), result)
            result.write_bytes(b'corrupt cache')
            self.assertEqual(sources.download(artifact, cache, lambda *a, **k: io.BytesIO(payload)).read_bytes(), payload)

    def test_path_traversal_rejected_before_download(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                sources.download({'name': '../outside'}, Path(directory))


if __name__ == '__main__':
    unittest.main()
