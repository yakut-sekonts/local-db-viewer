import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const resources = process.env.LOCAL_DB_VIEWER_RESOURCES;
if (resources) process.resourcesPath = resolve(resources);
const common = resources ? join(resolve(resources), 'jdbc') : resolve('runtime/common');
const compiler = process.env.JAVA_HOME || resolve('runtime/compiler');
const binary = name => join(compiler, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const directory = resolve('dist-tests/timeout-fixture');
await mkdir(directory, { recursive: true });
execFileSync(binary('javac'), ['--release', '21', '-encoding', 'UTF-8', '-cp', join(common, '*'), '-d', directory, 'tests/jdbc/ConnectionTimeoutDriver.java'], { stdio: 'inherit' });
const fixture = join(directory, 'fixture.jar');
execFileSync(binary('jar'), ['--create', '--file', fixture, '-C', directory, 'fixture'], { stdio: 'inherit' });
await build({ entryPoints: { 'timeout-database': 'electron/database.ts', 'timeout-worker': 'electron/jdbc-worker.ts' }, outdir: 'dist-tests', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const require = createRequire(import.meta.url);
const { DatabaseSession } = require('../dist-tests/timeout-database.cjs');
const { inspectJdbc } = require('../dist-tests/timeout-worker.cjs');
const sqliteJars = (await readdir(common)).filter(name => /^(sqlite-jdbc|slf4j)-/.test(name)).map(name => join(common, name));
const base = { id: 'timeout', name: 'Timeout fixture', engine: 'jdbc', endpoint: 'jdbc:timeout:test', user: '', auth: 'none', tls: false, catalog: '', schema: '' };
const profile = (seconds, delayMs = 0) => ({ ...base, jdbc: { driverClass: 'fixture.ConnectionTimeoutDriver', classpath: [fixture, ...sqliteJars], properties: { delayMs: String(delayMs) }, options: { connectTimeoutSeconds: seconds } } });
const checks = [];
const sockets = new Set(); let accepted = 0;
const server = createServer(socket => { accepted++; sockets.add(socket); socket.on('error', () => {}); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const query = session => session.createQuery(crypto.randomUUID(), 10);
const guard = setTimeout(() => { console.error('Timeout integration suite exceeded 150 seconds'); process.exit(1); }, 150000);
try {
  const slow = profile(1, 60000), session = new DatabaseSession(slow);
  try {
    const started = Date.now();
    const result = await query(session).run('SELECT 1');
    assert.equal(result.state, 'FAILED'); assert.match(result.error, /лимит подключения JDBC/);
    assert.ok(Date.now() - started < 8000);
    // A failed attempt must not poison the session queue or leave an orphan JVM.
    slow.jdbc.properties.delayMs = '0';
    const recovered = await query(session).run('SELECT 42');
    assert.equal(recovered.state, 'FINISHED', recovered.error);
    const longQuery = await query(session).run('SELECT fixture_sleep(1600)');
    assert.equal(longQuery.state, 'FINISHED', longQuery.error);
    await delay(1100);
    assert.equal((await query(session).run('SELECT 43')).state, 'FINISHED');
  } finally { await session.abort(); }
  checks.push('deadline stops an uncooperative driver; same session retries; connected SQL and idle connection survive');
  console.log('PASS:', checks.at(-1));

  const lateProfile = profile(1, 1100);
  lateProfile.jdbc.properties.shutdownDelayMs = '1800';
  const late = new DatabaseSession(lateProfile);
  try {
    assert.equal((await query(late).run('SELECT 99')).state, 'FAILED');
    lateProfile.jdbc.properties.delayMs = '0'; lateProfile.jdbc.properties.shutdownDelayMs = '0';
    const fresh = await query(late).run('SELECT fixture_sleep(1600), 42');
    assert.equal(fresh.state, 'FINISHED', fresh.error); assert.deepEqual(fresh.rows, [['1', '42']]);
  } finally { await late.abort(); }
  checks.push('late messages from a terminating JVM cannot complete a new session query');

  // The metadata/request budget is distinct from the opening budget.
  const inspected = await inspectJdbc(profile(5, 2200), { kind: 'test' }, 1500);
  assert.match(inspected, /SQLite/);
  const metadata = new DatabaseSession(profile(5, 2200));
  try { assert.match(await metadata.inspect({ kind: 'test' }, 1500), /SQLite/); }
  finally { await metadata.abort(); }
  checks.push('test and pooled inspection pause operation deadlines while connecting');
  console.log('PASS:', checks.at(-1));

  const zero = new DatabaseSession(profile(0, 31000));
  try { assert.equal((await query(zero).run('SELECT 1')).state, 'FINISHED'); }
  finally { await zero.abort(); }
  checks.push('zero waits beyond 30 seconds without a hidden default deadline');
  console.log('PASS:', checks.at(-1));

  const canceled = new DatabaseSession(profile(0, 60000));
  try {
    const task = query(canceled), running = task.run('SELECT 1');
    for (let attempt = 0; attempt < 250 && !canceled.worker?.isConnecting; attempt++) await delay(20);
    assert.equal(canceled.worker?.isConnecting, true); await task.cancel();
    assert.equal((await running).state, 'CANCELED');
  } finally { await canceled.abort(); }
  checks.push('opening with zero timeout can be canceled');

  for (const [engine, endpoint, properties] of [
    ['postgres', `postgresql://127.0.0.1:${port}/test`, { loginTimeout: '120', connectTimeout: '120' }],
    ['mysql', `mysql://127.0.0.1:${port}/test`, { connectTimeout: '120000' }],
    ['mariadb', `mariadb://127.0.0.1:${port}/test`, { connectTimeout: '120000' }],
    ['mssql', `sqlserver://127.0.0.1:${port}/test`, { loginTimeout: '120' }],
    ['clickhouse', `http://127.0.0.1:${port}/test`, { connection_timeout: '120000' }],
    ['trino', `http://127.0.0.1:${port}`, {}],
  ]) {
    const before = accepted, started = Date.now();
    const connection = { ...base, engine, endpoint, user: 'fixture', jdbc: { properties, options: { connectTimeoutSeconds: 4 } } };
    // This is the same path as the UI Test Connection, using each real driver.
    await assert.rejects(inspectJdbc(connection, { kind: 'test' }), /лимит подключения JDBC/);
    assert.ok(accepted > before, `${engine} never reached the listening TCP server`);
    assert.ok(Date.now() - started < 12000, `${engine} left a live attempt`);
    for (const socket of sockets) socket.destroy();
    checks.push(`${engine}: accepted TCP connection without handshake response is bounded`);
    console.log('PASS:', checks.at(-1));
  }

  // Property inspection should never attempt to open a network connection.
  const before = accepted;
  const sqlserverInfo = await inspectJdbc({ ...base, endpoint: `jdbc:sqlserver://127.0.0.1:${port};databaseName={name;loginTimeout=999};LOGINtimeout={11}`, jdbc: { driverId: 'mssql', driverClass: 'com.microsoft.sqlserver.jdbc.SQLServerDriver', properties: { LOGINTIMEOUT: '60' } } }, { kind: 'properties' });
  assert.equal(sqlserverInfo.find(item => item.name === 'loginTimeout')?.value, '11');
  checks.push('real SQL Server driver receives the URL loginTimeout, not a generated or Advanced default');
  const properties = await inspectJdbc({ ...base, engine: 'trino', endpoint: `http://127.0.0.1:${port}`, user: 'fixture', jdbc: { options: { connectTimeoutSeconds: 1 } } }, { kind: 'properties' });
  assert.ok(properties.length > 0); assert.equal(accepted, before);
  checks.push('Advanced property discovery stays offline');
  await mkdir('test-artifacts', { recursive: true });
  await writeFile('test-artifacts/connection-timeout-results.json', JSON.stringify({ passed: true, platform: process.platform, checks }, null, 2));
} finally {
  clearTimeout(guard);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
