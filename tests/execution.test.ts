import assert from 'node:assert/strict';
import test from 'node:test';
import { statementAtCursor } from '../electron/sql';
import { executionTarget } from '../src/execution';

const cursorTarget = (sql: string, cursor: number, engine: Parameters<typeof executionTarget>[4] = 'trino') => executionTarget(sql, cursor, { start: cursor, end: cursor }, 'statement', engine);

test('cursor chooses the entire CTE, JOIN, subquery and UNION statement', () => {
  const query = '-- context\nWITH t AS (\n SELECT 1 AS id\n), u AS (SELECT id FROM t)\nSELECT t.id FROM t JOIN u ON t.id = u.id\nWHERE EXISTS (SELECT 1 FROM u)\nUNION ALL SELECT 2';
  const sql = `SELECT 0;\n${query};\nSELECT 3;`;
  for (const needle of ['-- context', 'WITH t', '1 AS id', 'SELECT id FROM t', 'JOIN u', 'EXISTS', 'UNION ALL']) {
    const target = cursorTarget(sql, sql.indexOf(needle) + 2);
    assert.equal(target.sql, query); assert.equal(target.source, 'cursor'); assert.equal(target.mode, 'statement'); assert.equal(target.startLine, 2); assert.equal(target.endLine, 8);
    assert.equal(sql.slice(target.start, target.end), target.sql);
  }
  assert.equal(cursorTarget(sql, sql.indexOf('SELECT 3')).sql, 'SELECT 3');
});

test('cursor boundaries handle semicolons, whitespace, comments and CRLF deliberately', () => {
  const sql = "SELECT '名😀;a' AS value;\r\n\r\n-- next;\r\n SELECT 2;  \r\n";
  assert.equal(cursorTarget(sql, 0).sql, "SELECT '名😀;a' AS value");
  assert.equal(cursorTarget(sql, sql.indexOf(';\r')).sql, "SELECT '名😀;a' AS value");
  const next = cursorTarget(sql, sql.indexOf(';\r') + 1);
  assert.equal(next.sql, '-- next;\r\n SELECT 2'); assert.equal(next.startLine, 3); assert.equal(next.endLine, 4);
  assert.equal(cursorTarget(sql, sql.length).sql, next.sql);
  assert.throws(() => cursorTarget('-- only comments;\n/* none */', 0), /SQL пустой/);
});

test('the execution parser and cursor agree on supported quoted literals and identifiers', () => {
  for (const [query, engine] of [
    ["SELECT 'x;''y', \"a;b\"", 'trino'],
    ["SELECT 'x;y', `a;b` # comment;\n", 'mysql'],
    ['SELECT [a;]]b]', 'mssql'],
    ["SELECT E'a\\\';b', $tag$c;d$tag$", 'postgres'],
    ["DO $$ BEGIN RAISE NOTICE 'a;b'; END $$", 'postgres'],
    ["SELECT 'a\\\';b'", 'clickhouse'],
  ] as const) {
    const sql = query + ';\nSELECT 7;';
    assert.equal(cursorTarget(sql, query.indexOf(';'), engine).sql, query.trim());
  }
  assert.throws(() => cursorTarget("SELECT 'a\\\';b'; SELECT 2", 10, 'mysql'), /backslash/);
});

test('unfinished later drafts do not block a completed earlier query', () => {
  for (const tail of ["SELECT 'unfinished", 'SELECT $$unfinished', '/* unfinished', 'GO\nSELECT 2']) {
    const sql = `SELECT 1;\n${tail}`;
    assert.equal(cursorTarget(sql, 3, 'postgres').sql, 'SELECT 1');
    assert.throws(() => cursorTarget(sql, sql.length, 'postgres'));
  }
  assert.throws(() => cursorTarget("SELECT 'unfinished;\n SELECT 2;", 25), /Незакрытая/);
  const many = 'SELECT 1;\n'.repeat(150);
  assert.equal(cursorTarget(many, many.length).sql, 'SELECT 1');
});

test('cursor never extracts a body fragment from unsupported procedures or client batches', () => {
  assert.equal(cursorTarget("CALL routine('a;b'); SELECT 2;", 8, 'jdbc').sql, "CALL routine('a;b')");
  assert.equal(cursorTarget("EXEC routine 'a;b'; SELECT 2;", 8, 'mssql').sql, "EXEC routine 'a;b'");
  for (const [sql, engine] of [
    ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(1); DELETE FROM t; END;', 'sqlite'],
    ['DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$', 'mysql'],
    ['DECLARE @x int; SELECT 2;', 'mssql'],
    ['SELECT 1\nGO\nSELECT 2;', 'mssql'],
  ] as const) assert.throws(() => cursorTarget(sql, sql.lastIndexOf('SELECT') < 0 ? sql.indexOf('DELETE') : sql.lastIndexOf('SELECT'), engine), /не поддерживаются/);
});

test('selection has priority, preserves SQL and turns several selected statements into a script', () => {
  const sql = "SELECT 0;\n  SELECT 'a;b';\nSELECT 2;\nDELETE FROM important_table;";
  const start = sql.indexOf("SELECT '"), end = sql.indexOf('\nDELETE');
  const target = executionTarget(sql, sql.length, { start, end }, 'statement', 'sqlite');
  assert.equal(target.sql, sql.slice(start, end)); assert.equal(target.mode, 'script'); assert.equal(target.count, 2); assert.equal(target.source, 'selection');
  assert.equal(target.startLine, 2); assert.equal(target.endLine, 3);
  const one = executionTarget(sql, 0, { start, end: sql.indexOf('\nSELECT 2') }, 'statement', 'sqlite');
  assert.equal(one.mode, 'statement'); assert.equal(one.sql, "SELECT 'a;b';");
  const explicit = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;";
  assert.equal(executionTarget(explicit, 0, { start: 0, end: explicit.length }, 'statement', 'postgres').mode, 'statement');
  assert.throws(() => executionTarget('SELECT 1;  SELECT 2', 0, { start: 9, end: 11 }, 'statement', 'sqlite'), /нет SQL/);
});

test('script button deliberately targets the whole console or selection, with bounded validation', () => {
  const sql = 'SELECT 1;\nSELECT 2;';
  const target = executionTarget(sql, 3, { start: 3, end: 3 }, 'script', 'trino');
  assert.equal(target.sql, sql); assert.equal(target.mode, 'script'); assert.equal(target.source, 'script'); assert.equal(target.count, 2);
  assert.throws(() => executionTarget('SELECT 1;'.repeat(101), 0, { start: 0, end: 0 }, 'script', 'trino'), /100/);
  assert.throws(() => cursorTarget(' '.repeat(1_000_001), 0), /1 000 000/);
  for (const offset of [-1, 1.2, 20]) assert.throws(() => statementAtCursor('SELECT 1', offset), /курсор/);
  assert.throws(() => executionTarget(sql, 0, { start: 5, end: 3 }, 'statement', 'trino'), /выделение/);
});
