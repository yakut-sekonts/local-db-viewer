import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriverManager, validateDriverCatalog } from '../electron/driver-manager';
import { driverCatalog } from '../electron/update-source';
import { validateConnection } from '../electron/trino';
import { jdbcConfig } from '../electron/jdbc-config';
import { DRIVERS, DATABASE_PRODUCTS, type DriverCatalog } from '../src/drivers';
import { tableFormatError } from '../src/metadataErrors';

function first<T>(values: T[]): T { const value = values[0]; assert.ok(value !== undefined); return value; }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('PK\x03\x04verified driver fixture');
const release = (version: string) => ({ key: hash(version), version, files: [{ path: 'com/h2database/h2/2.5.250/h2-2.5.250.jar', size: bytes.length, sha256: hash(bytes) }] });
async function fixture(t: any, overrides: { fetch?: () => Promise<Response>; probe?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'driver-manager-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
  let catalog: DriverCatalog = { format: 1, drivers: { h2: release('2.5.250') } };
  let calls = 0;
  const manager = new DriverManager(directory, {}, catalog, async (url, init) => {
    calls++; assert.ok(url.startsWith('https://repo.maven.apache.org/maven2/')); assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined);
    return overrides.fetch ? overrides.fetch() : new Response(bytes);
  }, async () => catalog, overrides.probe ?? (async () => {}), () => {});
  await manager.initialize();
  t.after(async () => { manager.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, setCatalog: (value: DriverCatalog) => { catalog = value; }, calls: () => calls };
}
test('catalog resolves products uniquely, and rejects unsafe artifact paths and sizes', () => {
  assert.equal(new Set(DRIVERS.map(driver => driver.id)).size, DRIVERS.length);
  assert.equal(new Set(DATABASE_PRODUCTS.map(product => product.id)).size, DATABASE_PRODUCTS.length);
  for (const product of DATABASE_PRODUCTS) assert.ok(DRIVERS.some(driver => driver.id === product.driverId));
  for (const path of ['../x.jar', '/x.jar', 'https://evil.test/x.jar', 'com//x.jar', 'com/%2e%2e/x.jar', 'com/x.jar?token=x']) {
    const data = { format: 1, drivers: { h2: { ...release('1'), files: [{ ...release('1').files[0], path }] } } };
    assert.throws(() => validateDriverCatalog(data));
  }
  assert.throws(() => validateDriverCatalog({ format: 1, drivers: { h2: { ...release('1'), files: [{ ...release('1').files[0], size: 2 ** 31 }] } } }));
});
test('driver update activates only after verification; immutable old paths and rollback survive restart', async t => {
  const { manager, setCatalog, calls, directory } = await fixture(t);
  await manager.install('h2');
  const oldPaths = await manager.paths('h2'), oldKey = manager.state().drivers.find(item => item.id === 'h2')!.selected!;
  assert.deepEqual(await readFile(first(oldPaths)), bytes);
  setCatalog({ format: 1, drivers: { h2: release('2.6.0') } }); await manager.check();
  assert.equal(manager.state().drivers.find(item => item.id === 'h2')!.available, true);
  await manager.install('h2');
  assert.deepEqual(await manager.paths('h2', oldKey), oldPaths); assert.equal(calls(), 1, 'reuse content-addressed dependency');
  await manager.select('h2', oldKey);
  const restored = new DriverManager(directory, {}, { format: 1, drivers: {} }, async () => { throw new Error('offline'); }, async () => ({}), async () => {}, () => {});
  await restored.initialize(); t.after(() => restored.dispose());
  assert.deepEqual(await restored.paths('h2'), oldPaths);
});
test('SHA failure, oversized response, and probe failure never activate a driver', async t => {
  for (const overrides of [
    { fetch: async () => new Response(Buffer.alloc(bytes.length)) },
    { fetch: async () => new Response(Buffer.alloc(bytes.length + 1)) },
    { probe: async () => { throw new Error('Missing dependency'); } },
  ]) {
    const { manager } = await fixture(t, overrides);
    await assert.rejects(manager.install('h2')); await assert.rejects(manager.paths('h2'));
    assert.equal(manager.isBusy(), false);
  }
});
test('failed update preserves selected version; tampered installed JAR is refused', async t => {
  let fail = false;
  const { manager, setCatalog } = await fixture(t, { probe: async () => { if (fail) throw new Error('Incompatible Java'); } });
  await manager.install('h2'); const paths = await manager.paths('h2'), before = manager.state().drivers.find(item => item.id === 'h2')!.selected;
  fail = true; setCatalog({ format: 1, drivers: { h2: release('3.0.0') } }); await manager.check(); await assert.rejects(manager.install('h2'));
  assert.equal(manager.state().drivers.find(item => item.id === 'h2')!.selected, before);
  await writeFile(first(paths), Buffer.alloc(bytes.length)); await assert.rejects(manager.paths('h2'), /повреждён/);
});
test('manual JAR import copies files and does not replace them with public releases', async t => {
  const { manager, directory } = await fixture(t);
  const path = join(directory, 'local.jar'); await writeFile(path, bytes);
  await manager.import('h2', 'company build', [path]); await rm(path);
  assert.deepEqual(await readFile(first(await manager.paths('h2'))), bytes);
  assert.equal(manager.state().drivers.find(item => item.id === 'h2')!.available, false);
  const invalid = join(directory, 'invalid.jar'); await writeFile(invalid, 'not a jar'); await assert.rejects(manager.import('h2', 'bad', [invalid]), /архив/);
});
test('corrupt driver settings cannot break update checks or overwrite the stored file', async t => {
  const { directory } = await fixture(t);
  const original = JSON.stringify({ automatic: false, installed: { h2: [{ ...release('2.5.250'), version: null, source: 'download' }] }, selected: { h2: release('2.5.250').key } });
  await writeFile(join(directory, 'settings.json'), original);
  const restored = new DriverManager(directory, {}, { format: 1, drivers: {} }, async () => { throw new Error('offline'); }, async () => { throw new Error('offline'); }, async () => {}, () => {});
  t.after(() => restored.dispose()); await restored.initialize(); await restored.check();
  assert.doesNotThrow(() => restored.state());
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), original);
  assert.equal(restored.state().drivers.find(item => item.id === 'h2')?.installed.length, 0);
});
test('catalog download supports public GitHub and never sends credentials outside GitHub API', async () => {
  const calls: any[] = [];
  const result = await driverCatalog('fixture/public', 'expired', async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response('', { status: 401 });
    return Response.json({ format: 1, drivers: {} });
  });
  assert.deepEqual(result, { format: 1, drivers: {} });
  assert.equal(calls[0].url, 'https://api.github.com/repos/fixture/public/contents/catalog.json?ref=driver-catalog');
  assert.equal(calls[1].init.headers.Authorization, undefined);
});
test('generic JDBC preserves literal settings and rejects credential URLs', () => {
  const draft = { id: 'fixture', engine: 'jdbc' as const, name: 'H2', endpoint: 'jdbc:h2:mem:fixture', user: 'sa', auth: 'basic' as const, secret: 'secret', tls: false, catalog: '', schema: '', jdbc: { driverId: 'h2', properties: { MODE: 'PostgreSQL' } } };
  const config = jdbcConfig(validateConnection(draft));
  assert.equal(config.driverClass, 'org.h2.Driver'); assert.equal(config.url, draft.endpoint); assert.equal(config.properties.password, 'secret'); assert.equal(config.properties.MODE, 'PostgreSQL');
  for (const endpoint of ['jdbc:postgresql://user:pass@localhost/test', 'jdbc:oracle:thin:user/pass@localhost:1521:xe', 'jdbc:h2:mem:fixture;PASSWORD=secret', 'jdbc:h2:mem:fixture?access%54oken=secret']) assert.throws(() => validateConnection({ ...draft, endpoint }));
});
test('Iceberg mismatch is explained without rewriting names or catalog', () => {
  assert.match(tableFormatError("Query failed (#id): Cannot query Iceberg table 'ods.shk_on_place'")!, /connector/);
  assert.equal(tableFormatError('Access Denied: Cannot select'), undefined);
});
