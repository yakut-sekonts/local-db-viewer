import type { DatabaseEngine, JdbcDialect } from './shared';

export interface Token { text: string; value: string; start: number; end: number; container: number; kind: 'name' | 'symbol' | 'string' | 'comment'; quoted?: boolean; closed?: boolean }
export interface Container { parent: number; start: number; end: number }
const keywords = new Set('SELECT DISTINCT ALL FROM WHERE JOIN LEFT RIGHT FULL INNER OUTER CROSS NATURAL ON USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH UNION EXCEPT INTERSECT AS AND OR NOT NULL IS IN EXISTS CASE WHEN THEN ELSE END ASC DESC WITH RECURSIVE UPDATE SET INSERT INTO DELETE VALUES RETURNING QUALIFY WINDOW FOR LATERAL TABLESAMPLE APPLY PIVOT UNPIVOT OVER PARTITION ROWS RANGE GROUPS PRECEDING FOLLOWING CURRENT ROW MATERIALIZED TOP PERCENT TIES FILTER WITHIN NULLS FIRST LAST'.split(' '));

export function tokenize(sql: string, engine?: DatabaseEngine, maximumTokens = Number.POSITIVE_INFINITY): { tokens: Token[]; containers: Container[] } {
  const tokens: Token[] = [];
  const containers: Container[] = [{ parent: -1, start: 0, end: sql.length }];
  let container = 0;
  let i = 0;
  while (i < sql.length) {
    if (tokens.length >= maximumTokens) throw new Error('DDL содержит слишком много SQL tokens; разделите файл.');
    if (/\s/u.test(sql.charAt(i))) { i++; continue; }
    const start = i;
    const mysql = engine === 'mysql' || engine === 'mariadb';
    const lineComment = sql.startsWith('--', i) && (!mysql || !sql.charAt(i + 2) || /\s/.test(sql.charAt(i + 2))) || mysql && sql.charAt(i) === '#';
    if (lineComment || sql.startsWith('/*', i)) {
      let closed = true;
      if (lineComment) { const end = sql.indexOf('\n', i); closed = end >= 0; i = end < 0 ? sql.length : end; }
      else {
        let depth = 1; i += 2;
        while (i < sql.length && depth) { if ((!engine || ['postgres','trino','mssql'].includes(engine)) && sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
        closed = depth === 0;
      }
      tokens.push({ text: sql.slice(start, i), value: '', start, end: i, container, kind: 'comment', closed }); continue;
    }
    const dollar = !engine || engine === 'postgres' ? sql.slice(i).match(/^\$(?:[a-zA-Z_]\w*)?\$/)?.[0] : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length); i = end < 0 ? sql.length : end + dollar.length;
      tokens.push({ text: sql.slice(start, i), value: '', start, end: i, container, kind: 'string', closed: end >= 0 }); continue;
    }
    if (['"', "'", '`'].includes(sql.charAt(i)) || sql.charAt(i) === '[' && (!engine || engine === 'mssql' || engine === 'jdbc')) {
      const opening = sql.charAt(i++); const closing = opening === '[' ? ']' : opening;
      const escaped = opening === "'" && (!engine || mysql || engine === 'clickhouse' || engine === 'postgres' && /e/i.test(sql.charAt(start - 1)) && !/[\p{L}\p{N}_$]/u.test(sql.charAt(start - 2))) || opening === '"' && mysql || opening === '`' && engine === 'clickhouse';
      let value = ''; let closed = false;
      while (i < sql.length) {
        if (sql.charAt(i) === closing) {
          if (sql.charAt(i + 1) === closing) { value += closing; i += 2; }
          else { i++; closed = true; break; }
        } else if (sql.charAt(i) === '\\' && escaped) { value += sql.slice(i, i + 2); i += 2; }
        else value += sql.charAt(i++);
      }
      tokens.push({ text: sql.slice(start, i), value, start, end: i, container, kind: opening === "'" ? 'string' : 'name', quoted: true, closed }); continue;
    }
    const word = sql.slice(i).match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)?.[0];
    if (word) { i += word.length; tokens.push({ text: word, value: word, start, end: i, container, kind: 'name' }); continue; }
    const value = sql.charAt(i++);
    if (value === ')' || value === ']') { const current = containers[container]; if (current && container > 0) { current.end = start; container = Math.max(0, current.parent); } }
    tokens.push({ text: value, value, start, end: i, container, kind: 'symbol' });
    if (value === '(' || value === '[') { containers.push({ parent: container, start: i, end: sql.length }); container = containers.length - 1; }
  }
  return { tokens, containers };
}
export const isKeyword = (token: Token | undefined, word: string) => Boolean(token && !token.quoted && token.value.toUpperCase() === word);
export const isName = (token: Token | undefined): token is Token => Boolean(token && token.kind === 'name' && (token.quoted || !keywords.has(token.value.toUpperCase())));
export const identifierName = (token: Token, engine: DatabaseEngine, dialect?: JdbcDialect) => token.quoted ? token.value : engine === 'postgres' || dialect?.unquotedCase === 'lower' ? token.value.toLowerCase() : dialect?.unquotedCase === 'upper' ? token.value.toUpperCase() : token.value;
export const catalogOnly = (engine: DatabaseEngine, dialect?: JdbcDialect) => ['mysql', 'mariadb', 'clickhouse'].includes(engine) || (engine === 'jdbc' && dialect?.catalogs && !dialect.schemas);
export function nameMatches(token: Token | undefined, name: string, engine: DatabaseEngine): boolean {
  if (!token) return false;
  if (token.quoted) return token.value === name;
  return engine === 'postgres' ? token.value.toLowerCase() === name : token.value.toLowerCase() === name.toLowerCase();
}

export function pathAt(tokens: Token[], start: number): { parts: Token[]; next: number } {
  const parts: Token[] = []; let i = start;
  for (;;) { const token = tokens[i]; if (!isName(token)) break; parts.push(token); i++; if (tokens[i]?.value !== '.' || !isName(tokens[i + 1])) break; i++; }
  return { parts, next: i };
}
