import { useEffect, useState } from 'react';
import type { QuerySnapshot } from './shared';
import { Results } from './Results';

export function ScriptResults({ latest, results, onError }: { latest?: QuerySnapshot; results?: QuerySnapshot[]; onError(message: string): void }) {
  const [selected, setSelected] = useState<number>();
  useEffect(() => setSelected(undefined), [latest?.requestId]);
  if (!latest?.script) return <Results result={latest} onError={onError} />;
  const script = latest.script, index = selected ?? script.index;
  const current = results?.find(result => result.script?.index === index) ?? latest;
  return <div className="script-results">
    <div className="script-summary"><strong className="script-state" data-state={script.state}>Скрипт · {script.state}</strong><span>Завершено {script.completed} из {script.total}</span><span>{(script.elapsedTimeMillis / 1000).toFixed(2)} s</span>{script.state === 'FAILED' && <span>Остановлен на команде {script.index + 1}</span>}{script.state === 'CANCELED' && <span>Дальнейшие команды отменены</span>}</div>
    <div className="script-tabs" role="tablist" aria-label="Результаты скрипта">{results?.map(result => result.script && <button key={result.script.index} role="tab" aria-selected={result.script.index === index} className={result.script.index === index ? 'active' : ''} title={result.script.preview} onClick={() => setSelected(result.script!.index)}><span className={`service-status ${result.state.toLowerCase()}`} />{result.script.index + 1} · строка {result.script.line}</button>)}</div>
    {current.script?.dataLimited && <div className="script-limit">Общий лимит табличных данных скрипта: 16 MiB. Часть данных не сохранена; остальные строки прочитаны драйвером.</div>}
    <Results result={{ ...current, inTransaction: latest.inTransaction }} onError={onError} />
  </div>;
}
