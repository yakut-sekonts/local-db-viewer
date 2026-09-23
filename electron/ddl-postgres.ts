import type { DdlMapping } from '../src/ddl';
import { identifier, sqlLiteral } from './sql';
import { catalogRows, DdlFiles, flag, number, optionalText, text, unsupported, type CatalogQuery, type CatalogRow } from './ddl-catalog';

const q = (value: string) => identifier(value, 'postgres');
const literal = (value: string) => sqlLiteral(value, 'postgres');
const path = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
function options(value: unknown): string {
  if (value === null) return '';
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('DDL: некорректные storage parameters.');
  return value.length ? ` WITH (${value.map((item: string) => {
    const separator = item.indexOf('=');
    if (separator < 1) throw new Error('DDL: некорректный storage parameter.');
    return `${item.slice(0, separator).split('.').map(q).join('.')} = ${literal(item.slice(separator + 1))}`;
  }).join(', ')})` : '';
}
function sequenceOptions(row: CatalogRow): string {
  return `START WITH ${integer(row, 'start')} INCREMENT BY ${integer(row, 'increment')} MINVALUE ${integer(row, 'minimum')} MAXVALUE ${integer(row, 'maximum')} CACHE ${integer(row, 'cache')} ${flag(row, 'cycle') ? '' : 'NO '}CYCLE`;
}
function integer(row: CatalogRow, key: string): string {
  const value = text(row, key);
  if (!/^-?\d+$/.test(value)) throw new Error(`DDL: некорректное значение sequence ${key}.`);
  return value;
}

/** Called on a dedicated connection: the snapshot and search_path never touch SQL consoles. */
export async function readPostgresDdl(mapping: DdlMapping, query: CatalogQuery) {
  const read = (sql: string) => catalogRows(query, `SELECT row_to_json(ddl_row)::text FROM (${sql}) AS ddl_row`);
  const [context] = await read("SELECT current_database() AS database, current_setting('server_version_num')::integer AS version");
  if (!context || text(context, 'database') !== mapping.catalog) throw new Error('PostgreSQL DDL: catalog должен совпадать с текущей базой подключения.');
  const version = number(context, 'version');
  if (version < 140000 || version >= 190000) unsupported(mapping.catalog, 'версия PostgreSQL вне диапазона 14–18');
  const scope = literal(mapping.schema), output = new DdlFiles();
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await query('SET LOCAL search_path = pg_catalog');
    const schema = await read(`SELECT n.oid::text AS id FROM pg_namespace n WHERE n.nspname = ${scope}`);
    if (schema.length !== 1) throw new Error('PostgreSQL DDL: schema не найдена.');
    const tables = await read(`SELECT c.oid::text AS id, c.relname AS name, c.relkind::text AS kind,
      c.relpersistence::text AS persistence, c.relispartition AS partition, c.reloftype <> 0 AS typed,
      c.relrowsecurity OR c.relforcerowsecurity OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
      c.relreplident::text AS replica, c.reloptions AS options, ts.spcname AS tablespace, am.amname AS method,
      EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance,
      EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.rulename <> '_RETURN') AS rules,
      EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') AS extension,
      obj_description(c.oid,'pg_class') AS comment, CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,false) END AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace LEFT JOIN pg_am am ON am.oid=c.relam
      WHERE n.nspname=${scope} AND c.relkind IN ('r','p','f','v','m') ORDER BY c.relname`);
    for (const table of tables) {
      const name = text(table, 'name'), kind = text(table, 'kind');
      if (!['r','v'].includes(kind)) unsupported(name, 'partitioned/foreign/materialized объект');
      for (const key of ['partition','typed','policies','inheritance','rules','extension']) if (flag(table, key)) unsupported(name, key);
      if (text(table, 'replica') !== 'd' && kind === 'r') unsupported(name, 'изменённый REPLICA IDENTITY');
      if (!['p','u'].includes(text(table, 'persistence'))) unsupported(name, 'temporary table');
    }
    const sequences = await read(`SELECT c.oid::text AS id, c.relname AS name, n.nspname AS schema,
      format_type(s.seqtypid,NULL) AS type, s.seqstart::text AS start, s.seqincrement::text AS increment,
      s.seqmin::text AS minimum, s.seqmax::text AS maximum, s.seqcache::text AS cache, s.seqcycle AS cycle,
      c.relpersistence::text AS persistence, d.deptype::text AS dependency, d.refobjid::text AS table_id,
      a.attname AS column_name, tn.nspname AS table_schema, tc.relname AS table_name, obj_description(c.oid,'pg_class') AS comment
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
      LEFT JOIN pg_class tc ON tc.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=tc.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
      WHERE n.nspname=${scope} ORDER BY c.relname`);
    for (const sequence of sequences) {
      if (optionalText(sequence, 'dependency') === 'i') continue;
      const name = text(sequence, 'name'), target = path(mapping.schema, name);
      const persistence = text(sequence, 'persistence');
      if (!['p','u'].includes(persistence)) unsupported(name, 'temporary sequence');
      output.add('sequence', name, `CREATE ${persistence === 'u' ? 'UNLOGGED ' : ''}SEQUENCE ${target} AS ${text(sequence,'type')} ${sequenceOptions(sequence)};`);
      if (optionalText(sequence, 'table_id')) output.add('sequence-owner', name, `ALTER SEQUENCE ${target} OWNED BY ${path(text(sequence,'table_schema'),text(sequence,'table_name'))}.${q(text(sequence,'column_name'))};`);
      const comment = optionalText(sequence, 'comment');
      if (comment !== null) output.add('sequence-comment', name, `COMMENT ON SEQUENCE ${target} IS ${literal(comment)};`);
    }
    const columns = await read(`SELECT a.attrelid::text AS table_id, a.attname AS name, a.attnum AS ordinal, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required, a.attidentity::text AS identity, a.attgenerated::text AS generated,
      a.attstorage::text AS storage, t.typstorage::text AS default_storage, a.attcompression::text AS compression,
      COALESCE(a.attstattarget,-1) AS statistics, a.attoptions AS options, a.attfdwoptions AS fdw_options,
      CASE WHEN a.attcollation <> 0 THEN quote_ident(cn.nspname)||'.'||quote_ident(co.collname) END AS collation,
      pg_get_expr(ad.adbin,ad.adrelid,false) AS expression, col_description(a.attrelid,a.attnum) AS comment
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE n.nspname=${scope} AND c.relkind IN ('r','v') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`);
    const constraints = await read(`SELECT con.conrelid::text AS table_id, con.conname AS name, con.contype::text AS kind, con.conkey AS columns,
      pg_get_constraintdef(con.oid,false) AS definition,
      COALESCE((to_jsonb(con)->>'conenforced')::boolean,true) AS enforced,
      (ic.reloptions IS NOT NULL OR ic.reltablespace <> 0 OR EXISTS (SELECT 1 FROM unnest(i.indoption) x WHERE x <> 0)) AS custom_index
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class ic ON ic.oid=con.conindid AND con.contype IN ('p','u','x') LEFT JOIN pg_index i ON i.indexrelid=ic.oid
      WHERE n.nspname=${scope} AND c.relkind='r' ORDER BY c.relname,con.conname`);
    const indexes = await read(`SELECT c.relname AS name, pg_get_indexdef(i.indexrelid,0,false) AS definition,
      i.indisvalid AND i.indisready AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${scope}
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid=i.indexrelid AND con.contype IN ('p','u','x')) ORDER BY c.relname`);
    for (const table of tables) {
      const id = text(table,'id'), name = text(table,'name'), target = path(mapping.schema,name), view = text(table,'kind') === 'v';
      const tableColumns = columns.filter(column => text(column,'table_id') === id), clauses: string[] = [], after: string[] = [];
      for (const column of tableColumns) {
        const columnName = text(column,'name'), identity = text(column,'identity'), generated = text(column,'generated');
        if (column.options !== null || column.fdw_options !== null) unsupported(`${name}.${columnName}`, 'column options');
        let clause = `${q(columnName)} ${text(column,'type')}`;
        const collation = optionalText(column,'collation'), expression = optionalText(column,'expression');
        if (collation) clause += ` COLLATE ${collation}`;
        if (identity) {
          if (!['a','d'].includes(identity)) unsupported(name,'identity mode');
          const sequence = sequences.find(item => optionalText(item,'dependency') === 'i' && optionalText(item,'table_id') === id && optionalText(item,'column_name') === columnName);
          if (!sequence) unsupported(name,'identity sequence вне выбранной schema');
          clause += ` GENERATED ${identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (SEQUENCE NAME ${path(text(sequence,'schema'),text(sequence,'name'))} ${sequenceOptions(sequence)})`;
        } else if (generated) {
          if (!['s','v'].includes(generated) || !expression) unsupported(name,'generated column');
          clause += ` GENERATED ALWAYS AS (${expression}) ${generated === 's' ? 'STORED' : 'VIRTUAL'}`;
        } else if (expression !== null) clause += ` DEFAULT ${expression}`;
        // PostgreSQL 18 stores named NOT NULL constraints separately.
        if (flag(column,'required') && !constraints.some(item => text(item,'table_id') === id && text(item,'kind') === 'n' && Array.isArray(item.columns) && item.columns.includes(number(column,'ordinal')))) clause += ' NOT NULL';
        clauses.push(clause);
        if (text(column,'storage') !== text(column,'default_storage')) {
          const storage = ({p:'PLAIN',e:'EXTERNAL',m:'MAIN',x:'EXTENDED'} as Record<string,string>)[text(column,'storage')];
          if (!storage) unsupported(name,'column storage');
          after.push(`ALTER TABLE ${target} ALTER COLUMN ${q(columnName)} SET STORAGE ${storage};`);
        }
        const compression = text(column,'compression');
        if (compression) {
          const method = ({p:'pglz',l:'lz4'} as Record<string,string>)[compression];
          if (!method) unsupported(name,'column compression');
          after.push(`ALTER TABLE ${target} ALTER COLUMN ${q(columnName)} SET COMPRESSION ${method};`);
        }
        if (number(column,'statistics') !== -1) after.push(`ALTER ${view ? 'VIEW' : 'TABLE'} ${target} ALTER COLUMN ${q(columnName)} SET STATISTICS ${number(column,'statistics')};`);
        const comment = optionalText(column,'comment');
        if (comment !== null) after.push(`COMMENT ON COLUMN ${target}.${q(columnName)} IS ${literal(comment)};`);
      }
      for (const constraint of constraints.filter(item => text(item,'table_id') === id)) {
        const kind = text(constraint,'kind');
        if (!['p','u','c','f','x','n'].includes(kind) || !flag(constraint,'enforced')) unsupported(name,'constraint type/enforcement');
        if (constraint.custom_index === true) unsupported(name,'custom storage/order constraint index');
        const clause = `CONSTRAINT ${q(text(constraint,'name'))} ${text(constraint,'definition')}`;
        if (kind === 'f') output.add('foreign-key', `${name}.${text(constraint,'name')}`, `ALTER TABLE ONLY ${target} ADD ${clause};`);
        else clauses.push(clause);
      }
      let sql: string;
      if (view) {
        sql = `CREATE VIEW ${target} (${tableColumns.map(column=>q(text(column,'name'))).join(', ')})${options(table.options)} AS\n${text(table,'definition').trimEnd()}`;
        for (const column of tableColumns) {
          const expression = optionalText(column,'expression');
          if (expression !== null) after.push(`ALTER VIEW ${target} ALTER COLUMN ${q(text(column,'name'))} SET DEFAULT ${expression};`);
        }
      } else {
        sql = `CREATE ${text(table,'persistence') === 'u' ? 'UNLOGGED ' : ''}TABLE ${target} (\n  ${clauses.join(',\n  ')}\n) USING ${q(text(table,'method'))}${options(table.options)}`;
        const tablespace = optionalText(table,'tablespace'); if (tablespace) sql += ` TABLESPACE ${q(tablespace)}`;
      }
      sql = sql.replace(/;?$/, ';');
      const comment = optionalText(table,'comment'); if (comment !== null) after.push(`COMMENT ON ${view ? 'VIEW' : 'TABLE'} ${target} IS ${literal(comment)};`);
      output.add(view ? 'view' : 'table', name, [sql,...after].join('\n'));
    }
    for (const index of indexes) {
      if (!flag(index,'valid')) unsupported(text(index,'name'),'invalid/unfinished index');
      output.add('index',text(index,'name'),text(index,'definition'));
    }
    const triggers = await read(`SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled::text AS enabled,
      pg_get_triggerdef(t.oid,false) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${scope} AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
    for (const trigger of triggers) {
      const name = text(trigger,'name'), table = text(trigger,'table_name'), state = text(trigger,'enabled');
      const action = ({O:'ENABLE',D:'DISABLE',A:'ENABLE ALWAYS',R:'ENABLE REPLICA'} as Record<string,string>)[state];
      if (!action) unsupported(name,'trigger state');
      output.add('trigger',`${table}.${name}`,`${text(trigger,'definition')};\nALTER TABLE ${path(mapping.schema,table)} ${action} TRIGGER ${q(name)};`);
    }
    return {files:output.files,warnings:[
      'PostgreSQL 14–18: tables/views, sequences, constraints, indexes, triggers и comments. Owners, grants, policies, routines и пользовательские типы не выгружаются; внешние зависимости должны существовать. Это определения объектов, не полный backup базы.',
      'Применение вручную: сначала sequences и tables, затем indexes/foreign keys/sequence-owner и зависимые views/triggers. Текущие значения sequences и данные не копируются.',
    ]};
  } finally { await query('ROLLBACK'); }
}
