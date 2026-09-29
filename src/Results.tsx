import { useEffect, useState } from 'react';
import { Table2, Check, CircleAlert, SquareTerminal, LoaderCircle } from 'lucide-react';
import type { QuerySnapshot } from './shared';
import { ResultGrid } from './ResultGrid';
export { cellText } from './result-grid';
export function Results({ result, onError }: { result?: QuerySnapshot; onError(message: string): void }) {
  const [view, setView] = useState<'data' | 'messages'>('data');
  useEffect(() => { setView('data'); }, [result?.requestId, result?.script?.index]);
  const running = result?.state === 'RUNNING';
  return <section className="results">
    <div className="results-heading"><button className={`result-tab ${view === 'data' ? 'active' : ''}`} onClick={() => setView('data')}><Table2 size={14} />Результат {result && <span className="count">{result.rows.length.toLocaleString('ru')}</span>}</button><button className={`result-tab ${view === 'messages' ? 'active' : ''}`} onClick={() => setView('messages')}><SquareTerminal size={14} />Сообщения{result?.error && <span className="error-dot" />}</button><div className="spacer" />{result && <span className={`result-state ${result.state.toLowerCase()}`}>{running ? <LoaderCircle size={12} className="spin" /> : result.state === 'FINISHED' ? <Check size={13} /> : <CircleAlert size={13} />}{result.state}</span>}</div>
    {result?.dataLimited && <div className="script-limit">Часть данных не сохранена из-за общего лимита памяти результатов.</div>}
    {view === 'messages' && <div className="messages"><p>{result ? `Query ID: ${result.queryId || 'ожидание coordinator'}` : 'Запросы ещё не выполнялись.'}</p>{result?.error && <pre className="error-text">{result.error}</pre>}{result?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{result?.updateType && <p>{result.updateType}{result.updateCount !== undefined ? ` · ${result.updateCount} строк` : ''}</p>}{result?.inTransaction && <p>Открыта транзакция. Выполните COMMIT или ROLLBACK в этой консоли.</p>}</div>}
    <div className="result-data" hidden={view !== 'data'}>
      {!result || (!result.columns.length && running) ? <div className="result-empty"><div className="result-empty-icon">{running ? <LoaderCircle size={24} className="spin" /> : <Table2 size={25} strokeWidth={1.3} />}</div><h3>{running ? 'Запрос выполняется' : 'Место для ваших результатов'}</h3><p>{running ? 'Статистика обновляется по мере выполнения.' : 'Выполните SQL или выделенный фрагмент.'}</p>{!running && <kbd>⌘ / Ctrl + Enter</kbd>}</div>
      : <>
        {result.error && <div role="alert" className="query-error"><CircleAlert size={16} /><pre>{result.error}</pre></div>}
        {!!result.columns.length && <ResultGrid key={`${result.requestId}:${result.script?.index ?? ''}`} result={result} onError={onError} />}
        {!result.columns.length && !result.error && <div className="result-empty"><Check size={25} /><h3>{result.state === 'CANCELED' ? 'Запрос отменён' : 'Команда выполнена'}</h3><p>{result.updateType}{result.updateCount !== undefined && ` · ${result.updateCount} строк`}</p></div>}
      </>}
    </div>
  </section>;
}
