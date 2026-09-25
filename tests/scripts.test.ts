import assert from 'node:assert/strict';
import test from 'node:test';
import { singleStatement, splitSqlScript } from '../electron/sql';
import { createScriptTask, retainScriptData, SCRIPT_RESULT_BYTES } from '../electron/script-runner';
import { executionState, type DatabaseEngine, type QuerySnapshot } from '../src/shared';

const values = (sql: string, engine: DatabaseEngine = 'sqlite') => splitSqlScript(sql, engine).map(part => part.sql);
const snapshot = (id: string, state: QuerySnapshot['state'] = 'FINISHED', rows: QuerySnapshot['rows'] = [['9223372036854775807', null]]): QuerySnapshot => ({ requestId: id, queryId: id, state, rows, columns: [{ name: 'value', type: 'text' }], totalRows: rows.length, truncated: false, stats: {}, warnings: [], inTransaction: false });

test('script boundaries preserve quoted text, comments and source locations', () => {
  const sql = " ;\r\n SELECT 'a;''b' AS [x;y];\r\n-- comment ;\r\nSELECT `x;y` FROM t; /* trailing ; */ ;";
  const parts = splitSqlScript(sql, 'sqlite');
  assert.deepEqual(parts.map(part => part.line), [2, 3]);
  assert.deepEqual(parts.map(part => sql.slice(part.start, part.end)), parts.map(part => part.sql));
  assert.deepEqual(values(sql), ["SELECT 'a;''b' AS [x;y]", '-- comment ;\r\nSELECT `x;y` FROM t']);
  assert.deepEqual(values('/* outer /* ; */ still comment */ SELECT 1; SELECT 2', 'trino'), ['/* outer /* ; */ still comment */ SELECT 1', 'SELECT 2']);
  assert.deepEqual(values("# comment ;\nSELECT 1; -- comment ;\nSELECT 2", 'mysql'), ['# comment ;\nSELECT 1', '-- comment ;\nSELECT 2']);
  assert.deepEqual(values("DO $body$ BEGIN RAISE NOTICE 'a;b'; END $body$; SELECT E'a\\\';b'", 'postgres'), ["DO $body$ BEGIN RAISE NOTICE 'a;b'; END $body$", "SELECT E'a\\\';b'"]);
  assert.deepEqual(values('SELECT [a;]]b]; SELECT 2', 'mssql'), ['SELECT [a;]]b]', 'SELECT 2']);
  assert.deepEqual(values("SELECT 'a\\\';b'; SELECT 2", 'clickhouse'), ["SELECT 'a\\\';b'", 'SELECT 2']);
  assert.equal(singleStatement('SELECT 1; -- trailing'), 'SELECT 1');
  assert.throws(() => singleStatement('SELECT 1; SELECT 2'), /одну SQL-команду/);
  assert.throws(() => singleStatement('SELECT 1;;'), /одну SQL-команду/);
});

test('validate the whole script before execution, including engine escape ambiguity and limits', () => {
  for (const sql of ['', ' ; /* comment */; ', "SELECT 1; SELECT 'unclosed", 'SELECT 1; /* open']) assert.throws(() => values(sql));
  assert.throws(() => values('SELECT $$unfinished;', 'postgres'), /dollar/);
  for (const engine of ['mysql', 'mariadb', 'postgres'] as const) assert.throws(() => values("SELECT 'a\\\';b'; SELECT 2", engine));
  assert.deepEqual(values("SELECT E'a\\\';b'; SELECT 2", 'postgres'), ["SELECT E'a\\\';b'", 'SELECT 2']);
  assert.throws(() => values('SELECT 1 /*! ; DELETE FROM t */', 'mysql'), /Исполняемые/);
  assert.equal(values('SELECT 1;'.repeat(100)).length, 100);
  assert.throws(() => values('SELECT 1;'.repeat(101)), /100/);
  assert.throws(() => values(' '.repeat(1_000_001)), /1 MB/);
});

test('client directives and procedural batches fail before any fragment runs', () => {
  for (const [sql, engine] of [
    ['SELECT 1\r\n  GO 2 -- repeat\r\nSELECT 2', 'mssql'],
    ['SELECT 1;\nDELIMITER $$\nCREATE PROCEDURE x() BEGIN SELECT 2; END$$', 'mysql'],
    ['SELECT 1;\n\\i other.sql', 'postgres'],
    ['SELECT 1;\n.read other.sql', 'sqlite'],
    ['SELECT 1;\n/\nSELECT 2', 'jdbc'],
    ['SELECT 1; CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET n=1; END', 'sqlite'],
    ['SELECT 1; CREATE DEFINER = user PROCEDURE x() BEGIN SELECT 2; END', 'mysql'],
    ['SELECT 1; CREATE OR REPLACE FUNCTION x() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql', 'postgres'],
    ['SELECT 1; DECLARE @x int; SELECT @x', 'mssql'],
    ['BEGIN ATOMIC SELECT 1; END', 'jdbc'],
    ['SELECT 1; CALL routine()', 'jdbc'],
    ['SELECT 1; EXEC routine', 'mssql'],
    ['SELECT 1; COPY t FROM STDIN', 'postgres'],
  ] as const) assert.throws(() => values(sql, engine), /не поддерживаются/, sql);
  assert.equal(values("SELECT '\nGO\n' AS text; /*\nDELIMITER $$\n*/ SELECT 2", 'mssql').length, 2);
  assert.equal(values('BEGIN IMMEDIATE TRANSACTION; INSERT INTO t VALUES(1); COMMIT', 'sqlite').length, 3);
  assert.equal(values('CREATE TEMP TABLE t (n int); CREATE UNIQUE INDEX i ON t(n); WITH x AS (SELECT 1) SELECT * FROM x', 'postgres').length, 3);
});

test('one queue reservation runs all statements, retains results and applies context only once', async () => {
  const sql: string[] = [], firsts: boolean[] = [], events: QuerySnapshot[] = []; let enqueues = 0;
  const task = createScriptTask({ requestId: 'script', engine: 'sqlite', inTransaction: () => false, enqueue: async work => { enqueues++; return work(); }, notify: value => events.push(value),
    createQuery: (id, notify, first) => { firsts.push(first); return { cancel: async () => {}, run: async value => { sql.push(value); notify(snapshot(id, 'RUNNING')); return snapshot(id); } }; },
  });
  const result = await task.run('SELECT 1; SELECT 2; SELECT 3');
  assert.equal(enqueues, 1); assert.deepEqual(firsts, [true, false, false]); assert.equal(sql.length, 3);
  assert.equal(result.script?.completed, 3); assert.equal(executionState(result), 'FINISHED');
  assert.equal(events.filter(value => executionState(value) !== 'RUNNING').length, 1);
  assert.ok(events.every(value => value.requestId === 'script'));
  assert.deepEqual(events.filter(value => value.state === 'FINISHED').map(value => value.rows), Array(3).fill([['9223372036854775807', null]]));
});

test('parser error performs no SQL; database error stops following commands without implicit rollback', async () => {
  const executed: string[] = [];
  const create = () => createScriptTask({ requestId: 'script', engine: 'sqlite', inTransaction: () => true, enqueue: work => work(), notify: () => {}, createQuery: id => ({ cancel: async () => {}, run: async sql => { executed.push(sql); if (sql === 'SELECT missing') throw new Error('missing table'); return { ...snapshot(id), inTransaction: true }; } }) });
  assert.equal((await create().run("SELECT 1; SELECT 'bad")).state, 'FAILED'); assert.deepEqual(executed, []);
  const result = await create().run('BEGIN; SELECT missing; COMMIT');
  assert.deepEqual(executed, ['BEGIN', 'SELECT missing']); assert.equal(result.script?.completed, 1);
  assert.equal(executionState(result), 'FAILED'); assert.equal(result.inTransaction, true); assert.equal(result.error, 'missing table');
});

test('cancellation before dispatch or between commands does not start more SQL', async () => {
  let executed = 0;
  const task = createScriptTask({ requestId: 'script', engine: 'sqlite', inTransaction: () => false, enqueue: work => work(), notify: () => {}, createQuery: id => ({ cancel: async () => {}, run: async () => { executed++; return snapshot(id); } }) });
  await task.cancel(); assert.equal(executionState(await task.run('SELECT 1; SELECT 2')), 'CANCELED'); assert.equal(executed, 0);
  const between = createScriptTask({ requestId: 'between', engine: 'sqlite', inTransaction: () => false, enqueue: work => work(), notify: value => { if (value.script?.completed === 1) void between.cancel(); }, createQuery: id => ({ cancel: async () => {}, run: async () => { executed++; return snapshot(id); } }) });
  const result = await between.run('SELECT 1; SELECT 2');
  assert.equal(executed, 1); assert.equal(result.state, 'FINISHED'); assert.equal(result.script?.state, 'CANCELED'); assert.equal(result.script?.completed, 1);
});

test('cancel targets the running task and the script remains queued exclusively until it settles', async () => {
  let releaseQuery!: (value: QuerySnapshot) => void, started!: () => void, canceled = 0, count = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const task = createScriptTask({ requestId: 'script', engine: 'sqlite', inTransaction: () => false, enqueue: work => work(), notify: () => {}, createQuery: id => ({ cancel: async () => { canceled++; releaseQuery(snapshot(id, 'CANCELED')); }, run: async () => { count++; started(); return new Promise(resolve => { releaseQuery = resolve; }); } }) });
  const running = task.run('SELECT 1; SELECT 2'); await began; await task.cancel();
  const result = await running;
  assert.equal(canceled, 1); assert.equal(count, 1); assert.equal(result.script?.completed, 0); assert.equal(executionState(result), 'CANCELED');
});

test('all statement results share a UTF-8 data budget without numeric coercion', async () => {
  const original = snapshot('id', 'FINISHED', [['名'.repeat(20)], ['9223372036854775807']]);
  const oneRow = Buffer.byteLength(JSON.stringify(original.columns)) + Buffer.byteLength(JSON.stringify(original.rows[0]));
  const kept = retainScriptData(original, oneRow);
  assert.deepEqual(kept.snapshot.rows, [original.rows[0]]); assert.equal(kept.bytes, oneRow); assert.equal(kept.limited, true); assert.equal(original.rows.length, 2);
  assert.deepEqual(retainScriptData(original, 0).snapshot.columns, []);
  let retained = 0; const payload = [['a'.repeat(4 * 1024 ** 2)]];
  const task = createScriptTask({ requestId: 'budget', engine: 'sqlite', inTransaction: () => false, enqueue: work => work(), notify: value => { if (value.state === 'FINISHED') retained += Buffer.byteLength(JSON.stringify(value.columns)) + value.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0); }, createQuery: id => ({ cancel: async () => {}, run: async () => snapshot(id, 'FINISHED', payload) }) });
  const result = await task.run('SELECT 1; SELECT 2; SELECT 3; SELECT 4; SELECT 5');
  assert.ok(retained <= SCRIPT_RESULT_BYTES); assert.equal(result.script?.dataLimited, true); assert.equal(result.script?.completed, 5); assert.equal(result.truncated, true);
});
