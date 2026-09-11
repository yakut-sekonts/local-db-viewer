import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TrinoQuery, TrinoSession, validateConnection, type Connection } from '../electron/trino';
import { csv } from '../electron/csv';
import { metadataSQL, previewSQL, singleStatement } from '../electron/sql';
import { ProfileStore } from '../electron/storage';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function server(handler: (request: IncomingMessage, response: ServerResponse, origin: string) => void) {
  let origin = '';
  const http = createServer((request, response) => handler(request, response, origin));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((resolve, reject) => { http.closeAllConnections(); http.close(error => error ? reject(error) : resolve()); }) };
}
const connection = (endpoint: string): Connection => ({ id: 'test', name: 'Test', endpoint, user: 'tester', auth: 'none', catalog: '', schema: '', engine: 'trino', tls: true });
function json(response: ServerResponse, data: unknown, headers: Record<string, string> = {}) { response.writeHead(200, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(data)); }

test('Trino drains nextUri even when stats say FINISHED and the row limit is reached', async () => {
  let pages = 0;
  const http = await server((request, response, origin) => {
    pages++;
    if (request.method === 'POST') json(response, { id: 'q1', nextUri: `${origin}/page/1`, stats: { state: 'FINISHED' } });
    else if (request.url === '/page/1') json(response, { id: 'q1', nextUri: `${origin}/page/2`, columns: [{ name: 'x', type: 'bigint' }], data: [[1], [2]] });
    else json(response, { id: 'q1', data: [[3]], stats: { state: 'FINISHED' } });
  });
  try {
    const result = await new TrinoQuery(connection(http.origin), new TrinoSession(), 'r1', 1).run('SELECT x');
    assert.equal(result.state, 'FINISHED'); assert.equal(pages, 3); assert.deepEqual(result.rows, [[1]]); assert.equal(result.totalRows, 3); assert.equal(result.truncated, true);
  } finally { await http.close(); }
});

test('Trino retains bigint and decimal precision, NULL and duplicate column names', async () => {
  const http = await server((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"id":"q","columns":[{"name":"x","type":"bigint"},{"name":"x","type":"decimal"},{"name":"n","type":"varchar"}],"data":[[9223372036854775807,12345678901234567890.123456,null]]}'); });
  try {
    const result = await new TrinoQuery(connection(http.origin), new TrinoSession(), 'r').run('SELECT 1');
    assert.deepEqual(result.rows, [['9223372036854775807', '12345678901234567890.123456', null]]);
  } finally { await http.close(); }
});

test('Trino preserves session headers and transaction state between commands', async () => {
  let calls = 0;
  const http = await server((request, response) => {
    if (calls++ === 0) json(response, { id: 'first' }, { 'X-Trino-Set-Catalog': 'iceberg', 'X-Trino-Set-Schema': 'analytics', 'X-Trino-Set-Session': 'query_max_run_time=1m', 'X-Trino-Started-Transaction-Id': 'tx-1' });
    else {
      assert.equal(request.headers['x-trino-catalog'], 'iceberg'); assert.equal(request.headers['x-trino-schema'], 'analytics');
      assert.equal(request.headers['x-trino-session'], 'query_max_run_time=1m'); assert.equal(request.headers['x-trino-transaction-id'], 'tx-1');
      json(response, { id: 'second' }, { 'X-Trino-Clear-Session': 'query_max_run_time', 'X-Trino-Clear-Transaction-Id': 'true' });
    }
  });
  try {
    const session = new TrinoSession();
    assert.equal((await new TrinoQuery(connection(http.origin), session, 'a').run('START TRANSACTION')).inTransaction, true);
    assert.equal((await new TrinoQuery(connection(http.origin), session, 'b').run('ROLLBACK')).inTransaction, false);
    assert.equal(session.headers()['X-Trino-Session'], undefined);
  } finally { await http.close(); }
});

test('Trino rejects an untrusted nextUri without contacting that host', async () => {
  let leaked = false;
  const untrusted = await server((_req, res) => { leaked = true; json(res, { id: 'bad' }); });
  const trusted = await server((_req, res) => json(res, { id: 'q', nextUri: `${untrusted.origin}/steal` }));
  try {
    const result = await new TrinoQuery(connection(trusted.origin), new TrinoSession(), 'r').run('SELECT 1');
    assert.equal(result.state, 'FAILED'); assert.match(result.error!, /origin/); assert.equal(leaked, false);
  } finally { await trusted.close(); await untrusted.close(); }
});

test('Trino retries transient 503 and reports SQL errors', async () => {
  let requests = 0;
  const http = await server((_req, res) => {
    if (requests++ === 0) { res.writeHead(503); res.end(); }
    else json(res, { id: 'q', error: { message: 'Unknown column', errorName: 'COLUMN_NOT_FOUND', errorLocation: { lineNumber: 1, columnNumber: 8 } } });
  });
  try {
    const result = await new TrinoQuery(connection(http.origin), new TrinoSession(), 'r').run('SELECT no_such_column');
    assert.equal(requests, 2); assert.equal(result.state, 'FAILED'); assert.match(result.error!, /COLUMN_NOT_FOUND/); assert.equal(result.errorLocation?.columnNumber, 8);
  } finally { await http.close(); }
});

test('Cancellation before initial POST response deletes the issued query', async () => {
  let deleted = false;
  let onPost!: () => void;
  const posted = new Promise<void>(resolve => { onPost = resolve; });
  const http = await server((request, response, origin) => {
    if (request.method === 'DELETE') { deleted = true; response.writeHead(204); response.end(); }
    else { onPost(); setTimeout(() => json(response, { id: 'q', nextUri: `${origin}/page` }), 40); }
  });
  try {
    const query = new TrinoQuery(connection(http.origin), new TrinoSession(), 'r');
    const result = query.run('SELECT 1'); await posted; await query.cancel();
    assert.equal((await result).state, 'CANCELED'); assert.equal(deleted, true);
  } finally { await http.close(); }
});

test('SQL lexer respects quoted strings, comments, dollar bodies and rejects batches', () => {
  assert.equal(singleStatement("SELECT ';'; -- a comment"), "SELECT ';'");
  assert.equal(singleStatement('SELECT $$a;b$$;'), 'SELECT $$a;b$$');
  assert.equal(singleStatement('SELECT 1 /* outer /* inner */ outer */;'), 'SELECT 1 /* outer /* inner */ outer */');
  assert.throws(() => singleStatement('SELECT 1; DELETE FROM accounts'), /одну SQL-команду/);
  assert.throws(() => singleStatement("SELECT 'broken"), /Незакрытая/);
});

test('Metadata and previews quote identifiers for each database dialect', () => {
  const input = { profileId: 'x', kind: 'columns' as const, catalog: 'cat', schema: "sch'ema", table: 'ta"ble' };
  assert.match(metadataSQL('postgres', input), /sch''ema/);
  assert.equal(previewSQL('trino', 'a', 'b', 'c"d'), 'SELECT *\nFROM "a"."b"."c""d"\nLIMIT 100;');
  assert.equal(previewSQL('mysql', 'a', 'a', 'b`c'), 'SELECT *\nFROM `a`.`b``c`\nLIMIT 100;');
  assert.equal(previewSQL('mssql', 'a', 'b', 'c]d'), 'SELECT TOP (100) *\nFROM [a].[b].[c]]d];');
});

test('HTTP authentication requires HTTPS; embedded credentials are rejected', () => {
  assert.throws(() => validateConnection({ ...connection('http://example.com'), auth: 'basic', secret: 'test' }), /HTTPS/);
  assert.throws(() => validateConnection(connection('https://user:password@example.com')), /credentials/);
});

test('Profile storage encrypts secrets, masks renderer results and serializes concurrent writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-test-'));
  try {
    const file = join(directory, 'connections.json');
    const store = new ProfileStore(file, { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
    const { id: _, ...base } = connection('https://trino.example.com');
    const [first, second] = await Promise.all([store.save({ ...base, name: 'First', auth: 'basic', secret: 'unit-test-secret' }), store.save({ ...base, name: 'Second' })]);
    assert.equal((await store.list()).length, 2); assert.equal(first.hasSecret, true); assert.equal(second.hasSecret, false);
    assert.equal((await store.get(first.id)).secret, 'unit-test-secret');
    assert.equal((await readFile(file, 'utf8')).includes('unit-test-secret'), false);
    assert.equal(JSON.stringify(first).includes('encryptedSecret'), false);
    await store.save({ ...first, name: 'Changed' }); assert.equal((await store.get(first.id)).secret, 'unit-test-secret');
  } finally { await rm(directory, { recursive: true }); }
});

test('CSV escapes delimiters, newlines and formula-like strings', () => {
  assert.equal(csv([{ name: 'value', type: 'varchar' }], [['=SUM(A1)'], ['a,"b"\n'], [null], [-12]]), '\ufeff"value"\r\n"\'=SUM(A1)"\r\n"a,""b""\n"\r\n\r\n"-12"\r\n');
});
