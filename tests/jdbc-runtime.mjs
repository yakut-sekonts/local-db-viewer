import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const execute = promisify(execFile);
const resources = process.env.LOCAL_DB_VIEWER_RESOURCES;
const platform = process.platform === 'win32' ? 'windows-x64' : 'mac-arm64';
const javaHome = resources ? join(resources, 'jre') : resolve('runtime', platform);
const common = resources ? join(resources, 'jdbc') : resolve('runtime/common');
const binary = name => join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const work = await mkdtemp(join(tmpdir(), 'local-db-viewer-tls-'));
const password = 'local-fixture-password';
let server;

async function bridge(config, request, expectedKind) {
  const child = spawn(binary('java'), ['-Xmx256m', '--enable-native-access=ALL-UNNAMED', '-cp', [join(common, '*')].join(delimiter), 'LocalDBViewerBridge'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('JDBC fixture timed out')), 30000);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      child.once('error', finish(reject));
      child.once('exit', finish(code => reject(new Error(`JDBC bridge exited early (${code})`))));
      lines.on('line', line => {
        try { const result = JSON.parse(line); if (result.kind === expectedKind) finish(resolve)(result); }
        catch (error) { finish(reject)(error); }
      });
      child.stdin.write(JSON.stringify(config) + '\n' + JSON.stringify(request) + '\n');
    });
  } finally {
    child.stdin.end(JSON.stringify({ kind: 'close' }) + '\n');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
  }
}

try {
  const drivers = {
    trino: ['io.trino.jdbc.TrinoDriver', 'jdbc:trino://localhost:8080'],
    postgres: ['org.postgresql.Driver', 'jdbc:postgresql://localhost/postgres'],
    mysql: ['com.mysql.cj.jdbc.Driver', 'jdbc:mysql://localhost/mysql'],
    mariadb: ['org.mariadb.jdbc.Driver', 'jdbc:mariadb://localhost/mysql'],
    sqlite: ['org.sqlite.JDBC', 'jdbc:sqlite::memory:'],
    mssql: ['com.microsoft.sqlserver.jdbc.SQLServerDriver', 'jdbc:sqlserver://localhost'],
    clickhouse: ['com.clickhouse.jdbc.ClickHouseDriver', 'jdbc:clickhouse:http://localhost:8123/default'],
  };
  const driverCounts = {};
  for (const [engine, [driverClass, url]] of Object.entries(drivers)) {
    const response = await bridge({ engine, driverClass, url, properties: {} }, { kind: 'properties' }, 'properties');
    assert.equal(response.error, undefined); assert.ok(response.properties.length > 0);
    driverCounts[engine] = response.properties.length;
  }
  console.log('PASS: all seven embedded JDBC drivers expose their actual Advanced properties');

  const store = join(work, 'server.p12');
  await execute(binary('keytool'), ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=localhost', '-ext', 'SAN=DNS:localhost', '-ext', 'BC=ca:true', '-validity', '1', '-storetype', 'PKCS12', '-keystore', store, '-storepass', password, '-keypass', password, '-noprompt']);
  const { stdout: certificate } = await execute(binary('keytool'), ['-exportcert', '-rfc', '-alias', 'fixture', '-keystore', store, '-storepass', password]);
  let authenticated = 0;
  server = createServer({ pfx: await readFile(store), passphrase: password }, async (request, response) => {
    for await (const _chunk of request) { /* Consume the SQL body. */ }
    if (request.headers.authorization === `Basic ${Buffer.from(`fixture:${password}`).toString('base64')}`) authenticated++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'tls-fixture', infoUri: `https://localhost:${server.address().port}/query`, columns: [{ name: 'connected', type: 'bigint', typeSignature: { rawType: 'bigint', arguments: [] } }], data: [[1]], stats: { state: 'FINISHED', queued: false, scheduled: true, nodes: 1, totalSplits: 1, queuedSplits: 0, runningSplits: 0, completedSplits: 1, cpuTimeMillis: 0, wallTimeMillis: 0, queuedTimeMillis: 0, elapsedTimeMillis: 1, processedRows: 1, processedBytes: 8, physicalInputBytes: 8, peakMemoryBytes: 0, spilledBytes: 0 }, warnings: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const query = { kind: 'run', requestId: 'tls', sql: 'SELECT 1', catalog: '', schema: '', maxRows: 10 };
  const config = (host, verification, ca) => ({ engine: 'trino', driverClass: drivers.trino[0], url: `jdbc:trino://${host}:${port}`, properties: { user: 'fixture', password, SSL: 'true', SSLVerification: verification }, sslCa: ca, options: {} });
  const valid = await bridge(config('localhost', 'FULL', certificate), query, 'done');
  assert.equal(valid.snapshot.state, 'FINISHED', valid.snapshot.error);
  assert.deepEqual(valid.snapshot.rows, [['1']]);
  const wrongName = await bridge(config('127.0.0.1', 'FULL', certificate), query, 'done');
  assert.equal(wrongName.snapshot.state, 'FAILED');
  const caOnly = await bridge(config('127.0.0.1', 'CA', certificate), query, 'done');
  assert.equal(caOnly.snapshot.state, 'FINISHED', caOnly.snapshot.error);
  const untrusted = await bridge(config('localhost', 'FULL', ''), query, 'done');
  assert.equal(untrusted.snapshot.state, 'FAILED');
  const unchecked = await bridge(config('localhost', 'NONE', ''), query, 'done');
  assert.equal(unchecked.snapshot.state, 'FINISHED', unchecked.snapshot.error);
  assert.ok(authenticated >= 3);
  assert.ok(!JSON.stringify([wrongName, untrusted]).includes(password));
  console.log('PASS: real Trino JDBC uses TLS/authentication and distinguishes FULL, CA and NONE verification');
  await mkdir('test-artifacts', { recursive: true });
  await writeFile('test-artifacts/jdbc-runtime-results.json', JSON.stringify({ passed: true, driverCounts, trinoTLS: { FULL: true, CA: true, NONE: true, rejectedWrongHostname: true, rejectedUntrustedCertificate: true }, testedAt: new Date().toISOString() }, null, 2));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(work, { recursive: true, force: true });
}
