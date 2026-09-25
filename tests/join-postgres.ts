import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { joinContract } from './join-contract';

if(process.env.CI!=='true' || !process.env.LDV_DDL_SERVER_TEST)throw new Error('Run only against disposable CI PostgreSQL.');
const client=new Client({host:'127.0.0.1',port:Number(process.env.LDV_PG_PORT),user:'postgres',password:'fixture-postgres',database:'postgres'});
await client.connect();
try {
  await client.query('BEGIN');
  const cases=await joinContract('postgres',async sql=>(await client.query(sql)).fields.map(field=>field.name));
  await mkdir('test-artifacts',{recursive:true});
  await writeFile('test-artifacts/ddl-join-completion-postgres.json',JSON.stringify({passed:true,engine:'postgres',cases,executedSuggestions:true},null,2));
  console.log(`PASS: ${cases} real PostgreSQL JOIN projections and accepted suggestions`);
} finally {
  await client.query('ROLLBACK').catch(()=>{});
  await client.end();
}
