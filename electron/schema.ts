import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, sqlLiteral } from './sql';
import type { Connection } from './trino';
import type { MetadataResult, Relationship, SchemaIndex, SchemaInput, TableMeta } from '../src/shared';

type ReadQuery = (sql: string) => Promise<MetadataResult>;
const key = (table: { catalog: string; schema: string; name: string }) => JSON.stringify([table.catalog, table.schema, table.name]);

/** Only system metadata is read. Data values never enter the completion index. */
export async function loadSchema(connection: Connection, input: SchemaInput, read: ReadQuery, virtual: Relationship[]): Promise<SchemaIndex> {
  const engine = connection.engine;
  const q = (value: string) => identifier(value, engine);
  const s = (value: string) => sqlLiteral(value, engine);
  let catalog = input.catalog || connection.catalog;
  let schema = input.schema || connection.schema;
  if (engine === 'sqlite') { catalog = 'main'; schema = 'main'; }
  else if (engine === 'postgres' || engine === 'mssql') {
    const context = await read(engine === 'postgres' ? 'SELECT current_database(), current_schema()' : 'SELECT DB_NAME(), SCHEMA_NAME()');
    catalog = engine === 'mssql' && catalog ? catalog : String(context.rows[0]?.[0] ?? '');
    schema ||= String(context.rows[0]?.[1] ?? (engine === 'postgres' ? 'public' : 'dbo'));
  } else if (engine === 'mysql' || engine === 'mariadb' || engine === 'clickhouse') {
    if (engine !== 'clickhouse') catalog ||= decodeURIComponent(new URL(connection.endpoint).pathname.slice(1));
    if (!catalog) catalog = String((await read(engine === 'clickhouse' ? 'SELECT currentDatabase()' : 'SELECT DATABASE()')).rows[0]?.[0] ?? '');
    schema = catalog;
  }
  const result: SchemaIndex = { profileId: input.profileId, catalog, schema, tables: [], relationships: [], warnings: [] };
  if (!catalog || !schema) {
    result.warnings.push('Выберите catalog и schema в панели запроса или через значок у schema в Database Explorer.');
    return result;
  }
  let columnsSQL: string;
  let foreignKeysSQL = '';
  // FK rows: id, name, source catalog/schema/table, target catalog/schema/table, source/target column.
  if (engine === 'sqlite') {
    columnsSQL = `SELECT m.name, p.name, p.type FROM main.sqlite_schema m JOIN pragma_table_xinfo(m.name) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' AND p.hidden <> 1 ORDER BY m.name, p.cid`;
    foreignKeysSQL = `SELECT m.name || ':' || f.id, 'fk_' || m.name || '_' || f.id, 'main', 'main', m.name, 'main', 'main', f."table", f."from", COALESCE(f."to", (SELECT p.name FROM pragma_table_info(f."table") p WHERE p.pk = f.seq + 1)) FROM main.sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq`;
  } else if (engine === 'postgres') {
    columnsSQL = `SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid WHERE n.nspname = ${s(schema)} AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(c.oid, a.attnum, 'SELECT') ORDER BY c.relname, a.attnum`;
    foreignKeysSQL = `SELECT f.oid::text, f.conname, current_database(), sn.nspname, st.relname, current_database(), tn.nspname, tt.relname, sc.attname, tc.attname FROM pg_catalog.pg_constraint f JOIN pg_catalog.pg_class st ON st.oid = f.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid = st.relnamespace JOIN pg_catalog.pg_class tt ON tt.oid = f.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = tt.relnamespace CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY AS k(source_num, target_num, pos) JOIN pg_catalog.pg_attribute sc ON sc.attrelid = st.oid AND sc.attnum = k.source_num JOIN pg_catalog.pg_attribute tc ON tc.attrelid = tt.oid AND tc.attnum = k.target_num WHERE f.contype = 'f' AND (sn.nspname = ${s(schema)} OR tn.nspname = ${s(schema)}) ORDER BY f.oid, k.pos`;
  } else if (engine === 'mysql' || engine === 'mariadb') {
    columnsSQL = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${s(catalog)} ORDER BY TABLE_NAME, ORDINAL_POSITION`;
    foreignKeysSQL = `SELECT CONCAT(CONSTRAINT_SCHEMA, '.', TABLE_NAME, '.', CONSTRAINT_NAME), CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_SCHEMA, TABLE_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND (TABLE_SCHEMA = ${s(catalog)} OR REFERENCED_TABLE_SCHEMA = ${s(catalog)}) ORDER BY CONSTRAINT_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`;
  } else if (engine === 'mssql') {
    const system = `${q(catalog)}.sys`;
    columnsSQL = `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ${q(catalog)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${s(schema)} ORDER BY TABLE_NAME, ORDINAL_POSITION`;
    foreignKeysSQL = `SELECT CAST(f.object_id AS varchar(20)), f.name, ${s(catalog)}, sn.name, st.name, ${s(catalog)}, tn.name, tt.name, sc.name, tc.name FROM ${system}.foreign_keys f JOIN ${system}.foreign_key_columns k ON k.constraint_object_id = f.object_id JOIN ${system}.tables st ON st.object_id = k.parent_object_id JOIN ${system}.schemas sn ON sn.schema_id = st.schema_id JOIN ${system}.tables tt ON tt.object_id = k.referenced_object_id JOIN ${system}.schemas tn ON tn.schema_id = tt.schema_id JOIN ${system}.columns sc ON sc.object_id = st.object_id AND sc.column_id = k.parent_column_id JOIN ${system}.columns tc ON tc.object_id = tt.object_id AND tc.column_id = k.referenced_column_id WHERE sn.name = ${s(schema)} OR tn.name = ${s(schema)} ORDER BY f.object_id, k.constraint_column_id`;
  } else if (engine === 'clickhouse') {
    columnsSQL = `SELECT table, name, type FROM system.columns WHERE database = ${s(catalog)} ORDER BY table, position`;
  } else {
    columnsSQL = `SELECT table_name, column_name, data_type FROM ${q(catalog)}.information_schema.columns WHERE table_schema = ${s(schema)} ORDER BY table_name, ordinal_position`;
  }
  const columns = await read(columnsSQL);
  const tables = new Map<string, TableMeta>();
  for (const row of columns.rows) {
    const name = String(row[0]);
    if (!tables.has(name)) tables.set(name, { catalog, schema, name, columns: [] });
    tables.get(name)!.columns.push({ name: String(row[1]), type: String(row[2] ?? '') });
  }
  result.tables = [...tables.values()];
  if (columns.truncated) result.warnings.push('Индекс ограничен 10 000 колонок / 8 MB. Уточните schema; часть объектов не попала в подсказки.');
  if (foreignKeysSQL) {
    try {
      const rows = await read(foreignKeysSQL);
      // Never suggest a partial composite key when the metadata limit cuts a group.
      if (rows.truncated) result.warnings.push('Список foreign keys превышает лимит. Автогенерация по этим ключам отключена.');
      else {
        const relations = new Map<string, Relationship>();
        for (const row of rows.rows) {
          const id = String(row[0]);
          if (!relations.has(id)) relations.set(id, { id: `fk:${catalog}:${id}`, name: String(row[1]), source: { catalog: String(row[2]), schema: String(row[3]), name: String(row[4]) }, target: { catalog: String(row[5]), schema: String(row[6]), name: String(row[7]) }, columns: [], kind: 'foreign-key' });
          relations.get(id)!.columns.push({ source: String(row[8] ?? ''), target: String(row[9] ?? '') });
        }
        result.relationships = [...relations.values()].filter(relation => relation.columns.every(pair => pair.source && pair.target));
      }
    } catch (error) { result.warnings.push(`Не удалось прочитать foreign keys: ${(error as Error).message}`); }
  }
  const visible = new Set(result.tables.map(key));
  result.relationships.push(...virtual.filter(relation => visible.has(key(relation.source)) || visible.has(key(relation.target))));
  return result;
}

export function validateRelation(value: Relationship): void {
  const name = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 512 && !/[\r\n\0]/.test(item);
  if (!value || !name(value.id) || !name(value.name) || value.kind !== 'virtual' || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 32) throw new Error('Некорректная виртуальная связь.');
  for (const table of [value.source, value.target]) if (!table || ![table.catalog, table.schema, table.name].every(name)) throw new Error('Укажите catalog, schema и таблицу для связи.');
  if (!value.columns.every(pair => pair && name(pair.source) && name(pair.target)) || new Set(value.columns.map(pair => pair.source)).size !== value.columns.length || new Set(value.columns.map(pair => pair.target)).size !== value.columns.length) throw new Error('Укажите уникальные пары колонок.');
}

export class RelationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}
  private async read(): Promise<Record<string, Relationship[]>> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Файл связей повреждён.');
      for (const items of Object.values(data)) { if (!Array.isArray(items)) throw new Error('Файл связей повреждён.'); items.forEach(validateRelation); }
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async list(profileId: string): Promise<Relationship[]> { return (await this.read())[profileId] ?? []; }
  change(profileId: string, transform: (items: Relationship[]) => Relationship[]): Promise<void> {
    const task = this.queue.then(async () => {
      const data = await this.read();
      Object.defineProperty(data, profileId, { value: transform(Object.hasOwn(data, profileId) ? data[profileId] : []), enumerable: true, writable: true, configurable: true });
      if (data[profileId].length > 1000) throw new Error('Лимит: 1 000 виртуальных связей на подключение.');
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
