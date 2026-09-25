import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { joinContract } from './join-contract';
import { completeSQL } from '../src/completion';
import type { DatabaseEngine, SchemaIndex, TableMeta } from '../src/shared';

const table=(name:string,columns:string[]):TableMeta=>({catalog:'test',schema:'public',name,columns:columns.map(name=>({name,type:'bigint'}))});
const left=table('left_table',['left_only','shared','id','tenant']);
const right=table('second',['right_only','id','shared','tenant']);
const third=table('third',['left_only','id','third_only']);
const parent=table('parent',['parent_id']);
const index:SchemaIndex={profileId:'fixture',catalog:'test',schema:'public',tables:[left,right,third,parent],warnings:[],relationships:[{
  id:'left_fk',name:'left_fk',kind:'foreign-key',source:left,target:parent,columns:[{source:'id',target:'parent_id'}],
}]};
function suggest(sql:string,engine:DatabaseEngine='postgres',schema=index) {
  const offset=sql.indexOf('|');assert.ok(offset>=0);
  return completeSQL(sql.replace('|',''),offset,schema,engine);
}
const labels=(sql:string,engine:DatabaseEngine='postgres',schema=index)=>suggest(sql,engine,schema).filter(item=>item.kind==='column').map(item=>item.label);

test('USING offers unique common names only, excludes other entries and replaces the whole edited name',()=>{
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (|)'),['shared','id','tenant']);
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (id,|)'),['shared','tenant']);
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (|, id)'),['shared','tenant']);
  const sql='SELECT * FROM left_table a JOIN second b USING (id, te|nant, shared)';
  const items=suggest(sql);assert.deepEqual(items.map(item=>item.label),['tenant']);
  assert.equal(sql.replace('|','').slice(items[0]!.start,items[0]!.end),'tenant');
  assert.equal(items[0]!.insertText,'"tenant"');
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (/* keys */ id, |'),['shared','tenant']);
  for(const expression of ['a.|','COALESCE(|)','id |','id + |'])assert.deepEqual(suggest(`SELECT * FROM left_table a JOIN second b USING (${expression})`),[],expression);
  assert.deepEqual(suggest("SELECT * FROM left_table a JOIN second b USING ('|')"),[]);
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN (SELECT id,id FROM second) b USING (|)'),[]);
});

test('merged names stay unqualified while qualified source fields follow the dialect',()=>{
  const sql='SELECT | FROM left_table a JOIN second b USING (id,tenant)';
  const items=labels(sql);
  assert.ok(items.includes('id') && items.includes('tenant'));
  assert.ok(!items.includes('a.id') && !items.includes('b.id'));
  assert.ok(items.includes('a.shared') && items.includes('b.shared'));
  assert.deepEqual(labels(sql.replace('SELECT |','SELECT b.|')),right.columns.map(column=>column.name));
  assert.deepEqual(labels(sql.replace('SELECT |','SELECT b.|'),'trino'),['right_only','shared']);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT b.* FROM left_table a JOIN second b USING (id,tenant)) d','trino'),['right_only','shared']);
  const commonOnly={...index,tables:[table('a',['id']),table('b',['id'])]};
  assert.deepEqual(labels('SELECT | FROM a JOIN b USING (id)','trino',commonOnly),['id']);
  assert.ok(labels(sql+' JOIN third c ON true').includes('a.id'));
  assert.ok(labels(sql+' JOIN third c ON true').includes('b.id'));
  assert.ok(labels(sql+' JOIN third c ON true').includes('c.id'));
  assert.ok(!labels(sql+' JOIN third c ON true').includes('id'));
});

test('SELECT star exposes USING/NATURAL column order through derived tables and CTEs',()=>{
  const derived='SELECT d.| FROM (SELECT * FROM left_table a JOIN second b USING (tenant,id,shared)) d';
  assert.deepEqual(labels(derived),['tenant','id','shared','left_only','right_only']);
  assert.deepEqual(labels(derived,'trino'),['tenant','id','shared','left_only','right_only']);
  assert.deepEqual(labels(derived,'sqlite'),['left_only','shared','id','tenant','right_only']);
  for(const engine of ['mysql','mariadb'] as const) {
    assert.deepEqual(labels(derived,engine),['shared','id','tenant','left_only','right_only']);
    assert.deepEqual(labels(derived.replace('a JOIN','a RIGHT JOIN'),engine),['id','shared','tenant','right_only','left_only']);
  }
  assert.deepEqual(labels('WITH x AS (SELECT * FROM left_table NATURAL LEFT JOIN second) SELECT x.| FROM x'),['shared','id','tenant','left_only','right_only']);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM left_table NATURAL JOIN parent) d'),[...left.columns.map(c=>c.name),'parent_id']);
  assert.ok(!suggest('SELECT * FROM left_table NATURAL JOIN |').some(item=>item.kind==='join'));
});

test('JOIN chains use the joined left operand and respect comma precedence',()=>{
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (id,shared,tenant) JOIN third c USING (|)'),['id','left_only']);
  assert.deepEqual(labels('SELECT * FROM left_table a, second b JOIN third c USING (|)'),['id']);
  // SQLite evaluates comma and explicit JOIN at the same precedence; ambiguous names are omitted conservatively.
  assert.deepEqual(labels('SELECT * FROM left_table a, second b JOIN third c USING (|)','sqlite'),['left_only']);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM left_table a JOIN second b USING (id,shared,tenant) JOIN third c USING (left_only,id)) d'),['left_only','id','shared','tenant','right_only','third_only']);
  assert.deepEqual(labels('SELECT * FROM left_table a, missing b JOIN third c USING (|)'),[]);
});

test('outer-join lineage follows only the unchanged preserved key and never a coalesced FULL key',()=>{
  for(const type of ['INNER','LEFT','RIGHT','FULL']) {
    const sql=`SELECT * FROM (SELECT id FROM left_table a ${type} JOIN second b USING (id)) d JOIN |`;
    assert.equal(suggest(sql).some(item=>item.kind==='join' && item.detail.includes('left_fk')),type==='INNER' || type==='LEFT',type);
  }
  const differentTypes={...index,tables:[{...left,columns:left.columns.map(column=>({...column,type:'integer'}))},right,parent]};
  assert.ok(!suggest('SELECT * FROM (SELECT id FROM left_table a LEFT JOIN second b USING (id)) d JOIN |','postgres',differentTypes).some(item=>item.kind==='join'));
  assert.match(suggest('SELECT d.| FROM (SELECT id FROM left_table a FULL JOIN second b USING (id)) d')[0]!.detail,/bigint/);
});

test('merged columns remain available in correlated, lateral and nested scopes',()=>{
  assert.match(suggest('SELECT d.| FROM (SELECT (id) AS key FROM left_table JOIN second USING (id)) d')[0]!.detail,/bigint/);
  assert.match(suggest('SELECT d.| FROM left_table a JOIN second b USING (id) JOIN LATERAL (SELECT id AS key) d ON true')[0]!.detail,/bigint/);
  assert.ok(labels('SELECT * FROM left_table a JOIN second b USING (id) WHERE EXISTS (SELECT | FROM parent p)').includes('id'));
  assert.ok(labels('SELECT * FROM left_table a JOIN second b USING (id) WHERE EXISTS (SELECT | FROM third t)').includes('t.id')===false);
  assert.deepEqual(labels('SELECT * FROM left_table a JOIN second b USING (id) WHERE EXISTS (SELECT * FROM parent p JOIN third t USING (|))'),[]);
  const renamed='WITH x AS (SELECT * FROM left_table JOIN second USING (id,shared,tenant)) SELECT * FROM x JOIN third USING (|)';
  assert.deepEqual(labels(renamed),['id','left_only']);
});

test('unknown, invalid and unsupported joins never fabricate a merged star or USING candidates',()=>{
  for(const source of ['missing JOIN second USING (id)','left_table JOIN second USING (id,id)','left_table JOIN second USING (absent)',
    'left_table NATURAL JOIN second ON true','left_table JOIN second USING (id) AS joined','left_table CROSS JOIN second USING (id)']) {
    assert.deepEqual(labels(`SELECT d.| FROM (SELECT * FROM ${source}) d`),[],source);
  }
  for(const engine of ['mssql','jdbc','clickhouse'] as const)assert.deepEqual(suggest('SELECT * FROM left_table JOIN second USING (|)',engine),[]);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM left_table NATURAL JOIN second) d','trino'),[]);
  const quoted={...index,tables:[table('a',['ID','id']),table('b',['ID','id'])]};
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM a JOIN b USING ("ID",id)) d','postgres',quoted),['ID','id']);
  assert.deepEqual(labels('SELECT * FROM a JOIN b USING (id, |)','postgres',quoted),['ID']);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM (SELECT id,id FROM left_table) a NATURAL JOIN second b) d'),[]);
  assert.deepEqual(labels('SELECT d.| FROM (SELECT * FROM left_table JOIN second USING(ID,SHARED,TENANT)) d','sqlite'),['left_only','shared','id','tenant','right_only']);
});

test('JOIN projection order and accepted suggestions match real SQLite metadata',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    assert.equal(await joinContract('sqlite',async sql=>{
      const statement=db.prepare(sql),columns=statement.columns();
      statement.all();return columns.map(column=>column.name);
    }),10);
  } finally {db.close();}
});
