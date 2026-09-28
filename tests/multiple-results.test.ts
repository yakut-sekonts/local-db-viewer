import assert from 'node:assert/strict';
import test from 'node:test';
import { resultSets, resultSetView } from '../src/result-sets';
import { retainScriptData } from '../electron/script-runner';
import type { QuerySnapshot } from '../src/shared';

const fixture=(): QuerySnapshot=>({requestId:'query',queryId:'q1',state:'FAILED',resultState:'FINISHED',columns:[],rows:[],totalRows:0,truncated:false,updateType:'JDBC',updateCount:'0',stats:{},warnings:['warning'],inTransaction:true,error:'later failure',additionalResults:[
  {columns:[{name:'first',type:'varchar'}],rows:[['first']],totalRows:1,truncated:false,resultState:'FINISHED'},
  {columns:[{name:'second',type:'varchar'}],rows:[['partial']],totalRows:2,truncated:true,resultState:'FAILED',error:'partial failure'},
]});
test('result selection isolates columns, counts, errors and CSV rows while preserving session state',()=>{
  const value=fixture();
  assert.equal(resultSets(value).length,3);
  const first=resultSetView(value,0), table=resultSetView(value,1), partial=resultSetView(value,2);
  assert.equal(first.state,'FINISHED');assert.equal(first.updateCount,'0');assert.equal(first.error,undefined);
  assert.deepEqual(table.rows,[['first']]);assert.equal(table.updateCount,undefined);assert.equal(table.updateType,undefined);assert.equal(table.error,undefined);
  assert.equal(table.inTransaction,true);assert.deepEqual(table.warnings,['warning']);assert.equal(table.additionalResults,undefined);
  assert.equal(partial.state,'FAILED');assert.equal(partial.error,'partial failure');assert.deepEqual(partial.rows,[['partial']]);
  assert.notEqual(table.requestId,partial.requestId);
  value.dataLimited=true;
  assert.equal(resultSetView(value,1).dataLimited,undefined,'one result must not inherit another result\'s truncation');
  value.additionalResults![1]!.resultState='RUNNING';
  assert.equal(resultSetView(value,2).state,'FAILED','worker failure must terminate an unfinished result');
});
test('script retention charges all JDBC result sets to one byte budget without mutating snapshots',()=>{
  const value=fixture(), copy=structuredClone(value);
  const firstBytes=Buffer.byteLength(JSON.stringify(value.columns));
  const second=value.additionalResults![0]!;
  const secondBytes=Buffer.byteLength(JSON.stringify(second.columns))+Buffer.byteLength(JSON.stringify(second.rows[0]));
  const kept=retainScriptData(value,firstBytes+secondBytes);
  assert.equal(kept.bytes,firstBytes+secondBytes);assert.equal(kept.limited,true);
  assert.deepEqual(kept.snapshot.additionalResults![0]!.rows,[['first']]);
  assert.deepEqual(kept.snapshot.additionalResults![1]!.rows,[]);assert.deepEqual(kept.snapshot.additionalResults![1]!.columns,[]);
  assert.equal(kept.snapshot.additionalResults![1]!.dataLimited,true);assert.deepEqual(value,copy);
});
