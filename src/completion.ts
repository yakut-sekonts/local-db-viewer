import type { JdbcDialect, DatabaseEngine, Relationship, SchemaIndex, TableRef } from './shared';
import { identifier } from '../electron/sql';
import { analyzeSQL, resolveTable, relationColumn, type Binding } from './sql-analysis';
import { tokenize, isKeyword, isName, nameMatches, identifierName, catalogOnly, pathAt, type Token } from './sql-lexer';
export { tokenize } from './sql-lexer';

export interface SqlSuggestion { label: string; insertText: string; detail: string; kind: 'column' | 'table' | 'join' | 'keyword'; start: number; end: number; rank: number; filterText?: string }
function quoteName(name: string, engine: DatabaseEngine, dialect?: JdbcDialect): string {
  if (engine !== 'jdbc' || !dialect) return identifier(name, engine);
  const end = dialect.quote === '[' ? ']' : dialect.quote;
  if (!dialect.quote) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('JDBC-драйвер не поддерживает quoting этого имени.'); return name; }
  return dialect.quote + name.replaceAll(end, end + end) + end;
}
export const tableKey = (table: TableRef) => JSON.stringify([table.catalog, table.schema, table.name]);
export function tablePath(table: TableRef, engine: DatabaseEngine, dialect?: JdbcDialect): string {
  if (engine === 'jdbc' && dialect) {
    const q = (name: string) => quoteName(name, engine, dialect);
    const name = [dialect.schemas ? table.schema : '', table.name].filter(Boolean).map(q).join('.');
    return !dialect.catalogs || !table.catalog ? name : dialect.catalogAtStart ? q(table.catalog) + dialect.catalogSeparator + name : name + dialect.catalogSeparator + q(table.catalog);
  }
  const parts = ['mysql', 'mariadb', 'clickhouse'].includes(engine) ? [table.catalog, table.name] : engine === 'postgres' || engine === 'sqlite' ? [table.schema, table.name] : [table.catalog, table.schema, table.name];
  return parts.filter(Boolean).map(name => identifier(name, engine)).join('.');
}
function context(sql: string, offset: number, engine: DatabaseEngine) {
  if (sql.length > 1_000_000 || !Number.isInteger(offset) || offset < 0 || offset > sql.length) return;
  let full: ReturnType<typeof tokenize>;
  try { full = tokenize(sql, engine, 100000); } catch { return; }
  const depths = [0];
  for(let i=1;i<full.containers.length;i++) {
    const depth=(depths[full.containers[i]!.parent] ?? 0)+1;
    if(depth>128)return;
    depths.push(depth);
  }
  const blocked = full.tokens.some(token => ['string', 'comment'].includes(token.kind) && token.start < offset && (offset < token.end || offset === token.end && !token.closed));
  const boundaries = full.tokens.filter(token => token.value === ';' && token.kind === 'symbol' && token.container === 0);
  const start = boundaries.filter(token => token.end <= offset).at(-1)?.end ?? 0;
  const end = boundaries.find(token => token.start >= offset)?.start ?? sql.length;
  const tokens = full.tokens.filter(token => token.kind !== 'comment' && token.start >= start && token.end <= end);
  const queryContainers = new Set(tokens.filter(token => isKeyword(token, 'SELECT')).map(token => token.container));
  let scope = 0;
  for (let i = 1; i < full.containers.length; i++) {
    const group = full.containers[i];
    if (group && group.start <= offset && offset <= group.end && queryContainers.has(i)) scope = i;
  }
  let scoped = tokens.filter(token => token.container === scope);
  const unionBefore = scoped.filter(token => ['UNION', 'EXCEPT', 'INTERSECT'].some(word => isKeyword(token, word)) && token.start < offset).at(-1)?.end ?? start;
  const unionAfter = scoped.find(token => ['UNION', 'EXCEPT', 'INTERSECT'].some(word => isKeyword(token, word)) && token.start >= offset)?.start ?? end;
  scoped = scoped.filter(token => token.start >= unionBefore && token.end <= unionAfter);
  const expressions = tokens.filter(token => {
    if (token.start < unionBefore || token.end > unionAfter) return false;
    let group = token.container;
    while (group !== scope) {
      if (group < 0 || queryContainers.has(group)) return false;
      const parent = full.containers[group]?.parent;
      if (parent === undefined) return false;
      group = parent;
    }
    return true;
  });
  const word = expressions.find(token => token.kind === 'name' && token.start < offset && token.end >= offset);
  const replaceStart = word?.start ?? offset;
  const before = expressions.filter(token => token.end <= replaceStart);
  const qualifier: Token[] = [];
  let position = before.length - 1;
  while (before[position]?.value === '.') { const token = before[position - 1]; if (!isName(token)) break; qualifier.unshift(token); position -= 2; }
  const prior = before.slice(0, position + 1);
  return { blocked, tokens, containers: full.containers, scope, start, end, offset, scoped, word, replaceStart, replaceEnd: word?.end ?? offset, before, qualifier, prior };
}

/** Contexts referenced explicitly in SQL are loaded lazily by the renderer. */
export function requestedSchemas(sql: string, offset: number, index: SchemaIndex, engine: DatabaseEngine): { catalog: string; schema: string }[] {
  if (engine === 'sqlite') return [];
  const current = context(sql, offset, engine);
  if (!current || current.blocked) return [];
  const paths: Token[][] = [];
  for (let i = 0; i < current.tokens.length; i++) if (['FROM', 'JOIN', 'UPDATE', 'INTO'].some(word => isKeyword(current.tokens[i], word))) paths.push(pathAt(current.tokens, i + 1).parts);
  if (current.qualifier.length && ['FROM', 'JOIN'].some(word => isKeyword(current.prior.at(-1), word))) paths.push([...current.qualifier, { value: '', kind: 'name' } as Token]);
  const contexts = paths.flatMap(path => {
    const [first, second] = path; if (!first || !second) return [];
    const name = (token: Token) => identifierName(token, engine, index.dialect);
    if (catalogOnly(engine, index.dialect)) return [{ catalog: name(first), schema: name(first) }];
    return [path.length > 2 ? { catalog: name(first), schema: name(second) } : { catalog: index.catalog, schema: name(first) }];
  });
  return [...new Map(contexts.filter(item => item.catalog && item.schema && (item.catalog !== index.catalog || item.schema !== index.schema)).map(item => [JSON.stringify(item), item])).values()].slice(0, 6);
}

export function completeSQL(sql: string, offset: number, index: SchemaIndex, engine: DatabaseEngine): SqlSuggestion[] {
  const ctx = context(sql, offset, engine);
  if (!ctx || ctx.blocked) return [];
  const analysis = analyzeSQL(sql, ctx, index, engine);
  const { ctes, refs, local } = analysis;
  const nameKey=(name: string)=>engine==='postgres'?name:name.toLowerCase();
  const projectedKey=(ref: Binding,table: TableRef,column: string)=>relationColumn(ref,table,column,engine);
  const uniqueColumns = new Map(refs.map(ref => {
    const counts = new Map<string,number>();
    for(const column of ref.table.columns) counts.set(nameKey(column.name),(counts.get(nameKey(column.name)) ?? 0)+1);
    return [ref,ref.table.columns.filter(column=>counts.get(nameKey(column.name))===1)] as const;
  }));
  const columns = (ref: Binding) => uniqueColumns.get(ref) ?? [];
  const columnNames=new Map(refs.map(ref=>[ref,new Map(columns(ref).map(column=>[nameKey(column.name),column]))]));
  const suggestions: SqlSuggestion[] = [];
  const q = (name: string) => quoteName(name, engine, index.dialect);
  const add = (label: string, insertText: string, detail: string, kind: SqlSuggestion['kind'], rank = 2, filterText?: string) => suggestions.push({ label, insertText, detail, kind, rank, filterText, start: ctx.replaceStart, end: ctx.replaceEnd });
  if(analysis.using!==undefined) {
    for(const column of analysis.using)add(column.name,q(column.name),`USING · общая колонка · ${column.type}`,'column',0);
    return suggestions;
  }
  const last = ctx.prior.at(-1);
  const fromClause = [...ctx.prior].reverse().find(token => ['FROM', 'JOIN', 'WHERE', 'ON', 'GROUP', 'ORDER', 'SELECT'].some(word => isKeyword(token, word)));
  const tableContext = ['FROM', 'JOIN', 'UPDATE', 'INTO'].some(word => isKeyword(last, word)) || last?.value === ',' && ['FROM', 'JOIN'].some(word => isKeyword(fromClause, word));
  const joinContext = isKeyword(last, 'JOIN');
  const joinIndex=ctx.prior.length-1-[...ctx.prior].reverse().findIndex(token=>isKeyword(token,'JOIN'));
  let naturalJoin=false;
  for(let i=joinIndex-1;i>=0 && ['NATURAL','LEFT','RIGHT','FULL','INNER','OUTER','CROSS'].some(word=>isKeyword(ctx.prior[i],word));i--)if(isKeyword(ctx.prior[i],'NATURAL'))naturalJoin=true;
  if (ctx.qualifier.length && !tableContext) {
    const matches = refs.filter(ref => ctx.qualifier.length === 1 ? nameMatches(ctx.qualifier[0], ref.alias, engine) : !ref.explicitAlias && !!ref.physical && resolveTable(ctx.qualifier, index, engine, []) === ref.physical);
    for (const ref of matches.length === 1 ? matches : []) for (const column of columns(ref)) add(column.name, q(column.name), `${ref.alias} · ${column.type}${ref.table.metadataSource === 'bundled' ? ' · встроенный справочник' : ''}`, 'column', 0);
    return suggestions;
  }
  if (tableContext) {
    for (const table of [...ctes, ...index.tables]) {
      const parts = ctx.qualifier;
      const matches = !parts.length ? ctes.includes(table) || table.catalog === index.catalog && table.schema === index.schema && !ctes.some(cte => nameKey(cte.name) === nameKey(table.name))
        : !ctes.includes(table) && ( parts.length === 1 ? nameMatches(parts[0], catalogOnly(engine, index.dialect) ? table.catalog : table.schema, engine)
        : nameMatches(parts[0], table.catalog, engine) && nameMatches(parts[1], table.schema, engine));
      if (matches) add(table.name, ctes.includes(table) || parts.length ? q(table.name) : tablePath(table, engine, index.dialect), ctes.includes(table) ? 'CTE' : `${table.catalog}.${table.schema} · ${table.columns.length} columns${table.metadataSource === 'bundled' ? ' · встроенный справочник' : ''}`, 'table', 1);
    }
  } else {
    const nearest=new Map<string,{distance:number;count:number}>();
    for(const item of analysis.columns) {
      const key=nameKey(item.column.name), known=nearest.get(key);
      if(!known || item.distance<known.distance)nearest.set(key,{distance:item.distance,count:1});
      else if(item.distance===known.distance)known.count++;
    }
    for(const item of analysis.columns) {
      const {column}=item, closest=nearest.get(nameKey(column.name))!;
      const ambiguous=closest.count>1 || item.distance!==closest.distance || analysis.unknownDistances.some(distance=>distance<=item.distance);
      if(!ambiguous) {
        const detail=item.bindings.length>1 ? 'Общая колонка JOIN' : item.bindings[0]?.alias ?? '';
        add(column.name,q(column.name),`${detail} · ${column.type}${item.bindings[0]?.table.metadataSource==='bundled' ? ' · встроенный справочник' : ''}`,'column',1);
      } else for(const binding of item.bindings) {
        const ref=refs.find(ref=>ref.alias===binding.alias && ref.distance===item.distance && ref.table===binding.table);
        const original=ref && columnNames.get(ref)?.get(nameKey(column.name));
        if(!ref || !original)continue;
        const label=`${ref.alias}.${original.name}`;
        add(label,`${q(ref.alias)}.${q(original.name)}`,`${ref.alias} · ${original.type}`,'column',1,`${original.name} ${label}`);
      }
    }
    for (const ref of refs) if(ref.table.columns.length)add(`${ref.alias}.*`, `${q(ref.alias)}.*`, `Все колонки ${ref.table.name}`, 'column', 3);
    const clause=[...ctx.before].reverse().find(token=>['SELECT','FROM','WHERE','GROUP','HAVING','ORDER','LIMIT','OFFSET','FETCH','QUALIFY','WINDOW'].some(word=>isKeyword(token,word)));
    if(isKeyword(clause,'ORDER') && clause?.container===ctx.scope) {
      const counts=new Map<string,number>();
      for(const column of analysis.projection)if(column.name!==undefined)counts.set(nameKey(column.name),(counts.get(nameKey(column.name)) ?? 0)+1);
      for(const column of analysis.projection)if(column.name!==undefined && counts.get(nameKey(column.name))===1)add(column.name,q(column.name),`Результат SELECT · ${column.type}`,'column',0);
    }
  }
  const predicate = (relation: Relationship, source: Binding, target: Binding) => {
    const pairs = relation.columns.map(pair => ({source:projectedKey(source,relation.source,pair.source),target:projectedKey(target,relation.target,pair.target)}));
    return pairs.every(pair => pair.source !== undefined && pair.target !== undefined) ? pairs.map(pair => `${q(source.alias)}.${q(pair.source!)} = ${q(target.alias)}.${q(pair.target!)}`).join(' AND ') : undefined;
  };
  const relationDetail = (relation: Relationship) => `${relation.kind === 'virtual' ? 'Виртуальная связь' : 'Foreign key'} · ${relation.name}`;
  if (isKeyword(last, 'ON') || isKeyword(last, 'AND') && isKeyword(fromClause, 'ON')) {
    const target = local.at(-1);
    if (target) for (const base of local.slice(0, -1)) for (const relation of index.relationships) {
      const text = predicate(relation,base,target) ?? predicate(relation,target,base);
      if (text) add(text, text, relationDetail(relation), 'join', 0);
    }
  }
  const currentWord = ctx.word?.value.toUpperCase() ?? '';
  const joins = ['LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', ...(engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite' || (engine === 'jdbc' && !index.dialect?.fullOuterJoins) ? [] : ['FULL JOIN'])];
  const canJoin = joinContext || !ctx.qualifier.length && local.length > 0 && (currentWord === 'JOIN' || joins.some(join => currentWord && join.startsWith(currentWord)) || isKeyword(fromClause, 'FROM') || isKeyword(fromClause, 'ON'));
  if (canJoin && !isKeyword(last, 'ON') && !(joinContext && naturalJoin)) for (const base of local) for (const relation of index.relationships) {
    const forward = relation.columns.every(pair => projectedKey(base,relation.source,pair.source) !== undefined);
    const reverse = relation.columns.every(pair => projectedKey(base,relation.target,pair.target) !== undefined);
    if (!forward && !reverse) continue;
    const target = forward ? relation.target : relation.source;
    const used = new Set(refs.map(ref => ref.alias.toLowerCase()));
    let alias = target.name.replace(/[^\p{L}\p{N}_]/gu, '_').split('_').map(part => part[0] ?? '').join('').toLowerCase() || 't';
    if (!/^[\p{L}_]/u.test(alias)) alias = 't';
    const seed = alias;
    for (let suffix = 2; used.has(alias.toLowerCase()); suffix++) alias = seed + suffix;
    const condition = relation.columns.map(pair => forward
      ? `${q(base.alias)}.${q(projectedKey(base,relation.source,pair.source)!)} = ${q(alias)}.${q(pair.target)}`
      : `${q(alias)}.${q(pair.source)} = ${q(base.alias)}.${q(projectedKey(base,relation.target,pair.target)!)}`).join(' AND ');
    const clause = `${tablePath(target, engine, index.dialect)} ${q(alias)} ON ${condition}`;
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
