import { Buffer } from 'node:buffer';
import { sqlEngine, profileDriver } from '../src/drivers';
import { isSystemSchema, objectAllowed, schemaAllowed } from '../src/schemaSettings';
import type { SourceIndex } from '../src/sources';
import type { MetadataResult, SchemaInput } from '../src/shared';
import type { Connection } from './trino';
import { identifier, sqlLiteral } from './sql';

export function supportsObjectSources(connection: Connection): boolean {
  if (profileDriver(connection) === 'redshift') return false;
  return ['sqlite', 'postgres', 'mssql', 'mysql', 'mariadb', 'trino', 'clickhouse'].includes(sqlEngine(connection)) || profileDriver(connection) === 'h2';
}

export function shouldLoadSources(connection: Connection, input: SchemaInput, automatic: boolean): boolean {
  if (!schemaAllowed(connection.jdbc?.schemas, input.catalog, input.schema)) return false;
  if (!automatic) return true;
  const mode = connection.jdbc?.options?.loadSources ?? 'user';
  return mode !== 'none' && (mode === 'all' || !isSystemSchema(input.catalog, input.schema));
}

/** Read source text verbatim from server metadata. This never generates or executes object DDL. */
export async function readObjectSources(connection: Connection, input: SchemaInput, query: (sql: string) => Promise<MetadataResult>): Promise<SourceIndex> {
  if (!supportsObjectSources(connection)) return { ...input, objects: [], warnings: ['Загрузка исходников пока недоступна для этого JDBC-драйвера.'], loadedAt: Date.now(), skipped: true };
  const engine = sqlEngine(connection), q = (value: string) => identifier(value, engine), literal = (value: string) => sqlLiteral(value, engine);
  const result: SourceIndex = { ...input, objects: [], warnings: [], loadedAt: Date.now() };
  const schema = literal(input.schema), catalog = q(input.catalog);
  let sql: string;
  if (engine === 'sqlite') {
    if (input.catalog && input.catalog !== 'main' || input.schema && input.schema !== 'main') throw new Error('SQLite sources: выберите main.');
    sql = "SELECT name, type, name, sql FROM main.sqlite_schema WHERE type IN ('view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
    result.catalog = result.schema = 'main';
  } else if (engine === 'postgres') {
    if (input.catalog) {
      const current = await query('SELECT current_database()');
      if (current.rows[0]?.[0] !== input.catalog) throw new Error('PostgreSQL: для другой database нужно отдельное подключение.');
    }
    if (!input.schema) return { ...result, skipped: true };
    sql = `SELECT c.oid::text, CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END, c.relname, pg_catalog.pg_get_viewdef(c.oid, true) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind IN ('v','m')
UNION ALL SELECT p.oid::text, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema} AND p.prokind IN ('f','p','w')
UNION ALL SELECT t.oid::text, 'trigger', t.tgname, pg_catalog.pg_get_triggerdef(t.oid, true) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT t.tgisinternal ORDER BY 2,3`;
    result.warnings.push('Views: SELECT-определение сервера. Functions/procedures/triggers: серверный SQL; зависимости и права не включены.');
  } else if (engine === 'mssql') {
    if (!input.catalog || !input.schema) return { ...result, skipped: true };
    sql = `SELECT CONVERT(varchar(20), o.object_id), RTRIM(o.type_desc), o.name, m.definition FROM ${catalog}.sys.objects o JOIN ${catalog}.sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN ${catalog}.sys.sql_modules m ON m.object_id=o.object_id WHERE s.name=${schema} AND o.type IN ('V','P','FN','IF','TF','TR') ORDER BY o.type,o.name`;
    result.warnings.push('Показаны видимые подключению SQL modules. Зашифрованные определения и объекты без VIEW DEFINITION недоступны.');
  } else if (engine === 'mysql' || engine === 'mariadb') {
    const database = literal(input.catalog || input.schema);
    if (!input.catalog && !input.schema) return { ...result, skipped: true };
    sql = `SELECT TABLE_NAME, 'view', TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=${database}
UNION ALL SELECT SPECIFIC_NAME, ROUTINE_TYPE, ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=${database}
UNION ALL SELECT TRIGGER_NAME, 'trigger', TRIGGER_NAME, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${database} ORDER BY 2,3`;
    result.warnings.push('Views: SELECT; routines/triggers: тело объекта из information_schema. Это исходник, а не полный CREATE с параметрами и правами.');
  } else if (engine === 'trino') {
    if (!input.catalog || !input.schema) return { ...result, skipped: true };
    sql = `SELECT table_name, 'view', table_name, view_definition FROM ${catalog}.information_schema.views WHERE table_schema=${schema} ORDER BY table_name`;
    result.warnings.push('Trino/Presto: SELECT-определения обычных views. Materialized views и routines не включены.');
  } else if (engine === 'clickhouse') {
    if (!input.catalog) return { ...result, skipped: true };
    sql = `SELECT name, engine, name, create_table_query FROM system.tables WHERE database=${literal(input.catalog)} AND engine IN ('View','MaterializedView','LiveView','WindowView') ORDER BY name`;
  } else if (profileDriver(connection) === 'h2') {
    if (!input.schema) return { ...result, skipped: true };
    sql = `SELECT TABLE_NAME, 'view', TABLE_NAME, VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA=${schema} ORDER BY TABLE_NAME`;
    result.warnings.push('H2: SELECT-определения views; Java routines не включены.');
  } else return { ...result, warnings: ['Загрузка исходников пока недоступна для этого JDBC-драйвера.'], skipped: true };
  const rows = await query(sql);
  let bytes = 0;
  for (const row of rows.rows) {
    const [id, kind, name, source] = row;
    if (typeof name !== 'string' || typeof kind !== 'string' || typeof id !== 'string') throw new Error('Сервер вернул некорректные метаданные исходников.');
    if (!objectAllowed(connection.jdbc?.schemas, { catalog: result.catalog, schema: result.schema, name })) continue;
    if (source !== null && typeof source !== 'string') throw new Error('Сервер вернул некорректный SQL объекта.');
    bytes += Buffer.byteLength(source ?? '', 'utf8');
    if (result.objects.length >= 512 || bytes > 2 * 1024 * 1024) { result.warnings.push('Исходники ограничены 512 объектами / 2 MB на schema. Уточните фильтр объектов.'); break; }
    result.objects.push({ catalog: result.catalog, schema: result.schema, id: JSON.stringify([kind,id]), kind, name, sql: source });
  }
  if (rows.truncated) result.warnings.push('Серверный ответ ограничен; список исходников неполный.');
  if (result.objects.some(object => object.sql === null)) result.warnings.push('Часть определений недоступна: проверьте права подключения или шифрование объектов.');
  return result;
}

export class SourceCache {
  private entries = new Map<string, { profileId: string; time: number; value: Promise<SourceIndex> }>();
  clear(profileId: string) { for (const [key, entry] of this.entries) if (entry.profileId === profileId) this.entries.delete(key); }
  async load(input: SchemaInput, refresh: boolean, read: () => Promise<SourceIndex>): Promise<SourceIndex> {
    const key = JSON.stringify([input.profileId,input.catalog,input.schema]), entry = this.entries.get(key);
    if (!refresh && entry && Date.now() - entry.time < 300000) return entry.value;
    if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value!);
    const value = read();
    this.entries.set(key, { profileId: input.profileId, time: Date.now(), value });
    try { return await value; }
    catch (error) { if (this.entries.get(key)?.value === value) this.entries.delete(key); throw error; }
  }
}
