import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import mysql from 'mysql2';

const resources = process.env.LOCAL_DB_VIEWER_RESOURCES;
const common = resources ? join(resources, 'jdbc') : resolve('runtime/common');
const java = resources ? join(resources, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java') : resolve('runtime', process.platform === 'win32' ? 'windows-x64' : 'mac-arm64', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const server = mysql.createServer(); const sockets = new Set(); let streamed = 0;
const textColumn = name => ({ catalog:'def',schema:'fixture',table:'values',orgTable:'values',orgName:name,name,columnType:mysql.Types.VAR_STRING,characterSet:45,columnLength:1024,flags:0,decimals:0 });
server.on('connection', connection => {
  sockets.add(connection.stream); connection.stream.on('close',()=>sockets.delete(connection.stream)); connection.on('error',()=>{});
  connection.serverHandshake({protocolVersion:10,serverVersion:'8.0.36-fixture',connectionId:123,statusFlags:2,characterSet:45,capabilityFlags:0x00088201});
  // mysql2's server fixture routes SET commands to stmt_prepare.
  connection.on('stmt_prepare', sql => {
    connection.sequenceId = 1;
    if (/^\s*SET\b/i.test(sql)) connection.writeOk({affectedRows:0,serverStatus:2});
    else connection.writeError({code:1295,message:'Prepared statements are outside this fixture'});
  });
  connection.on('init_db', () => { connection.sequenceId = 1; connection.writeOk({affectedRows:0,serverStatus:2}); });
  connection.on('query', sql => {
    connection.sequenceId = 1;
    if (sql.includes('fixture_large_stream')) {
      connection.writeColumns([{...textColumn('payload'),columnType:mysql.Types.BLOB,columnLength:65535}]);
      void (async () => {
        const payload = 'x'.repeat(2048);
        for (let i=0;i<60000;i++) { connection.writeTextRow([payload]); streamed++; if(connection.stream.writableNeedDrain) await once(connection.stream,'drain'); }
        connection.writeEof(0,2);
      })().catch(()=>connection.stream.destroy()); return;
    }
    if (/^\s*(?:\/\*[\s\S]*?\*\/\s*)?SELECT/i.test(sql)) {
      const names = sql.split(/\bSELECT\b/i).pop().split(',').map(part => part.trim().split(/\s+AS\s+/i).pop().replace(/^@@(?:session\.)?/i,''));
      const variables = {auto_increment_increment:'1',character_set_client:'utf8mb4',character_set_connection:'utf8mb4',character_set_results:'utf8mb4',character_set_server:'utf8mb4',collation_server:'utf8mb4_general_ci',collation_connection:'utf8mb4_general_ci',init_connect:'',interactive_timeout:'28800',license:'GPL',lower_case_table_names:'0',max_allowed_packet:'67108864',net_buffer_length:'16384',net_write_timeout:'60',performance_schema:'0',query_cache_size:'0',query_cache_type:'OFF',sql_mode:'STRICT_TRANS_TABLES',system_time_zone:'UTC',time_zone:'SYSTEM',transaction_isolation:'REPEATABLE-READ',tx_isolation:'REPEATABLE-READ',wait_timeout:'28800',autocommit:'1'};
      connection.writeColumns(names.map(textColumn)); connection.writeTextRow(names.map(name=>variables[name]??'0')); connection.writeEof(0,2); return;
    }
    connection.writeOk({affectedRows:0,serverStatus:2});
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const child = spawn(java,['-Xmx48m','--enable-native-access=ALL-UNNAMED','-cp',join(common,'*'),'LocalDBViewerBridge'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let stderr=''; child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
const lines=createInterface({input:child.stdout});
try {
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MySQL streaming timeout: '+stderr)),90000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`JVM exited ${code}: ${stderr}`));});
    lines.on('line',line=>{const value=JSON.parse(line);if(value.kind==='done'){clearTimeout(timer);resolve(value.snapshot);}});
    const config={engine:'mysql',driverClass:'com.mysql.cj.jdbc.Driver',url:`jdbc:mysql://127.0.0.1:${server._server.address().port}/fixture`,properties:{user:'fixture',sslMode:'DISABLED',allowPublicKeyRetrieval:'false',socketTimeout:'10000'},options:{}};
    child.stdin.write(JSON.stringify(config)+'\n'+JSON.stringify({kind:'run',requestId:'streaming',sql:'SELECT fixture_large_stream',catalog:'',schema:'',maxRows:1})+'\n');
  });
  assert.equal(result.state,'FINISHED',result.error);assert.equal(result.totalRows,60000);assert.equal(result.rows.length,1);assert.equal(result.rows[0][0].length,2048);assert.equal(result.truncated,true);assert.equal(streamed,60000);
  console.log('PASS: actual MySQL Connector/J drains 117 MiB of LONGVARCHAR with a 48 MiB JVM heap and retains one row');
} finally {child.kill();lines.close();for(const socket of sockets)socket.destroy();server.close();}
