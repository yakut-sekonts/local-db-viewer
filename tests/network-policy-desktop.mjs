import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'ldv-network-policy-'));
const artifacts = resolve('test-artifacts'); await mkdir(artifacts, { recursive: true });
const report = { passed: false, platform: process.platform, checks: [] };
function record(...checks) { report.checks.push(...checks); console.log('PASS:', checks.join('; ')); }
const resources = process.env.LOCAL_DB_VIEWER_RESOURCES;
const java = resources ? join(resources, 'jre') : resolve('runtime', process.platform === 'win32' ? 'windows-x64' : 'mac-arm64');
const jars = resources ? join(resources, 'jdbc') : resolve('runtime/common');
const keytool = join(java, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
const store = join(directory, 'fixture.p12'), password = 'disposable-fixture';
await promisify(execFile)(keytool, ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=api.github.com', '-ext', 'SAN=DNS:api.github.com,DNS:release-assets.githubusercontent.com,DNS:vendor.test,DNS:repo.maven.apache.org', '-validity', '1', '-storetype', 'PKCS12', '-keystore', store, '-storepass', password, '-keypass', password, '-noprompt']);
const { stdout: certificate } = await promisify(execFile)(keytool, ['-exportcert', '-rfc', '-alias', 'fixture', '-keystore', store, '-storepass', password]);
const fingerprint = new X509Certificate(certificate).fingerprint256;
const bytes = Buffer.from('verified offline installer fixture');
const calls = [], tunnels = [], sockets = new Set(), held = new Set();
let slow = false, dbCalls = 0;
const release = { tag_name: 'v99.0.0', body: 'Network policy fixture', assets: ['mac-arm64.zip', 'windows-x64-setup.exe'].map((suffix, id) => ({ id: id + 1, name: `Local-DB-Viewer-99.0.0-${suffix}`, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })) };
const sha = createHash('sha256').update('fixture jar').digest('hex');
const catalog = { format: 1, drivers: { h2: { version: '99.0.0', key: 'a'.repeat(64), files: [{ path: 'fixture.jar', size: 11, sha256: sha }] } } };
const manifest = { format: 1, driverId: 'custom', driverClass: 'org.h2.Driver', revision: 1, version: '99.0.0', files: [{ url: 'https://vendor.test/fixture.jar', size: 11, sha256: sha }] };
function sendBody(response, body) {
  if (!slow) { response.end(body); return; }
  held.add(response); response.on('close', () => held.delete(response));
  response.write(body.subarray(0, 1)); // Headers and one byte arrive before policy cancellation.
}
const tls = httpsServer({ pfx: await readFile(store), passphrase: password }, (request, response) => {
  calls.push({ host: request.headers.host, path: request.url });
  response.setHeader('Content-Type', 'application/json');
  if (request.url.endsWith('/latest')) response.end(JSON.stringify(release));
  else if (request.url.includes('/assets/')) { response.writeHead(302, { location: 'https://release-assets.githubusercontent.com/fixture' }); response.end(); }
  else if (request.url.includes('/contents/catalog.json')) response.end(JSON.stringify(catalog));
  else if (request.url === '/feed.json') response.end(JSON.stringify(manifest));
  else sendBody(response, bytes);
});
const proxy = httpServer((_request, response) => { response.writeHead(400); response.end(); });
proxy.on('connect', (request, client, head) => {
  tunnels.push(request.url);
  if (!['api.github.com:443', 'release-assets.githubusercontent.com:443', 'vendor.test:443', 'repo.maven.apache.org:443'].includes(request.url)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const upstream = connect(tls.address().port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
});
const database = httpServer((request, response) => {
  dbCalls++; request.resume();
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ id: 'offline-db-fixture', infoUri: 'http://127.0.0.1', columns: [{ name: 'value', type: 'varchar' }], data: [['42']], stats: { state: 'FINISHED', elapsedTimeMillis: 1 } }));
});
for (const server of [tls, proxy, database]) {
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}
for (const name of ['updates', 'drivers']) await mkdir(join(directory, name));
await writeFile(join(directory, 'network-settings.json'), JSON.stringify({ format: 1, mode: 'database-only' }));
await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: true }));
await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: true, installed: {}, selected: {}, sources: { custom: { url: 'https://vendor.test/feed.json', driverClass: 'org.h2.Driver' } } }));
// No secrets or Keychain access: all test profiles live in a disposable directory.
await writeFile(join(directory, 'connections.json'), JSON.stringify([
  { id: 'native', name: 'Native network fixture', engine: 'trino', endpoint: `http://127.0.0.1:${database.address().port}`, user: 'fixture', auth: 'none', tls: false, catalog: '', schema: '' },
  { id: 'jdbc', name: 'Offline JDBC fixture', engine: 'sqlite', endpoint: join(directory, 'fixture.sqlite'), user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: {} },
]));
const launch = () => electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: [...(process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')]), `--proxy-server=http://127.0.0.1:${proxy.address().port}`], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory } });
let app, page;
async function start() {
  app = await launch(); page = await app.firstWindow();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.evaluate(() => window.studio.drivers.state());
  await app.evaluate(async ({ session }, { port, fingerprint }) => {
    const { X509Certificate } = process.getBuiltinModule('node:crypto');
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}` });
    session.defaultSession.setCertificateVerifyProc((request, callback) => callback(
      ['api.github.com', 'release-assets.githubusercontent.com', 'vendor.test', 'repo.maven.apache.org'].includes(request.hostname) && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -2));
  }, { port: proxy.address().port, fingerprint });
}
async function mode(value) {
  await page.getByRole('button', { name: 'Сетевые настройки', exact: true }).click();
  await page.getByLabel('Сетевой режим', { exact: true }).selectOption(value);
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сетевые настройки', exact: true })).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.studio.network.state())).mode, value);
}
async function query(profileId) {
  return page.evaluate(async profileId => {
    const requestId = crypto.randomUUID(), sessionId = `network-${profileId}`;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Database query timeout')); }, 30000);
        const off = window.studio.query.onUpdate(result => {
          if (result.requestId !== requestId || result.state === 'RUNNING') return;
          clearTimeout(timer); off(); result.state === 'FINISHED' ? resolve(result.rows) : reject(new Error(result.error));
        });
        window.studio.query.run({ requestId, sessionId, profileId, sql: 'SELECT 42 AS value', catalog: '', schema: '', maxRows: 1 }).catch(error => { clearTimeout(timer); off(); reject(error); });
      });
    } finally { await window.studio.query.release(sessionId); }
  }, profileId);
}
try {
  await start();
  assert.equal(tunnels.length, 0); assert.equal(calls.length, 0);
  record('persisted restriction applies before startup checks');
  const failures = await page.evaluate(async () => {
    const results = [];
    for (const action of [() => window.studio.updates.check(), () => window.studio.updates.download(), () => window.studio.drivers.check(), () => window.studio.drivers.install('h2'), () => window.studio.drivers.configureSource('custom', { url: 'https://vendor.test/feed.json', driverClass: 'org.h2.Driver' })]) {
      try { await action(); results.push('unexpected success'); } catch (error) { results.push(error.message); }
    }
    return results;
  });
  assert.ok(failures.every(error => error.includes('Только БД'))); assert.equal(tunnels.length, 0);
  record('IPC blocks updater/catalog/Maven/vendor operations without a request');
  await page.getByRole('button', { name: 'Обновления Local DB Viewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить обновления', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Настройки доступа к обновлениям', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть обновления', exact: true }).click();
  await page.getByRole('button', { name: 'JDBC-драйверы', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить версии драйверов', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить и проверить источник', exact: true })).toBeDisabled();
  const localJars = (await readdir(jars)).filter(name => /^(sqlite-jdbc|slf4j-api|slf4j-nop)-.*\.jar$/.test(name)).map(name => join(jars, name));
  assert.ok(localJars.length >= 1);
  await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, localJars);
  assert.equal(await page.evaluate(() => window.studio.drivers.import('sqlite', 'offline-local')), true);
  await page.getByRole('button', { name: 'Закрыть драйверы', exact: true }).click();
  assert.deepEqual(await query('jdbc'), [['42']]);
  assert.deepEqual(await query('native'), [['42']]); assert.ok(dbCalls > 0);
  assert.equal(tunnels.length, 0);
  record('offline UI and settings save', 'local JAR import and JDBC SQL', 'native database HTTP remains usable');
  await page.getByRole('button', { name: 'Сетевые настройки', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'network-policy.png') });
  await page.getByRole('button', { name: 'Закрыть сетевые настройки', exact: true }).click();
  await mode('online');
  const checked = await page.evaluate(() => window.studio.updates.check());
  assert.equal(checked.phase, 'available', checked.error);
  const drivers = await page.evaluate(() => window.studio.drivers.check());
  assert.equal(drivers.error, undefined); assert.equal(drivers.drivers.find(d => d.id === 'custom').sourceError, undefined);
  record('online checks use real HTTPS proxy and vendor feed');
  slow = true;
  const download = page.evaluate(() => window.studio.updates.download());
  await expect.poll(() => held.size).toBe(1);
  await mode('database-only');
  await expect.poll(async () => (await page.evaluate(() => window.studio.updates.state())).phase).toBe('error');
  const aborted = await download;
  assert.equal(aborted.phase, 'error'); assert.match(aborted.error, /Только БД/);
  await expect.poll(() => held.size).toBe(0);
  const offlineCalls = calls.length;
  await mode('online'); slow = false;
  assert.equal((await page.evaluate(() => window.studio.updates.download())).phase, 'ready');
  assert.ok(calls.length > offlineCalls);
  record('in-flight Chromium response aborted', 'fresh download succeeds after opt-in');
  await mode('database-only');
  await page.getByRole('button', { name: 'Обновления Local DB Viewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Перезапустить и обновить', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Закрыть обновления', exact: true }).click();
  record('verified installer stays available offline');
  const beforeRestart = calls.length, tunnelsBeforeRestart = tunnels.length;
  await app.close(); app = undefined; await start();
  assert.equal((await page.evaluate(() => window.studio.network.state())).mode, 'database-only');
  assert.equal((await page.evaluate(() => window.studio.updates.state())).settings.automatic, true);
  assert.equal((await page.evaluate(() => window.studio.drivers.state())).automatic, true);
  assert.equal(calls.length, beforeRestart); assert.equal(tunnels.length, tunnelsBeforeRestart);
  record('restart preserves policy and automatic preferences without egress');
  await app.close(); app = undefined;
  await writeFile(join(directory, 'network-settings.json'), '{broken'); await start();
  const damaged = await page.evaluate(() => window.studio.network.state());
  assert.equal(damaged.mode, 'database-only'); assert.match(damaged.error, /прочитать/);
  assert.equal(calls.length, beforeRestart); assert.equal(tunnels.length, tunnelsBeforeRestart);
  assert.equal(await readFile(join(directory, 'network-settings.json'), 'utf8'), '{broken');
  record('corrupt policy fails closed before startup');
  report.passed = true;
  console.log('PASS: offline policy startup, UI, IPC, real HTTPS cancellation, local JAR/JDBC/native DB, restart and corrupt settings');
} finally {
  await app?.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all([tls, proxy, database].map(server => new Promise(resolve => server.close(resolve))));
  await writeFile(join(artifacts, 'network-policy-results.json'), JSON.stringify(report, null, 2));
}
