import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitLineBytes } from '../electron/line-limit';
import { singleStatement } from '../electron/sql';
import { tlsOptions } from '../electron/tls';
import { ProfileStore } from '../electron/storage';
import { completeSQL } from '../src/completion';

test('explicit CA replaces all roots and native TLS retains hostname verification', () => {
  const ca = rootCertificates[0]; assert.ok(ca);
  for (const mode of ['FULL', 'CA'] as const) {
    const options = tlsOptions({ sslCa: ca, sslVerification: mode });
    assert.equal(options.ca.length, 1); assert.equal(options.ca[0]?.trim(), ca.trim());
    assert.equal(options.checkServerIdentity, checkServerIdentity); assert.equal(options.rejectUnauthorized, true);
    assert.ok(options.checkServerIdentity('wrong.example', { subjectaltname: 'DNS:correct.example' } as any));
  }
});
test('ClickHouse limit rejects an unfinished UTF-8 record before readline receives oversized data', async () => {
  let requested = 0;
  async function* chunks() { try { for (let i = 0; i < 1000; i++) { requested++; yield Buffer.from('Д'); } } finally { requested += 0; } }
  const stream = Readable.from(limitLineBytes(chunks(), 8));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { await assert.rejects(async () => { for await (const _line of lines) assert.fail('An oversized unfinished row must not reach readline'); }, /превышает 8 bytes/); }
  finally { lines.close(); stream.destroy(); }
  assert.equal(requested, 5, 'stop after 10 bytes, without draining input');
});
test('ClickHouse byte cap resets across chunks, CRLF and multiple records', async () => {
  const source = Readable.from([Buffer.from('1234\n12'), Buffer.from('34\r\n12345'), Buffer.from('\n')]);
  const stream = Readable.from(limitLineBytes(source, 5)), lines = createInterface({ input: stream, crlfDelay: Infinity });
  const output: string[] = []; for await (const line of lines) output.push(line);
  assert.deepEqual(output, ['1234', '1234', '12345']);
});
test('statement boundaries follow engine-specific backslash, identifier and comment rules', () => {
  const standard = "SELECT 'a\\'; DELETE FROM accounts; -- '";
  for (const engine of ['trino','sqlite','postgres','mssql','jdbc'] as const) assert.throws(() => singleStatement(standard, engine), /одну SQL-команду/);
  assert.equal(singleStatement("SELECT 'a\\\';b';", 'mysql'), "SELECT 'a\\\';b'");
  assert.throws(() => singleStatement("SELECT 'a\\\';b';", 'trino'));
  assert.throws(() => singleStatement(standard, 'mysql', { backslashEscapes: false }), /одну SQL-команду/);
  assert.equal(singleStatement("SELECT E'a\\\';b';", 'postgres'), "SELECT E'a\\\';b'");
  assert.equal(singleStatement('SELECT $$a;b$$;', 'postgres'), 'SELECT $$a;b$$');
  assert.throws(() => singleStatement('SELECT $$a;b$$;', 'trino'));
  assert.throws(() => singleStatement('SELECT arr[1; DELETE FROM t]', 'trino'));
  assert.equal(singleStatement('SELECT [a;b];', 'mssql'), 'SELECT [a;b]');
  assert.equal(singleStatement('SELECT 1; # trailing MySQL comment', 'mysql'), 'SELECT 1');
  assert.throws(() => singleStatement('SELECT 1; --x\nDELETE FROM t', 'mysql'));
  assert.throws(() => singleStatement('SELECT 1 /*!; DELETE FROM t */', 'mysql'), /Исполняемые/);
  assert.throws(() => singleStatement('/* outer /* inner */ SELECT 1; DELETE FROM t */', 'mysql'));
  assert.throws(() => singleStatement('/* empty */; -- still empty', 'trino'), /SQL пустой/);
});
test('incomplete SQL tokens and empty arrays do not crash completion', () => {
  const index = { profileId:'p',catalog:'db',schema:'public',tables:[],relationships:[],warnings:[] };
  for (const text of ['', ')', '((((', 'WITH ', 'WITH x AS (', 'WITH x (', 'SELECT * FROM ', 'SELECT * FROM db.', 'SELECT * FROM a JOIN ', 'SELECT .', 'SELECT 1 UNION ']) assert.doesNotThrow(() => completeSQL(text,text.length,index,'postgres'));
});
test('broken stored profiles fail before rendering and are not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'broken-profiles-')), path = join(directory,'connections.json');
  const store = new ProfileStore(path, {encrypt:value=>value,decrypt:value=>value});
  try {
    for (const data of [[null], [{id:'x',name:'broken',engine:'unknown'}], [{id:'x',name:'bad URL',engine:'trino',endpoint:'broken',user:'u',auth:'none',tls:false,catalog:'',schema:''}]]) {
      const original = JSON.stringify(data); await writeFile(path,original); await assert.rejects(store.list(), /повреждён/); assert.equal(await readFile(path,'utf8'),original);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
