import { tableKey, tokenize } from './completion';
import type { DatabaseEngine, SchemaIndex, TableRef, Relationship } from './shared';
import type { DdlMapping } from './ddl';

type Token = ReturnType<typeof tokenize>['tokens'][number];
const word = (token: Token | undefined, value: string) => !!token && !token.quoted && token.kind === 'name' && token.value.toUpperCase() === value;
const name = (token: Token, engine: DatabaseEngine) => !token.quoted && engine === 'postgres' ? token.value.toLowerCase() : token.value;
function path(tokens: Token[], start: number, mapping: DdlMapping, engine: DatabaseEngine): { ref: TableRef; next: number } | undefined {
  const parts: string[] = []; let i = start;
  while (tokens[i]?.kind === 'name') { parts.push(name(tokens[i]!, engine)); i++; if (tokens[i]?.value !== '.') break; i++; }
  const last = parts.at(-1); if (!last || parts.length > 3) return;
  const catalogOnly = ['mysql','mariadb','clickhouse'].includes(engine);
  return { ref: { name: last, catalog: parts.length === 3 ? parts[0]! : parts.length === 2 && catalogOnly ? parts[0]! : mapping.catalog,
    schema: parts.length === 3 ? parts[1]! : parts.length === 2 && !catalogOnly ? parts[0]! : mapping.schema }, next: i };
}
function names(tokens: Token[], start: number, engine: DatabaseEngine): string[] {
  if (tokens[start]?.value !== '(') return [];
  const result: string[] = []; let expectName = true;
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === ')') return expectName ? [] : result;
    if (expectName && token.kind === 'name') { result.push(name(token, engine)); expectName = false; }
    else if (!expectName && token.value === ',') expectName = true;
    else return [];
  }
  return [];
}

/** Offline CREATE TABLE + declarative ADD CONSTRAINT model. Unsupported statements never execute. */
export function ddlIndex(mapping: DdlMapping, files: { file: string; sql: string }[], engine: DatabaseEngine): SchemaIndex {
  const index: SchemaIndex = { profileId: mapping.profileId, catalog: mapping.catalog, schema: mapping.schema, tables: [], relationships: [], warnings: [] };
  if (engine !== 'jdbc') index.dialect = { quote: ['mysql','mariadb','clickhouse'].includes(engine) ? '`' : engine === 'mssql' ? '[' : '"', catalogs: !['postgres','sqlite'].includes(engine), schemas: !['mysql','mariadb','clickhouse'].includes(engine), catalogAtStart: true, catalogSeparator: '.', unquotedCase: engine === 'postgres' ? 'lower' : 'preserve', fullOuterJoins: !['mysql','mariadb'].includes(engine) };
  const primary = new Map<string, string[]>(), seen = new Set<string>(), ambiguous = new Set<string>();
  const relations: Relationship[] = [];
  const addedKeys: {ref: TableRef; columns: string[]}[] = [];
  const warn = (file: string, message: string) => index.warnings.push(`${file}: ${message}`);
  let columnCount = 0;
  filesLoop: for (const file of files) {
    let all: Token[];
    try { all = tokenize(file.sql, engine, 100000).tokens; } catch (error) { warn(file.file,(error as Error).message); continue; }
    if (all.some(token => token.closed === false && !(token.kind === 'comment' && (token.text.startsWith('--') || token.text.startsWith('#'))))) { warn(file.file, 'незакрытый SQL token; файл не индексирован'); continue; }
    const tokens = all.filter(token => token.kind !== 'comment'); let created = 0, addedConstraints = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]?.container !== 0 || !word(tokens[i],'ALTER') || !word(tokens[i+1],'TABLE')) continue;
      let start = i+2;
      if (word(tokens[start],'ONLY')) start++;
      const table = path(tokens,start,mapping,engine);
      if (!table) continue;
      start = table.next;
      if (word(tokens[start],'WITH') && (word(tokens[start+1],'CHECK') || word(tokens[start+1],'NOCHECK'))) start+=2;
      if (!word(tokens[start],'ADD')) continue;
      start++;
      let constraintName: string | undefined;
      if (word(tokens[start],'CONSTRAINT') && tokens[start+1]?.kind === 'name') { constraintName=name(tokens[start+1]!,engine); start+=2; }
      const foreign = word(tokens[start],'FOREIGN'), primaryKey = word(tokens[start],'PRIMARY');
      if ((!foreign && !primaryKey) || !word(tokens[start+1],'KEY')) continue;
      start+=2;
      if (word(tokens[start],'CLUSTERED') || word(tokens[start],'NONCLUSTERED')) start++;
      const sourceNames = names(tokens,start,engine);
      if (!sourceNames.length) continue;
      if (primaryKey) {addedKeys.push({ref:table.ref,columns:sourceNames});addedConstraints++;continue;}
      const end = tokens.findIndex((token,pos)=>pos>start && token.container===0 && token.value===';');
      const clause = tokens.slice(start,end<0?undefined:end), refAt=clause.findIndex(token=>word(token,'REFERENCES'));
      if (refAt<0) continue;
      const target = path(clause,refAt+1,mapping,engine);
      if (!target) continue;
      const targetNames = names(clause,target.next,engine);
      if (targetNames.length && targetNames.length!==sourceNames.length) {warn(file.file,'неполный составной foreign key');continue;}
      relations.push({id:`ddl:${file.file}:${tokens[i]!.start}`,name:constraintName??`${table.ref.name} → ${target.ref.name}`,source:table.ref,target:target.ref,columns:sourceNames.map((source,n)=>({source,target:targetNames[n]??''})),kind:'foreign-key'});
      addedConstraints++;
    }
    for (let i = 0; i < tokens.length; i++) {
      if (!word(tokens[i], 'CREATE') || tokens[i]!.container !== 0) continue;
      let start = i + 1;
      while (['TEMP','TEMPORARY','UNLOGGED'].some(value => word(tokens[start], value))) start++;
      if (!word(tokens[start], 'TABLE')) continue;
      start++;
      if (word(tokens[start], 'IF') && word(tokens[start + 1], 'NOT') && word(tokens[start + 2], 'EXISTS')) start += 3;
      const table = path(tokens, start, mapping, engine);
      if (!table || tokens[table.next]?.value !== '(') { warn(file.file, 'CREATE TABLE AS/LIKE без явных колонок не индексируется'); continue; }
      const open = table.next, outer = tokens[open]!.container;
      const close = tokens.findIndex((token, pos) => pos > open && token.value === ')' && token.container === outer);
      if (close < 0) { warn(file.file, 'незакрытый CREATE TABLE'); continue; }
      const key = tableKey(table.ref); created++;
      if (seen.size >= 1000) { warn(file.file,'локальный индекс ограничен 1000 таблицами'); break filesLoop; }
      if (seen.has(key)) { ambiguous.add(key); warn(file.file, `повторное определение ${table.ref.name}; объект исключён из подсказок`); i = close; continue; }
      seen.add(key);
      const columns: { name: string; type: string }[] = [], pk: string[] = [];
      const inner = tokens[open + 1]?.container;
      let clauseStart = open + 1;
      const clauses: Token[][] = [];
      for (let j = clauseStart; j <= close; j++) if (j === close || tokens[j]?.value === ',' && tokens[j]?.container === inner) { clauses.push(tokens.slice(clauseStart,j)); clauseStart = j + 1; }
      for (let clause of clauses) {
        if (!clause.length) continue;
        if (word(clause[0], 'CONSTRAINT')) clause = clause.slice(2);
        const first = clause[0]; if (!first) continue;
        const constraint = !first.quoted && ['PRIMARY','FOREIGN','UNIQUE','CHECK','KEY','INDEX','EXCLUDE'].includes(first.value.toUpperCase());
        const column = !constraint && first.kind === 'name' ? name(first, engine) : undefined;
        if (column) {
          const boundary = clause.findIndex((token,pos) => pos > 0 && token.container === first.container && !token.quoted && ['CONSTRAINT','PRIMARY','REFERENCES','NOT','NULL','DEFAULT','UNIQUE','CHECK','COLLATE','GENERATED','IDENTITY','COMMENT','AUTO_INCREMENT'].includes(token.value.toUpperCase()));
          const typeTokens = clause.slice(1, boundary < 0 ? undefined : boundary);
          if (!typeTokens.length) { warn(file.file, `тип ${column} не указан`); }
          columns.push({ name: column, type: typeTokens.length ? file.sql.slice(typeTokens[0]!.start,typeTokens.at(-1)!.end) : '' });
          if (++columnCount > 20000) { warn(file.file,'локальный индекс ограничен 20 000 колонок; неполная таблица исключена'); break filesLoop; }
          if (clause.some((token,pos) => word(token,'PRIMARY') && word(clause[pos + 1],'KEY'))) pk.push(column);
        } else if (word(first,'PRIMARY') && word(clause[1],'KEY')) pk.push(...names(clause,2,engine));
        const refAt = clause.findIndex(token => word(token,'REFERENCES'));
        if (refAt >= 0) {
          const sourceNames = column ? [column] : word(first,'FOREIGN') && word(clause[1],'KEY') ? names(clause,2,engine) : [];
          const target = path(clause,refAt + 1,mapping,engine);
          if (target && sourceNames.length) {
            const targetNames = names(clause,target.next,engine);
            if (targetNames.length && targetNames.length !== sourceNames.length) { warn(file.file,'неполный составной foreign key'); continue; }
            relations.push({ id: `ddl:${file.file}:${first.start}`, name: `${table.ref.name} → ${target.ref.name}`, source: table.ref, target: target.ref, columns: sourceNames.map((source,n) => ({ source, target: targetNames[n] ?? '' })), kind: 'foreign-key' });
          }
        }
      }
      if (new Set(columns.map(column => column.name)).size !== columns.length) { ambiguous.add(key); warn(file.file,'повторяющиеся колонки'); }
      index.tables.push({ ...table.ref, columns }); primary.set(key,pk); i = close;
    }
    if (!created && !addedConstraints && file.sql.trim()) warn(file.file,'для подсказок поддерживаются CREATE TABLE и ALTER TABLE ADD PRIMARY/FOREIGN KEY; остальные команды сохранены как SQL');
    if (tokens.some(token => token.container === 0 && word(token,'ALTER')) && !addedConstraints) warn(file.file,'ALTER колонок не изменяет локальный индекс; обновите CREATE TABLE до итоговой структуры');
  }
  index.tables = index.tables.filter(table => !ambiguous.has(tableKey(table)));
  for (const key of addedKeys) {
    const id=tableKey(key.ref), table=index.tables.find(table=>tableKey(table)===id);
    if (table && key.columns.every(column=>table.columns.some(item=>item.name===column))) primary.set(id,key.columns);
  }
  for (const relation of relations) {
    if (ambiguous.has(tableKey(relation.source)) || ambiguous.has(tableKey(relation.target))) continue;
    const source=index.tables.find(table=>tableKey(table)===tableKey(relation.source));
    if (!source || relation.columns.some(pair=>!source.columns.some(column=>column.name===pair.source))) continue;
    if (relation.columns.some(pair => !pair.target)) {
      const pk = primary.get(tableKey(relation.target));
      if (!pk || pk.length !== relation.columns.length) continue;
      relation.columns.forEach((pair,n) => { pair.target = pk[n]!; });
    }
    index.relationships.push(relation);
  }
  index.warnings = [...new Set(index.warnings)].slice(0,100);
  return index;
}
