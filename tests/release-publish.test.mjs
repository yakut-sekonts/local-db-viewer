import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishRelease } from '../scripts/release.mjs';

async function fixture(version) {
  const directory = await mkdtemp(join(tmpdir(), 'release-publish-'));
  await mkdir(join(directory, 'release-assets'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(directory, 'CHANGELOG.md'), `# Changes\n\n## ${version}\n\nRelease notes\n\n## 0.0.1\n\nOld notes\n`);
  for (const suffix of ['mac-arm64.dmg', 'mac-arm64.zip', 'windows-x64-setup.exe', 'third-party-sources.zip']) await writeFile(join(directory, 'release-assets', `Local-DB-Viewer-${version}-${suffix}`), 'fixture asset');
  return directory;
}

test('publisher stages all installers and corresponding sources before publishing to the correct channel', async () => {
  for (const version of ['1.2.0', '1.2.0-beta.2']) {
    const directory = await fixture(version), calls = [];
    try {
      await publishRelease({ directory, ref: 'v' + version, repository: 'fixture/releases', gh: args => { calls.push(args); if (args[1] === 'view') throw new Error('Release not found'); } });
      assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'upload', 'edit']);
      assert.ok(calls[1].includes('--draft'));
      assert.equal(calls[1].includes('--prerelease'), version.includes('-beta.'));
      assert.equal(calls[3].includes('--latest=false'), version.includes('-beta.'));
      assert.equal(calls[3].includes('--latest'), !version.includes('-beta.'));
      assert.ok(calls[3].includes('--draft=false'));
      assert.ok(calls[2].some(a => a.endsWith('-third-party-sources.zip')));
      assert.equal((await readFile(join(directory, 'release-assets/SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 4);
      assert.equal((await readFile(join(directory, 'release-notes.md'), 'utf8')).trim(), 'Release notes');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('publisher never makes a release public after incomplete artifacts or a failed upload', async () => {
  const version = '1.2.0-beta.2', directory = await fixture(version), calls = [];
  const run = args => { calls.push(args); if (args[1] === 'view') throw new Error('Not found'); if (args[1] === 'upload') throw new Error('Upload interrupted'); };
  try {
    await assert.rejects(publishRelease({ directory, ref: 'v' + version, repository: 'fixture/releases', gh: run }), /Upload interrupted/);
    assert.ok(calls.every(args => args[1] !== 'edit'));
    calls.length = 0;
    await rm(join(directory, 'release-assets', `Local-DB-Viewer-${version}-third-party-sources.zip`));
    await assert.rejects(publishRelease({ directory, ref: 'v' + version, repository: 'fixture/releases', gh: run }), /Missing release artifact/);
    assert.deepEqual(calls, []);
    await assert.rejects(publishRelease({ directory, ref: 'v9.9.9', repository: 'fixture/releases', gh: run }), /Git tag/);
    assert.deepEqual(calls, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
