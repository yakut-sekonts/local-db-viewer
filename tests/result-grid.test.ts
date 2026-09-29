import assert from 'node:assert/strict';
import test from 'node:test';
import { cellText, copyGridRange, gridRows, type GridSelection } from '../src/result-grid';
import { CLIPBOARD_BYTES, validateClipboardText } from '../src/clipboard';

const range = (row: number, column: number, lastRow = row, lastColumn = column): GridSelection => ({ anchor: { row, column }, focus: { row: lastRow, column: lastColumn } });
test('numeric sorting keeps bigint/decimal precision, exponent order and stable equal values', () => {
  const column = [{ name: 'amount', type: 'Nullable(Decimal(38, 8))' }];
  const values = ['9007199254740993','-0.00000002','9007199254740992','0','-0','1e-8','0.000000010','-9007199254740993','-9007199254740992','12345678901234567890.123455','12345678901234567890.123456',null];
  const rows = values.map((value, index) => [value,index]), original = structuredClone(rows);
  assert.deepEqual(gridRows(rows,column,'',{column:0,direction:'asc'}).map(row=>row[0]),['-9007199254740993','-9007199254740992','-0.00000002','0','-0','1e-8','0.000000010','9007199254740992','9007199254740993','12345678901234567890.123455','12345678901234567890.123456',null]);
  const descending=gridRows(rows,column,'',{column:0,direction:'desc'});
  assert.equal(descending.at(-1)?.[0],null);assert.equal(descending[0]?.[0],'12345678901234567890.123456');
  assert.ok(descending.findIndex(row=>row[0]==='1e-8')<descending.findIndex(row=>row[0]==='0.000000010'));
  assert.deepEqual(rows,original);assert.equal(gridRows(rows,column,''),rows);
  for (const type of ['Float32','Float64','UInt64','int8','BIGINT UNSIGNED','NUMBER(38,8)']) assert.deepEqual(gridRows([['10'],['2']],[{name:'x',type}],'',{column:0,direction:'asc'}).map(row=>row[0]),['2','10']);
  assert.deepEqual(gridRows([['2e10000'],['1e10001'],['9e9999']],[{name:'x',type:'float'}],'',{column:0,direction:'asc'}).map(row=>row[0]),['9e9999','2e10000','1e10001']);
});
test('text/boolean/unknown values have deterministic ordering and invalid numeric values cannot break transitivity',()=>{
  const rows=[['2'],['10'],['abc'],[''],[null],['1']];
  assert.deepEqual(gridRows(rows,[{name:'x',type:'varchar'}],'',{column:0,direction:'asc'}).map(row=>row[0]),['','1','10','2','abc',null]);
  assert.deepEqual(gridRows(rows,[{name:'x',type:'bigint'}],'',{column:0,direction:'asc'}).map(row=>row[0]),['1','2','10','','abc',null]);
  assert.deepEqual(gridRows([[true],[false],[null],['true'],['false']],[{name:'b',type:'boolean'}],'',{column:0,direction:'desc'}).map(row=>row[0]),[true,'true',false,'false',null]);
  assert.deepEqual(gridRows([['ЁЖ',1],['еж',2],['Другой',3]],[{name:'x',type:'text'}],'ёж'),[['ЁЖ',1]]);
});
test('copy preserves single-cell text and serializes positional ranges, duplicate headers and multiline TSV',()=>{
  const columns=[{name:'same',type:'bigint'},{name:'same',type:'decimal(30,6)'},{name:'note',type:'text'}];
  const rows=[['9007199254740993','-12345678901234567890.123456','line\n"quote"\t名'],['2','0','']];
  assert.equal(copyGridRange(columns,rows,range(0,0)),'9007199254740993');
  assert.equal(copyGridRange(columns,rows,range(0,2)),rows[0]?.[2]);
  assert.equal(copyGridRange(columns,rows,range(1,2)),'');
  assert.equal(copyGridRange(columns,rows,range(1,1,0,0),true),'same\tsame\r\n9007199254740993\t-12345678901234567890.123456\r\n2\t0');
  assert.equal(copyGridRange(columns,rows,range(0,2,1,2)),'"line\n""quote""\t名"\r\n');
  assert.equal(copyGridRange([{name:'x',type:'text'}],[[null]],range(0,0)),'NULL');
  assert.equal(cellText({a:['1',null]}),'{"a":["1",null]}');
});
test('TSV ranges neutralize text formulas and retain valid numeric values; exact single-cell copy remains literal',()=>{
  const columns=[{name:'=header',type:'text'},{name:'n',type:'numeric'}], rows=[['=2+2','-12.5'],['  @SUM(1)','+4e2']];
  assert.equal(copyGridRange(columns,rows,range(0,0,1,1),true),"'=header\tn\r\n'=2+2\t-12.5\r\n'  @SUM(1)\t+4e2");
  assert.equal(copyGridRange(columns,rows,range(0,0)),'=2+2');
});
test('clipboard rejects invalid, oversized UTF-8 and stale selections before writing',()=>{
  validateClipboardText('');validateClipboardText('名');
  assert.throws(()=>validateClipboardText({text:'x'}),/Некорректный/);
  assert.throws(()=>validateClipboardText('before\0after'),/NUL/);
  assert.throws(()=>copyGridRange([{name:'x',type:'text'}],[['before\0after']],range(0,0)),/NUL/);
  assert.throws(()=>copyGridRange([{name:'x',type:'text'}],[['before\0after'],['next']],range(0,0,1,0)),/NUL/);
  assert.throws(()=>validateClipboardText('名'.repeat(Math.floor(CLIPBOARD_BYTES/3)+1)),/16 MiB/);
  assert.throws(()=>copyGridRange([{name:'x',type:'text'}],[['a']],range(0,0,1,0)),/Выделение/);
  assert.throws(()=>copyGridRange([{name:'x',type:'text'}],[['a']],range(-1,0)),/Выделение/);
  assert.throws(()=>copyGridRange([{name:'x',type:'text'}],[['a']],range(0,NaN)),/Выделение/);
  assert.throws(()=>copyGridRange(Array.from({length:1001},()=>({name:'x',type:'text'})),Array.from({length:1000},()=>[]),range(0,0,999,1000)),/1 000 000/);
});
