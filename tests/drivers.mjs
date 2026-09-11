import { _electron as electron, expect } from '@playwright/test';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import mysql from 'mysql2';

// Deterministic protocol fixtures exercise the actual shipped database drivers.
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
const int16 = value => { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; };
const int32 = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
const cstring = value => Buffer.from(value + '\0');
const packet = (type, body) => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const pg = tcpServer(socket => {
  track(socket);
  let buffer = Buffer.alloc(0); let startup = true;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (startup) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE()) return;
        const length = buffer.readInt32BE(); buffer = buffer.subarray(length); startup = false;
        socket.write(Buffer.concat([packet('R', int32(0)), packet('K', Buffer.concat([int32(123), int32(456)])), packet('Z', Buffer.from('I'))]));
      } else {
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffer[0]); const length = buffer.readInt32BE(1);
        const body = buffer.subarray(5, length + 1); buffer = buffer.subarray(length + 1);
        if (type === 'X') { socket.end(); return; }
        if (type !== 'Q') throw new Error(`Unexpected PG packet ${type}`);
        const sql = body.toString('utf8').replace(/\0$/, '');
        if (sql.includes('invalid')) {
          socket.write(Buffer.concat([packet('E', Buffer.concat([cstring('SERROR'), cstring('C42703'), cstring('Mfixture column does not exist'), Buffer.from([0])])), packet('Z', Buffer.from('I'))]));
          continue;
        }
        const columns = [['id', 20, 8], ['amount', 1700, -1], ['note', 25, -1]];
        const description = Buffer.concat([int16(columns.length), ...columns.map(([name, oid, size]) => Buffer.concat([cstring(name), int32(0), int16(0), int32(oid), int16(size), int32(-1), int16(0)]))]);
        const data = Buffer.concat([int16(3), ...['9223372036854775807', '12345678901234567890.123456', null].map(value => value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]))]);
        socket.write(Buffer.concat([packet('T', description), packet('D', data), packet('C', cstring('SELECT 1')), packet('Z', Buffer.from('I'))]));
      }
    }
  });
});
await new Promise(resolve => pg.listen(0, '127.0.0.1', resolve));

const my = mysql.createServer();
my.on('connection', connection => {
  track(connection.stream); connection.on('error', error => console.error('MySQL fixture error:', error.message));
  connection.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.0-fixture', connectionId: 124, statusFlags: 2, characterSet: 45, capabilityFlags: 0x00088201 });
  connection.on('stmt_prepare', sql => { connection.sequenceId = 1; connection.writeOk({ affectedRows: 0, serverStatus: 2 }); });
  connection.on('query', sql => {
    connection.sequenceId = 1;
    if (sql.startsWith('KILL ')) { connection.writeOk({ affectedRows: 0, serverStatus: 2 }); return; }
    if (sql.includes('invalid')) { connection.writeError({ code: 1054, message: 'fixture column does not exist' }); return; }
    const columns = [
      { name: 'id', columnType: mysql.Types.LONGLONG, characterSet: 63, columnLength: 20, flags: 0, decimals: 0 },
      { name: 'amount', columnType: mysql.Types.NEWDECIMAL, characterSet: 63, columnLength: 40, flags: 0, decimals: 6 },
      { name: 'note', columnType: mysql.Types.VAR_STRING, characterSet: 45, columnLength: 100, flags: 0, decimals: 0 },
    ];
    connection.writeColumns(columns.map(column => ({ catalog: 'def', schema: 'fixture', table: 'values', orgTable: 'values', orgName: column.name, ...column })));
    connection.writeTextRow(['9223372036854775807', '12345678901234567890.123456', null]); connection.writeEof(0, 2);
  });
});
await new Promise(resolve => my.listen(0, '127.0.0.1', resolve));

const clickhouse = httpServer(async (request, response) => {
  let sql = ''; for await (const chunk of request) sql += chunk;
  if (sql.includes('invalid')) { response.writeHead(400); response.end('Code: 47. UNKNOWN_IDENTIFIER'); return; }
  expect(new URL(request.url, 'http://localhost').searchParams.get('default_format')).toBe('JSONCompactEachRowWithNamesAndTypes');
  response.setHeader('Content-Type', 'application/x-ndjson');
  response.end('["id","amount","note"]\n["UInt64","Decimal(38,6)","Nullable(String)"]\n["9223372036854775807","12345678901234567890.123456",null]\n');
});
await new Promise(resolve => clickhouse.listen(0, '127.0.0.1', resolve));
const dataDir = await mkdtemp(join(tmpdir(), 'local-db-viewer-driver-'));
const app = await electron.launch({ args: [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: dataDir } });
try {
  const page = await app.firstWindow();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  for (const [engine, endpoint] of [
    ['postgres', `postgresql://127.0.0.1:${pg.address().port}/fixture`],
    ['mysql', `mysql://127.0.0.1:${my._server.address().port}`],
    ['mariadb', `mysql://127.0.0.1:${my._server.address().port}`],
    ['clickhouse', `http://127.0.0.1:${clickhouse.address().port}`],
  ]) {
    const profile = await page.evaluate(draft => window.studio.profiles.save(draft), { name: engine, engine, endpoint, user: 'fixture', auth: 'none', tls: false, catalog: '', schema: '' });
    for (const sql of ['SELECT precision_values', 'SELECT invalid']) {
      const result = await page.evaluate(async ({ profile, sql }) => {
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timeout: ${profile.engine}`)); }, 20000);
          const unsubscribe = window.studio.query.onUpdate(result => {
            if (result.requestId === requestId && result.state !== 'RUNNING') { clearTimeout(timeout); unsubscribe(); resolve(result); }
          });
          window.studio.query.run({ requestId, sessionId: profile.id, profileId: profile.id, sql, catalog: '', schema: '', maxRows: 100 }).catch(reject);
        });
      }, { profile, sql });
      if (sql.includes('invalid')) { expect(result.state, `${engine}: ${result.error}`).toBe('FAILED'); expect(result.error).toBeTruthy(); }
      else { expect(result.state, `${engine}: ${result.error}`).toBe('FINISHED'); expect(result.rows).toEqual([['9223372036854775807', '12345678901234567890.123456', null]]); }
    }
    await page.evaluate(id => window.studio.query.release(id), profile.id);
    console.log(`PASS: ${engine} wire protocol, row values, bigint/decimal precision, NULL, SQL error, close`);
  }
} finally {
  for (const socket of sockets) socket.destroy();
  await app.close();
  await Promise.all([new Promise(resolve => pg.close(resolve)), new Promise(resolve => my.close(resolve)), new Promise(resolve => clickhouse.close(resolve))]);
}
