import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection, type Connection as MysqlConnection, type RowDataPacket } from 'mysql2/promise';
import { DatabaseSession } from '../electron/database';
import type { Connection } from '../electron/trino';
import type { MetadataResult, QuerySnapshot, SchemaIndex } from '../src/shared';
import { completeSQL } from '../src/completion';

// Fixed loopback destination, disposable schema and fixture-only credentials.
// Never accept an arbitrary host/password or run this against a user's database.
if (process.env.CI !== 'true' || process.env.LDV_MYSQL_SERVER_TEST !== '1') throw new Error('Run only against disposable CI MySQL/MariaDB services.');
const engine = process.env.LDV_MYSQL_ENGINE;
assert.ok(engine === 'mysql' || engine === 'mariadb');
const port = Number(process.env.LDV_MYSQL_PORT);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const javaHome = process.env.JAVA_HOME;
assert.ok(javaHome, 'JAVA_HOME is required');
const artifacts = resolve('test-artifacts');
await mkdir(artifacts, { recursive: true });
const resources = await mkdtemp(join(artifacts, 'mysql-runtime-'));
await symlink(resolve('runtime/common'), join(resources, 'jdbc'), 'dir');
await symlink(javaHome, join(resources, 'jre'), 'dir');
Object.defineProperty(process, 'resourcesPath', { value: resources });
const database = 'ldv_fixture', user = 'ldv_fixture', password = 'fixture-jdbc-only';
const checks: string[] = [];
const report: Record<string, unknown> = { passed: false, engine, server: process.env.LDV_MYSQL_SERVER, image: process.env.LDV_MYSQL_IMAGE, platform: process.platform, stdoutEncoding: 'windows-1252', checks };
const sessions = new Set<DatabaseSession>();
let observer: MysqlConnection | undefined;
const guard = setTimeout(() => { console.error('Live JDBC integration exceeded four minutes'); process.exit(1); }, 240000);
const q = (name: string) => '`' + name.replaceAll('`', '``') + '`';
const profile = (jdbc: Connection['jdbc'] = {}, secret = password): Connection => ({
  id: crypto.randomUUID(), name: 'Disposable JDBC fixture', engine, endpoint: `${engine}://127.0.0.1:${port}/${database}`,
  catalog: database, schema: '', user, auth: 'basic', secret, tls: false,
  jdbc: { ...jdbc, vmOptions: ['-Dstdout.encoding=windows-1252', ...(jdbc?.vmOptions ?? [])],
    // Public key retrieval is allowed only for this isolated, non-TLS CI service.
    properties: { allowPublicKeyRetrieval: 'true', socketTimeout: '10000', ...jdbc?.properties },
    options: { connectTimeoutSeconds: 5, ...jdbc?.options } },
});
function session(jdbc?: Connection['jdbc'], secret?: string) {
  const value = new DatabaseSession(profile(jdbc, secret)); sessions.add(value); return value;
}
async function run(value: DatabaseSession, sql: string, maximum = 100): Promise<QuerySnapshot> {
  const result = await value.createQuery(crypto.randomUUID(), maximum, undefined, database, '').run(sql);
  assert.equal(result.state, 'FINISHED', `${sql.slice(0, 100)}: ${result.error}`);
  return result;
}
async function query(sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  assert.ok(observer); const [rows] = await observer.query<RowDataPacket[]>(sql, values); return rows;
}
function passed(message: string) { checks.push(message); console.log('PASS:', message); }
async function waitForQuery(connectionId: string, marker: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await query('SELECT INFO FROM information_schema.PROCESSLIST WHERE ID = ?', [connectionId]);
    if (String(rows[0]?.INFO ?? '').includes(marker)) return;
    await delay(50);
  }
  throw new Error(`Database never observed ${marker}`);
}

try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { observer = await createConnection({ host: '127.0.0.1', port, user, password, database, charset: 'utf8mb4', connectTimeout: 2000 }); break; }
    catch (error) { if (attempt === 39) throw error; await delay(1000); }
  }
  assert.ok(observer);
  report.serverVersion = (await query('SELECT VERSION() AS version'))[0]?.version;
  if (engine === 'mariadb') assert.match(String(report.serverVersion), /MariaDB/i);
  else assert.doesNotMatch(String(report.serverVersion), /MariaDB/i);
  const main = session();
  report.driver = await main.inspect<string>({ kind: 'test' });
  passed('real JDBC authentication and server/driver identification');

  const wrong = session({}, 'deliberately-wrong-fixture-password');
  const denied = await wrong.createQuery('denied').run('SELECT 1');
  assert.equal(denied.state, 'FAILED');
  assert.ok(!JSON.stringify(denied).includes('deliberately-wrong-fixture-password'));
  await wrong.abort();
  passed('authentication failure is reported without leaking the password');

  const table = 'данные_%名', decoy = 'данные_X名';
  await run(main, `CREATE TABLE ${q(table)} (id BIGINT, amount DECIMAL(38,12), label VARCHAR(100), body LONGTEXT, payload LONGBLOB, dt DATETIME(6)) CHARACTER SET utf8mb4`);
  await run(main, `CREATE TABLE ${q(decoy)} (must_not_appear INT)`);
  const label = 'Кириллица 名 😀', text = 'Строка с "кавычками"\nи табуляцией\t😀';
  // Seed through an independent client; assert decoding through the actual JDBC bridge.
  await observer.execute(`INSERT INTO ${q(table)} VALUES (?, ?, ?, ?, ?, ?)`, ['9223372036854775807', '12345678901234567890.123456789012', label, text, Buffer.from([0, 127, 128, 255]), '2026-10-06 12:34:56.123456']);
  await observer.execute(`INSERT INTO ${q(table)} VALUES (NULL, NULL, NULL, NULL, NULL, NULL), (0, 0, '', '', X'', NULL)`);
  const values = await run(main, `SELECT * FROM ${q(table)} ORDER BY id IS NULL, id DESC`);
  assert.deepEqual(values.rows, [
    ['9223372036854775807', '12345678901234567890.123456789012', label, text, '007f80ff', '2026-10-06 12:34:56.123456'],
    ['0', '0.000000000000', '', '', '', null], Array(6).fill(null),
  ]);
  assert.deepEqual((await run(main, 'SELECT 1 AS duplicate, 2 AS duplicate')).rows, [['1', '2']]);
  assert.deepEqual((await run(main, `SELECT id FROM ${q(table)} WHERE 1=0`)).rows, []);
  passed('Unicode values/identifiers, LONGTEXT, binary, exact BIGINT/DECIMAL, DATETIME(6), NULL/empty/duplicate columns');

  const catalogs = await main.inspect<MetadataResult>({ kind: 'metadata', operation: 'catalogs' });
  assert.ok(catalogs.rows.some(row => row[0] === database));
  const tables = await main.inspect<MetadataResult>({ kind: 'metadata', operation: 'tables', catalog: database, schema: '' });
  assert.ok(tables.rows.some(row => row[0] === table));
  const columns = await main.inspect<MetadataResult>({ kind: 'metadata', operation: 'columns', catalog: database, schema: '', table });
  assert.deepEqual(columns.rows.map(row => row[0]), ['id', 'amount', 'label', 'body', 'payload', 'dt']);
  const preview = await main.inspect<string>({ kind: 'preview', catalog: database, schema: '', table });
  assert.equal((await run(main, preview)).totalRows, 3);
  passed('catalog/table/column metadata and preview quote Unicode and literal wildcard identifiers');

  await run(main, 'CREATE TABLE customers (tenant INT, id INT, name VARCHAR(50), PRIMARY KEY(tenant,id))');
  await run(main, 'CREATE TABLE orders (id INT PRIMARY KEY, tenant INT, customer_id INT, CONSTRAINT orders_customer FOREIGN KEY(tenant,customer_id) REFERENCES customers(tenant,id))');
  await run(main, "INSERT INTO customers VALUES (1,10,'first'),(2,10,'second')");
  await run(main, 'INSERT INTO orders VALUES (1,1,10),(2,2,10)');
  const index = await main.inspect<SchemaIndex>({ kind: 'schema', profileId: 'fixture', catalog: database, schema: '' });
  assert.deepEqual(index.warnings, []);
  const relation = index.relationships.find(item => item.name === 'orders_customer'); assert.ok(relation);
  assert.deepEqual(relation.columns, [{ source: 'tenant', target: 'tenant' }, { source: 'customer_id', target: 'id' }]);
  const textSQL = 'SELECT * FROM orders o JOIN ';
  const suggestion = completeSQL(textSQL, textSQL.length, index, engine).find(item => item.kind === 'join' && item.insertText.includes('customers'));
  assert.ok(suggestion, 'Expected JOIN derived from the real composite foreign key');
  assert.equal((await run(main, textSQL.slice(0, suggestion.start) + suggestion.insertText + textSQL.slice(suggestion.end))).totalRows, 2);
  const columnSQL = 'SELECT o. FROM orders o';
  assert.deepEqual(completeSQL(columnSQL, columnSQL.indexOf('o.') + 2, index, engine).map(item => item.label), ['id', 'tenant', 'customer_id']);
  passed('real composite foreign key drives executable JOIN and alias.column completions');

  await run(main, 'CREATE TABLE transactions_fixture (id INT PRIMARY KEY) ENGINE=InnoDB');
  assert.equal((await run(main, 'BEGIN')).inTransaction, true);
  await run(main, 'INSERT INTO transactions_fixture VALUES (1)');
  await run(main, 'SAVEPOINT retained');
  await run(main, 'INSERT INTO transactions_fixture VALUES (2)');
  assert.equal((await run(main, 'ROLLBACK TO retained')).inTransaction, true);
  assert.equal((await run(main, 'COMMIT')).inTransaction, false);
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  await run(main, 'BEGIN'); await run(main, 'INSERT INTO transactions_fixture VALUES (3)');
  await main.close();
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  const manual = session({ options: { autoCommit: false } });
  assert.equal((await run(manual, 'INSERT INTO transactions_fixture VALUES (4)')).inTransaction, true);
  assert.equal((await run(manual, 'ROLLBACK')).inTransaction, false);
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  await manual.close();
  passed('BEGIN/COMMIT, savepoint rollback, manual autocommit and rollback on session close');

  const events: QuerySnapshot[] = [];
  const failedScript = await main.createScript('failed-script', 100, value => events.push(value), database, '').run("BEGIN; INSERT INTO transactions_fixture VALUES (5); SELECT * FROM missing_fixture; INSERT INTO transactions_fixture VALUES (6); COMMIT;");
  assert.equal(failedScript.script?.state, 'FAILED'); assert.equal(failedScript.script.completed, 2);
  assert.equal(failedScript.inTransaction, true);
  await run(main, 'ROLLBACK');
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  passed('script stops on SQL error and leaves an explicit rollback available');

  const timed = session({ options: { queryTimeoutSeconds: 1, autoCommit: false } });
  await run(timed, 'INSERT INTO transactions_fixture VALUES (9)');
  const timeoutStarted = Date.now();
  const timedResult = await timed.createQuery('query-timeout').run('SELECT SLEEP(20)');
  assert.equal(timedResult.state, 'FAILED'); assert.ok(Date.now() - timeoutStarted < 10000);
  if (engine === 'mysql') {
    assert.equal(timedResult.inTransaction, false);
    assert.ok(timedResult.warnings.some(message => message.includes('соединение закрыто')));
    assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  } else await run(timed, 'ROLLBACK');
  assert.deepEqual((await run(timed, 'SELECT 42')).rows, [['42']]);
  await timed.close();
  let connectionId = String((await run(main, 'SELECT CONNECTION_ID()')).rows[0]?.[0]);
  assert.match(connectionId, /^\d+$/);
  await run(main, 'BEGIN'); await run(main, 'INSERT INTO transactions_fixture VALUES (8)');
  const cancellation = main.createQuery('cancel');
  const running = cancellation.run('SELECT /* LDV_CANCEL */ SLEEP(30)');
  await waitForQuery(connectionId, 'LDV_CANCEL'); await cancellation.cancel();
  const canceled = await running;
  assert.equal(canceled.state, 'CANCELED');
  if (engine === 'mysql') {
    assert.equal(canceled.inTransaction, false);
    assert.ok(canceled.warnings.some(message => message.includes('соединение закрыто')));
  } else await run(main, 'ROLLBACK');
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  assert.deepEqual((await run(main, 'SELECT 43')).rows, [['43']]);
  const afterCancelId = String((await run(main, 'SELECT CONNECTION_ID()')).rows[0]?.[0]);
  if (engine === 'mysql') assert.notEqual(afterCancelId, connectionId);
  connectionId = afterCancelId;
  passed('query timeout/cancel, transaction cleanup and next query; MySQL replaces the poisoned connection');

  await run(main, 'BEGIN'); await run(main, 'INSERT INTO transactions_fixture VALUES (7)');
  const interrupted = main.createQuery('network-interrupted').run('SELECT /* LDV_DISCONNECT */ SLEEP(30)');
  await waitForQuery(connectionId, 'LDV_DISCONNECT');
  await observer.query(`KILL CONNECTION ${connectionId}`);
  assert.equal((await interrupted).state, 'FAILED');
  // Explicit reconnect only: never replay statements from an interrupted transaction.
  await main.abort();
  assert.deepEqual((await run(main, 'SELECT id FROM transactions_fixture')).rows, [['1']]);
  const newId = String((await run(main, 'SELECT CONNECTION_ID()')).rows[0]?.[0]);
  assert.notEqual(newId, connectionId);
  passed('real server disconnect fails the query, rolls back pending writes and permits explicit reconnect');

  const stream = session({ vmOptions: ['-Xmx48m'] });
  await run(stream, 'CREATE TABLE digits (n INT)');
  await run(stream, 'INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)');
  await run(stream, 'CREATE TABLE stream_value (body LONGTEXT)');
  await run(stream, "INSERT INTO stream_value VALUES (REPEAT('x',2048))");
  const streamed = await run(stream, 'SELECT body FROM stream_value CROSS JOIN digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e LIMIT 60000', 1);
  assert.equal(streamed.totalRows, 60000); assert.equal(streamed.rows.length, 1); assert.equal(streamed.truncated, true);
  assert.equal(String(streamed.rows[0]?.[0]).length, 2048);
  assert.deepEqual((await run(stream, 'SELECT 44')).rows, [['44']]);
  await stream.close();
  passed('117 MiB real LONGTEXT result drains with a 48 MiB heap, one retained row and a reusable connection');

  await run(main, `INSERT INTO ${q(table)} (id, body) VALUES (4, REPEAT('x',4194305))`);
  const oversized = await main.createQuery('oversized-cell').run(`SELECT body FROM ${q(table)} WHERE id=4`);
  assert.equal(oversized.state, 'FAILED'); assert.match(oversized.error ?? '', /Text cell exceeds 4 MB/);
  assert.deepEqual((await run(main, 'SELECT 45')).rows, [['45']]);
  passed('real oversized LONGTEXT hits the cell limit without poisoning the next query');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  clearTimeout(guard);
  for (const value of sessions) await value.abort().catch(() => {});
  await observer?.end().catch(() => {});
  await writeFile(join(artifacts, 'mysql-server-results.json'), JSON.stringify(report, null, 2));
  await rm(resources, { recursive: true, force: true });
}
