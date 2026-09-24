import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnectionOptions } from '../electron/connection-options';
import { readObjectSources, shouldLoadSources, SourceCache, supportsObjectSources } from '../electron/object-sources';
import { withSystemCatalogs } from '../src/systemCatalogs';
import { completeSQL } from '../src/completion';
import { formatSQL } from '../src/formatSql';
import { generatedStyle } from '../src/codeStyle';
import type { Profile } from '../src/shared';
import type { SchemaIndex } from '../src/shared';
import type { SourceIndex } from '../src/sources';

const profile: Profile = { id: 'p', hasSecret: false, name: 'fixture', engine: 'trino', endpoint: 'https://db.invalid', auth: 'none', tls: true, user: 'u', catalog: 'iceberg', schema: 'public', jdbc: {} };
const input = { profileId: 'p', catalog: 'iceberg', schema: 'public' };
const index: SchemaIndex = { ...input, tables: [], relationships: [], warnings: [] };

test('connection settings reject invalid modes and incomplete code styles', () => {
  validateConnectionOptions({ options: { switchSchema: 'manual', loadSources: 'none', preIntrospectedObjects: false, codeStyle: { keywordCase: 'lower', indentSize: 2, useTabs: false } } });
  for (const options of [{switchSchema:'bad'}, {loadSources:'bad'}, {preIntrospectedObjects:0}, {codeStyle:{}}, {codeStyle:{keywordCase:'upper',indentSize:0,useTabs:false}}, {codeStyle:{keywordCase:'upper',indentSize:2.5,useTabs:false}}]) assert.throws(() => validateConnectionOptions({ options } as never));
});
test('automatic source loading honors mode, system schema classification and schema scope', () => {
  assert.equal(shouldLoadSources(profile, input, true), true);
  for (const schema of ['pg_catalog', 'INFORMATION_SCHEMA', 'mysql', 'performance_schema', 'pg_temp_42']) assert.equal(shouldLoadSources(profile, { ...input, schema }, true), false);
  const none = { ...profile, jdbc: { options: { loadSources: 'none' as const } } };
  assert.equal(shouldLoadSources(none, input, true), false);
  assert.equal(shouldLoadSources(none, input, false), true);
  assert.equal(shouldLoadSources({ ...profile, jdbc: { options: { loadSources: 'all' } } }, { ...input, schema: 'information_schema' }, true), true);
  assert.equal(shouldLoadSources({ ...profile, jdbc: { schemas: {mode:'selected',selected:[]} } }, input, false), false);
  assert.equal(supportsObjectSources({ ...profile, engine: 'jdbc', jdbc: {driverId:'custom'} }), false);
});
test('source reader preserves SQL verbatim, null definitions, filters and unique object kinds', async () => {
  const sql = "CREATE VIEW v AS SELECT 'secret;--literal' AS value";
  const result = await readObjectSources({ ...profile, engine:'sqlite', jdbc:{ schemas:{mode:'all',selected:[],objectExclude:'*.hidden'} } }, { ...input,catalog:'',schema:'' }, async query => {
    assert.match(query,/main.sqlite_schema/);
    return { columns:[], rows:[['v','view','v',sql],['v','trigger','v',null],['hidden','view','hidden',sql]], truncated:false };
  });
  assert.equal(result.catalog,'main'); assert.equal(result.schema,'main');
  assert.equal(result.objects.length,2); assert.equal(result.objects[0]?.sql,sql); assert.equal(result.objects[1]?.sql,null);
  assert.notEqual(result.objects[0]?.id,result.objects[1]?.id); assert.match(result.warnings.join(' '),/прав/);
});
test('source SQL quotes catalog and schema names and bounds retained source text', async () => {
  const result = await readObjectSources(profile, { ...input,catalog:'odd"catalog',schema:"s' OR TRUE--" }, async sql => {
    assert.match(sql,/FROM "odd""catalog"\.information_schema.views/);
    assert.match(sql,/table_schema='s'' OR TRUE--'/);
    return {columns:[],rows:[['v','view','v','x'.repeat(2*1024*1024+1)]],truncated:true};
  });
  assert.equal(result.objects.length,0); assert.match(result.warnings.join(' '),/2 MB/); assert.match(result.warnings.join(' '),/неполный/);
});
test('source cache coalesces reads, refreshes and never retains failures', async () => {
  const cache = new SourceCache(); let reads=0;
  const source: SourceIndex={...input,objects:[],warnings:[],loadedAt:1};
  const read=async()=>{reads++;return source;};
  await Promise.all([cache.load(input,false,read),cache.load(input,false,read)]); assert.equal(reads,1);
  await cache.load(input,true,read); assert.equal(reads,2);
  cache.clear(input.profileId); await cache.load(input,false,read); assert.equal(reads,3);
  cache.clear(input.profileId); await assert.rejects(cache.load(input,false,async()=>{throw new Error('server unavailable');}));
  await cache.load(input,false,read); assert.equal(reads,4);
});
test('bundled catalog completion is marked, opt-out and object exclusions work; actual metadata wins', () => {
  const enriched=withSystemCatalogs(index,profile), table=enriched.tables.find(table=>table.name==='columns')!;
  assert.ok(table.columns.some(column=>column.name==='column_name'));
  const sql='SELECT c. FROM iceberg.information_schema.columns c';
  assert.ok(completeSQL(sql,9,enriched,'trino').some(item=>item.label==='column_name'&&item.detail.includes('встроенный справочник')));
  const actual={...table,columns:[{name:'real_column',type:'actual'}],metadataSource:undefined};
  assert.deepEqual(withSystemCatalogs({...index,tables:[actual]},profile).tables.find(table=>table.name==='columns'),actual);
  assert.equal(withSystemCatalogs(index,{...profile,jdbc:{options:{preIntrospectedObjects:false}}}),index);
  assert.ok(!withSystemCatalogs(index,{...profile,jdbc:{schemas:{mode:'all',selected:[],objectExclude:'*.columns'}}}).tables.some(table=>table.name==='columns'));
  assert.deepEqual(enriched.relationships,[]);
});
test('formatting follows dialect and code style while preserving literals, quoted names and comments', () => {
  const style={keywordCase:'lower' as const,indentSize:2,useTabs:false};
  const sql="SELECT [Select], 'UPPER;select' AS [Value] FROM [Table] WHERE [Select] = 1 -- Keep Case";
  const formatted=formatSQL(sql,'mssql',style);
  for(const text of ['[Select]', "'UPPER;select'", '[Value]', '[Table]', '-- Keep Case']) assert.ok(formatted.includes(text),text);
  assert.ok(formatted.startsWith('select\n  [Select]')); assert.ok(formatted.includes('\nfrom\n  [Table]'));
  assert.equal(generatedStyle('SELECT * FROM "Select" WHERE "WHERE" = \'FROM\'','postgres',style),'select * from "Select" where "WHERE" = \'FROM\'');
  assert.match(formatSQL('select count(*) from "T"','trino',{...style,useTabs:true}),/\n\t/);
  assert.throws(()=>formatSQL('SELECT '+ 'a'.repeat(128000),'sqlite'),/128 KB/);
  assert.throws(()=>formatSQL("SELECT 'secret_unclosed",'sqlite'),error=>error instanceof Error&&!error.message.includes('secret_unclosed'));
});
