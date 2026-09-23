import type { Connection } from './trino';
import type { DdlMapping } from '../src/ddl';
import type { MetadataResult } from '../src/shared';
import { sqlEngine } from '../src/drivers';
import { identifier, sqlLiteral } from './sql';
import { ddlFileName } from './ddl-store';
import { readPostgresDdl } from './ddl-postgres';
import { readMssqlDdl } from './ddl-mssql';

export function ddlConnection(connection: Connection): Connection {
  if (!['postgres','mssql'].includes(sqlEngine(connection))) return connection;
  return { ...connection, jdbc: { ...connection.jdbc, options: { ...connection.jdbc?.options, singleSession: false, autoCommit: true, keepAliveSeconds: 0, autoDisconnectSeconds: 0 } } };
}

/** Prefer native definitions; catalog exporters reject unsupported structures explicitly. */
export async function readDdl(connection: Connection, mapping: DdlMapping, query: (sql: string) => Promise<MetadataResult>) {
  const engine = sqlEngine(connection), q = (name: string) => identifier(name, engine), literal = (name: string) => sqlLiteral(name, engine);
  const read = async (sql: string) => { const result = await query(sql); if (result.truncated) throw new Error('Серверный DDL превышает лимит. Выгрузка остановлена без записи файлов.'); return result.rows; };
  if (engine === 'postgres' || engine === 'mssql') {
    if (!mapping.catalog || !mapping.schema) throw new Error('Для выгрузки укажите catalog/database и schema.');
    return engine === 'postgres' ? readPostgresDdl(mapping,read) : readMssqlDdl(mapping,read);
  }
  const files: { file: string; sql: string }[] = [];
  const add = (kind: string, name: unknown, sql: unknown) => {
    if (typeof name !== 'string' || typeof sql !== 'string' || !sql.trim()) throw new Error('Сервер не вернул полный SQL объекта.');
    files.push({ file: ddlFileName(kind, name), sql: sql.trimEnd().replace(/;?$/, ';') + '\n' });
  };
  if (engine === 'sqlite') {
    if (mapping.catalog && mapping.catalog !== 'main' || mapping.schema && mapping.schema !== 'main') throw new Error('SQLite DDL: выберите main.');
    for (const row of await read("SELECT type, name, sql FROM main.sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name")) add(String(row[0]), row[1], row[2]);
    return { files, warnings: ['SQLite: определения таблиц, views, indexes и triggers из sqlite_schema. PRAGMA и данные не выгружаются.'] };
  }
  if (!['trino','mysql','mariadb','clickhouse'].includes(engine)) throw new Error('Для этого JDBC-драйвера серверная выгрузка DDL пока недоступна. Можно связать каталог готовых SQL-файлов, редактировать их и использовать локальное автодополнение.');
  if (!mapping.catalog || engine === 'trino' && !mapping.schema) throw new Error('Для выгрузки укажите catalog/database и schema.');
  const sql = engine === 'trino' ? `SELECT table_name, table_type FROM ${q(mapping.catalog)}.information_schema.tables WHERE table_schema = ${literal(mapping.schema)} ORDER BY table_name`
    : engine === 'clickhouse' ? `SELECT name, 'TABLE' FROM system.tables WHERE database = ${literal(mapping.catalog)} ORDER BY name`
    : `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${literal(mapping.catalog)} ORDER BY TABLE_NAME`;
  const tables = await read(sql);
  if (tables.length > 1000) throw new Error('Лимит выгрузки: 1000 объектов.');
  for (const row of tables) {
    if (typeof row[0] !== 'string') throw new Error('Некорректное имя объекта в метаданных.');
    const name = row[0], type = String(row[1]).toUpperCase(), view = type.includes('VIEW');
    const path = [mapping.catalog, ...(engine === 'trino' ? [mapping.schema] : []), name].map(q).join('.');
    const definition = await read(`SHOW CREATE ${engine === 'trino' && view ? type.includes('MATERIALIZED') ? 'MATERIALIZED VIEW' : 'VIEW' : 'TABLE'} ${path}`);
    if (definition.length !== 1) throw new Error(`Не удалось получить однозначный DDL: ${name}.`);
    add(view ? 'view' : 'table', name, definition[0]?.[engine === 'mysql' || engine === 'mariadb' ? 1 : 0]);
  }
  return { files, warnings: ['Выгружаются определения tables/views, возвращаемые SHOW CREATE. Отдельные routines, grants и другие объекты не входят в mapping. Применение SQL к серверу выполняется вручную из консоли.'] };
}
