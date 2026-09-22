import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DdlStore, ddlHash, ddlFileName } from '../electron/ddl-store';
import { ddlIndex } from '../src/ddl-index';
import { readDdl } from '../electron/ddl-reader';
import type { DdlMapping } from '../src/ddl';
const mapping: DdlMapping = {id:'m',name:'DDL',profileId:'p',directory:tmpdir(),catalog:'main',schema:'main'};
test('DDL index preserves quoted names, nested types, composite and inferred foreign keys', () => {
  const index=ddlIndex(mapping,[{file:'schema.sql',sql:`
    CREATE TABLE "parent" ("a" DECIMAL(12, 2), "b" varchar(60) DEFAULT 'not,a,column', PRIMARY KEY ("a","b"));
    CREATE TABLE child (id INTEGER PRIMARY KEY, a DECIMAL(12,2), b varchar(60), CONSTRAINT fk FOREIGN KEY(a,b) REFERENCES parent);
    CREATE TABLE mixed ("Order ID" INTEGER REFERENCES child(id), payload ARRAY(ROW(name VARCHAR, score DECIMAL(8,2))));
  `}], 'sqlite');
  assert.deepEqual(index.tables.map(table=>table.columns.map(column=>column.name)),[['a','b'],['id','a','b'],['Order ID','payload']]);
  assert.equal(index.tables[0]?.columns[0]?.type,'DECIMAL(12, 2)');
  assert.equal(index.relationships.length,2); assert.deepEqual(index.relationships[0]?.columns,[{source:'a',target:'a'},{source:'b',target:'b'}]);
  assert.equal(index.warnings.length,0);
  const broken=ddlIndex(mapping,[{file:'broken.sql',sql:'CREATE TABLE t(a INT); CREATE TABLE t(b INT); ALTER TABLE x ADD y INT;'}],'postgres');
  assert.equal(broken.tables.length,0); assert.ok(broken.warnings.some(value=>value.includes('ALTER')));
});
test('DDL literals follow the selected dialect instead of swallowing following columns', () => {
  const sqlite = ddlIndex(mapping,[{file:'sqlite.sql',sql:String.raw`CREATE TABLE t(path TEXT DEFAULT '\', next_col INT);`}],'sqlite');
  assert.deepEqual(sqlite.tables[0]?.columns.map(item=>item.name),['path','next_col']);
  const mysql = ddlIndex(mapping,[{file:'mysql.sql',sql:String.raw`# local comment
CREATE TABLE t(path TEXT DEFAULT '\\', next_col INT); # final comment`}],'mysql');
  assert.deepEqual(mysql.tables[0]?.columns.map(item=>item.name),['path','next_col']);
  assert.equal(mysql.warnings.length,0);
});
test('DDL comparison detects stale files before writing; backups preserve edits and local-only files', async () => {
  const work=await mkdtemp(join(tmpdir(),'ddl-test-')),directory=join(work,'sql'); await mkdir(directory);
  const store=new DdlStore(join(work,'mappings.json'));
  try {
    await store.save({...mapping,directory});
    await writeFile(join(directory,'t.sql'),'CREATE TABLE t(old INT);'); await writeFile(join(directory,'local.sql'),'-- local');
    let preview=await store.preview('m',[{file:'t.sql',sql:'CREATE TABLE t(new INT);'},{file:'new.sql',sql:'CREATE TABLE n(id INT);'}],[]);
    assert.equal(preview.differences.find(item=>item.file==='local.sql')?.status,'local-only');
    await writeFile(join(directory,'t.sql'),'-- external edit');
    await assert.rejects(store.writePreview(preview.token,['t.sql','new.sql']),/изменён снаружи/);
    assert.ok(!(await readdir(directory)).includes('new.sql'));
    preview=await store.preview('m',[{file:'t.sql',sql:'CREATE TABLE t(new INT);'}],[]);
    await store.writePreview(preview.token,['t.sql']);
    assert.equal(await readFile(join(directory,'t.sql'),'utf8'),'CREATE TABLE t(new INT);');
    const backups=await readdir(join(directory,'.local-db-viewer-backup'));
    assert.equal(await readFile(join(directory,'.local-db-viewer-backup',backups[0]!,'t.sql'),'utf8'),'-- external edit');
    await assert.rejects(store.writeFile('m','../escape.sql','',ddlHash('x')),/Некорректный/);
    await assert.rejects(store.writeFile('m','t.sql','',ddlHash('wrong')),/изменён снаружи/);
    await store.remove('m'); assert.equal(await readFile(join(directory,'local.sql'),'utf8'),'-- local');
  } finally {await rm(work,{recursive:true,force:true});}
});
test('DDL rejects oversized files, links, unsafe names and invalid UTF-8 without overwriting', async () => {
  const work=await mkdtemp(join(tmpdir(),'ddl-bounds-')),directory=join(work,'sql'); await mkdir(directory);
  const store=new DdlStore(join(work,'mappings.json'));
  try {
    await store.save({...mapping,directory});
    await writeFile(join(directory,'large.sql'),Buffer.alloc(1_000_001)); await assert.rejects(store.files('m'),/лимит/); await rm(join(directory,'large.sql'));
    await writeFile(join(directory,'invalid.sql'),Buffer.from([0xff])); await assert.rejects(store.files('m')); await rm(join(directory,'invalid.sql'));
    if(process.platform!=='win32') {await writeFile(join(work,'outside.sql'),'SELECT 1');await symlink(join(work,'outside.sql'),join(directory,'linked.sql'));await assert.rejects(store.files('m'),/недопустимый/);}
    assert.ok(!ddlFileName('table','../CON / 名').includes('/'));
  }finally{await rm(work,{recursive:true,force:true});}
});
test('native DDL uses complete server definitions and rejects truncated metadata', async () => {
  const connection={id:'p',name:'Fixture',engine:'trino' as const,endpoint:'https://db.example',user:'u',auth:'none' as const,tls:true,catalog:'cat',schema:'s',jdbc:{}};
  const queries:string[]=[];
  const result=await readDdl(connection,{...mapping,catalog:'ca"t',schema:'s'},async sql=>{queries.push(sql);return {columns:[],rows:sql.startsWith('SELECT')?[['t','BASE TABLE']]:[['CREATE TABLE "ca""t"."s"."t" (id bigint)']],truncated:false};});
  assert.match(queries[1]!,/^SHOW CREATE TABLE "ca""t"\."s"\."t"$/); assert.ok(result.files[0]?.sql.endsWith(';\n'));
  await assert.rejects(readDdl(connection,mapping,async()=>({columns:[],rows:[],truncated:true})),/лимит/);
});
