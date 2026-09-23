import test from 'node:test';
import assert from 'node:assert/strict';
import { ddlConnection, readDdl } from '../electron/ddl-reader';
import { DdlFiles } from '../electron/ddl-catalog';
import { ddlIndex } from '../src/ddl-index';
import type { Connection } from '../electron/trino';
import type { DdlMapping } from '../src/ddl';

const mapping: DdlMapping = {id:'ddl',name:'DDL',profileId:'p',directory:'/unused',catalog:'db',schema:'s'};
const connection: Connection = {id:'p',name:'PG',engine:'postgres',endpoint:'postgresql://localhost/db',user:'u',auth:'none',tls:false,catalog:'db',schema:'s',jdbc:{options:{singleSession:true,autoCommit:false,keepAliveSeconds:5,startupStatements:['SET statement_timeout = 10000']}}};
const result = (rows: unknown[]) => ({columns:[],rows:rows.map(row=>[JSON.stringify(row)]),truncated:false});

test('catalog export gets an isolated session without changing the stored profile or authentication', () => {
  const isolated=ddlConnection(connection);
  assert.equal(isolated.jdbc?.options?.singleSession,false);
  assert.equal(isolated.jdbc?.options?.autoCommit,true);
  assert.equal(connection.jdbc?.options?.singleSession,true);
  assert.equal(connection.jdbc?.options?.autoCommit,false);
  assert.deepEqual(isolated.jdbc?.options?.startupStatements,connection.jdbc?.options?.startupStatements);
  assert.equal(ddlConnection({...connection,engine:'trino'}).jdbc?.options?.singleSession,true);
});

test('PostgreSQL refuses incomplete policy/partition exports and rolls back its snapshot', async () => {
  const queries: string[]=[];
  await assert.rejects(readDdl(connection,mapping,async sql=>{
    queries.push(sql);
    if(sql.includes('server_version_num')) return result([{database:'db',version:170000}]);
    if(sql.includes('SELECT n.oid')) return result([{id:'1'}]);
    if(sql.includes('c.relkind::text')) return result([{id:'2',name:'sensitive',kind:'r',partition:false,typed:false,policies:true}]);
    return result([]);
  }),/policies.*без записи/);
  assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(queries.includes('SET LOCAL search_path = pg_catalog'));
  assert.equal(queries.at(-1),'ROLLBACK');
});

test('SQL Server requires database VIEW DEFINITION rather than exporting a silently partial schema', async () => {
  const profile={...connection,engine:'mssql' as const};
  await assert.rejects(readDdl(profile,mapping,async()=>result([{database:'db',version:16,permitted:false}])),/VIEW DEFINITION/);
  await assert.rejects(readDdl(profile,mapping,async()=>result([{database:'wrong',version:16,permitted:true}])),/catalog/);
  await assert.rejects(readDdl(profile,mapping,async()=>result([{database:'db',version:17,permitted:true}])),/2019–2022/);
});

test('generated DDL limits apply while accumulating definitions', () => {
  const files=new DdlFiles();
  assert.throws(()=>files.add('table','large','x'.repeat(1_000_001)),/лимит/);
  assert.equal(files.files.length,0);
  files.add('table','t','CREATE TABLE t(id int)');
  assert.throws(()=>files.add('table','t','CREATE TABLE t(id text)'),/повторное/);
});

test('offline JOINs resolve composite ALTER foreign keys across files, including ONLY and WITH NOCHECK', () => {
  for(const engine of ['postgres','mssql'] as const) {
    const files=[
      {file:'fk.sql',sql:`ALTER TABLE ${engine==='postgres'?'ONLY ':''}s.child ${engine==='mssql'?'WITH NOCHECK ':''}ADD CONSTRAINT fk FOREIGN KEY(a,b) REFERENCES s.parent(a,b);`},
      {file:'tables.sql',sql:'CREATE TABLE s.parent(a int,b int); CREATE TABLE s.child(a int,b int);'},
      {file:'pk.sql',sql:'ALTER TABLE s.parent ADD CONSTRAINT pk PRIMARY KEY(a,b);'},
      {file:'inferred.sql',sql:'CREATE TABLE s.inferred(a int,b int, FOREIGN KEY(a,b) REFERENCES s.parent);'},
    ];
    const index=ddlIndex(mapping,files,engine);
    assert.equal(index.relationships.length,2);
    assert.deepEqual(index.relationships[0]?.columns,[{source:'a',target:'a'},{source:'b',target:'b'}]);
    assert.deepEqual(index.relationships[1]?.columns,[{source:'a',target:'a'},{source:'b',target:'b'}]);
    assert.deepEqual(index.warnings,[]);
  }
  const bad=ddlIndex(mapping,[{file:'x.sql',sql:'CREATE TABLE s.a(id int); ALTER TABLE s.a ADD FOREIGN KEY(missing) REFERENCES s.a(id);'}],'postgres');
  assert.equal(bad.relationships.length,0);
});

test('named NOT NULL and clustered primary keys do not create phantom columns', () => {
  const pg=ddlIndex(mapping,[{file:'pg.sql',sql:'CREATE TABLE s.t(id integer, CONSTRAINT id_required NOT NULL id);'}],'postgres');
  assert.deepEqual(pg.tables[0]?.columns.map(column=>column.name),['id']);
  const ms=ddlIndex(mapping,[{file:'ms.sql',sql:'CREATE TABLE s.t(id int, value AS (id*2) PERSISTED, CONSTRAINT pk PRIMARY KEY CLUSTERED(id DESC)); CREATE TABLE s.child(id int REFERENCES s.t);'}],'mssql');
  assert.equal(ms.tables[0]?.columns[1]?.type,'computed');
  assert.deepEqual(ms.relationships[0]?.columns,[{source:'id',target:'id'}]);
});
