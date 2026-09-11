import type { DatabaseEngine, MetadataInput } from '../src/shared';

// Read command words only; comments do not change transaction semantics and a
// savepoint rollback does not end the surrounding transaction.
export function transactionAction(sql: string): string {
  const words: string[] = [];
  let i = 0;
  while (i < sql.length && words.length < 6) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      continue;
    }
    const word = /^[A-Za-z_]+/.exec(sql.slice(i))?.[0];
    if (!word) break;
    words.push(word.toUpperCase()); i += word.length;
  }
  const command = words.join(' ');
  if (words[0] === 'BEGIN' || words[0] === 'SAVEPOINT') return 'begin';
  if (words[0] === 'START' && words[1] === 'TRANSACTION') return 'begin';
  if (/^ROLLBACK(?: (?:WORK|TRANSACTION))? TO\b/.test(command)) return '';
  const action = ['COMMIT', 'END'].includes(words[0]) ? 'commit' : ['ROLLBACK', 'ABORT'].includes(words[0]) ? 'rollback' : '';
  return action && /\bAND CHAIN\b/.test(command) ? `${action}-chain` : action;
}

export function identifier(value: string, engine: DatabaseEngine): string {
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'clickhouse') return '`' + value.replaceAll('`', '``') + '`';
  if (engine === 'mssql') return '[' + value.replaceAll(']', ']]') + ']';
  return '"' + value.replaceAll('"', '""') + '"';
}
export function sqlLiteral(value: string, engine: DatabaseEngine): string {
  if (engine === 'mysql' || engine === 'mariadb') {
    const hex = [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  if (engine === 'postgres') return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
  if (engine === 'clickhouse') return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  return (engine === 'mssql' ? 'N' : '') + "'" + value.replaceAll("'", "''") + "'";
}

// Reject a second statement without splitting strings, quoted identifiers or function bodies.
export function singleStatement(sql: string): string {
  let i = 0;
  let ended = false;
  let end = sql.length;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const next = sql.indexOf('\n', i); i = next < 0 ? sql.length : next + 1; continue; }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Незакрытый SQL-комментарий.');
      continue;
    }
    if (ended) throw new Error('Выполняйте одну SQL-команду за раз. Выделите нужный фрагмент.');
    if (sql[i] === ';') { ended = true; end = i++; continue; }
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    if (dollar) { const next = sql.indexOf(dollar, i + dollar.length); if (next < 0) throw new Error('Незакрытая dollar-quoted строка.'); i = next + dollar.length; continue; }
    if (["'", '"', '`', '['].includes(sql[i])) {
      const opening = sql[i++]; const closing = opening === '[' ? ']' : opening;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === closing) { if (sql[i + 1] === closing) i += 2; else { i++; closed = true; break; } }
        else if (sql[i] === '\\' && opening !== '[') i += 2;
        else i++;
      }
      if (!closed) throw new Error('Незакрытая строка или identifier.');
      continue;
    }
    i++;
  }
  const statement = sql.slice(0, end).trim();
  if (!statement || statement.length > 1_000_000) throw new Error('SQL пустой или превышает 1 MB.');
  return statement;
}

export function metadataSQL(engine: DatabaseEngine, input: MetadataInput): string {
  const literal = (value: string) => sqlLiteral(value, engine);
  const cat = input.catalog ?? ''; const schema = input.schema ?? ''; const table = input.table ?? '';
  const q = (name: string) => identifier(name, engine);
  const path = [cat, schema, table].filter(Boolean).map(q);
  if (engine === 'trino') return ({ catalogs: 'SHOW CATALOGS', schemas: `SHOW SCHEMAS FROM ${q(cat)}`, tables: `SHOW TABLES FROM ${q(cat)}.${q(schema)}`, columns: `SHOW COLUMNS FROM ${path.join('.')}` })[input.kind];
  if (engine === 'postgres') return ({
    catalogs: 'SELECT current_database() AS database',
    schemas: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    tables: `SELECT table_name FROM information_schema.tables WHERE table_schema = ${literal(schema)} ORDER BY table_name`,
    columns: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ${literal(schema)} AND table_name = ${literal(table)} ORDER BY ordinal_position`,
  })[input.kind];
  if (engine === 'sqlite') return ({
    catalogs: "SELECT 'main' AS database", schemas: "SELECT 'main' AS schema",
    tables: "SELECT name FROM main.sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    columns: `SELECT name, type FROM pragma_table_info(${literal(table)}) ORDER BY cid`,
  })[input.kind];
  if (engine === 'mysql' || engine === 'mariadb') return ({
    catalogs: 'SHOW DATABASES', schemas: `SELECT ${literal(cat)} AS schema_name`,
    tables: `SHOW FULL TABLES FROM ${q(cat)}`,
    columns: `SHOW COLUMNS FROM ${q(cat)}.${q(table)}`,
  })[input.kind];
  if (engine === 'mssql') return ({
    catalogs: 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name',
    schemas: `SELECT name FROM ${q(cat)}.sys.schemas ORDER BY name`,
    tables: `SELECT TABLE_NAME FROM ${q(cat)}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ${literal(schema)} ORDER BY TABLE_NAME`,
    columns: `SELECT COLUMN_NAME, DATA_TYPE FROM ${q(cat)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${literal(schema)} AND TABLE_NAME = ${literal(table)} ORDER BY ORDINAL_POSITION`,
  })[input.kind];
  return ({
    catalogs: 'SHOW DATABASES', schemas: `SELECT ${literal(cat)} AS schema`,
    tables: `SHOW TABLES FROM ${q(cat)}`, columns: `DESCRIBE TABLE ${q(cat)}.${q(table)}`,
  })[input.kind];
}

export function previewSQL(engine: DatabaseEngine, catalog: string, schema: string, table: string): string {
  const parts = engine === 'postgres' || engine === 'sqlite' ? [schema, table] : ['mysql', 'mariadb', 'clickhouse'].includes(engine) ? [catalog, table] : [catalog, schema, table];
  const path = parts.filter(Boolean).map(name => identifier(name, engine)).join('.');
  return engine === 'mssql' ? `SELECT TOP (100) *\nFROM ${path};` : `SELECT *\nFROM ${path}\nLIMIT 100;`;
}
