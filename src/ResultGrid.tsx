import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Copy, Download, Maximize2, Search } from 'lucide-react';
import type { QuerySnapshot } from './shared';
import { cellText, copyGridRange, gridRows, selectionBounds, type GridPoint, type GridSelection, type GridSort } from './result-grid';
import { CellDialog } from './CellDialog';

const PAGE_SIZE = 100;
export function ResultGrid({ result, onError }: { result: QuerySnapshot; onError(message: string): void }) {
  const [page, setPage] = useState(0), [filter, setFilter] = useState('');
  const [sort, setSort] = useState<GridSort>();
  const [selection, setSelection] = useState<GridSelection>();
  const [inspected, setInspected] = useState<GridPoint>();
  const [copied, setCopied] = useState(false);
  const grid = useRef<HTMLDivElement>(null), dragging = useRef(false);
  const rows = useMemo(() => gridRows(result.rows, result.columns, filter, sort), [result.rows, result.columns, filter, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const bounds = selection ? selectionBounds(selection) : undefined;
  const running = result.state === 'RUNNING';
  // Streaming / refreshed data must not leave a selection pointing at different cells.
  useEffect(() => { setSelection(undefined); setInspected(undefined); setCopied(false); }, [rows, result.columns]);
  useEffect(() => { const stop = () => { dragging.current = false; }; window.addEventListener('mouseup', stop); window.addEventListener('blur', stop); return () => { window.removeEventListener('mouseup', stop); window.removeEventListener('blur', stop); }; }, []);
  useEffect(() => { grid.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selection, currentPage]);

  function select(point: GridPoint, extend = false) {
    setSelection(previous => ({ anchor: extend && previous ? previous.anchor : point, focus: point }));
    setCopied(false);
  }
  function selectAll() {
    if (!rows.length || !result.columns.length) return;
    setSelection({ anchor: { row: 0, column: 0 }, focus: { row: rows.length - 1, column: result.columns.length - 1 } }); setCopied(false);
  }
  async function copy(headers = false) {
    if (!selection) return;
    try { await window.studio.copyText(copyGridRange(result.columns, rows, selection, headers)); setCopied(true); }
    catch (error) { onError((error as Error).message); }
  }
  function changeSort(column: number) {
    setSort(previous => previous?.column !== column ? { column, direction: 'asc' } : previous.direction === 'asc' ? { column, direction: 'desc' } : undefined);
    setPage(0);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== grid.current) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); void copy(event.shiftKey); return; }
    if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); selectAll(); return; }
    if (event.key === 'Escape') { setSelection(undefined); setCopied(false); return; }
    if (event.key === 'Enter' && selection && !command && !event.altKey) { event.preventDefault(); event.stopPropagation(); setInspected(selection.focus); return; }
    if (!rows.length || !result.columns.length || event.altKey) return;
    const previous = selection?.focus ?? { row: currentPage * PAGE_SIZE, column: 0 }, next = { ...previous };
    switch (event.key) {
      case 'ArrowUp': next.row--; break;
      case 'ArrowDown': next.row++; break;
      case 'ArrowLeft': next.column--; break;
      case 'ArrowRight': next.column++; break;
      case 'PageUp': next.row -= PAGE_SIZE; break;
      case 'PageDown': next.row += PAGE_SIZE; break;
      case 'Home': next.column = 0; if (command) next.row = 0; break;
      case 'End': next.column = result.columns.length - 1; if (command) next.row = rows.length - 1; break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    next.row = Math.max(0, Math.min(rows.length - 1, next.row)); next.column = Math.max(0, Math.min(result.columns.length - 1, next.column));
    select(next, event.shiftKey); setPage(Math.floor(next.row / PAGE_SIZE));
  }
  const inspectedColumn = inspected ? result.columns[inspected.column] : undefined;
  return <>
    <div className="grid-toolbar"><label><Search size={13} /><input placeholder="Фильтр загруженных строк…" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label><span>{filter ? `${rows.length.toLocaleString('ru')} из ${result.rows.length.toLocaleString('ru')} загруженных строк` : result.truncated ? `Загружено ${result.rows.length.toLocaleString('ru')} из ${result.totalRows.toLocaleString('ru')} строк` : `${rows.length.toLocaleString('ru')} строк`}</span><div className="spacer" />
      <button className="icon-button" disabled={!selection} aria-label="Копировать выделение" title="Копировать выделение · Ctrl / ⌘ + C" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      <button className="button text-button" disabled={!selection} title="Копировать выделение с названиями колонок · Ctrl / ⌘ + Shift + C" onClick={() => void copy(true)}>С заголовками</button>
      <button className="icon-button" disabled={!selection} aria-label="Открыть значение ячейки" title="Полное значение ячейки · Enter / двойной щелчок" onClick={() => selection && setInspected(selection.focus)}><Maximize2 size={14} /></button>
      <button className="button text-button" title="Экспорт всех загруженных строк без локального фильтра и сортировки; опасные CSV-формулы экранируются" disabled={running} onClick={() => void window.studio.exportCSV({ columns: result.columns, rows: result.rows }).catch(error => onError(error.message))}><Download size={13} />CSV</button>
    </div>
    <div className="grid-scroll result-grid" ref={grid} tabIndex={0} aria-label="Таблица результатов" onKeyDown={keyDown} onCopy={event => {
      // Electron's native Edit → Copy menu also dispatches a copy event.
      if (event.target !== grid.current || !selection) return;
      event.preventDefault();
      try { event.clipboardData.setData('text/plain', copyGridRange(result.columns, rows, selection)); setCopied(true); }
      catch (error) { onError((error as Error).message); }
    }}>
      <table><thead><tr><th className="row-number"><button aria-label="Выделить все загруженные строки" onClick={() => { grid.current?.focus(); selectAll(); }}>#</button></th>{result.columns.map((column, index) => <th key={index} aria-sort={sort?.column === index ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="grid-column-sort" aria-label={`Сортировать колонку ${index + 1}: ${column.name}`} title="Сортировка загруженных строк: по возрастанию → по убыванию → исходный порядок; NULL в конце" onClick={() => changeSort(index)}><span>{column.name}</span><small>{column.type}</small>{sort?.column === index && (sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}</tr></thead>
        <tbody>{visible.map((row, index) => {
          const rowIndex = currentPage * PAGE_SIZE + index;
          return <tr key={rowIndex}><td className="row-number"><button aria-label={`Выделить строку ${rowIndex + 1}`} onClick={() => { grid.current?.focus(); setSelection({ anchor: { row: rowIndex, column: 0 }, focus: { row: rowIndex, column: result.columns.length - 1 } }); setCopied(false); }}>{rowIndex + 1}</button></td>{result.columns.map((_, columnIndex) => {
            const text = cellText(row[columnIndex]), point = { row: rowIndex, column: columnIndex };
            const selected = Boolean(bounds && rowIndex >= bounds.top && rowIndex <= bounds.bottom && columnIndex >= bounds.left && columnIndex <= bounds.right);
            const active = selection?.focus.row === rowIndex && selection.focus.column === columnIndex;
            return <td key={columnIndex} data-row={rowIndex} data-column={columnIndex} data-selected={selected || undefined} data-active={active || undefined} className={row[columnIndex] === null ? 'null-value' : typeof row[columnIndex] === 'number' ? 'number-value' : ''} title={text.length > 512 ? text.slice(0, 512) + '… (Enter — полное значение)' : text}
              onMouseDown={event => { if (event.button !== 0) return; event.preventDefault(); grid.current?.focus(); dragging.current = true; select(point, event.shiftKey); }}
              onMouseEnter={event => { if (dragging.current && (event.buttons & 1)) select(point, true); }}
              onDoubleClick={() => setInspected(point)}>{text.length > 2048 ? text.slice(0, 2048) + '…' : text}</td>;
          })}</tr>;
        })}</tbody></table>{rows.length === 0 && <div className="no-rows">Нет строк</div>}
    </div>
    <div className="grid-footer"><span>{sort ? 'Сортировка только загруженных строк · ' : ''}{result.truncated ? 'Часть строк не сохранена из-за лимита отображения.' : 'Результаты доступны только для чтения'}</span><span role="status">{copied ? 'Скопировано' : bounds ? `${bounds.bottom - bounds.top + 1} × ${bounds.right - bounds.left + 1} ячеек` : 'Shift — диапазон · Ctrl / ⌘ + C — копировать'}</span><div className="spacer" /><button className="icon-button" aria-label="Предыдущая страница" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button><span>{currentPage + 1} / {pages}</span><button className="icon-button" aria-label="Следующая страница" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button></div>
    {inspected && inspectedColumn && <CellDialog value={rows[inspected.row]?.[inspected.column]} column={inspectedColumn} row={inspected.row} onClose={() => { setInspected(undefined); requestAnimationFrame(() => grid.current?.focus()); }} />}
  </>;
}
