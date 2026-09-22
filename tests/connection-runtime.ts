import assert from 'node:assert/strict';
import { Server } from 'ssh2';
import { generateKeyPairSync, createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSession } from '../electron/database';
import { sessionTemplate } from '../electron/session-template';
import { SessionPool } from '../electron/session-pool';
import { runtimePaths } from '../electron/runtime-paths';
import { sshFingerprint, openSshTunnel } from '../electron/ssh';
import { ProxyAgent, fetch } from 'undici';
import { inspectJdbc } from '../electron/jdbc-worker';
import { beforeConnect } from '../electron/before-connect';
import type { Connection } from '../electron/trino';

async function main() {
const execute = promisify(execFile), work = await mkdtemp(join(tmpdir(), 'connection-runtime-'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
let requests = 0, forwards = 0;
const clients = new Set<import('ssh2').Connection>();
const ssh = new Server({ hostKeys: [privateKey] }, client => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
  client.on('authentication', context => { if (context.method === 'password' && context.username === 'fixture' && context.password === 'ssh-password') context.accept(); else context.reject(); });
  client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
    if (info.destIP !== 'database.fixture.invalid') { reject(); return; }
    forwards++;
    const socket = connect(info.destPort, '127.0.0.1');
    socket.once('connect', () => { const stream = accept(); stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy()); socket.on('close', () => stream.destroy()); stream.pipe(socket).pipe(stream); });
    socket.on('error', () => reject());
  }));
});
let https: ReturnType<typeof createServer> | undefined;
const sessions: DatabaseSession[] = [];
try {
  const password = 'tls-fixture-password', store = join(work, 'client-server.p12');
  await execute(runtimePaths().java.replace(/java(?:\.exe)?$/, process.platform === 'win32' ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=database.fixture.invalid', '-ext', 'SAN=DNS:database.fixture.invalid', '-ext', 'BC=ca:true', '-validity', '1', '-storetype', 'PKCS12', '-keystore', store, '-storepass', password, '-keypass', password, '-noprompt']);
  const { stdout: ca } = await execute(runtimePaths().java.replace(/java(?:\.exe)?$/, process.platform === 'win32' ? 'keytool.exe' : 'keytool'), ['-exportcert', '-rfc', '-alias', 'fixture', '-keystore', store, '-storepass', password]);
  const caPath = join(work, 'ca.pem'); await writeFile(caPath, ca);
  https = createServer({ pfx: await readFile(store), passphrase: password, ca, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    assert.equal((request.socket as TLSSocket).authorized, true); requests++; request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'ssh-fixture', infoUri: 'https://database.fixture.invalid/query', columns: [{ name: 'value', type: 'bigint', typeSignature: { rawType: 'bigint', arguments: [] } }], data: [[7]], stats: { state: 'FINISHED', queued: false, scheduled: true, nodes: 1, totalSplits: 1, queuedSplits: 0, runningSplits: 0, completedSplits: 1, cpuTimeMillis: 0, wallTimeMillis: 1, queuedTimeMillis: 0, elapsedTimeMillis: 1, processedRows: 1, processedBytes: 8, physicalInputBytes: 8, peakMemoryBytes: 0, spilledBytes: 0 }, warnings: [] }));
  });
  await new Promise<void>(resolve => https!.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => ssh.listen(0, '127.0.0.1', resolve));
  const sshPort = (ssh.address() as { port: number }).port, dbPort = (https.address() as { port: number }).port;
  const fingerprint = await sshFingerprint('127.0.0.1', sshPort);
  assert.match(fingerprint, /^SHA256:/);
  const profile: Connection = { id: 'ssh', name: 'SSH JDBC fixture', engine: 'trino', endpoint: `https://database.fixture.invalid:${dbPort}`, user: 'fixture', auth: 'none', tls: true, catalog: '', schema: '', jdbc: { ssh: { enabled: true, host: '127.0.0.1', port: sshPort, user: 'fixture', authentication: 'password', password: 'ssh-password', fingerprint }, certificates: { trustSource: 'file', trustStoreType: 'PEM', trustStorePath: caPath, clientMode: 'store', clientStorePath: store, clientStoreType: 'PKCS12', clientStorePassword: password } } };
  const session = new DatabaseSession(profile); sessions.push(session);
  const result = await session.createQuery('ssh-query').run('SELECT 7');
  assert.equal(result.state, 'FINISHED', result.error); assert.deepEqual(result.rows, [['7']]); assert.ok(forwards > 0 && requests > 0);
  console.log('PASS: real Trino JDBC over SSH with remote DNS, FULL hostname verification and mutual TLS');
  const before = forwards;
  const bad = new DatabaseSession({ ...profile, jdbc: { ...profile.jdbc, ssh: { ...profile.jdbc!.ssh!, fingerprint: `SHA256:${createHash('sha256').update('wrong').digest('base64').replace(/=+$/, '')}` } } }); sessions.push(bad);
  assert.equal((await bad.createQuery('wrong-host-key').run('SELECT 7')).state, 'FAILED'); assert.equal(forwards, before);
  await inspectJdbc({ ...profile, jdbc: { ...profile.jdbc, ssh: { ...profile.jdbc!.ssh!, host: 'not-an-ssh-host.invalid' } } }, { kind: 'properties' });
  assert.equal(forwards, before);
  console.log('PASS: wrong SSH host key rejected; driver property inspection opens no SSH/network connection');
  const controller = new AbortController(), tunnel = await openSshTunnel(profile.jdbc!.ssh!, controller.signal, error => { throw error; });
  const proxy = new ProxyAgent({ uri: `http://127.0.0.1:${tunnel.port}`, requestTls: { pfx: await readFile(store), passphrase: password, ca } });
  try {
    const response = await fetch(profile.endpoint, { method: 'POST', body: 'SELECT 7', dispatcher: proxy });
    assert.deepEqual((await response.json() as { data: number[][] }).data, [[7]]);
  } finally { await proxy.close(); tunnel.close(); }
  console.log('PASS: SSH HTTP CONNECT proxy preserves TLS hostname and client authentication');
  const pool = new SessionPool(async connection => connection);
  const sqlite: Connection = { id: 'single', name: 'single', engine: 'sqlite', endpoint: ':memory:', user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { options: { singleSession: true, startupStatements: ['CREATE TABLE t(value INTEGER)', 'INSERT INTO t VALUES (0)'], keepAliveSeconds: 5, autoDisconnectSeconds: 5 } } };
  const [a, b] = await Promise.all([pool.acquire(sqlite, 'a'), pool.acquire(sqlite, 'b')]);
  try {
    assert.equal(a.session, b.session);
    await a.session.createQuery('insert').run('INSERT INTO t VALUES (9)');
    assert.deepEqual((await b.session.createQuery('shared-read').run('SELECT value FROM t ORDER BY value')).rows, [['0'], ['9']]);
    await a.release();
    assert.deepEqual((await b.session.createQuery('still-open').run('SELECT COUNT(*) FROM t')).rows, [['2']]);
    await b.session.createQuery('begin').run('BEGIN');
    assert.equal(b.session.inTransaction, true);
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert.deepEqual((await b.session.createQuery('transaction-kept').run('SELECT COUNT(*) FROM t')).rows, [['2']]);
    await b.session.createQuery('rollback').run('ROLLBACK');
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert.deepEqual((await b.session.createQuery('idle-reconnected').run('SELECT COUNT(*) FROM t')).rows, [['1']]);
  } finally { await b.release(); }
  console.log('PASS: single-session shared state, lease lifetime, protected transaction and idle reconnect');
  const templated: Connection = { ...sqlite, id: 'templates', endpoint: join(work, 'templates.sqlite'), jdbc: { options: { singleSession: true }, sessionTemplates: [
    { id: 'console', name: 'Console', options: { startupStatements: ['CREATE TEMP TABLE session_marker(value TEXT)', "INSERT INTO session_marker VALUES ('console')"] } },
    { id: 'metadata', name: 'Metadata', options: { startupStatements: ['CREATE TEMP TABLE session_marker(value TEXT)', "INSERT INTO session_marker VALUES ('metadata')"] } },
  ], defaultSessionTemplate: 'console', introspectionSessionTemplate: 'metadata' } };
  const consoleLease = await pool.acquire(sessionTemplate(templated,'console'),'template-console');
  const sameLease = await pool.acquire(sessionTemplate(templated,'console'),'template-console-2');
  const metadataLease = await pool.acquire(sessionTemplate(templated,'introspection'),'template-metadata');
  try {
    assert.equal(consoleLease.session,sameLease.session); assert.notEqual(consoleLease.session,metadataLease.session);
    const first=await consoleLease.session.createQuery('template-console-read').run('SELECT value FROM session_marker');
    const second=await metadataLease.session.createQuery('template-meta-read').run('SELECT value FROM session_marker');
    assert.equal(first.state,'FINISHED',first.error); assert.equal(second.state,'FINISHED',second.error);
    assert.deepEqual(first.rows,[['console']]); assert.deepEqual(second.rows,[['metadata']]);
  } finally { await sameLease.release(); await consoleLease.release(); await metadataLease.release(); }
  console.log('PASS: session templates apply startup SQL; console and introspection identities use separate physical sessions');
  const output = join(work, 'before.txt');
  await beforeConnect({ options: { beforeConnect: [{ id: 'a', name: 'fixture', executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], "ready")', output], timeoutSeconds: 10, enabled: true }] } }, new AbortController().signal);
  assert.equal(await readFile(output, 'utf8'), 'ready');
  await assert.rejects(beforeConnect({ options: { beforeConnect: [{ id: 'a', name: 'failure', executable: process.execPath, args: ['-e', 'process.exit(7)'], timeoutSeconds: 10, enabled: true }] } }, new AbortController().signal), /exit code 7/);
  console.log('PASS: Before connection arguments passed without shell; non-zero exit stops connection');
} finally {
  await Promise.allSettled(sessions.map(session => session.close()));
  for (const client of clients) client.end();
  await new Promise<void>(resolve => ssh.close(() => resolve()));
  await new Promise<void>(resolve => { if (https) https.close(() => resolve()); else resolve(); });
  await rm(work, { recursive: true, force: true });
}

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
