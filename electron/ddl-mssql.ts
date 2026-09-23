import type { DdlMapping } from '../src/ddl';
import { tokenize } from '../src/completion';
import { identifier, sqlLiteral } from './sql';
import { catalogRows, DdlFiles, flag, number, optionalText, text, unsupported, type CatalogQuery, type CatalogRow } from './ddl-catalog';

const q = (value: string) => identifier(value, 'mssql');
const literal = (value: string) => sqlLiteral(value, 'mssql');
const path = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
function integer(row: CatalogRow, key: string): string {
  const value = text(row,key);
  if (!/^-?\d+$/.test(value)) throw new Error(`DDL: некорректное значение ${key}.`);
  return value;
}
function dataType(row: CatalogRow): string {
  const type = text(row,'type');
  if (flag(row,'custom_type')) return path(text(row,'type_schema'),type);
  if (['varchar','nvarchar','char','nchar','binary','varbinary'].includes(type)) {
    const length = number(row,'length');
    return `${type}(${length === -1 ? 'max' : length / (type.startsWith('n') ? 2 : 1)})`;
  }
  if (['decimal','numeric'].includes(type)) return `${type}(${number(row,'precision')},${number(row,'scale')})`;
  if (['datetime2','datetimeoffset','time'].includes(type)) return `${type}(${number(row,'scale')})`;
  if (type === 'float') return `float(${number(row,'precision')})`;
  return q(type);
}
function createModule(sql: string, kind: 'VIEW' | 'TRIGGER'): string {
  const tokens = tokenize(sql,'mssql',100000).tokens.filter(token=>token.kind !== 'comment');
  const first = tokens[0], operation = first?.value.toUpperCase();
  const type = tokens[operation === 'CREATE' && tokens[1]?.value.toUpperCase() === 'OR' && tokens[2]?.value.toUpperCase() === 'ALTER' ? 3 : 1];
  if (!first || !['CREATE','ALTER'].includes(operation ?? '') || type?.value.toUpperCase() !== kind) unsupported(kind,'неоднозначное определение модуля');
  return operation === 'ALTER' ? sql.slice(0,first.start)+'CREATE'+sql.slice(first.end) : sql;
}

/** SQL Server needs database VIEW DEFINITION, otherwise catalog visibility can hide objects. */
export async function readMssqlDdl(mapping: DdlMapping, query: CatalogQuery) {
  const read = (fields: string, from = '') => catalogRows(query, `SELECT (SELECT ${fields} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS [metadata] ${from}`);
  const [context] = await read("DB_NAME() AS [database], CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS [version], CONVERT(bit,COALESCE(HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION'),0)) AS [permitted]");
  if (!context || text(context,'database') !== mapping.catalog) throw new Error('SQL Server DDL: catalog должен совпадать с текущей базой подключения.');
  const version = number(context,'version');
  if (version < 15 || version > 16) unsupported(mapping.catalog,'версия SQL Server вне диапазона 2019–2022');
  if (!flag(context,'permitted')) throw new Error('SQL Server DDL: требуется VIEW DEFINITION на выбранную базу, чтобы не пропустить скрытые объекты.');
  const scope = literal(mapping.schema), output = new DdlFiles();
  if ((await read('s.schema_id AS [id]',`FROM sys.schemas s WHERE s.name=${scope}`)).length !== 1) throw new Error('SQL Server DDL: schema не найдена.');
  const tableQuery = `FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name`;
  const tables = await read(`t.object_id AS [id], t.name, CONVERT(nvarchar(30),t.modify_date,126) AS [modified],
    t.is_memory_optimized AS [memory], t.temporal_type AS [temporal], t.is_filetable AS [filetable],
    t.is_node AS [node], t.is_edge AS [edge], COALESCE(t.filestream_data_space_id,0) AS [filestream],
    t.large_value_types_out_of_row AS [out_of_row], t.text_in_row_limit AS [text_in_row],
    t.lock_escalation_desc AS [lock_escalation], t.lob_data_space_id AS [lob_space],
    CONVERT(bit,CASE WHEN EXISTS (SELECT 1 FROM sys.fulltext_indexes f WHERE f.object_id=t.object_id) THEN 1 ELSE 0 END) AS [fulltext],
    CONVERT(bit,CASE WHEN EXISTS (SELECT 1 FROM sys.security_predicates p WHERE p.target_object_id=t.object_id) THEN 1 ELSE 0 END) AS [policies]`,tableQuery);
  for (const table of tables) {
    const name = text(table,'name');
    for (const key of ['memory','filetable','node','edge','out_of_row','policies','fulltext']) if (flag(table,key)) unsupported(name,key);
    for (const key of ['temporal','filestream','text_in_row']) if (number(table,key) !== 0) unsupported(name,key);
  }
  const columns = await read(`c.object_id AS [table_id], c.name, c.column_id AS [ordinal], ty.name AS [type], ts.name AS [type_schema],
    ty.is_user_defined AS [custom_type], ty.is_assembly_type AS [assembly_type], c.max_length AS [length], c.precision, c.scale,
    c.is_nullable AS [nullable], c.collation_name AS [collation], c.is_identity AS [identity], c.is_computed AS [computed],
    CONVERT(nvarchar(80),ic.seed_value) AS [seed], CONVERT(nvarchar(80),ic.increment_value) AS [increment], ic.is_not_for_replication AS [identity_replication],
    cc.definition AS [expression], cc.is_persisted AS [persisted], dc.name AS [default_name], dc.definition AS [default_definition],
    c.default_object_id AS [default_id], c.rule_object_id AS [rule_id], c.is_sparse AS [sparse], c.is_column_set AS [column_set],
    c.is_rowguidcol AS [rowguid], c.is_filestream AS [filestream], c.xml_collection_id AS [xml_collection],
    c.generated_always_type AS [generated], c.encryption_type AS [encryption], c.is_hidden AS [hidden], CONVERT(bit,COALESCE(mc.is_masked,0)) AS [masked]`,
    `FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
    JOIN sys.types ty ON ty.user_type_id=c.user_type_id JOIN sys.schemas ts ON ts.schema_id=ty.schema_id
    LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
    LEFT JOIN sys.masked_columns mc ON mc.object_id=c.object_id AND mc.column_id=c.column_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id
    WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name,c.column_id`);
  const spaces = await read('d.data_space_id AS [id], d.name, d.type', 'FROM sys.data_spaces d');
  const space = (id: number): string => {
    const value = spaces.find(item=>number(item,'id') === id);
    if (!value || text(value,'type') !== 'FG') unsupported(mapping.schema,'partition scheme/filegroup');
    return q(text(value,'name'));
  };
  const indexes = await read(`i.object_id AS [table_id], i.index_id AS [id], i.name, i.type, i.is_unique AS [unique_index],
    i.is_primary_key AS [primary_key], i.is_unique_constraint AS [unique_constraint], i.is_disabled AS [disabled],
    i.is_hypothetical AS [hypothetical], i.data_space_id AS [space], i.filter_definition AS [filter],
    i.has_filter, i.fill_factor AS [fill_factor], i.is_padded AS [padded], i.ignore_dup_key,
    i.allow_row_locks, i.allow_page_locks, i.optimize_for_sequential_key AS [sequential],
    st.no_recompute, kc.name AS [constraint_name]`,
    `FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
    LEFT JOIN sys.key_constraints kc ON kc.parent_object_id=i.object_id AND kc.unique_index_id=i.index_id
    LEFT JOIN sys.stats st ON st.object_id=i.object_id AND st.stats_id=i.index_id
    WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name,i.index_id`);
  const indexColumns = await read(`ic.object_id AS [table_id], ic.index_id AS [index_id], ic.key_ordinal AS [ordinal],
    ic.is_descending_key AS [descending_key], ic.is_included_column AS [included], c.name`,
    `FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
    JOIN sys.tables t ON t.object_id=ic.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
    WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name,ic.index_id,ic.index_column_id`);
  const partitions = await read(`p.object_id AS [table_id], p.index_id AS [index_id], p.data_compression_desc AS [compression],
    ${version >= 16 ? 'p.xml_compression' : 'CONVERT(bit,0)'} AS [xml_compression]`,
    `FROM sys.partitions p JOIN sys.tables t ON t.object_id=p.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=${scope} AND t.is_ms_shipped=0`);
  function compression(tableId: number, indexId: number): string {
    const selected = partitions.filter(item=>number(item,'table_id') === tableId && number(item,'index_id') === indexId);
    if (selected.length !== 1 || flag(selected[0]!,'xml_compression')) unsupported(mapping.schema,'partitioning/XML compression');
    const value = text(selected[0]!,'compression');
    if (!['NONE','ROW','PAGE'].includes(value)) unsupported(mapping.schema,'columnstore compression');
    return value;
  }
  function indexBody(index: CatalogRow): string {
    const id = number(index,'id'), tableId = number(index,'table_id'), type = number(index,'type');
    if (![1,2].includes(type) || flag(index,'disabled') || flag(index,'hypothetical')) unsupported(text(index,'name'),'специальный/disabled/hypothetical index');
    const cols = indexColumns.filter(item=>number(item,'table_id') === tableId && number(item,'index_id') === id);
    const keys = cols.filter(item=>number(item,'ordinal') > 0).sort((a,b)=>number(a,'ordinal')-number(b,'ordinal'));
    if (!keys.length) throw new Error('DDL: index без ключей.');
    let sql = `${type === 1 ? 'CLUSTERED' : 'NONCLUSTERED'} (${keys.map(item=>`${q(text(item,'name'))} ${flag(item,'descending_key') ? 'DESC' : 'ASC'}`).join(', ')})`;
    const included = cols.filter(item=>flag(item,'included'));
    if (included.length) sql += ` INCLUDE (${included.map(item=>q(text(item,'name'))).join(', ')})`;
    if (flag(index,'has_filter')) sql += ` WHERE ${text(index,'filter')}`;
    const on = (key: string) => flag(index,key) ? 'ON' : 'OFF';
    const fillFactor = number(index,'fill_factor');
    if (fillFactor < 0 || fillFactor > 100) unsupported(text(index,'name'),'fill factor');
    // Catalog zero means the server default; CREATE TABLE constraints accept 1–100 only.
    const fillOption = fillFactor === 0 ? '' : `FILLFACTOR = ${fillFactor}, `;
    sql += ` WITH (PAD_INDEX = ${on('padded')}, ${fillOption}IGNORE_DUP_KEY = ${on('ignore_dup_key')}, STATISTICS_NORECOMPUTE = ${on('no_recompute')}, ALLOW_ROW_LOCKS = ${on('allow_row_locks')}, ALLOW_PAGE_LOCKS = ${on('allow_page_locks')}, OPTIMIZE_FOR_SEQUENTIAL_KEY = ${on('sequential')}, DATA_COMPRESSION = ${compression(tableId,id)}) ON ${space(number(index,'space'))}`;
    return sql;
  }
  for (const table of tables) {
    const id = number(table,'id'), name = text(table,'name'), target = path(mapping.schema,name), clauses: string[] = [];
    const tableColumns = columns.filter(column=>number(column,'table_id') === id);
    if (!tableColumns.length) throw new Error(`DDL: ${name} — не получены колонки.`);
    for (const column of tableColumns) {
      const columnName = text(column,'name');
      for (const key of ['assembly_type','column_set','filestream','hidden','masked']) if (flag(column,key)) unsupported(`${name}.${columnName}`,key);
      for (const key of ['rule_id','xml_collection','generated']) if (number(column,key) !== 0) unsupported(`${name}.${columnName}`,key);
      if (column.encryption !== null) unsupported(`${name}.${columnName}`,'Always Encrypted');
      let sql = q(columnName);
      if (flag(column,'computed')) {
        sql += ` AS ${text(column,'expression')}`;
        if (flag(column,'persisted')) sql += ` PERSISTED${flag(column,'nullable') ? '' : ' NOT NULL'}`;
      } else {
        sql += ` ${dataType(column)}`;
        const collation = optionalText(column,'collation');
        if (collation) {
          // COLLATE accepts a collation token, not a bracket-delimited identifier.
          if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(collation)) unsupported(`${name}.${columnName}`,'collation name');
          sql += ` COLLATE ${collation}`;
        }
        if (flag(column,'sparse')) sql += ' SPARSE';
        if (flag(column,'identity')) sql += ` IDENTITY(${integer(column,'seed')},${integer(column,'increment')})${flag(column,'identity_replication') ? ' NOT FOR REPLICATION' : ''}`;
        if (flag(column,'rowguid')) sql += ' ROWGUIDCOL';
        sql += flag(column,'nullable') ? ' NULL' : ' NOT NULL';
        if (number(column,'default_id') !== 0) sql += ` CONSTRAINT ${q(text(column,'default_name'))} DEFAULT ${text(column,'default_definition')}`;
      }
      clauses.push(sql);
    }
    for (const index of indexes.filter(item=>number(item,'table_id') === id && (flag(item,'primary_key') || flag(item,'unique_constraint')))) {
      clauses.push(`CONSTRAINT ${q(text(index,'constraint_name'))} ${flag(index,'primary_key') ? 'PRIMARY KEY' : 'UNIQUE'} ${indexBody(index)}`);
    }
    const storage = indexes.find(item=>number(item,'table_id') === id && [0,1].includes(number(item,'type')));
    if (!storage) throw new Error(`DDL: ${name} — не получено размещение таблицы.`);
    let sql = `CREATE TABLE ${target} (\n  ${clauses.join(',\n  ')}\n) ON ${space(number(storage,'space'))}`;
    if (number(table,'lob_space')) sql += ` TEXTIMAGE_ON ${space(number(table,'lob_space'))}`;
    if (number(storage,'type') === 0) sql += ` WITH (DATA_COMPRESSION = ${compression(id,0)})`;
    const escalation = text(table,'lock_escalation');
    if (!['AUTO','TABLE','DISABLE'].includes(escalation)) unsupported(name,'lock escalation');
    output.add('table',name,`${sql};\nALTER TABLE ${target} SET (LOCK_ESCALATION = ${escalation});`);
    for (const index of indexes.filter(item=>number(item,'table_id') === id && number(item,'type') !== 0 && !flag(item,'primary_key') && !flag(item,'unique_constraint'))) {
      const body = indexBody(index), split = body.indexOf(' (');
      output.add('index',`${name}.${text(index,'name')}`,`CREATE ${flag(index,'unique_index') ? 'UNIQUE ' : ''}${body.slice(0,split)} INDEX ${q(text(index,'name'))} ON ${target}${body.slice(split)};`);
    }
  }
  const checks = await read('t.name AS [table_name], c.name, c.definition, c.is_disabled AS [disabled], c.is_not_trusted AS [untrusted], c.is_not_for_replication AS [replication]',
    `FROM sys.check_constraints c JOIN sys.tables t ON t.object_id=c.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name,c.name`);
  const foreignKeys = await read(`f.object_id AS [id], t.name AS [table_name], f.name, rs.name AS [target_schema], rt.name AS [target_name],
    f.delete_referential_action_desc AS [on_delete], f.update_referential_action_desc AS [on_update],
    f.is_disabled AS [disabled], f.is_not_trusted AS [untrusted], f.is_not_for_replication AS [replication]`,
    `FROM sys.foreign_keys f JOIN sys.tables t ON t.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
    JOIN sys.tables rt ON rt.object_id=f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY t.name,f.name`);
  const fkColumns = await read('f.object_id AS [id], c.constraint_column_id AS [ordinal], pc.name AS [source], rc.name AS [target]',
    `FROM sys.foreign_keys f JOIN sys.foreign_key_columns c ON c.constraint_object_id=f.object_id
    JOIN sys.columns pc ON pc.object_id=c.parent_object_id AND pc.column_id=c.parent_column_id
    JOIN sys.columns rc ON rc.object_id=c.referenced_object_id AND rc.column_id=c.referenced_column_id
    JOIN sys.tables t ON t.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=${scope} AND t.is_ms_shipped=0 ORDER BY f.object_id,c.constraint_column_id`);
  for (const constraint of [...checks,...foreignKeys]) {
    const name = text(constraint,'name'), table = text(constraint,'table_name'), target = path(mapping.schema,table);
    let definition: string;
    if ('definition' in constraint) definition = `CHECK${flag(constraint,'replication') ? ' NOT FOR REPLICATION' : ''} ${text(constraint,'definition')}`;
    else {
      const cols = fkColumns.filter(item=>number(item,'id') === number(constraint,'id'));
      if (!cols.length) throw new Error(`DDL: ${name} — не получены колонки foreign key.`);
      const action = (key: string) => { const value = text(constraint,key); if (!['NO_ACTION','CASCADE','SET_NULL','SET_DEFAULT'].includes(value)) unsupported(name,'FK action'); return value.replaceAll('_',' '); };
      definition = `FOREIGN KEY (${cols.map(item=>q(text(item,'source'))).join(', ')}) REFERENCES ${path(text(constraint,'target_schema'),text(constraint,'target_name'))} (${cols.map(item=>q(text(item,'target'))).join(', ')}) ON DELETE ${action('on_delete')} ON UPDATE ${action('on_update')}${flag(constraint,'replication') ? ' NOT FOR REPLICATION' : ''}`;
    }
    output.add('definition' in constraint ? 'check' : 'foreign-key',`${table}.${name}`,`ALTER TABLE ${target} WITH ${flag(constraint,'untrusted') ? 'NOCHECK' : 'CHECK'} ADD CONSTRAINT ${q(name)} ${definition};\nALTER TABLE ${target} ${flag(constraint,'disabled') ? 'NOCHECK' : 'CHECK'} CONSTRAINT ${q(name)};`);
  }
  const modules = await read(`o.name, o.type, parent.name AS [table_name], m.definition, m.uses_ansi_nulls AS [ansi_nulls],
    m.uses_quoted_identifier AS [quoted_identifier], tr.is_disabled AS [disabled],
    CONVERT(bit,CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id=o.object_id AND i.index_id>0) THEN 1 ELSE 0 END) AS [indexed_view]`,
    `FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id
    LEFT JOIN sys.triggers tr ON tr.object_id=o.object_id LEFT JOIN sys.objects parent ON parent.object_id=o.parent_object_id
    WHERE s.name=${scope} AND o.type IN ('V','TR','TA') AND o.is_ms_shipped=0 ORDER BY o.type,o.name`);
  for (const module of modules) {
    const name = text(module,'name'), type = text(module,'type').trim();
    if (!['V','TR'].includes(type)) unsupported(name,'CLR trigger');
    if (flag(module,'indexed_view')) unsupported(name,'indexed view');
    const definition = createModule(text(module,'definition'),type === 'V' ? 'VIEW' : 'TRIGGER');
    // SQL Server stores leading whitespace submitted after GO in sys.sql_modules.
    // Canonicalize only the outer whitespace so round trips do not accumulate blank lines.
    let sql = `SET ANSI_NULLS ${flag(module,'ansi_nulls') ? 'ON' : 'OFF'};\nSET QUOTED_IDENTIFIER ${flag(module,'quoted_identifier') ? 'ON' : 'OFF'};\nGO\n${definition.trim().replace(/;?$/,';')}`;
    if (type === 'TR' && flag(module,'disabled')) sql += `\nGO\nDISABLE TRIGGER ${path(mapping.schema,name)} ON ${path(mapping.schema,text(module,'table_name'))};`;
    output.add(type === 'V' ? 'view' : 'trigger',name,sql);
  }
  // DDL changes during the catalog reads invalidate the preview instead of saving a mixed table definition.
  const finalTables = await read('t.object_id AS [id], t.name, CONVERT(nvarchar(30),t.modify_date,126) AS [modified]',tableQuery);
  if (JSON.stringify(tables.map(({id,name,modified})=>({id,name,modified}))) !== JSON.stringify(finalTables)) throw new Error('SQL Server DDL: структура изменилась во время чтения. Повторите сравнение.');
  return {files:output.files,warnings:[
    'SQL Server 2019–2022: обычные rowstore tables, defaults, computed/identity columns, PK/UNIQUE/CHECK/FK, indexes, views и table triggers. Требуется VIEW DEFINITION на базу.',
    'Выгрузка не является backup: данные, owners/grants, extended properties, sequences, routines, пользовательские типы и статистика не копируются. Внешние зависимости должны существовать. Temporal, partitioned, memory-optimized, graph, encrypted/masked и специальные индексы останавливают выгрузку.',
    'Применение вручную: tables, затем indexes/check/foreign-key, после — зависимые views/triggers. GO разделяет SQL Server batches; сложные triggers с несколькими командами в теле применяйте через нативный клиент.',
  ]};
}
