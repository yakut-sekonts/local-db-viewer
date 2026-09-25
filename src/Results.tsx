import { useEffect, useMemo, useState } from 'react';
import { Table2, Download, Search, ChevronLeft, ChevronRight, Check, CircleAlert, SquareTerminal, LoaderCircle } from 'lucide-react';
import type { QuerySnapshot } from './shared';

export const cellText = (value: unknown): string => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function Results({ result, onError }: { result?: QuerySnapshot; onError(message: string): void }) {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'data' | 'messages'>('data');
  useEffect(() => { setPage(0); setFilter(''); setView('data'); }, [result?.requestId, result?.script?.index]);
  const rows = useMemo(() => (result?.rows ?? []).filter(row => !filter || row.some(value => cellText(value).toLowerCase().includes(filter.toLowerCase()))), [result?.rows, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  const currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * 100, (currentPage + 1) * 100);
  const running = result?.state === 'RUNNING';
  return <section className="results">
    <div className="results-heading"><button className={`result-tab ${view === 'data' ? 'active' : ''}`} onClick={() => setView('data')}><Table2 size={14} />Результат {result && <span className="count">{result.rows.length.toLocaleString('ru')}</span>}</button><button className={`result-tab ${view === 'messages' ? 'active' : ''}`} onClick={() => setView('messages')}><SquareTerminal size={14} />Сообщения{result?.error && <span className="error-dot" />}</button><div className="spacer" />{result && <span className={`result-state ${result.state.toLowerCase()}`}>{running ? <LoaderCircle size={12} className="spin" /> : result.state === 'FINISHED' ? <Check size={13} /> : <CircleAlert size={13} />}{result.state}</span>}</div>
    {view === 'messages' ? <div className="messages"><p>{result ? `Query ID: ${result.queryId || 'ожидание coordinator'}` : 'Запросы ещё не выполнялись.'}</p>{result?.error && <pre className="error-text">{result.error}</pre>}{result?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{result?.updateType && <p>{result.updateType}{result.updateCount !== undefined ? ` · ${result.updateCount} строк` : ''}</p>}{result?.inTransaction && <p>Открыта транзакция. Выполните COMMIT или ROLLBACK в этой консоли.</p>}</div>
      : !result || (!result.columns.length && running) ? <div className="result-empty"><div className="result-empty-icon">{running ? <LoaderCircle size={24} className="spin" /> : <Table2 size={25} strokeWidth={1.3} />}</div><h3>{running ? 'Запрос выполняется' : 'Место для ваших результатов'}</h3><p>{running ? 'Статистика обновляется по мере выполнения.' : 'Выполните SQL или выделенный фрагмент.'}</p>{!running && <kbd>⌘ / Ctrl + Enter</kbd>}</div>
      : <>
        {result.error && <div role="alert" className="query-error"><CircleAlert size={16} /><pre>{result.error}</pre></div>}
        {!!result.columns.length && <><div className="grid-toolbar"><label><Search size={13} /><input placeholder="Фильтр загруженных строк…" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label><span>{result.truncated ? `Показаны первые ${result.rows.length.toLocaleString('ru')} из ${result.totalRows.toLocaleString('ru')} строк` : `${rows.length.toLocaleString('ru')} строк`}</span><div className="spacer" /><button className="button text-button" title="Экспорт загруженных строк; опасные CSV-формулы экранируются" disabled={running} onClick={() => void window.studio.exportCSV({ columns: result.columns, rows: result.rows }).catch(error => onError(error.message))}><Download size={13} />CSV</button></div>
        <div className="grid-scroll"><table><thead><tr><th className="row-number">#</th>{result.columns.map((column, index) => <th key={index}><span>{column.name}</span><small>{column.type}</small></th>)}</tr></thead><tbody>{visible.map((row, index) => <tr key={index}><td className="row-number">{currentPage * 100 + index + 1}</td>{result.columns.map((_, columnIndex) => <td key={columnIndex} className={row[columnIndex] === null ? 'null-value' : typeof row[columnIndex] === 'number' ? 'number-value' : ''} title={cellText(row[columnIndex])}>{cellText(row[columnIndex])}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <div className="no-rows">Нет строк</div>}</div>
        <div className="grid-footer"><span>{result.truncated ? 'Лимит отображения: строки / 8 MB. Остальные страницы прочитаны без сохранения.' : 'Результаты доступны только для чтения'}</span><div className="spacer" /><button className="icon-button" aria-label="Предыдущая страница" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button><span>{currentPage + 1} / {pages}</span><button className="icon-button" aria-label="Следующая страница" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button></div></>}
        {!result.columns.length && !result.error && <div className="result-empty"><Check size={25} /><h3>{result.state === 'CANCELED' ? 'Запрос отменён' : 'Команда выполнена'}</h3><p>{result.updateType}{result.updateCount !== undefined && ` · ${result.updateCount} строк`}</p></div>}
      </>}
  </section>;
}
