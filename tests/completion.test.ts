import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeSQL, requestedSchemas } from '../src/completion';
import { loadSchema, RelationStore, validateRelation } from '../electron/schema';
import { sqlLiteral } from '../electron/sql';
import type { Connection } from '../electron/trino';
import type { DatabaseEngine, Relationship, SchemaIndex, TableMeta } from '../src/shared';

const table = (name: string, columns: string[], schema = 'public'): TableMeta => ({ catalog: 'analytics', schema, name, columns: columns.map(name => ({ name, type: 'bigint' })) });
const orders = table('orders', ['id', 'customer_id', 'tenant_id', 'amount']);
const customers = table('customers', ['id', 'tenant_id', 'name']);
const relationship: Relationship = { id: 'orders_customer_fk', name: 'orders_customer_fk', kind: 'foreign-key', source: orders, target: customers, columns: [{ source: 'customer_id', target: 'id' }, { source: 'tenant_id', target: 'tenant_id' }] };
const index: SchemaIndex = { profileId: 'test', catalog: 'analytics', schema: 'public', tables: [orders, customers, table('secret', ['hidden'])], relationships: [relationship], warnings: [] };
function first<T>(values: T[]): T { const value = values[0]; assert.ok(value !== undefined, 'Expected a fixture element'); return value; }
function suggest(text: string, engine: DatabaseEngine = 'postgres', schema = index) {
  const offset = text.indexOf('|'); assert.ok(offset >= 0);
  return completeSQL(text.replace('|', ''), offset, schema, engine);
}

test('columns resolve aliases defined after cursor, distinguish ambiguous names and ignore unrelated tables', () => {
  const items = suggest('SELECT o.| FROM orders AS o');
  assert.deepEqual(items.map(item => item.label), orders.columns.map(column => column.name));
  const contextual = suggest('SELECT | FROM orders o JOIN customers c ON o.customer_id = c.id');
  assert.ok(contextual.some(item => item.label === 'o.id' && item.insertText === '"o"."id"'));
  assert.ok(contextual.some(item => item.label === 'c.id'));
  assert.ok(!contextual.some(item => item.label === 'hidden'));
  const aggregate = suggest('SELECT SUM(o.|) FROM orders o JOIN customers c ON o.customer_id = c.id');
  assert.deepEqual(aggregate.map(item => item.label), orders.columns.map(column => column.name));
  assert.equal(first(aggregate).insertText, '"id"');
});
test('quoted aliases, partial identifier replacement and dialect quotes', () => {
  const text = 'SELECT "Order alias".cu|stomer_id FROM orders "Order alias"';
  const item = suggest(text).find(item => item.label === 'customer_id')!;
  assert.ok(item); assert.equal(item.insertText, '"customer_id"');
  assert.equal(text.replace('|', '').slice(item.start, item.end), 'customer_id');
  assert.equal(first(suggest('SELECT o.| FROM orders o', 'mysql')).insertText, '`id`');
  assert.equal(first(suggest('SELECT o.| FROM orders o', 'mssql')).insertText, '[id]');
  assert.deepEqual(suggest('SELECT O.| FROM orders O').map(item => item.label), orders.columns.map(column => column.name));
  assert.ok(suggest('SELECT * FROM orders O JOIN |').some(item => item.insertText.includes('"o"."customer_id"')));
  assert.deepEqual(suggest('WITH X AS (SELECT CUSTOMER_ID AS CID FROM ORDERS) SELECT X.| FROM X').map(item => item.label), ['cid']);
});
test('table context suggests qualified tables; functions and field contexts do not become table contexts', () => {
  assert.ok(suggest('SELECT * FROM |').some(item => item.kind === 'table' && item.insertText === '"public"."orders"'));
  assert.ok(!suggest('SELECT | FROM orders o').some(item => item.kind === 'table'));
  assert.ok(suggest('SELECT * FROM orders o, |').some(item => item.kind === 'table'));
});
test('JOIN completion uses every FK pair and aliases, forward and reverse', () => {
  const joins = suggest('SELECT * FROM orders o JOIN |').filter(item => item.kind === 'join');
  assert.equal(joins.length, 1);
  assert.equal(first(joins).insertText, '"public"."customers" "c" ON "o"."customer_id" = "c"."id" AND "o"."tenant_id" = "c"."tenant_id"');
  assert.ok(suggest('SELECT * FROM customers c JOIN |').some(item => item.insertText.includes('"o"."customer_id" = "c"."id"')));
  const on = suggest('SELECT * FROM orders o LEFT JOIN customers x ON |').filter(item => item.kind === 'join');
  assert.equal(first(on).insertText, '"o"."customer_id" = "x"."id" AND "o"."tenant_id" = "x"."tenant_id"');
});
test('JOIN variants, existing LEFT prefix and alias collision are handled', () => {
  assert.ok(suggest('SELECT * FROM orders o LE|').some(item => item.label === 'LEFT JOIN customers'));
  assert.ok(suggest('SELECT * FROM orders o LEFT |').some(item => item.insertText.startsWith('JOIN ')));
  assert.ok(!suggest('SELECT * FROM orders o |', 'mysql').some(item => item.insertText.startsWith('FULL JOIN')));
  assert.ok(suggest('SELECT * FROM orders c JOIN |').some(item => item.insertText.includes('"customers" "c2"')));
});
test('comments, strings, dollar quoted strings, nested SELECTs and separate statements stay isolated', () => {
  for (const sql of ["SELECT 'o.|' FROM orders o", 'SELECT 1 -- o.|', 'SELECT /* JOIN | */ * FROM orders', 'SELECT $$ text | $$ FROM orders']) assert.deepEqual(suggest(sql), []);
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (SELECT c.| FROM customers c)').map(item => item.label), customers.columns.map(column => column.name));
  assert.deepEqual(suggest('SELECT c.| FROM orders o WHERE EXISTS (SELECT 1 FROM customers c)'), []);
  assert.deepEqual(suggest('SELECT * FROM orders o; SELECT o.| FROM customers c'), []);
  assert.deepEqual(suggest('SELECT * FROM orders o UNION SELECT o.| FROM customers c'), []);
});
test('CTEs with explicit columns, projections and star have usable fields', () => {
  assert.deepEqual(suggest('WITH x (customer, total) AS (SELECT customer_id, amount FROM orders) SELECT x.| FROM x').map(item => item.label), ['customer', 'total']);
  assert.deepEqual(suggest('WITH x AS (SELECT o.customer_id, SUM(o.amount) AS total FROM orders o GROUP BY o.customer_id) SELECT x.| FROM x').map(item => item.label), ['customer_id', 'total']);
  assert.deepEqual(suggest('WITH x AS (SELECT o.* FROM orders o) SELECT x.| FROM x').map(item => item.label), orders.columns.map(column => column.name));
  assert.ok(!suggest('WITH orders AS (SELECT name FROM customers) SELECT * FROM orders o JOIN |').some(item => item.kind === 'join'));
});
test('qualified schema requests and virtual cross-schema relationships', () => {
  const sql = 'SELECT x. FROM warehouse.finance.orders x';
  assert.deepEqual(requestedSchemas(sql, sql.indexOf('. ') + 1, index, 'trino'), [{ catalog: 'warehouse', schema: 'finance' }]);
  const remote = table('customers', ['id', 'tenant_id'], 'crm');
  const schema = { ...index, tables: [...index.tables, remote], relationships: [{ ...relationship, target: remote, kind: 'virtual' as const }] };
  const item = suggest('SELECT * FROM orders o JOIN |', 'postgres', schema).find(item => item.kind === 'join');
  assert.ok(item?.insertText.includes('"crm"."customers"'));
  assert.ok(item?.detail.includes('Виртуальная'));
});
test('schema loader preserves composite key order and discards truncated foreign keys', async () => {
  const connection = { engine: 'sqlite', catalog: '', schema: '' } as Connection;
  const input = { profileId: 'p', catalog: '', schema: '' };
  const rows = [['k', 'fk', 'main', 'main', 'orders', 'main', 'main', 'customers', 'customer_id', 'id'], ['k', 'fk', 'main', 'main', 'orders', 'main', 'main', 'customers', 'tenant_id', 'tenant_id']];
  const run = async (truncated: boolean) => loadSchema(connection, input, async sql => ({ columns: [], rows: sql.includes('foreign_key_list') ? rows : [['orders', 'customer_id', 'INTEGER']], truncated: sql.includes('foreign_key_list') && truncated }), []);
  assert.deepEqual(first((await run(false)).relationships).columns, relationship.columns);
  const limited = await run(true); assert.equal(limited.relationships.length, 0); assert.equal(limited.warnings.length, 1);
});
test('virtual relationship persistence is atomic and isolates profiles; invalid pairs fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-relations-'));
  const path = join(directory, 'relationships.json');
  const store = new RelationStore(path);
  const virtual = { ...relationship, kind: 'virtual' as const };
  validateRelation(virtual);
  assert.throws(() => validateRelation({ ...virtual, columns: [first(virtual.columns), first(virtual.columns)] }));
  await Promise.all([store.change('a', () => [virtual]), store.change('b', () => [{ ...virtual, id: 'b' }])]);
  assert.equal(first(await new RelationStore(path).list('a')).id, relationship.id);
  assert.equal(first(await store.list('b')).id, 'b');
  await store.change('a', () => []); assert.deepEqual(await store.list('a'), []);
});
test('metadata literals preserve backslashes and quotes independently of MySQL sql_mode', () => {
  assert.equal(sqlLiteral("a\\'b", 'mysql'), "CONVERT(X'615c2762' USING utf8mb4)");
  assert.equal(sqlLiteral("a\\'b", 'postgres'), "E'a\\\\''b'");
  assert.equal(sqlLiteral("a'b", 'mssql'), "N'a''b'");
});
