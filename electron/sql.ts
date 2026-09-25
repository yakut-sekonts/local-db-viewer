import type { DatabaseEngine, MetadataInput } from '../src/shared';

// Read command words only; comments do not change transaction semantics and a
// savepoint rollback does not end the surrounding transaction.
export function transactionAction(sql: string): string {
  const words: string[] = [];
  let i = 0;
  while (i < sql.length && words.length < 6) {
    if (/\s/.test(sql.charAt(i))) { i++; continue; }
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
  const action = ['COMMIT', 'END'].includes(words[0] ?? '') ? 'commit' : ['ROLLBACK', 'ABORT'].includes(words[0] ?? '') ? 'rollback' : '';
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

// This checks statement boundaries, not SQL validity. Session-dependent escape
// modes can be supplied explicitly; a JDBC driver without a known dialect uses ANSI.
export interface SqlLexingOptions { backslashEscapes?: boolean }
export function singleStatement(sql: string, engine: DatabaseEngine = 'jdbc', options: SqlLexingOptions = {}): string {
  const first = scanStatements(sql, engine, options, false)[0];
  if (!first) throw new Error('SQL пустой или превышает 1 MB.');
  return first.sql;
}
export interface SqlStatement { sql: string; start: number; end: number; line: number }
function scanStatements(sql: string, engine: DatabaseEngine, options: SqlLexingOptions, multiple: boolean): SqlStatement[] {
  if (typeof sql !== 'string' || sql.length > 1_000_000) throw new Error('SQL пустой или превышает 1 MB.');
  const mysql = engine === 'mysql' || engine === 'mariadb';
  const postgres = engine === 'postgres';
  const backslashes = options.backslashEscapes ?? (mysql || engine === 'clickhouse');
  const nestedComments = ['postgres', 'trino', 'mssql'].includes(engine);
  let i = 0, start = 0, ended = false, hasToken = false;
  const statements: SqlStatement[] = [];
  const lineStarts = [0];
  const directiveOffsets = new Set(multiple ? [...sql.matchAll(/^[ \t]*(?=[gd\\./])/gim)].map(match => match.index + match[0].length) : []);
  for (let offset = 0; offset < sql.length; offset++) if (sql.charAt(offset) === '\n') lineStarts.push(offset + 1);
  const append = (end: number) => {
    if (!hasToken) return;
    const fragment = sql.slice(start, end), trimmed = fragment.trim();
    const offset = start + fragment.length - fragment.trimStart().length;
    let low = 0, high = lineStarts.length;
    while (low < high) { const middle = Math.floor((low + high) / 2); if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1; else high = middle; }
    statements.push({ sql: trimmed, start: offset, end: offset + trimmed.length, line: low });
    if (multiple && statements.length > 100) throw new Error('В одном скрипте допускается до 100 SQL-команд.');
  };
  while (i < sql.length) {
    const character = sql.charAt(i);
    if (/\s/.test(character)) { i++; continue; }
    if ((sql.startsWith('--', i) && (!mysql || !sql.charAt(i + 2) || /\s/.test(sql.charAt(i + 2)))) || (mysql && character === '#')) {
      const next = sql.indexOf('\n', i); i = next < 0 ? sql.length : next + 1; continue;
    }
    if (sql.startsWith('/*', i)) {
      if (mysql && (sql.startsWith('/*!', i) || sql.startsWith('/*M!', i))) throw new Error('Исполняемые MySQL/MariaDB-комментарии не поддерживаются. Выполните SQL явно.');
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (nestedComments && sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Незакрытый SQL-комментарий.');
      continue;
    }
    if (ended) throw new Error('Выполняйте одну SQL-команду за раз. Выделите нужный фрагмент.');
    if (directiveOffsets.has(i)) {
      const line = sql.slice(i, sql.indexOf('\n', i) < 0 ? sql.length : sql.indexOf('\n', i));
      if (/^(?:GO(?:\s+\d+)?\s*(?:--.*)?|DELIMITER\b.*|\\.*|\.[A-Za-z].*|\/\s*)\r?$/i.test(line)) throw new Error('GO, DELIMITER и команды клиентских программ не поддерживаются в последовательном скрипте. Ни одна команда не выполнена.');
    }
    if (character === ';') { append(i); hasToken = false; ended = !multiple; start = ++i; continue; }
    hasToken = true;
    const dollar = postgres && !/[\p{L}\p{N}_$]/u.test(sql.charAt(i - 1)) ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0] : undefined;
    if (dollar) {
      const next = sql.indexOf(dollar, i + dollar.length); if (next < 0) throw new Error('Незакрытая dollar-quoted строка.');
      i = next + dollar.length; continue;
    }
    const bracket = character === '[' && (engine === 'mssql' || engine === 'sqlite');
    const backtick = character === '`' && (mysql || engine === 'clickhouse' || engine === 'sqlite');
    if (character === "'" || character === '"' || bracket || backtick) {
      const opening = character, closing = bracket ? ']' : opening;
      const escapeString = postgres && opening === "'" && /e/i.test(sql.charAt(i - 1)) && !/[\p{L}\p{N}_$]/u.test(sql.charAt(i - 2));
      const escaped = !bracket && (escapeString || backslashes && (opening === "'" || (opening === '"' && mysql) || backtick && engine === 'clickhouse'));
      i++; let closed = false;
      while (i < sql.length) {
        if (sql.charAt(i) === closing) {
          if (sql.charAt(i + 1) === closing) i += 2;
          else { i++; closed = true; break; }
        } else if (escaped && sql.charAt(i) === '\\') i += 2;
        else i++;
      }
      if (!closed) throw new Error('Незакрытая строка или identifier.');
      continue;
    }
    i++;
  }
  append(sql.length);
  if (!statements.length) throw new Error('SQL пустой или превышает 1 MB.');
  return statements;
}

// Sequential statements are not procedural/server batches. Validate every part
// before executing any of it; never submit a cut-off routine or client directive.
export function splitSqlScript(sql: string, engine: DatabaseEngine = 'jdbc'): SqlStatement[] {
  const statements = scanStatements(sql, engine, {}, true);
  if (['mysql', 'mariadb', 'postgres'].includes(engine)) {
    let alternative: SqlStatement[];
    try { alternative = scanStatements(sql, engine, { backslashEscapes: engine === 'postgres' }, true); }
    catch { throw new Error('Границы скрипта зависят от режима backslash escaping. Выполните неоднозначную команду отдельно.'); }
    if (alternative.length !== statements.length || alternative.some((part, i) => part.start !== statements[i]?.start || part.end !== statements[i]?.end)) throw new Error('Границы скрипта зависят от режима backslash escaping. Выполните неоднозначную команду отдельно.');
  }
  for (const part of statements) {
    // Comments and literals are removed only for conservative classification;
    // their original bytes are preserved in the statement sent to the driver.
    const prefix = leadingSqlWords(part.sql, engine);
    const command = prefix.join(' ');
    if (/^(?:DELIMITER|GO|DECLARE|IF|WHILE|FOR|LOOP|CALL|EXEC|EXECUTE)\b/.test(command)
      || /^BEGIN\b/.test(command) && !/^BEGIN(?: (?:WORK|TRANSACTION|TRAN)| (?:DEFERRED|IMMEDIATE|EXCLUSIVE)(?: TRANSACTION)?)?$/.test(command)
      || /^(?:CREATE|ALTER)\b/.test(command) && !/^(?:CREATE|ALTER)(?: OR (?:REPLACE|ALTER))?(?: TEMP(?:ORARY)?| UNIQUE| UNLOGGED)? (?:TABLE|VIEW|MATERIALIZED VIEW|INDEX|SCHEMA|DATABASE|SEQUENCE|ROLE|USER|TYPE)\b/.test(command)
      || /^COPY\b/.test(command) && /\b(?:FROM\s+STDIN|TO\s+STDOUT)\b/i.test(part.sql)
      || /^\\/.test(part.sql.trimStart())) {
      throw new Error(`Строка ${part.line}: procedural SQL, GO/DELIMITER и клиентские команды не поддерживаются в последовательном скрипте. Выполните их подходящим клиентом.`);
    }
  }
  return statements;
}
function leadingSqlWords(sql: string, engine: DatabaseEngine): string[] {
  const words: string[] = []; let i = 0;
  while (i < sql.length && words.length < 12) {
    if (/\s/.test(sql.charAt(i))) { i++; continue; }
    if (sql.startsWith('--', i) && (!['mysql', 'mariadb'].includes(engine) || /\s/.test(sql.charAt(i + 2))) || ['mysql', 'mariadb'].includes(engine) && sql.charAt(i) === '#') {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) { if (['postgres','trino','mssql'].includes(engine) && sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      continue;
    }
    const word = /^[A-Za-z_]+/.exec(sql.slice(i))?.[0]; if (!word) break;
    words.push(word.toUpperCase()); i += word.length;
  }
  return words;
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
