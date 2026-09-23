import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from 'pg';
import { Connection as TdsConnection, Request } from 'tedious';
import { ddlConnection, readDdl } from '../electron/ddl-reader';
import { SessionPool } from '../electron/session-pool';
import { ddlIndex } from '../src/ddl-index';
import type { MetadataResult, DatabaseEngine, Cell } from '../src/shared';
import type { Connection } from '../electron/trino';
import { identifier } from '../electron/sql';

// Disposable CI databases only. No developer credentials or production hosts are used.
if (process.env.CI !== 'true' || !process.env.LDV_DDL_SERVER_TEST) throw new Error('Run against disposable PostgreSQL / SQL Server CI services.');
const resources=resolve('test-artifacts/ddl-jdbc-runtime');
await mkdir(resources,{recursive:true});
await symlink(resolve('runtime/common'),join(resources,'jdbc'),'dir');
await symlink(process.env.JAVA_HOME!,join(resources,'jre'),'dir');
Object.defineProperty(process,'resourcesPath',{value:resources});
const schema = `DDL ' quoted 名`, source = 'ldv_ddl_source', destination = 'ldv_ddl_restored';
type Query = (sql: string) => Promise<MetadataResult>;
function mapping(database: string) { return {id:'fixture',name:'fixture',profileId:'fixture',directory:'/unused',catalog:database,schema}; }
function profile(engine: DatabaseEngine, catalog: string): Connection { return {id:'fixture',name:'fixture',engine,endpoint:'fixture',catalog,schema,user:'fixture',auth:'none',tls:false,jdbc:{}}; }
async function postgres(database: string) {
  const client = new Client({host:'127.0.0.1',port:Number(process.env.LDV_PG_PORT),user:'postgres',password:'fixture-postgres',database});
  await client.connect();
  const query: Query = async sql => {
    const result = await client.query({text:sql,rowMode:'array'});
    const last = Array.isArray(result) ? result.at(-1)! : result;
    return {columns:[],rows:last.rows,truncated:false};
  };
  return {query,close:()=>client.end()};
}
async function mssql(database: string) {
  const client = new TdsConnection({server:'127.0.0.1',authentication:{type:'default',options:{userName:'sa',password:'Fixture-Only_4821Test'}},options:{port:Number(process.env.LDV_MSSQL_PORT),database,encrypt:false,trustServerCertificate:true,requestTimeout:30000}});
  await new Promise<void>((resolve,reject)=>{client.once('connect',error=>error?reject(error):resolve());client.once('error',reject);client.connect();});
  const query: Query = sql => new Promise((resolve,reject)=>{
    const rows: Cell[][] = [];
    const request = new Request(sql,error=>error?reject(new Error(`${error.message}\nFixture SQL:\n${sql}`,{cause:error})):resolve({columns:[],rows,truncated:false}));
    request.on('row',columns=>rows.push(columns.map((column: {value: Cell})=>column.value)));
    client.execSqlBatch(request);
  });
  return {query,close:()=>new Promise<void>(resolve=>{client.once('end',resolve);client.close();})};
}
const reports: {engine: string; passed: boolean; [key: string]: unknown}[] = [];
for (const engine of ['postgres','mssql'] as const) {
  const open = engine === 'postgres' ? postgres : mssql, q = (name:string)=>identifier(name,engine), s=q(schema);
  let admin: Awaited<ReturnType<typeof open>> | undefined;
  for(let attempt=0;attempt<60;attempt++) {
    try { admin=await open(engine==='postgres'?'postgres':'master');break; }
    catch(error) {if(attempt===59)throw error;await new Promise(resolve=>setTimeout(resolve,2000));}
  }
  assert.ok(admin);
  for(const database of [source,destination]) await admin.query(`CREATE DATABASE ${q(database)}`);
  await admin.close();
  const a=await open(source),b=await open(destination);
  try {
    for(const db of [a,b]) await db.query(`CREATE SCHEMA ${s}`);
    if(engine==='postgres') {
      for(const db of [a,b]) await db.query(`CREATE FUNCTION ${s}.fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await a.query(`CREATE TABLE ${s}.parent (a integer, b integer, label varchar(80) COLLATE "C" DEFAULT 'a;''b', amount numeric(12,3), doubled numeric GENERATED ALWAYS AS (amount*2) STORED,
        CONSTRAINT parent_pk PRIMARY KEY (a,b), CONSTRAINT positive CHECK(amount>=0)) WITH (fillfactor=77);
        CREATE TABLE ${s}.child (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 7 CACHE 3), a integer, b integer, label text, CONSTRAINT child_pk PRIMARY KEY(id));
        ALTER TABLE ${s}.child ADD CONSTRAINT child_parent FOREIGN KEY(a,b) REFERENCES ${s}.parent(a,b) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED NOT VALID;
        CREATE TABLE ${s}.serial_table (id serial PRIMARY KEY, value text);
        CREATE INDEX child_expression ON ${s}.child (lower(label)) INCLUDE(a) WHERE label IS NOT NULL;
        CREATE VIEW ${s}.v WITH (security_barrier=true) AS SELECT a,b,label FROM ${s}.parent;
        COMMENT ON TABLE ${s}.parent IS 'Table comment; quote '' and newline
next line'; COMMENT ON COLUMN ${s}.parent.label IS 'Unicode: 名';
        ALTER TABLE ${s}.child ALTER COLUMN label SET STORAGE EXTERNAL;
        ALTER TABLE ${s}.parent ALTER COLUMN label SET STATISTICS 120;
        CREATE TRIGGER child_trigger BEFORE INSERT ON ${s}.child FOR EACH ROW EXECUTE FUNCTION ${s}.fixture_trigger();
        ALTER TABLE ${s}.child DISABLE TRIGGER child_trigger;`);
    } else {
      await a.query(`CREATE TABLE ${s}.parent (id int IDENTITY(2,3) NOT NULL, code nvarchar(36) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
        amount decimal(12,3) CONSTRAINT parent_amount DEFAULT ((0)), doubled AS (amount*2) PERSISTED,
        CONSTRAINT parent_pk PRIMARY KEY CLUSTERED (id DESC) WITH (FILLFACTOR=83,DATA_COMPRESSION=ROW), CONSTRAINT parent_code UNIQUE NONCLUSTERED(code));
        CREATE TABLE ${s}.child (a int NOT NULL, b int NOT NULL, parent_id int NULL, label varchar(80) CONSTRAINT child_label DEFAULT ('semi;colon'),
        CONSTRAINT child_pk PRIMARY KEY NONCLUSTERED(a,b)) WITH (DATA_COMPRESSION=PAGE);
        ALTER TABLE ${s}.child WITH NOCHECK ADD CONSTRAINT child_parent FOREIGN KEY(parent_id) REFERENCES ${s}.parent(id) ON DELETE SET NULL;
        ALTER TABLE ${s}.child WITH NOCHECK ADD CONSTRAINT label_present CHECK(label IS NOT NULL);
        CREATE INDEX child_filtered ON ${s}.child(parent_id DESC) INCLUDE(label) WHERE parent_id IS NOT NULL WITH (FILLFACTOR=77,DATA_COMPRESSION=PAGE);`);
      await a.query(`CREATE VIEW ${s}.v AS SELECT id,code,amount FROM ${s}.parent`);
      await a.query(`ALTER VIEW ${s}.v AS SELECT id,code,amount,doubled FROM ${s}.parent`);
      await a.query(`CREATE TRIGGER ${s}.child_trigger ON ${s}.child AFTER INSERT AS BEGIN SET NOCOUNT ON; SELECT 1; END`);
      await a.query(`DISABLE TRIGGER ${s}.child_trigger ON ${s}.child`);
    }
    const first=await readDdl(profile(engine,source),mapping(source),a.query);
    assert.ok(first.files.length>5);
    const order=['sequence','table','index','check','foreign-key','sequence-owner','sequence-comment','view','trigger'];
    const kind=(file:string)=>order.find(value=>file.startsWith(value+'-')) ?? 'unknown';
    // Longer prefixes must win over "sequence".
    const rank=(file:string)=>order.indexOf(file.startsWith('sequence-owner-')?'sequence-owner':file.startsWith('sequence-comment-')?'sequence-comment':kind(file));
    const files=[...first.files].sort((a,b)=>rank(a.file)-rank(b.file)||a.file.localeCompare(b.file));
    for(const file of files) {
      const batches=engine==='mssql'?file.sql.split(/^GO\r?$/m):[file.sql];
      for(const batch of batches) if(batch.trim()) await b.query(batch);
    }
    const second=await readDdl(profile(engine,destination),mapping(destination),b.query);
    const sorted=(files:typeof first.files)=>[...files].sort((a,b)=>a.file.localeCompare(b.file));
    await mkdir('test-artifacts',{recursive:true});
    await writeFile(`test-artifacts/ddl-${engine}-before.json`,JSON.stringify(sorted(first.files),null,2));
    await writeFile(`test-artifacts/ddl-${engine}-after.json`,JSON.stringify(sorted(second.files),null,2));
    assert.deepEqual(sorted(second.files),sorted(first.files),`${engine}: export → restore → export must preserve definitions`);
    const jdbc: Connection = {...profile(engine,source),schema:'',user:engine==='postgres'?'postgres':'sa',auth:'basic',secret:engine==='postgres'?'fixture-postgres':'Fixture-Only_4821Test',
      endpoint:`${engine==='postgres'?'postgresql':'sqlserver'}://127.0.0.1:${engine==='postgres'?process.env.LDV_PG_PORT:process.env.LDV_MSSQL_PORT}/${source}`,jdbc:{options:{singleSession:true}}};
    const pool=new SessionPool(async profile=>profile),consoleLease=await pool.acquire(jdbc),ddlLease=await pool.acquire(ddlConnection(jdbc));
    try {
      assert.notEqual(consoleLease.session,ddlLease.session);
      const begin=await consoleLease.session.createQuery('begin').run(engine==='postgres'?'BEGIN':'BEGIN TRANSACTION');
      assert.equal(begin.state,'FINISHED',begin.error);
      const jdbcQuery: Query=async sql=>{
        const result=await ddlLease.session.createQuery(crypto.randomUUID(),10000,undefined,source,'').run(sql);
        if(result.state!=='FINISHED')throw new Error(result.error||result.state);
        return {columns:result.columns,rows:result.rows,truncated:result.truncated};
      };
      const throughJdbc=await readDdl(jdbc,mapping(source),jdbcQuery);
      assert.deepEqual(sorted(throughJdbc.files),sorted(first.files),'JDBC and native catalog readers must return identical definitions');
      assert.equal(consoleLease.session.inTransaction,true,'DDL must leave the SQL console transaction open');
      const rollback=await consoleLease.session.createQuery('rollback').run('ROLLBACK');assert.equal(rollback.state,'FINISHED',rollback.error);
    } finally {await ddlLease.release();await consoleLease.release();}
    const index=ddlIndex(mapping(source),first.files,engine);
    assert.ok(index.tables.some(table=>table.name==='child'));
    assert.ok(index.relationships.some(relation=>relation.source.name==='child'&&relation.target.name==='parent'),'exported ALTER FK must supply offline JOINs');
    if(engine==='postgres') {
      const path=(await a.query('SHOW search_path')).rows[0]?.[0];assert.notEqual(path,'pg_catalog');
      await a.query(`ALTER TABLE ${s}.parent ENABLE ROW LEVEL SECURITY`);
      await assert.rejects(readDdl(profile(engine,source),mapping(source),a.query),/policies/);
      assert.equal((await a.query('SHOW transaction_read_only')).rows[0]?.[0],'off');
    } else {
      await a.query(`CREATE USER fixture_hidden WITHOUT LOGIN`);
      await a.query(`EXECUTE AS USER = 'fixture_hidden'`);
      try { await assert.rejects(readDdl(profile(engine,source),mapping(source),a.query),/VIEW DEFINITION/); }
      finally {await a.query('REVERT');}
      await a.query(`ALTER TABLE ${s}.child ALTER COLUMN label ADD MASKED WITH (FUNCTION='default()')`);
      await assert.rejects(readDdl(profile(engine,source),mapping(source),a.query),/masked/);
    }
    reports.push({engine,passed:true,roundTrip:true,files:first.files.length,jdbc:true,consoleTransactionPreserved:true,offlineForeignKeys:true,unsupportedRejected:true});
    console.log(`PASS: ${engine} definitions → clean database → identical definitions, offline JOINs and guards`);
  } catch(error) {
    reports.push({engine,passed:false,error:(error as Error).stack});console.error(error);
  } finally {await a.close();await b.close();}
}
const passed=reports.every(report=>report.passed);
await writeFile('test-artifacts/ddl-servers-results.json',JSON.stringify({passed,reports},null,2));
assert.ok(passed,'DDL server integration failed; see per-engine errors and artifacts.');
