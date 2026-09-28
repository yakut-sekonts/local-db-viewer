import { useEffect, useState } from 'react';
import type { QuerySnapshot } from './shared';
import { resultSets, resultSetView } from './result-sets';
import { Results } from './Results';

export function ResultSets({ result, onError }: { result?: QuerySnapshot; onError(message:string):void }) {
  const [selected,setSelected] = useState<number>();
  useEffect(()=>setSelected(undefined),[result?.requestId]);
  if(!result?.additionalResults?.length) return <Results result={result} onError={onError} />;
  const values=resultSets(result);
  // Prefer a table over a final procedure update count; a user's explicit selection stays pinned.
  const tables=values.map((value,index)=>value.columns.length ? index : -1).filter(index=>index>=0);
  const index=selected!==undefined && selected<values.length ? selected : tables.at(-1) ?? values.length-1;
  return <div className="script-results query-results">
    <div className="script-summary"><strong className="query-state" data-state={result.state}>Запрос · {result.state}</strong><span>{values.length} результатов</span>{Boolean(result.omittedResults) && <span>Ещё {result.omittedResults} прочитано без сохранения (лимит 100 результатов)</span>}</div>
    {result.error && <div role="alert" className="query-error"><pre>{result.error}</pre></div>}
    <div className="script-tabs statement-result-tabs" role="tablist" aria-label="Результаты запроса">{values.map((value,i)=><button key={i} role="tab" aria-selected={i===index} className={i===index ? 'active' : ''} onClick={()=>setSelected(i)}>{i+1} · {value.columns.length ? 'Таблица' : value.updateCount!==undefined ? `Изменено: ${value.updateCount}` : value.dataLimited ? 'Лимит данных' : 'Результат'}</button>)}</div>
    <Results result={resultSetView(result,index)} onError={onError} />
  </div>;
}
