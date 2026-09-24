import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DriverManager } from '../electron/driver-manager';
import { driverFeedRelease, fetchDriverFeedFile, readDriverFeed, validateDriverFeed, validateDriverSource, type DriverFeedManifest } from '../electron/driver-feed';
import type { UpdateFetch } from '../electron/update-source';

const source = { url: 'https://vendor.test/driver.json', driverClass: 'com.vendor.jdbc.Driver' };
const bytes = Buffer.from('PK\x03\x04external driver fixture');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const manifest = (revision = 1): DriverFeedManifest => ({ format: 1, driverId: 'custom', driverClass: source.driverClass, revision, version: `vendor-build-${revision}`, files: [{ url: 'https://vendor.test/driver.jar', size: bytes.length, sha256: hash(bytes) }] });
const status = (manager: DriverManager) => manager.state().drivers.find(driver => driver.id === 'custom')!;

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'driver-feed-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
  let data: unknown = manifest(), fail = '', probeFails = false;
  let payload: Buffer = bytes;
  const calls: string[] = [], probes: (string | undefined)[] = [];
  const fetch: UpdateFetch = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'manual');
    if (fail) throw new Error(fail);
    if (url === source.url) return Response.json(data);
    assert.equal(url, manifest().files[0]!.url); return new Response(new Uint8Array(payload));
  };
  const makeManager = () => new DriverManager(directory, {}, { format: 1, drivers: {} }, fetch, async () => { throw new Error('Public catalog offline'); }, async (_id, _paths, driverClass) => { probes.push(driverClass); if (probeFails) throw new Error('Invalid driver class'); }, () => {});
  const manager = makeManager(); await manager.initialize();
  t.after(async () => { manager.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, calls, probes, makeManager, setData: (value: unknown) => { data = value; }, fail: (value: string) => { fail = value; }, failProbe: () => { probeFails = true; }, payload: (value: Buffer) => { payload = value; } };
}
test('driver feeds reject malformed metadata, duplicate files, credentials and unsafe URLs', () => {
  assert.deepEqual(validateDriverFeed(manifest(), 'custom', source.driverClass), manifest());
  for (const url of ['http://vendor.test/file', 'https://user:secret@vendor.test/file', 'https://vendor.test/file?token=secret', 'file:///secret', 'https://vendor.test/#secret', 'https://vendor.test/\\bad']) {
    assert.throws(() => validateDriverSource({ ...source, url }));
    assert.throws(() => validateDriverFeed({ ...manifest(), files: [{ ...manifest().files[0], url }] }, 'custom', source.driverClass));
  }
  for (const patch of [{ format: 2 }, { driverId: 'redis' }, { driverClass: 'wrong.Driver' }, { revision: 0 }, { revision: 1.5 }, { version: '\nsecret' }, { files: [] }, { files: [manifest().files[0], manifest().files[0]] }, { files: [{ ...manifest().files[0], size: 2 ** 31 }] }]) {
    assert.throws(() => validateDriverFeed({ ...manifest(), ...patch }, 'custom', source.driverClass));
  }
  assert.throws(() => validateDriverSource({ ...source, driverClass: 'bad class' }));
});
test('imported drivers receive feed updates; full bundle probing, rollback, pinning and sources survive restart', async t => {
  const f = await fixture(t), { manager } = f;
  const path = join(f.directory, 'import.jar'); await writeFile(path, bytes);
  await manager.import('custom', 'company local', [path]); const previous = status(manager).selected!;
  await manager.configureSource('custom', source);
  assert.equal(status(manager).available, true);
  await manager.install('custom'); const first = status(manager).selected!;
  assert.deepEqual(f.probes, [source.driverClass]); assert.equal(status(manager).available, false);
  f.setData(manifest(2)); await manager.check();
  assert.equal(manager.state().error, 'Public catalog offline'); assert.equal(status(manager).latest, 'vendor-build-2');
  assert.equal(status(manager).available, true); await manager.install('custom');
  assert.deepEqual(await readFile((await manager.paths('custom', first))[0]!), bytes);
  await manager.select('custom', previous); assert.equal(status(manager).available, true);
  const restored = f.makeManager(); await restored.initialize(); t.after(() => restored.dispose());
  assert.equal(status(restored).selected, previous); assert.deepEqual(status(restored).updateSource, source);
  assert.equal(status(restored).latest, 'vendor-build-2');
  await restored.select('custom', first);
  await assert.rejects(restored.paths('custom', undefined, 'other.Driver'), /не совпадает/);
  assert.ok(await restored.paths('custom', undefined, source.driverClass));
  await restored.configureSource('custom', null);
  assert.equal(status(restored).updateSource, undefined); assert.equal(status(restored).available, false);
  assert.equal(status(restored).selected, first, 'removing the source preserves the installed version');
});
test('a failed check preserves last valid feed; stale or reused revision never replaces it', async t => {
  const f = await fixture(t); await f.manager.configureSource('custom', source);
  f.setData(manifest(2)); await f.manager.check(); const expected = status(f.manager).latestKey;
  for (const invalid of [manifest(1), { ...manifest(2), version: 'changed' }, { ...manifest(3), driverClass: 'wrong.Driver' }, { format: 3 }]) {
    f.setData(invalid); await f.manager.check(); assert.equal(status(f.manager).latestKey, expected); assert.ok(status(f.manager).sourceError);
  }
  f.fail('ERR_CERT_AUTHORITY_INVALID https://vendor.test/?token=secret'); await f.manager.check();
  assert.match(status(f.manager).sourceError!, /TLS/); assert.doesNotMatch(status(f.manager).sourceError!, /secret/);
  f.fail(''); f.setData(manifest(3)); await f.manager.check(); assert.equal(status(f.manager).sourceError, undefined);
  assert.equal(status(f.manager).latestKey, driverFeedRelease(manifest(3)).key);
});
test('invalid source configuration and failed JAR verification cannot replace an installed version', async t => {
  for (const failure of ['hash', 'probe']) {
    const f = await fixture(t);
    await f.manager.configureSource('custom', source); await f.manager.install('custom'); const original = status(f.manager).selected;
    await assert.rejects(f.manager.configureSource('custom', { ...source, url: 'http://wrong.test' }));
    assert.equal(status(f.manager).updateSource?.url, source.url);
    const next = Buffer.from('PK\x03\x04new driver'); const data = manifest(2); data.files = [{ url: data.files[0]!.url, size: next.length, sha256: hash(next) }];
    f.setData(data); await f.manager.check(); f.payload(failure === 'hash' ? Buffer.alloc(next.length) : next);
    if (failure === 'probe') f.failProbe();
    await assert.rejects(f.manager.install('custom')); assert.equal(status(f.manager).selected, original); assert.equal(f.manager.isBusy(), false);
  }
});
test('feed redirects are bounded HTTPS GETs without credentials, cookies or GitHub tokens', async () => {
  const calls: string[] = [];
  await fetchDriverFeedFile(source.url, AbortSignal.timeout(1000), async (url, options) => {
    calls.push(url); assert.equal(options.headers, undefined); assert.equal(options.credentials, 'omit');
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.test/driver?signature=secret' } }) : new Response(bytes);
  });
  assert.deepEqual(calls, [source.url, 'https://cdn.test/driver?signature=secret']);
  for (const location of ['http://cdn.test/driver', 'https://user:secret@cdn.test/driver', 'file:///secret']) {
    let count = 0;
    await assert.rejects(fetchDriverFeedFile(source.url, AbortSignal.timeout(1000), async () => { count++; return new Response(null, { status: 302, headers: { location } }); }), /перенаправление/);
    assert.equal(count, 1);
  }
  let hops = 0;
  await assert.rejects(fetchDriverFeedFile(source.url, AbortSignal.timeout(1000), async () => { hops++; return new Response(null, { status: 302, headers: { location: source.url } }); }), /много/);
  assert.equal(hops, 6);
});
test('feed JSON reading enforces a streaming byte cap and rejects invalid or partial responses', async () => {
  let cancelled = false;
  await assert.rejects(readDriverFeed(source, 'custom', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 ** 2 + 1)); }, cancel() { cancelled = true; } }))), /1 MiB/);
  assert.equal(cancelled, true);
  await assert.rejects(readDriverFeed(source, 'custom', async () => new Response('<html>proxy login</html>')), /JSON/);
  await assert.rejects(readDriverFeed(source, 'custom', async () => new Response('{}', { status: 206 })), /HTTP 206/);
});
test('a corrupt saved feed cannot hide installed drivers or overwrite their persisted configuration', async t => {
  const f = await fixture(t); await f.manager.configureSource('custom', source); await f.manager.install('custom');
  const key = status(f.manager).selected;
  const path = join(f.directory, 'settings.json'), settings = JSON.parse(await readFile(path, 'utf8'));
  settings.sources.custom.manifest.revision = null;
  const corrupt = JSON.stringify(settings); await writeFile(path, corrupt);
  const restored = f.makeManager(); await restored.initialize(); t.after(() => restored.dispose());
  assert.equal(status(restored).selected, key); assert.equal(status(restored).updateSource, undefined); assert.match(status(restored).sourceError!, /повреждён/);
  assert.deepEqual(await readFile((await restored.paths('custom'))[0]!), bytes);
  assert.equal(await readFile(path, 'utf8'), corrupt);
});
test('manifest generator preserves dependency order, computes real hashes and does not overwrite files', async t => {
  const f = await fixture(t), first = join(f.directory, 'драйвер.jar'), second = join(f.directory, 'dependency.jar'), output = join(f.directory, 'driver.json');
  await writeFile(first, bytes); await writeFile(second, Buffer.concat([bytes, Buffer.from('dependency')]));
  const args = ['scripts/create-driver-feed.mjs', '--driver', 'custom', '--class', source.driverClass, '--version', 'vendor-build-1', '--revision', '1', '--base-url', 'https://vendor.test/jars/', '--output', output, first, second];
  await promisify(execFile)(process.execPath, args);
  const feed = validateDriverFeed(JSON.parse(await readFile(output, 'utf8')), 'custom', source.driverClass);
  assert.equal(feed.files[0]!.sha256, hash(bytes)); assert.equal(decodeURIComponent(feed.files[0]!.url), 'https://vendor.test/jars/драйвер.jar');
  assert.equal(feed.files[1]!.url, 'https://vendor.test/jars/dependency.jar');
  await assert.rejects(promisify(execFile)(process.execPath, args));
});
