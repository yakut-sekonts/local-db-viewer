import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadAsset, newerVersion, selectRelease, validRepository } from '../electron/update-source';
import { Updater } from '../electron/updater';

test('stable release selection uses numeric versions, architecture and SHA256', () => {
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.2.0', '0.2.0'), false);
  assert.equal(newerVersion('0.1.9', '0.2.0'), false);
  for (const value of ['1.2', '1.2.3-beta', '01.2.3', '9999999999999999999.0.0']) assert.throws(() => newerVersion(value, '0.1.0'));
  const asset = { id: 1, name: 'Local-DB-Viewer-0.2.0-mac-arm64.zip', size: 2, digest: `sha256:${'a'.repeat(64)}` };
  const release = { tag_name: 'v0.2.0', body: 'Changes', assets: [asset] };
  assert.equal(selectRelease(release, '0.1.0', 'darwin', 'arm64')?.asset.name, asset.name);
  assert.throws(() => selectRelease(release, '0.1.0', 'darwin', 'x64'));
  assert.throws(() => selectRelease(release, '0.1.0', 'win32', 'x64'));
  assert.equal(selectRelease({ ...release, prerelease: true }, '0.1.0', 'darwin', 'arm64'), undefined);
  assert.throws(() => selectRelease({ ...release, assets: [{ ...asset, digest: '' }] }, '0.1.0', 'darwin', 'arm64'));
  assert.equal(validRepository('https://github.com/example/local-db-viewer.git'), 'example/local-db-viewer');
  for (const value of ['https://evil.test/o/r', 'o/r/../../repo', 'o/r?token=secret', 'o/..']) assert.throws(() => validRepository(value));
});

test('download authenticates only to GitHub API and verifies complete bytes before rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-update-'));
  const previous = globalThis.fetch;
  const bytes = Buffer.from('verified installer');
  const asset = { id: 4, name: 'installer.exe', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (url: any, options: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') });
    return String(url).startsWith('https://api.github.com/') ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/download/file' } }) : new Response(bytes);
  }) as typeof fetch;
  try {
    const file = join(directory, asset.name);
    await downloadAsset('owner/releases', 'device-token', asset, file, () => {});
    assert.deepEqual(await readFile(file), bytes);
    assert.equal(calls[0].authorization, 'Bearer device-token');
    assert.equal(calls[1].authorization, null);
    await assert.rejects(downloadAsset('owner/releases', 'device-token', { ...asset, digest: `sha256:${'f'.repeat(64)}` }, join(directory, 'bad.exe'), () => {}), /SHA256/);
    assert.deepEqual(await readdir(directory), ['installer.exe']);
    await assert.rejects(downloadAsset('owner/releases', 'device-token', { ...asset, size: 2 }, join(directory, 'large.exe'), () => {}), /Размер/);
    assert.deepEqual(await readdir(directory), ['installer.exe']);
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } })) as typeof fetch;
    await assert.rejects(downloadAsset('owner/releases', 'device-token', asset, join(directory, 'redirect.exe'), () => {}), /недопустимый адрес/);
  } finally { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); }
});

test('updater persists only encrypted credentials and preserves them on ordinary settings edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-update-settings-'));
  const encryption = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
  const updater = new Updater(directory, '0.1.0', encryption, () => {}, async () => {});
  try {
    await updater.initialize();
    await updater.configure({ repository: 'owner/releases', automatic: false, token: 'private-device-token' });
    assert.equal(updater.state().settings.hasToken, true);
    assert.equal(JSON.stringify(updater.state()).includes('private-device-token'), false);
    assert.equal((await readFile(join(directory, 'settings.json'), 'utf8')).includes('private-device-token'), false);
    await updater.configure({ repository: 'owner/releases', automatic: false });
    assert.equal(updater.state().settings.hasToken, true);
    await assert.rejects(updater.install(), /не загружено/);
    await updater.configure({ repository: 'owner/releases', automatic: false, token: '' });
    assert.equal(updater.state().settings.hasToken, false);
    assert.equal(updater.state().phase, 'unconfigured');
  } finally { updater.dispose(); await rm(directory, { recursive: true, force: true }); }
});
