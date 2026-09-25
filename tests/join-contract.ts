import assert from 'node:assert/strict';
import { completeSQL } from '../src/completion';
import type { DatabaseEngine, SchemaIndex, TableMeta } from '../src/shared';

/** Compare inferred CTE fields with a real engine's result metadata, then execute accepted completions. */
export async function joinContract(engine: DatabaseEngine, query: (sql:string)=>Promise<string[]>): Promise<number> {
  const tables: TableMeta[]=[
    {catalog:'fixture',schema:'public',name:'join_left',columns:['left_only','shared','id','tenant'].map(name=>({name,type:'bigint'}))},
    {catalog:'fixture',schema:'public',name:'join_right',columns:['right_only','id','shared','tenant'].map(name=>({name,type:'bigint'}))},
  ];
  const index: SchemaIndex={profileId:'fixture',catalog:'fixture',schema:'public',tables,relationships:[],warnings:[]};
  for(const table of tables)await query(`CREATE TEMPORARY TABLE ${table.name} (${table.columns.map(column=>`${column.name} bigint`).join(',')})`);
  await query('INSERT INTO join_left VALUES (10,1,1,1),(20,2,2,2)');
  await query('INSERT INTO join_right VALUES (100,1,1,1),(300,3,3,3)');
  const queries=[
    ...['INNER','LEFT','RIGHT','FULL'].map(type=>`SELECT * FROM join_left a ${type} JOIN join_right b USING (tenant,id,shared)`),
    ...['INNER','LEFT','RIGHT','FULL'].map(type=>`SELECT * FROM join_left a NATURAL ${type} JOIN join_right b`),
    'SELECT a.*, b.right_only FROM join_left a LEFT JOIN join_right b USING (id,shared,tenant)',
    'SELECT id AS merged_id, tenant FROM join_left a FULL JOIN join_right b USING (id,shared,tenant)',
  ];
  for(const sql of queries) {
    const actual=await query(sql);
    const text=`WITH projected AS (${sql}) SELECT p. FROM projected p`;
    const offset=text.indexOf('p. FROM')+2;
    const items=completeSQL(text,offset,index,engine);
    assert.deepEqual(items.map(item=>item.label),actual,`${engine}: ${sql}`);
    for(const item of items)await query(text.slice(0,item.start)+item.insertText+text.slice(item.end));
  }
  const text='SELECT * FROM join_left a JOIN join_right b USING ()',offset=text.length-1;
  const items=completeSQL(text,offset,index,engine);
  assert.deepEqual(items.map(item=>item.label),['shared','id','tenant']);
  for(const item of items)await query(text.slice(0,item.start)+item.insertText+text.slice(item.end));
  return queries.length;
}
