import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildMultipleResultsFixture } from './multiple-results-fixture.mjs';

const fixture=buildMultipleResultsFixture();
const resources=process.env.LOCAL_DB_VIEWER_RESOURCES;
const home=resources?join(resources,'jre'):resolve('runtime',process.platform==='win32'?'windows-x64':'mac-arm64');
const common=resources?join(resources,'jdbc'):resolve('runtime/common');
const child=spawn(join(home,'bin',process.platform==='win32'?'java.exe':'java'),['-Xmx128m','--enable-native-access=ALL-UNNAMED','-cp',join(common,'*'),'LocalDBViewerBridge'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const lines=createInterface({input:child.stdout}), checks=[];
let pending, stderr='';
child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
child.on('error',error=>pending?.reject(error));
child.on('exit',code=>pending?.reject(new Error(`Bridge exited ${code}: ${stderr}`)));
lines.on('line',line=>{
  try {
    const message=JSON.parse(line);
    if(message.kind==='update') pending?.update(message.snapshot);
    if(message.kind==='done') pending?.resolve(message.snapshot);
  } catch(error) {pending?.reject(error);}
});
child.stdin.write(JSON.stringify({engine:'jdbc',driverClass:'fixture.MultipleResultsDriver',url:'jdbc:fixture:multiple',driverClasspath:[fixture],properties:{}})+'\n');
async function run(sql,maxRows=100,update=()=>{}) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending=undefined;reject(new Error('Result chain timed out'));},30000);
    const finish=callback=>value=>{clearTimeout(timer);pending=undefined;callback(value);};
    pending={resolve:finish(resolve),reject:finish(reject),update};
    child.stdin.write(JSON.stringify({kind:'run',requestId:crypto.randomUUID(),sql,maxRows})+'\n');
  });
}
const values=result=>[result,...(result.additionalResults??[])];
try {
  const mixed=await run('CALL mixed()');
  assert.equal(mixed.state,'FINISHED',mixed.error); assert.equal(values(mixed).length,5);
  assert.equal(mixed.updateCount,'0'); assert.deepEqual(mixed.additionalResults[0].rows,[['first'],['first']]);
  assert.equal(mixed.additionalResults[1].updateCount,'9007199254740993');
  assert.equal(mixed.additionalResults[2].columns[0].name,'empty');assert.deepEqual(mixed.additionalResults[2].rows,[]);
  assert.deepEqual(mixed.additionalResults[3].rows,[['second']]);
  assert.ok(values(mixed).every(value=>value.resultState==='FINISHED'));
  checks.push('ordered tables, zero update count, lossless 64-bit count, empty table, ResultSet closure');

  const limited=await run('CALL mixed()',1);
  assert.equal(limited.additionalResults[0].totalRows,2);assert.equal(limited.additionalResults[0].rows.length,1);assert.equal(limited.additionalResults[0].truncated,true);
  const large=await run('CALL large()');
  assert.equal(large.state,'FINISHED',large.error);assert.equal(large.rows.length,3);
  assert.equal(large.additionalResults[0].totalRows,8);assert.equal(large.additionalResults[0].dataLimited,true);
  assert.ok(values(large).reduce((n,value)=>n+Buffer.byteLength(JSON.stringify(value.rows))+Buffer.byteLength(JSON.stringify(value.columns)),0)<=8*1024*1024);
  checks.push('per-result row limit and 8 MiB aggregate bound while draining all rows');

  const many=await run('CALL many()');assert.equal(many.state,'FINISHED',many.error);assert.equal(values(many).length,100);assert.equal(many.omittedResults,1);
  const endless=await run('CALL endless()');assert.equal(endless.state,'FAILED');assert.match(endless.error,/1000/);assert.equal(values(endless).length,100);
  checks.push('100 retained results, overflow drained, broken infinite result chain stopped');

  const failed=await run('CALL error()');assert.equal(failed.state,'FAILED');assert.match(failed.error,/later error/);
  assert.equal(failed.additionalResults[0].resultState,'FINISHED');assert.deepEqual(failed.additionalResults[0].rows,[['first'],['first']]);
  const partial=await run('CALL partial()');assert.equal(partial.state,'FAILED');assert.deepEqual(partial.rows,[['kept']]);
  assert.equal(partial.additionalResults[0].resultState,'FAILED');assert.deepEqual(partial.additionalResults[0].rows,[['partial']]);assert.equal(partial.additionalResults[0].totalRows,1);
  checks.push('late SQL exception and partial-row exception preserve earlier data');

  const canceled=await run('CALL cancel()',100,message=>{
    if(message.additionalResults?.length) child.stdin.write(JSON.stringify({kind:'cancel'})+'\n');
  });
  assert.equal(canceled.state,'CANCELED');assert.deepEqual(canceled.additionalResults[0].rows,[['first'],['first']]);
  const unsupported=await run('CALL unsupported()');assert.equal(unsupported.state,'FINISHED',unsupported.error);assert.ok(unsupported.warnings.some(warning=>warning.includes('getMoreResults')));
  const legacy=await run('CALL many_legacy()');assert.equal(legacy.state,'FINISHED',legacy.error);assert.equal(legacy.updateCount,'0');assert.equal(values(legacy).length,100);
  const recovered=await run('CALL mixed()');assert.equal(recovered.state,'FINISHED',recovered.error);assert.equal(values(recovered).length,5);
  checks.push('cancellation between results, unsupported API warning, legacy count fallback, same-session recovery');
  await mkdir('test-artifacts',{recursive:true});
  await writeFile('test-artifacts/multiple-results-runtime.json',JSON.stringify({passed:true,platform:process.platform,checks},null,2));
  checks.forEach(check=>console.log(`PASS: ${check}`));
} finally {
  pending=undefined;child.stdin.end(JSON.stringify({kind:'close'})+'\n');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  lines.close();
}
