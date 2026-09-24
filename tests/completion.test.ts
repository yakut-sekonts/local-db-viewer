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

test('nested derived tables expose projections, bare aliases and positional column aliases', () => {
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT o.customer_id cid, CAST(o.amount AS decimal(12, 3)) AS total FROM orders o) d').map(item=>item.label),['cid','total']);
  const nested=suggest('SELECT x.| FROM (SELECT d.* FROM (SELECT customer_id AS cid, tenant_id FROM orders) d) x(customer, tenant)');
  assert.deepEqual(nested.map(item=>item.label),['customer','tenant']);
  assert.match(nested[0]!.detail,/bigint/);
  const positional=suggest('SELECT x.| FROM (SELECT amount+1, customer_id FROM orders) x(total,customer)');
  assert.deepEqual(positional.map(item=>item.label),['total','customer']);
  assert.match(positional[0]!.detail,/тип не определён/);
  assert.match(positional[1]!.detail,/bigint/);
  assert.deepEqual(suggest('SELECT o.| FROM (SELECT o.* FROM orders o) d'),[]);
});

test('correlated subqueries see outer bindings while shadowed and non-lateral sources stay isolated', () => {
  const fields=orders.columns.map(column=>column.name);
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE o.|)').map(item=>item.label),fields);
  assert.deepEqual(suggest('SELECT (SELECT o.| FROM customers c) FROM orders o').map(item=>item.label),fields);
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (SELECT o.| FROM customers o)').map(item=>item.label),customers.columns.map(column=>column.name));
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (SELECT o.| FROM unavailable o)'),[]);
  assert.deepEqual(suggest('SELECT * FROM orders o JOIN (SELECT o.|) d ON true'),[]);
  assert.deepEqual(suggest('SELECT * FROM orders o JOIN LATERAL (SELECT o.|) d ON true').map(item=>item.label),fields);
  assert.deepEqual(suggest('SELECT * FROM orders o CROSS APPLY (SELECT o.|) d','mssql').map(item=>item.label),fields);
  assert.deepEqual(suggest('SELECT * FROM orders o JOIN LATERAL (SELECT c.|) d ON true JOIN customers c ON true'),[]);
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (SELECT * FROM (SELECT o.|) d)').map(item=>item.label),fields);
  assert.deepEqual(suggest('SELECT * FROM orders o WHERE EXISTS (WITH x AS (SELECT o.|) SELECT * FROM x)').map(item=>item.label),fields);
});

test('nested WITH scopes, sequential CTE visibility and recursive declared fields are isolated', () => {
  assert.deepEqual(suggest('WITH x AS (SELECT id FROM orders), y AS (SELECT x.* FROM x) SELECT y.| FROM y').map(item=>item.label),['id']);
  assert.deepEqual(suggest('WITH x AS (SELECT name FROM customers) SELECT d.| FROM (WITH x AS (SELECT amount FROM orders) SELECT x.* FROM x) d').map(item=>item.label),['amount']);
  assert.deepEqual(suggest('WITH x AS (SELECT name FROM customers) SELECT x.| FROM x WHERE EXISTS (WITH x AS (SELECT amount FROM orders) SELECT 1 FROM x)').map(item=>item.label),['name']);
  assert.ok(!suggest('WITH x AS (SELECT * FROM |), y AS (SELECT name FROM customers) SELECT * FROM y').some(item=>item.label==='y'));
  assert.deepEqual(suggest('WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT x.| FROM x WHERE n<5) SELECT * FROM x').map(item=>item.label),['n']);
  assert.deepEqual(suggest('WITH x AS MATERIALIZED (SELECT customer_id FROM orders) SELECT x.| FROM x').map(item=>item.label),['customer_id']);
  assert.ok(suggest('WITH orders AS (SELECT name FROM customers) SELECT * FROM public.|').some(item=>item.kind==='table' && item.label==='orders' && item.detail!=='CTE'));
});

test('UNION branches expose only their own aliases and derived output names come from the first branch', () => {
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT customer_id cid FROM orders UNION ALL SELECT id FROM customers) d').map(item=>item.label),['cid']);
  assert.deepEqual(suggest('SELECT * FROM (SELECT o.id FROM orders o UNION ALL SELECT o.| FROM customers c) d'),[]);
  assert.deepEqual(suggest('SELECT * FROM (SELECT c.| FROM orders o UNION ALL SELECT c.id FROM customers c) d'),[]);
  assert.ok(!suggest('SELECT * FROM (SELECT customer_id,tenant_id FROM orders UNION ALL SELECT id,tenant_id FROM customers) d JOIN |').some(item=>item.kind==='join'));
});

test('projection inference preserves known column and CAST types without guessing arithmetic types', () => {
  const items=suggest('SELECT d.| FROM (SELECT amount AS renamed, amount+1 AS calculated, CAST(amount AS decimal(12,3)) AS converted, COUNT(*) AS total FROM orders GROUP BY amount) d');
  assert.match(items.find(item=>item.label==='renamed')!.detail,/bigint/);
  assert.match(items.find(item=>item.label==='calculated')!.detail,/тип не определён/);
  assert.match(items.find(item=>item.label==='converted')!.detail,/decimal\(12,3\)/);
  assert.match(items.find(item=>item.label==='total')!.detail,/bigint/);
  assert.match(suggest('SELECT d.| FROM (SELECT amount::numeric(14,2) AS converted FROM orders) d')[0]!.detail,/numeric\(14,2\)/);
  assert.match(suggest('SELECT d.| FROM (SELECT COUNT(*) AS n FROM orders) d','mssql')[0]!.detail,/ · int$/);
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT TOP (10) id AS order_id FROM orders) d','mssql').map(item=>item.label),['order_id']);
});

test('JOIN suggestions follow unchanged projected composite keys and never computed or incomplete keys', () => {
  const sql='SELECT * FROM (SELECT customer_id AS cid, tenant_id AS tenant FROM orders) d JOIN |';
  assert.ok(suggest(sql).some(item=>item.kind==='join' && item.insertText.includes('"d"."cid" = "c"."id" AND "d"."tenant" = "c"."tenant_id"')));
  assert.ok(suggest('WITH x AS (SELECT customer_id AS cid,tenant_id FROM orders) SELECT * FROM x JOIN customers c ON |').some(item=>item.kind==='join' && item.insertText==='"x"."cid" = "c"."id" AND "x"."tenant_id" = "c"."tenant_id"'));
  for(const projection of ['customer_id','customer_id+1 AS customer_id,tenant_id','CAST(customer_id AS bigint) AS customer_id,tenant_id','customer_id AS id,tenant_id AS id']) {
    assert.ok(!suggest(`SELECT * FROM (SELECT ${projection} FROM orders) d JOIN |`).some(item=>item.kind==='join'),projection);
  }
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT o.id,c.id FROM orders o JOIN customers c ON true) d'),[]);
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT customer_id AS ID,tenant_id AS id FROM orders) d','mysql'),[]);
  assert.ok(!suggest('SELECT * FROM (SELECT customer_id AS ID,tenant_id AS id FROM orders) d JOIN |','mysql').some(item=>item.kind==='join'));
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT customer_id AS "ID",tenant_id AS "id" FROM orders) d').map(item=>item.label),['ID','id']);
});

test('metadata dependencies inside CTEs and derived queries are loaded without touching other statements', () => {
  const text='SELECT * FROM ignored.secret; WITH x AS (SELECT * FROM finance.orders) SELECT d. FROM (SELECT x.*,c.name FROM x JOIN crm.customers c ON true) d; SELECT * FROM unused.table';
  assert.deepEqual(requestedSchemas(text,text.indexOf('d. ')+2,index,'postgres'),[{catalog:'analytics',schema:'finance'},{catalog:'analytics',schema:'crm'}]);
});

test('completion tokenization follows database comment rules and incomplete derived input remains usable', () => {
  assert.deepEqual(suggest('SELECT 1 # o.| FROM orders o','mysql'),[]);
  assert.deepEqual(suggest('SELECT 1 /* o.| */ FROM orders o','postgres'),[]);
  assert.deepEqual(suggest('SELECT * FROM (SELECT o.| FROM orders o').map(item=>item.label),orders.columns.map(column=>column.name));
  assert.deepEqual(suggest('SELECT public.orders.| FROM public.orders').map(item=>item.label),orders.columns.map(column=>column.name));
  assert.deepEqual(suggest('SELECT public.orders.| FROM public.orders o'),[]);
});

test('ORDER BY exposes output aliases, while WHERE and window expressions keep their own scopes', () => {
  const sql='SELECT amount+1 AS total FROM orders';
  assert.ok(suggest(`${sql} ORDER BY |`).some(item=>item.label==='total' && item.rank===0));
  assert.ok(!suggest(`${sql} WHERE |`).some(item=>item.label==='total'));
  assert.ok(!suggest('SELECT amount+1 AS total, SUM(amount) OVER (ORDER BY |) FROM orders').some(item=>item.label==='total'));
  const union='SELECT amount AS result FROM orders o UNION ALL SELECT id AS other FROM customers c ORDER BY ';
  assert.deepEqual(suggest(union+'|').filter(item=>item.kind==='column').map(item=>item.label),['result']);
  assert.deepEqual(suggest(union+'c.|'),[]);
});

test('array expressions and quoted aliases preserve projection boundaries; excessive input is bounded', () => {
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT ARRAY[1,2] AS values_array, id FROM orders) d').map(item=>item.label),['values_array','id']);
  assert.deepEqual(suggest('SELECT d.| FROM (SELECT customer_id AS "Customer ID", tenant_id AS "Tenant" FROM orders) d').map(item=>item.label),['Customer ID','Tenant']);
  assert.deepEqual(suggest('SELECT '+ '('.repeat(129) + 'o.|' + ')'.repeat(129) + ' FROM orders o'),[]);
  assert.deepEqual(completeSQL(' '.repeat(1_000_001),0,index,'postgres'),[]);
  const huge={...index,tables:[{...orders,columns:Array.from({length:50001},(_,i)=>({name:`c${i}`,type:'bigint'}))}]};
  assert.deepEqual(suggest('SELECT o.| FROM orders o','postgres',huge),[]);
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
