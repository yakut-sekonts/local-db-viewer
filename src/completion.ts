import type { Column, DatabaseEngine, Relationship, SchemaIndex, TableMeta, TableRef } from './shared';
import { identifier } from '../electron/sql';

interface Token { text: string; value: string; start: number; end: number; container: number; kind: 'name' | 'symbol' | 'string' | 'comment'; quoted?: boolean; closed?: boolean }
interface Container { parent: number; start: number; end: number }
interface Binding { table: TableMeta; alias: string; explicitAlias: boolean }
export interface SqlSuggestion { label: string; insertText: string; detail: string; kind: 'column' | 'table' | 'join' | 'keyword'; start: number; end: number; rank: number; filterText?: string }
const keywords = new Set('SELECT DISTINCT ALL FROM WHERE JOIN LEFT RIGHT FULL INNER OUTER CROSS NATURAL ON USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH UNION EXCEPT INTERSECT AS AND OR NOT NULL IS IN EXISTS CASE WHEN THEN ELSE END ASC DESC WITH RECURSIVE UPDATE SET INSERT INTO DELETE VALUES RETURNING QUALIFY WINDOW FOR LATERAL TABLESAMPLE'.split(' '));

function tokenize(sql: string): { tokens: Token[]; containers: Container[] } {
  const tokens: Token[] = [];
  const containers: Container[] = [{ parent: -1, start: 0, end: sql.length }];
  let container = 0;
  let i = 0;
  while (i < sql.length) {
    if (/\s/u.test(sql[i])) { i++; continue; }
    const start = i;
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      let closed = true;
      if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); closed = end >= 0; i = end < 0 ? sql.length : end; }
      else {
        let depth = 1; i += 2;
        while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
        closed = depth === 0;
      }
      tokens.push({ text: sql.slice(start, i), value: '', start, end: i, container, kind: 'comment', closed }); continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[a-zA-Z_]\w*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length); i = end < 0 ? sql.length : end + dollar.length;
      tokens.push({ text: sql.slice(start, i), value: '', start, end: i, container, kind: 'string', closed: end >= 0 }); continue;
    }
    if (['"', "'", '`', '['].includes(sql[i])) {
      const opening = sql[i++]; const closing = opening === '[' ? ']' : opening;
      let value = ''; let closed = false;
      while (i < sql.length) {
        if (sql[i] === closing) {
          if (sql[i + 1] === closing) { value += closing; i += 2; }
          else { i++; closed = true; break; }
        } else if (sql[i] === '\\' && opening === "'") { value += sql.slice(i, i + 2); i += 2; }
        else value += sql[i++];
      }
      tokens.push({ text: sql.slice(start, i), value, start, end: i, container, kind: opening === "'" ? 'string' : 'name', quoted: true, closed }); continue;
    }
    const word = sql.slice(i).match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)?.[0];
    if (word) { i += word.length; tokens.push({ text: word, value: word, start, end: i, container, kind: 'name' }); continue; }
    const value = sql[i++];
    if (value === ')') { containers[container].end = start; container = Math.max(0, containers[container].parent); }
    tokens.push({ text: value, value, start, end: i, container, kind: 'symbol' });
    if (value === '(') { containers.push({ parent: container, start: i, end: sql.length }); container = containers.length - 1; }
  }
  return { tokens, containers };
}
const isKeyword = (token: Token | undefined, word: string) => Boolean(token && !token.quoted && token.value.toUpperCase() === word);
const isName = (token: Token | undefined): token is Token => Boolean(token && token.kind === 'name' && (token.quoted || !keywords.has(token.value.toUpperCase())));
const identifierName = (token: Token, engine: DatabaseEngine) => engine === 'postgres' && !token.quoted ? token.value.toLowerCase() : token.value;
function nameMatches(token: Token, name: string, engine: DatabaseEngine): boolean {
  if (token.quoted) return token.value === name;
  return engine === 'postgres' ? token.value.toLowerCase() === name : token.value.toLowerCase() === name.toLowerCase();
}
export const tableKey = (table: TableRef) => JSON.stringify([table.catalog, table.schema, table.name]);
export function tablePath(table: TableRef, engine: DatabaseEngine): string {
  const parts = ['mysql', 'mariadb', 'clickhouse'].includes(engine) ? [table.catalog, table.name] : engine === 'postgres' || engine === 'sqlite' ? [table.schema, table.name] : [table.catalog, table.schema, table.name];
  return parts.filter(Boolean).map(name => identifier(name, engine)).join('.');
}
function pathAt(tokens: Token[], start: number): { parts: Token[]; next: number } {
  const parts: Token[] = []; let i = start;
  while (isName(tokens[i])) { parts.push(tokens[i++]); if (tokens[i]?.value !== '.' || !isName(tokens[i + 1])) break; i++; }
  return { parts, next: i };
}
function resolveTable(parts: Token[], index: SchemaIndex, engine: DatabaseEngine, ctes: TableMeta[]): TableMeta | undefined {
  const last = parts.at(-1);
  if (!last) return;
  const candidates = [...ctes, ...index.tables].filter(table => nameMatches(last, table.name, engine));
  if (parts.length === 1) return candidates.find(table => ctes.includes(table) || (table.catalog === index.catalog && table.schema === index.schema));
  return candidates.find(table => parts.length === 2
    ? nameMatches(parts[0], ['mysql', 'mariadb', 'clickhouse'].includes(engine) ? table.catalog : table.schema, engine)
    : nameMatches(parts[0], table.catalog, engine) && nameMatches(parts[1], table.schema, engine));
}
function bindings(tokens: Token[], index: SchemaIndex, engine: DatabaseEngine, ctes: TableMeta[]): Binding[] {
  const result: Binding[] = []; let from = false;
  for (let i = 0; i < tokens.length; i++) {
    const upper = tokens[i].quoted ? '' : tokens[i].value.toUpperCase();
    if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'SET', 'RETURNING'].includes(upper)) from = false;
    if (!['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(upper) && !(from && tokens[i].value === ',')) continue;
    from = true;
    const path = pathAt(tokens, i + 1);
    if (!path.parts.length || tokens[path.next]?.value === '(') continue;
    const table = resolveTable(path.parts, index, engine, ctes);
    let next = path.next;
    if (isKeyword(tokens[next], 'AS')) next++;
    const alias = identifierName(isName(tokens[next]) ? tokens[next] : path.parts.at(-1)!, engine);
    if (table) result.push({ table, alias, explicitAlias: isName(tokens[next]) });
    i = isName(tokens[next]) ? next : path.next - 1;
  }
  return result;
}

/** Conservative projection inference: named columns, AS aliases, alias.*, explicit CTE column lists. */
function cteTables(tokens: Token[], containers: Container[], index: SchemaIndex, engine: DatabaseEngine): TableMeta[] {
  const ctes: TableMeta[] = [];
  const root = tokens.filter(token => token.container === 0);
  if (!isKeyword(root[0], 'WITH')) return ctes;
  for (let i = 1; i < root.length; i++) {
    if (isKeyword(root[i], 'SELECT')) break;
    if (!isName(root[i])) continue;
    const name = identifierName(root[i], engine);
    let next = i + 1;
    let names: string[] = [];
    if (root[next]?.value === '(') {
      const group = containers.findIndex(item => item.start === root[next].end);
      names = tokens.filter(token => token.container === group && isName(token)).map(token => identifierName(token, engine));
      next += 2;
    }
    if (!isKeyword(root[next], 'AS') || root[next + 1]?.value !== '(') continue;
    const opening = root[next + 1];
    const group = containers.findIndex(item => item.start === opening.end);
    const inner = tokens.filter(token => token.container === group);
    const refs = bindings(inner, index, engine, ctes);
    const columns: Column[] = [];
    const from = inner.findIndex(token => isKeyword(token, 'FROM'));
    const projection = inner.slice(1, from < 0 ? undefined : from);
    const pieces: Token[][] = [[]];
    for (const token of projection) { if (token.value === ',') pieces.push([]); else pieces.at(-1)!.push(token); }
    for (const piece of pieces) {
      const aliasAt = piece.findIndex(token => isKeyword(token, 'AS'));
      if (aliasAt >= 0 && isName(piece[aliasAt + 1])) columns.push({ name: identifierName(piece[aliasAt + 1], engine), type: 'CTE expression' });
      else if (piece.at(-1)?.value === '*') {
        const sources = piece.length === 3 ? refs.filter(ref => nameMatches(piece[0], ref.alias, engine)) : refs;
        columns.push(...sources.flatMap(ref => ref.table.columns));
      } else if (piece.length === 1 && isName(piece[0]) || piece.length === 3 && piece[1]?.value === '.' && isName(piece[2])) {
        const columnName = identifierName(piece.at(-1)!, engine);
        columns.push({ name: columnName, type: refs.flatMap(ref => ref.table.columns).find(column => column.name === columnName)?.type ?? 'CTE column' });
      }
    }
    ctes.push({ catalog: index.catalog, schema: index.schema, name, columns: names.length ? names.map(name => ({ name, type: 'CTE column' })) : columns });
    i = next + 2;
  }
  return ctes;
}

function context(sql: string, offset: number) {
  const full = tokenize(sql);
  const blocked = full.tokens.some(token => ['string', 'comment'].includes(token.kind) && token.start < offset && (offset < token.end || offset === token.end && !token.closed));
  const boundaries = full.tokens.filter(token => token.value === ';' && token.kind === 'symbol' && token.container === 0);
  const start = boundaries.filter(token => token.end <= offset).at(-1)?.end ?? 0;
  const end = boundaries.find(token => token.start >= offset)?.start ?? sql.length;
  const tokens = full.tokens.filter(token => token.kind !== 'comment' && token.start >= start && token.end <= end);
  let scope = 0;
  for (let i = 1; i < full.containers.length; i++) {
    const group = full.containers[i];
    if (group.start <= offset && offset <= group.end && tokens.some(token => token.container === i && isKeyword(token, 'SELECT'))) scope = i;
  }
  let scoped = tokens.filter(token => token.container === scope);
  const unionBefore = scoped.filter(token => ['UNION', 'EXCEPT', 'INTERSECT'].some(word => isKeyword(token, word)) && token.start < offset).at(-1)?.end ?? start;
  const unionAfter = scoped.find(token => ['UNION', 'EXCEPT', 'INTERSECT'].some(word => isKeyword(token, word)) && token.start >= offset)?.start ?? end;
  scoped = scoped.filter(token => token.start >= unionBefore && token.end <= unionAfter);
  const queryContainers = new Set(tokens.filter(token => isKeyword(token, 'SELECT')).map(token => token.container));
  const expressions = tokens.filter(token => {
    if (token.start < unionBefore || token.end > unionAfter) return false;
    let group = token.container;
    while (group !== scope) {
      if (group < 0 || queryContainers.has(group)) return false;
      group = full.containers[group].parent;
    }
    return true;
  });
  const word = expressions.find(token => token.kind === 'name' && token.start < offset && token.end >= offset);
  const replaceStart = word?.start ?? offset;
  const before = expressions.filter(token => token.end <= replaceStart);
  const qualifier: Token[] = [];
  let position = before.length - 1;
  while (before[position]?.value === '.' && isName(before[position - 1])) { qualifier.unshift(before[position - 1]); position -= 2; }
  const prior = before.slice(0, position + 1);
  return { blocked, tokens, containers: full.containers, scoped, word, replaceStart, replaceEnd: word?.end ?? offset, before, qualifier, prior };
}

/** Contexts referenced explicitly in SQL are loaded lazily by the renderer. */
export function requestedSchemas(sql: string, offset: number, index: SchemaIndex, engine: DatabaseEngine): { catalog: string; schema: string }[] {
  if (engine === 'sqlite') return [];
  const current = context(sql, offset);
  if (current.blocked) return [];
  const paths: Token[][] = [];
  for (let i = 0; i < current.scoped.length; i++) if (['FROM', 'JOIN', 'UPDATE', 'INTO'].some(word => isKeyword(current.scoped[i], word))) paths.push(pathAt(current.scoped, i + 1).parts);
  if (current.qualifier.length && ['FROM', 'JOIN'].some(word => isKeyword(current.prior.at(-1), word))) paths.push([...current.qualifier, { value: '', kind: 'name' } as Token]);
  const contexts = paths.filter(path => path.length > 1).map(path => {
    const name = (token: Token) => engine === 'postgres' && !token.quoted ? token.value.toLowerCase() : token.value;
    if (['mysql', 'mariadb', 'clickhouse'].includes(engine)) return { catalog: name(path[0]), schema: name(path[0]) };
    return path.length > 2 ? { catalog: name(path[0]), schema: name(path[1]) } : { catalog: index.catalog, schema: name(path[0]) };
  });
  return [...new Map(contexts.filter(item => item.catalog && item.schema && (item.catalog !== index.catalog || item.schema !== index.schema)).map(item => [JSON.stringify(item), item])).values()].slice(0, 6);
}

export function completeSQL(sql: string, offset: number, index: SchemaIndex, engine: DatabaseEngine): SqlSuggestion[] {
  const ctx = context(sql, offset);
  if (ctx.blocked) return [];
  const ctes = cteTables(ctx.tokens, ctx.containers, index, engine);
  const refs = bindings(ctx.scoped, index, engine, ctes);
  const suggestions: SqlSuggestion[] = [];
  const q = (name: string) => identifier(name, engine);
  const add = (label: string, insertText: string, detail: string, kind: SqlSuggestion['kind'], rank = 2, filterText?: string) => suggestions.push({ label, insertText, detail, kind, rank, filterText, start: ctx.replaceStart, end: ctx.replaceEnd });
  const last = ctx.prior.at(-1);
  const fromClause = [...ctx.prior].reverse().find(token => ['FROM', 'JOIN', 'WHERE', 'ON', 'GROUP', 'ORDER', 'SELECT'].some(word => isKeyword(token, word)));
  const tableContext = ['FROM', 'JOIN', 'UPDATE', 'INTO'].some(word => isKeyword(last, word)) || last?.value === ',' && ['FROM', 'JOIN'].some(word => isKeyword(fromClause, word));
  const joinContext = isKeyword(last, 'JOIN');
  if (ctx.qualifier.length && !tableContext) {
    const matches = refs.filter(ref => ctx.qualifier.length === 1 ? nameMatches(ctx.qualifier[0], ref.alias, engine) : !ref.explicitAlias && resolveTable(ctx.qualifier, index, engine, ctes) === ref.table);
    for (const ref of matches) for (const column of ref.table.columns) add(column.name, q(column.name), `${ref.alias} · ${column.type}`, 'column', 0);
    return suggestions;
  }
  if (tableContext) {
    for (const table of [...ctes, ...index.tables]) {
      const parts = ctx.qualifier;
      const matches = !parts.length ? ctes.includes(table) || table.catalog === index.catalog && table.schema === index.schema
        : parts.length === 1 ? nameMatches(parts[0], ['mysql', 'mariadb', 'clickhouse'].includes(engine) ? table.catalog : table.schema, engine)
        : nameMatches(parts[0], table.catalog, engine) && nameMatches(parts[1], table.schema, engine);
      if (matches) add(table.name, ctes.includes(table) || parts.length ? q(table.name) : tablePath(table, engine), ctes.includes(table) ? 'CTE' : `${table.catalog}.${table.schema} · ${table.columns.length} columns`, 'table', 1);
    }
  } else {
    const counts = new Map<string, number>();
    for (const ref of refs) for (const column of ref.table.columns) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    for (const ref of refs) for (const column of ref.table.columns) {
      const ambiguous = (counts.get(column.name) ?? 0) > 1;
      const label = ambiguous ? `${ref.alias}.${column.name}` : column.name;
      add(label, ambiguous ? `${q(ref.alias)}.${q(column.name)}` : q(column.name), `${ref.alias} · ${column.type}`, 'column', 1, `${column.name} ${label}`);
    }
    for (const ref of refs) add(`${ref.alias}.*`, `${q(ref.alias)}.*`, `Все колонки ${ref.table.name}`, 'column', 3);
  }
  const predicate = (relation: Relationship, sourceAlias: string, targetAlias: string) => relation.columns.map(pair => `${q(sourceAlias)}.${q(pair.source)} = ${q(targetAlias)}.${q(pair.target)}`).join(' AND ');
  const relationDetail = (relation: Relationship) => `${relation.kind === 'virtual' ? 'Виртуальная связь' : 'Foreign key'} · ${relation.name}`;
  if (isKeyword(last, 'ON') || isKeyword(last, 'AND') && isKeyword(fromClause, 'ON')) {
    const target = refs.at(-1);
    if (target && !ctes.includes(target.table)) for (const base of refs.slice(0, -1).filter(ref => !ctes.includes(ref.table))) for (const relation of index.relationships) {
      let text = '';
      if (tableKey(base.table) === tableKey(relation.source) && tableKey(target.table) === tableKey(relation.target)) text = predicate(relation, base.alias, target.alias);
      else if (tableKey(base.table) === tableKey(relation.target) && tableKey(target.table) === tableKey(relation.source)) text = predicate(relation, target.alias, base.alias);
      if (text) add(text, text, relationDetail(relation), 'join', 0);
    }
  }
  const currentWord = ctx.word?.value.toUpperCase() ?? '';
  const joins = ['LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', ...(engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite' ? [] : ['FULL JOIN'])];
  const canJoin = joinContext || !ctx.qualifier.length && refs.length > 0 && (currentWord === 'JOIN' || joins.some(join => currentWord && join.startsWith(currentWord)) || isKeyword(fromClause, 'FROM') || isKeyword(fromClause, 'ON'));
  if (canJoin && !isKeyword(last, 'ON')) for (const base of refs.filter(ref => !ctes.includes(ref.table))) for (const relation of index.relationships) {
    const forward = tableKey(base.table) === tableKey(relation.source);
    const reverse = tableKey(base.table) === tableKey(relation.target);
    if (!forward && !reverse) continue;
    const target = forward ? relation.target : relation.source;
    const used = new Set(refs.map(ref => ref.alias.toLowerCase()));
    let alias = target.name.replace(/[^\p{L}\p{N}_]/gu, '_').split('_').map(part => part[0] ?? '').join('').toLowerCase() || 't';
    if (!/^[\p{L}_]/u.test(alias)) alias = 't';
    const seed = alias;
    for (let suffix = 2; used.has(alias.toLowerCase()); suffix++) alias = seed + suffix;
    const condition = forward ? predicate(relation, base.alias, alias) : predicate(relation, alias, base.alias);
    const clause = `${tablePath(target, engine)} ${q(alias)} ON ${condition}`;
    if (joinContext) {
      const suggestion = { label: `${target.name} — ON ${condition}`, insertText: clause, detail: relationDetail(relation), kind: 'join' as const, rank: 0, filterText: target.name, start: ctx.qualifier[0]?.start ?? ctx.replaceStart, end: ctx.replaceEnd };
      if (!ctx.qualifier.length || resolveTable([...ctx.qualifier, { value: target.name, quoted: true, kind: 'name' } as Token], { ...index, tables: [{ ...target, columns: [] }] }, engine, []) ) suggestions.push(suggestion);
    } else if (!tableContext) {
      const variants = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER'].some(word => isKeyword(last, word)) ? ['JOIN'] : joins;
      for (const join of variants) add(`${join} ${target.name}`, `${join} ${clause}`, relationDetail(relation), 'join', 2);
    }
  }
  if (!tableContext && !ctx.qualifier.length) for (const keyword of ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'DISTINCT', 'COUNT(*)', 'SUM()', 'AVG()', 'IS NULL', 'IS NOT NULL']) add(keyword, keyword, 'SQL', 'keyword', 9);
  return [...new Map(suggestions.map(item => [`${item.kind}:${item.insertText}`, item])).values()];
}
