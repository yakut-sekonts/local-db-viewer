import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { NetworkBlockedError, NetworkPolicy } from '../electron/network-policy';
import { Updater } from '../electron/updater';
import { DriverManager } from '../electron/driver-manager';
import { updateNetworkError } from '../electron/update-source';
import type { NetworkMode } from '../src/network';
import { createHash } from 'node:crypto';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ldv-network-'));
  const path = join(directory, 'network-settings.json'), policy = new NetworkPolicy(path);
  t.after(async () => { policy.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, policy };
}

test('network policy defaults online only for a missing file, persists and validates IPC input', async t => {
  const { path, policy } = await fixture(t);
  let calls = 0;
  const fetch = policy.guard(async () => { calls++; return new Response('ok'); });
  await assert.rejects(fetch('https://fixture.test', {}), NetworkBlockedError);
  await policy.initialize(); assert.equal(policy.allowed(), true);
  await fetch('https://fixture.test', {}); assert.equal(calls, 1);
  await policy.configure('database-only');
  await assert.rejects(fetch('https://fixture.test', {}), NetworkBlockedError);
  for (const mode of [null, true, {}, 'offline', 'ONLINE']) await assert.rejects(policy.configure(mode as NetworkMode), /Некорректный/);
  const restored = new NetworkPolicy(path); t.after(() => restored.dispose()); await restored.initialize();
  assert.equal(restored.allowed(), false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { format: 1, mode: 'database-only' });
  await restored.configure('online'); assert.equal(restored.allowed(), true);
});

test('invalid or unreadable settings fail closed without replacing the original file', async t => {
  const { path } = await fixture(t);
  for (const text of ['{', 'null', '{}', '{"format":2,"mode":"online"}', '{"format":1,"mode":true}', 'x'.repeat(4097)]) {
    await writeFile(path, text);
    const policy = new NetworkPolicy(path); await policy.initialize();
    assert.equal(policy.allowed(), false); assert.match(policy.state().error!, /прочитать/);
    assert.equal(await readFile(path, 'utf8'), text); policy.dispose();
  }
  await rm(path); await mkdir(path);
  const policy = new NetworkPolicy(path); await policy.initialize();
  assert.equal(policy.allowed(), false); policy.dispose();
});

test('write failure never enables downloads and serial changes preserve the final mode', async t => {
  const { path, policy } = await fixture(t); await policy.initialize();
  await mkdir(path); // Deterministic cross-platform rename failure, including administrator CI users.
  await assert.rejects(policy.configure('database-only'), /сохранить/);
  assert.equal(policy.allowed(), false);
  await assert.rejects(policy.configure('online'), /сохранить/);
  assert.equal(policy.allowed(), false);
  await rm(path, { recursive: true });
  await Promise.all([policy.configure('online'), policy.configure('database-only'), policy.configure('online')]);
  assert.equal(policy.allowed(), true); assert.equal(JSON.parse(await readFile(path, 'utf8')).mode, 'online');
});

test('enabling restriction aborts response bodies and prevents old retries after re-enabling', async t => {
  const { policy } = await fixture(t); await policy.initialize();
  let calls = 0, responseStarted!: () => void, continueRetry!: () => void;
  const started = new Promise<void>(resolve => { responseStarted = resolve; });
  const retry = new Promise<void>(resolve => { continueRetry = resolve; });
  const fetch = policy.guard(async (_url, options) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      options.signal!.addEventListener('abort', () => controller.error(options.signal!.reason), { once: true });
      responseStarted();
    } }));
  });
  const task = policy.run(async () => {
    await assert.rejects((await fetch('https://fixture.test/body', {})).text(), NetworkBlockedError);
    await retry;
    await assert.rejects(fetch('https://fixture.test/fallback', {}), NetworkBlockedError);
    await assert.rejects(policy.run(() => fetch('https://fixture.test/nested', {})), NetworkBlockedError);
  });
  await started; await policy.configure('database-only'); await policy.configure('online'); continueRetry(); await task;
  assert.equal(calls, 1);
  assert.equal(await policy.run(() => policy.guard(async () => new Response('new'))('https://fixture.test', {})).then(r => r.text()), 'new');
});

test('caller cancellation is preserved and policy errors remain actionable without leaking URLs', async t => {
  const { policy } = await fixture(t); await policy.initialize();
  const controller = new AbortController(), reason = new Error('caller cancelled'); controller.abort(reason);
  await assert.rejects(policy.guard(async () => { throw new Error('Unexpected transport'); })('https://secret.test', { signal: controller.signal }), reason);
  const error = updateNetworkError({ cause: new NetworkBlockedError(), message: 'https://private.test/?token=secret' }, 'private.test');
  assert.match(error.message, /Только БД/); assert.doesNotMatch(error.message, /secret|private|VPN|таймаут/i);
});

test('offline startup, periodic and manual actions cannot reach any external source; local JARs remain usable', async t => {
  const { directory, policy } = await fixture(t); await policy.initialize(); await policy.configure('database-only');
  t.mock.timers.enable({ apis: ['setInterval'] });
  let requests = 0, catalogs = 0, probes = 0;
  const fetch = policy.guard(async () => { requests++; return new Response('{}'); });
  const updater = new Updater(join(directory, 'updates'), '1.0.0', { encrypt: v => v, decrypt: v => v }, () => {}, async () => {}, fetch, policy);
  const bytes = Buffer.from('PK\x03\x04fixture'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const catalog = { format: 1, drivers: { h2: { key: 'a'.repeat(64), version: '2.0', files: [{ path: 'fixture.jar', sha256, size: bytes.length }] } } };
  const drivers = new DriverManager(join(directory, 'drivers'), {}, catalog, fetch, async () => { catalogs++; return catalog; }, async () => { probes++; }, () => {}, policy);
  t.after(() => { updater.dispose(); drivers.dispose(); });
  await updater.initialize('fixture/public'); await drivers.initialize();
  t.mock.timers.tick(2 * 60 * 60 * 1000); await turn();
  assert.equal(updater.state().phase, 'idle'); assert.equal(drivers.state().error, undefined);
  for (const action of [() => updater.check(), () => updater.download(), () => updater.readDriverCatalog(), () => drivers.check(), () => drivers.install('h2'), () => drivers.configureSource('h2', { url: 'https://vendor.test/feed.json', driverClass: 'org.h2.Driver' })]) await assert.rejects(action(), NetworkBlockedError);
  assert.equal(requests, 0); assert.equal(catalogs, 0);
  const path = join(directory, 'local.jar'); await writeFile(path, bytes);
  await drivers.import('h2', 'local', [path]);
  const key = drivers.state().drivers.find(driver => driver.id === 'h2')!.selected!;
  await drivers.select('h2', key); assert.equal((await drivers.paths('h2')).length, 1); assert.equal(probes, 1);
  await drivers.configureSource('h2', null);
  assert.equal(updater.state().settings.automatic, true); assert.equal(drivers.state().automatic, true);
  await policy.configure('online');
  t.mock.timers.tick(60 * 60 * 1000); await turn();
  assert.ok(requests > 0); assert.ok(catalogs > 0);
  // Let all asynchronous checks finish before fixture cleanup.
  const deadline = Date.now() + 5000;
  while (drivers.state().checking || updater.state().phase === 'checking') { assert.ok(Date.now() < deadline, 'Automatic checks did not finish'); await delay(10); }
});

test('interrupted JAR download removes partial files and never activates the driver', async t => {
  const { directory, policy } = await fixture(t); await policy.initialize();
  let started!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  const bytes = Buffer.from('PK\x03\x04fixture'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const catalog = { format: 1, drivers: { h2: { key: 'a'.repeat(64), version: '2.0', files: [{ path: 'fixture.jar', size: bytes.length, sha256 }] } } };
  const fetch = policy.guard(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 1));
    options.signal!.addEventListener('abort', () => controller.error(options.signal!.reason), { once: true });
    started();
  } })));
  const drivers = new DriverManager(join(directory, 'drivers'), {}, catalog, fetch, async () => catalog, async () => { assert.fail('Cancelled JAR must not reach probe'); }, () => {}, policy);
  t.after(() => drivers.dispose());
  const installation = assert.rejects(drivers.install('h2'), /Только БД/);
  await downloading; await policy.configure('database-only'); await installation;
  assert.equal(drivers.isBusy(), false); assert.equal(drivers.state().drivers.find(d => d.id === 'h2')!.installed.length, 0);
  assert.deepEqual(await readdir(join(directory, 'drivers/objects')), []);
});

test('previously verified installer can be installed offline, without network or weaker integrity checks', async t => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') { t.skip('Installer selection only supports distribution platforms'); return; }
  const { directory, policy } = await fixture(t); await policy.initialize();
  const bytes = 'offline installer', installed: string[] = [];
  const release = { tag_name: 'v1.1.0', assets: ['mac-arm64.zip', 'windows-x64-setup.exe'].map((suffix, id) => ({ id: id + 1, name: `Local-DB-Viewer-1.1.0-${suffix}`, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })) };
  const updater = new Updater(join(directory, 'updates'), '1.0.0', { encrypt: v => v, decrypt: v => v }, () => {}, async path => { installed.push(await readFile(path, 'utf8')); }, policy.guard(async url => url.endsWith('/latest') ? Response.json(release) : new Response(bytes)), policy);
  t.after(() => updater.dispose());
  await updater.configure({ repository: 'fixture/public', automatic: false });
  assert.equal((await updater.check()).phase, 'available'); assert.equal((await updater.download()).phase, 'ready');
  await policy.configure('database-only'); await updater.install(); assert.deepEqual(installed, [bytes]);
  const folder = (await readdir(join(directory, 'updates'), { withFileTypes: true })).find(entry => entry.isDirectory())!;
  const name = (await readdir(join(directory, 'updates', folder.name))).find(name => /\.(zip|exe)$/.test(name))!;
  await writeFile(join(directory, 'updates', folder.name, name), 'tampered');
  await assert.rejects(updater.install(), /изменился/); assert.equal(installed.length, 1);
});
