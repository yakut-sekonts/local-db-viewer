import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseReleaseVersion, compareReleaseVersions } from '../src/release-version';
import { newerVersion, releaseList, selectRelease, selectNewestRelease } from '../electron/update-source';
import { Updater } from '../electron/updater';
import { confirmUpdateStartup } from '../electron/update-install-state';

function release(version: string, extras: object = {}) {
  return { tag_name: 'v' + version, prerelease: version.includes('-beta.'), draft: false, body: version, assets: ['mac-arm64.zip', 'windows-x64-setup.exe'].map((suffix, index) => ({ id: index + 1, name: `Local-DB-Viewer-${version}-${suffix}`, size: 1, digest: `sha256:${createHash('sha256').update('x').digest('hex')}` })), ...extras };
}

test('release ordering preserves SemVer beta precedence and rejects unsupported or unsafe versions', () => {
  const ordered = ['0.9.9', '0.10.0-beta.0', '0.10.0-beta.2', '0.10.0-beta.10', '0.10.0', '0.10.1-beta.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.ok(newerVersion(ordered[i]!, ordered[i - 1]!));
  for (const value of ordered) assert.equal(compareReleaseVersions(value, value), 0);
  for (const value of ['1.2.3-beta', '1.2.3-beta.01', '01.2.3', '1.2.3-alpha.1', '1.2.3+secret', '1.2.3-beta.-1', '1.2.3-beta.9007199254740992', '1.2.3\n', '../1.2.3', null]) assert.equal(parseReleaseVersion(value), undefined);
});

test('stable never receives prereleases, while beta selects newest by version, including stable promotion', () => {
  const stable = release('1.1.0'), beta2 = release('1.2.0-beta.2'), beta10 = release('1.2.0-beta.10');
  const data = [stable, release('99.0.0-beta.1', { draft: true }), beta2, beta10, { tag_name: 'driver-catalog' }, release('2.0.0-beta.1', { prerelease: false })];
  assert.equal(selectNewestRelease(data, '1.0.0', 'win32', 'x64', 'stable')?.version, '1.1.0');
  assert.equal(selectNewestRelease(data, '1.0.0', 'win32', 'x64', 'beta')?.version, '1.2.0-beta.10');
  assert.equal(selectRelease(beta10, '1.0.0', 'win32', 'x64'), undefined);
  assert.equal(selectRelease({ ...beta10, prerelease: false }, '1.0.0', 'win32', 'x64'), undefined);
  assert.equal(selectNewestRelease([...data, release('1.2.0')], '1.2.0-beta.10', 'darwin', 'arm64', 'beta')?.version, '1.2.0');
  assert.equal(selectNewestRelease([stable], '1.2.0-beta.10', 'darwin', 'arm64', 'stable'), undefined);
  assert.throws(() => selectNewestRelease([stable, release('1.2.0-beta.10', { assets: [] })], '1.0.0', 'win32', 'x64', 'beta'), /SHA256/);
});

test('beta release listing handles pagination and expired tokens without following external links', async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const data = await releaseList('owner/public', 'expired', async (url, options) => {
    const auth = new Headers(options.headers).get('authorization');
    calls.push({ url, auth });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    if (auth) return new Response(null, { status: 401 });
    return new Response(JSON.stringify(url.endsWith('page=1') ? Array.from({ length: 100 }, () => release('1.0.0')) : [release('1.1.0-beta.2')]), { headers: { link: '<https://attacker.invalid/?token=secret>; rel="next"' } });
  });
  assert.equal(data.length, 101);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer expired', null, 'Bearer expired', null]);
  assert.ok(calls.every(c => c.url.startsWith('https://api.github.com/repos/owner/public/releases?per_page=100&page=')));
  assert.equal(selectNewestRelease(data, '1.0.0', 'darwin', 'arm64', 'beta')?.version, '1.1.0-beta.2');
  await assert.rejects(releaseList('owner/public', undefined, async () => new Response('{}')), /список/);
  let pages = 0;
  await assert.rejects(releaseList('owner/public', undefined, async () => { pages++; return new Response(JSON.stringify(Array(100).fill(null))); }), /лимит 500/);
  assert.equal(pages, 5);
});

test('channel migration is opt-in, persists, preserves tokens and invalidates a downloaded beta when switching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update-channels-'));
  const encryption = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
  const installed: string[] = [];
  const fetch = async (url: string) => new Response(url.endsWith('/latest') ? JSON.stringify(release('1.1.0')) : url.includes('/assets/') ? 'x' : JSON.stringify([release('1.2.0-beta.2'), release('1.1.0')]));
  const updater = new Updater(directory, '1.0.0', encryption, () => {}, async (_path, version) => { installed.push(version); }, fetch);
  let restarted: Updater | undefined;
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ repository: 'owner/releases', automatic: false, encryptedToken: encryption.encrypt('secret') }));
    await updater.initialize();
    assert.equal(updater.state().settings.channel, 'stable');
    // Linux runs pure release selection tests above; actual installer selection
    // is defined only for the two distribution platforms.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal((await updater.check()).version, '1.1.0');
    }
    await assert.rejects(updater.configure({ repository: 'owner/releases', automatic: false, channel: 'preview' as 'beta' }), /Некорректные/);
    await updater.configure({ repository: 'owner/releases', automatic: false, channel: 'beta' });
    await updater.configure({ repository: 'owner/releases', automatic: false });
    assert.equal(updater.state().settings.channel, 'beta');
    assert.equal(updater.state().settings.hasToken, true);
    restarted = new Updater(directory, '1.0.0', encryption, () => {}, async () => {}, fetch);
    await restarted.initialize(); assert.equal(restarted.state().settings.channel, 'beta');
    assert.equal((await readFile(join(directory, 'settings.json'), 'utf8')).includes('secret'), false);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal((await updater.check()).version, '1.2.0-beta.2');
      assert.equal((await updater.download()).phase, 'ready');
      await updater.configure({ repository: 'owner/releases', automatic: false, channel: 'stable' });
      await assert.rejects(updater.install(), /не загружено/);
      assert.equal(updater.state().version, undefined);
      assert.equal((await updater.check()).version, '1.1.0');
      assert.deepEqual(installed, []);
    }
  } finally { updater.dispose(); restarted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Windows startup acknowledgement identifies exact beta, not just its numeric PE version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beta-ack-'));
  try {
    const state = { phase: 'restarting', version: '1.2.0-beta.2', message: 'ready', token: randomUUID(), timestamp: new Date().toISOString() };
    await writeFile(join(directory, 'install-state.json'), JSON.stringify(state));
    for (const wrong of ['1.2.0-beta.1', '1.2.0', '1.2.0.0']) await confirmUpdateStartup(directory, wrong);
    await assert.rejects(readFile(join(directory, 'startup-ack.json')));
    await confirmUpdateStartup(directory, '1.2.0-beta.2');
    const ack = JSON.parse(await readFile(join(directory, 'startup-ack.json'), 'utf8'));
    assert.equal(ack.version, state.version); assert.equal(ack.token, state.token);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
