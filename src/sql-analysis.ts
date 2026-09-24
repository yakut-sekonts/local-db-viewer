import type { Column, DatabaseEngine, SchemaIndex, TableMeta, TableRef } from './shared';
import { catalogOnly, identifierName, isKeyword, isName, nameMatches, pathAt, type Container, type Token } from './sql-lexer';

interface Origin { table: TableRef; column: string }
interface Projection { name?: string; type: string; origin?: Origin }
export interface QueryColumn extends Column { origin?: Origin }
interface QueryTable extends TableMeta { columns: QueryColumn[] }
export interface Binding { table: QueryTable; physical?: TableMeta; alias: string; explicitAlias: boolean; distance: number; unknown?: boolean }
interface Query {
  refs: Binding[];
  local: Binding[];
  ctes: QueryTable[];
  projection: Projection[];
  complete: boolean;
}
interface Context { tokens: Token[]; containers: Container[]; scope: number; start: number; end: number; offset: number }
const unknownType = 'тип не определён';
const key = (table: TableRef) => JSON.stringify([table.catalog, table.schema, table.name]);
const setOperator = (token: Token) => ['UNION','INTERSECT','EXCEPT'].some(word => isKeyword(token,word));
const emptyQuery = (): Query => ({refs:[],local:[],ctes:[],projection:[],complete:false});
const relationColumns = new WeakMap<Binding,Map<string,string | undefined>>();
const originKey = (table: TableRef, column: string) => JSON.stringify([key(table),column]);
class AnalysisLimit extends Error {}
function lastIndex(tokens: Token[], predicate: (token: Token, index: number) => boolean): number {
  for(let i=tokens.length-1;i>=0;i--) if(predicate(tokens[i]!,i)) return i;
  return -1;
}

export function resolveTable(parts: Token[], index: SchemaIndex, engine: DatabaseEngine, ctes: TableMeta[]): TableMeta | undefined {
  const last = parts.at(-1);
  if (!last || parts.length > 3) return;
  // A CTE only has an unqualified name. Explicit schema qualification addresses a real table.
  if (parts.length === 1) return ctes.find(table => nameMatches(last,table.name,engine))
    ?? index.tables.find(table => nameMatches(last,table.name,engine) && table.catalog === index.catalog && table.schema === index.schema);
  return index.tables.find(table => nameMatches(last,table.name,engine) && (parts.length === 2
    ? nameMatches(parts[0],catalogOnly(engine,index.dialect) ? table.catalog : table.schema,engine)
    : nameMatches(parts[0],table.catalog,engine) && nameMatches(parts[1],table.schema,engine)));
}

/** A JOIN is offered through a projection only when every key has one unchanged output column. */
export function relationColumn(binding: Binding, table: TableRef, column: string, engine: DatabaseEngine): string | undefined {
  let values=relationColumns.get(binding);
  if(!values) {
    values=new Map();
    const names=new Map<string,number>();
    const nameKey=(name: string)=>engine==='postgres'?name:name.toLowerCase();
    for(const item of binding.table.columns)names.set(nameKey(item.name),(names.get(nameKey(item.name)) ?? 0)+1);
    for(const item of binding.table.columns)if(item.origin) {
      const key=originKey(item.origin.table,item.origin.column);
      values.set(key,values.has(key) || names.get(nameKey(item.name))!>1 ? undefined:item.name);
    }
    relationColumns.set(binding,values);
  }
  return values.get(originKey(table,column));
}

/** Bounded, read-only SQL analysis. Uncertain expressions keep their names but never acquire invented FK lineage. */
export function analyzeSQL(sql: string, context: Context, index: SchemaIndex, engine: DatabaseEngine): Query {
  const byContainer = new Map<number, Token[]>(), children = new Map<number, number[]>(), opening = new Map<number,number>();
  const physicalTables = new Map<TableMeta,QueryTable>();
  let columnBudget=50000, bindingBudget=512;
  function reserveColumns(count: number) { columnBudget-=count; if(columnBudget<0)throw new AnalysisLimit(); }
  for (const token of context.tokens) {
    const tokens = byContainer.get(token.container) ?? [];
    tokens.push(token); byContainer.set(token.container,tokens);
  }
  context.containers.forEach((group,id) => {
    opening.set(group.start,id);
    const values = children.get(group.parent) ?? []; values.push(id); children.set(group.parent,values);
  });
  const name = (token: Token) => identifierName(token,engine,index.dialect);
  const aliasKey = (value: string) => engine === 'postgres' ? value : value.toLowerCase();
  const groupOf = (token: Token | undefined) => token?.value === '(' ? opening.get(token.end) : undefined;
  const direct = (id: number) => byContainer.get(id) ?? [];
  const makeTable = (tableName: string, projection: Projection[]): QueryTable => ({catalog:index.catalog,schema:index.schema,name:tableName,
    columns:projection.flatMap(column => column.name === undefined ? [] : [{...column,name:column.name}])});
  function visible(local: Binding[], outer: Binding[]): Binding[] {
    const used = new Set(local.map(binding => aliasKey(binding.alias)));
    return [...local,...outer.filter(binding => !used.has(aliasKey(binding.alias))).map(binding => ({...binding,distance:binding.distance+1}))];
  }
  function columnNames(id: number | undefined): string[] {
    if (id === undefined) return [];
    const tokens = direct(id);
    return tokens.length && tokens.every((token,i) => i % 2 === 0 ? isName(token) : token.value === ',')
      && tokens.length % 2 === 1 ? tokens.filter((_,i) => i % 2 === 0).map(name) : [];
  }
  function renamed(projection: Projection[], names: string[], complete: boolean): Projection[] {
    if (!names.length) return projection;
    if (!complete) return names.map(name => ({name,type:unknownType}));
    return Array.from({length:Math.max(names.length,projection.length)},(_,i) => ({...(projection[i] ?? {type:unknownType}),name:names[i] ?? projection[i]?.name}));
  }
  function sourceColumn(parts: Token[], refs: Binding[]): QueryColumn | undefined {
    const last = parts.at(-1); if (!last) return;
    let candidates = refs;
    if (parts.length > 1) {
      candidates = refs.filter(ref => parts.length === 2 ? nameMatches(parts[0],ref.alias,engine)
        : !ref.explicitAlias && !!ref.physical && resolveTable(parts.slice(0,-1),index,engine,[]) === ref.physical);
      if (candidates.length !== 1) return;
    }
    const matches = candidates.flatMap(ref => ref.table.columns.filter(column => nameMatches(last,column.name,engine)).map(column => ({ref,column})));
    const distance = Math.min(...matches.map(item => item.ref.distance));
    if (parts.length === 1 && refs.some(ref => ref.unknown && ref.distance <= distance)) return;
    const nearest = matches.filter(item => item.ref.distance === distance);
    return nearest.length === 1 ? nearest[0]?.column : undefined;
  }
  function infer(expression: Token[], refs: Binding[]): Omit<Projection,'name'> {
    if (!expression.length) return {type:unknownType};
    const path = pathAt(expression,0);
    if (path.parts.length && path.next === expression.length) {
      const column = sourceColumn(path.parts,refs);
      if (column) return {type:column.type,origin:column.origin};
    }
    const inner = groupOf(expression[0]);
    if (expression.length === 2 && inner !== undefined && expression[1]?.value === ')' && !direct(inner).some(token => isKeyword(token,'SELECT'))) return infer(direct(inner),refs);
    const call = expression[0]?.value.toUpperCase(), argumentGroup = groupOf(expression[1]);
    if (expression.length === 3 && !expression[0]?.quoted && argumentGroup !== undefined && expression[2]?.value === ')') {
      const args = direct(argumentGroup), as = args.findIndex(token => isKeyword(token,'AS'));
      if ((call === 'CAST' || call === 'TRY_CAST') && as > 0 && args[as+1]) {
        const type = sql.slice(args[as+1]!.start,args.at(-1)!.end).trim();
        // These tokens come from the editor, never from executing SQL for inference.
        if (type) return {type};
      }
      if (call === 'COUNT' || call === 'COUNT_BIG' && engine === 'mssql') {
        const type = engine === 'mssql' ? call === 'COUNT_BIG' ? 'bigint' : 'int' : engine === 'sqlite' ? 'INTEGER' : engine === 'clickhouse' ? 'UInt64' : engine === 'jdbc' ? unknownType : 'bigint';
        return {type};
      }
    }
    if (engine === 'postgres') {
      const cast = lastIndex(expression,(token,i) => token.value === ':' && expression[i-1]?.value === ':');
      if (cast >= 1 && expression[cast+1] && expression.slice(cast+1).every(token => token.kind === 'name' || ['(',')','[',']',',','.'].includes(token.value) || /^\d$/.test(token.value))) return {type:sql.slice(expression[cast+1]!.start,expression.at(-1)!.end).trim()};
    }
    return {type:unknownType};
  }
  function project(tokens: Token[], refs: Binding[], local: Binding[]): {projection: Projection[]; complete: boolean} {
    const select = tokens.findIndex(token => isKeyword(token,'SELECT'));
    if (select < 0) return {projection:[],complete:false};
    let start = select+1;
    if (isKeyword(tokens[start],'ALL')) start++;
    if (isKeyword(tokens[start],'DISTINCT')) { start++; if (isKeyword(tokens[start],'ON') && groupOf(tokens[start+1]) !== undefined) start+=3; }
    if (engine === 'mssql' && isKeyword(tokens[start],'TOP')) {
      start++;
      if (groupOf(tokens[start]) !== undefined) start+=2; else while (/^\d$/.test(tokens[start]?.value ?? '')) start++;
      if (isKeyword(tokens[start],'PERCENT')) start++;
      if (isKeyword(tokens[start],'WITH') && isKeyword(tokens[start+1],'TIES')) start+=2;
    }
    const end = tokens.findIndex((token,i) => i>=start && ['FROM','WHERE','GROUP','HAVING','ORDER','LIMIT','OFFSET','FETCH','QUALIFY','WINDOW','INTO'].some(word => isKeyword(token,word)));
    const projection: Projection[] = []; let complete = true;
    let piece: Token[] = []; const pieces = [piece];
    for (const token of tokens.slice(start,end < 0 ? undefined : end)) {
      if (token.value === ',') { piece = []; pieces.push(piece); } else piece.push(token);
    }
    for (const value of pieces) {
      if (!value.length) { complete=false;continue; }
      const star = value.length === 1 && value[0]?.value === '*' || value.length === 3 && isName(value[0]) && value[1]?.value === '.' && value[2]?.value === '*';
      if (star) {
        const sources = value.length === 1 ? local : refs.filter(ref => nameMatches(value[0],ref.alias,engine));
        if (!sources.length || sources.some(ref=>ref.unknown)) complete=false;
        else { reserveColumns(sources.reduce((count,ref)=>count+ref.table.columns.length,0)); projection.push(...sources.flatMap(ref=>ref.table.columns)); }
        continue;
      }
      let expression = value, alias: Token | undefined;
      const as = lastIndex(value,token=>isKeyword(token,'AS'));
      if (as >= 0 && as === value.length-2 && isName(value[as+1])) { alias=value[as+1];expression=value.slice(0,as); }
      else if (engine === 'mssql' && isName(value[0]) && value[1]?.value === '=') { alias=value[0];expression=value.slice(2); }
      else {
        const last = value.at(-1), before = value.at(-2);
        // Bare aliases require a completed expression and a separating space. Operators never become aliases.
        if (isName(last) && before && before.end < last.start && (before.value === ')' || before.kind === 'string' || /^\d$/.test(before.value) || isName(before) || isKeyword(before,'END'))
          && !(engine === 'postgres' && value.some(token=>token.value === ':'))) {alias=last;expression=value.slice(0,-1);}
      }
      const path = pathAt(expression,0), bare = path.parts.length && path.next === expression.length ? path.parts.at(-1) : undefined;
      reserveColumns(1);projection.push({name:alias ? name(alias) : bare ? name(bare) : undefined,...infer(expression,refs)});
    }
    return {projection,complete};
  }

  let active: Query | undefined, visits = 0;
  function query(group: number, start: number, end: number, inherited: QueryTable[], outer: Binding[], depth: number): Query {
    if (depth > 32 || ++visits > 512) throw new AnalysisLimit();
    const tokens = direct(group).filter(token=>token.start>=start && token.end<=end);
    let ctes = [...inherited], main = 0;
    const handled = new Set<number>();
    if (isKeyword(tokens[0],'WITH')) {
      let i=1; const recursive=isKeyword(tokens[i],'RECURSIVE'); if(recursive)i++;
      while (isName(tokens[i])) {
        const tableName=name(tokens[i]!); i++;
        const list=groupOf(tokens[i]), names=columnNames(list);
        if(list!==undefined)i+=2;
        if(!isKeyword(tokens[i],'AS'))break;i++;
        if(isKeyword(tokens[i],'NOT'))i++;
        if(isKeyword(tokens[i],'MATERIALIZED'))i++;
        const body=groupOf(tokens[i]);if(body===undefined)break;
        const bounds=context.containers[body]!;
        const prior=ctes.filter(table=>aliasKey(table.name)!==aliasKey(tableName));
        const provisional=makeTable(tableName,names.map(name=>({name,type:unknownType})));
        handled.add(body);
        const result=query(body,bounds.start,bounds.end,recursive?[provisional,...prior]:ctes,outer,depth+1);
        ctes=[makeTable(tableName,renamed(result.projection,names,result.complete)),...prior];
        i+=2;main=i;
        if(tokens[i]?.value!==',')break;i++;
      }
    }
    const body=tokens.slice(main), splits=body.flatMap((token,i)=>setOperator(token)?[i]:[]), branches: Query[]=[];
    let begin=0;
    for(const boundary of [...splits,body.length]) {
      const section=body.slice(begin,boundary), lower=begin===0?start:body[begin-1]!.end, upper=boundary===body.length?end:body[boundary]!.start;
      const local: Binding[]=[];
      let from=false;
      for(let i=0;i<section.length;i++) {
        const token=section[i]!;
        if(['WHERE','GROUP','ORDER','HAVING','LIMIT','OFFSET','FETCH','QUALIFY','WINDOW','SET','RETURNING'].some(word=>isKeyword(token,word)))from=false;
        const introducer=['FROM','JOIN','UPDATE','INTO','APPLY'].some(word=>isKeyword(token,word));
        if(!introducer && !(from && token.value===','))continue;
        from=true;
        let position=i+1;
        const lateral=isKeyword(section[position],'LATERAL') || isKeyword(token,'APPLY');
        if(isKeyword(section[position],'LATERAL'))position++;
        const nested=groupOf(section[position]);
        let table: QueryTable | undefined, physical: TableMeta | undefined, derivedProjection: Projection[] | undefined, unknown=false, fallback: Token | undefined;
        if(nested!==undefined) {
          const bounds=context.containers[nested]!;
          handled.add(nested);
          const result=query(nested,bounds.start,bounds.end,ctes,lateral?visible(local,outer):outer,depth+1);
          derivedProjection=result.projection;table=makeTable('',result.projection);unknown=!result.complete;
          position+=2;
        } else {
          const path=pathAt(section,position);if(!path.parts.length)continue;
          fallback=path.parts.at(-1);position=path.next;
          if(groupOf(section[position])!==undefined) { position+=2;unknown=true; }
          else {
            const source=resolveTable(path.parts,index,engine,ctes);
            if(source && !ctes.includes(source as QueryTable))physical=source;
            if(physical) {
              table=physicalTables.get(physical);
              if(!table) {reserveColumns(physical.columns.length);table={...physical,columns:physical.columns.map(column=>({...column,origin:{table:physical!,column:column.name}}))};physicalTables.set(physical,table);}
            } else table=source as QueryTable | undefined;
            unknown=!source;
          }
        }
        if(isKeyword(section[position],'AS'))position++;
        const explicitAlias=isName(section[position]), aliasToken=explicitAlias?section[position]:fallback;
        if(!aliasToken)continue;
        const alias=name(aliasToken); if(explicitAlias)position++;
        const names=columnNames(groupOf(section[position]));if(names.length)position+=2;
        table=table ?? makeTable(alias,[]);
        if(names.length)table={...table,columns:makeTable(alias,renamed(derivedProjection ?? table.columns,names,!unknown)).columns};
        if(--bindingBudget<0)throw new AnalysisLimit();
        local.push({table,physical,alias,explicitAlias,distance:0,unknown});
        i=position-1;
      }
      const refs=visible(local,outer), result: Query={local,refs,ctes,...project(section,refs,local)};
      branches.push(result);
      if(group===context.scope && context.offset>=lower && context.offset<=upper)active=result;
      // Scalar/EXISTS subqueries correlate with this branch. FROM and CTE bodies were handled above.
      function nestedExpressions(parent: number) {
        const pending=[...(children.get(parent) ?? [])];
        for(let scanned=0;pending.length && scanned<100000;scanned++) {
          const child=pending.pop()!;
          if(handled.has(child))continue;
          const bounds=context.containers[child]!;
          if(bounds.start<lower || bounds.end>upper)continue;
          if(direct(child).some(token=>isKeyword(token,'SELECT') || isKeyword(token,'WITH'))) {
            handled.add(child);query(child,bounds.start,bounds.end,ctes,refs,depth+1);
          } else pending.push(...(children.get(child) ?? []));
        }
      }
      nestedExpressions(group);
      begin=boundary+1;
    }
    const result=branches[0] ?? emptyQuery();
    if(branches.length>1) {
      const combined: Query={...result,refs:[],local:[],complete:branches.every(branch=>branch.complete && branch.projection.length===result.projection.length),
        projection:result.projection.map((column,i)=>({name:column.name,type:branches.every(branch=>branch.projection[i]?.type===column.type)?column.type:unknownType}))};
      const finalClause=body.slice((splits.at(-1) ?? -1)+1).find(token=>['ORDER','LIMIT','OFFSET','FETCH'].some(word=>isKeyword(token,word)));
      if(group===context.scope && finalClause && context.offset>=finalClause.start)active=combined;
      return combined;
    }
    return result;
  }
  try {
    const root=query(0,context.start,context.end,[],[],0);
    return active ?? (context.scope===0 ? root : emptyQuery());
  } catch(error) { if(error instanceof AnalysisLimit)return emptyQuery();throw error; }
}
