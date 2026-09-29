import { useEffect, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';
import type { Column } from './shared';
import { cellText } from './result-grid';

export function CellDialog({ value, column, row, onClose }: { value: unknown; column: Column; row: number; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="connection-dialog cell-dialog" aria-labelledby="cell-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="dialog-heading"><div><h2 id="cell-heading">Значение ячейки</h2><p>{column.name} · {column.type} · строка {row + 1}{value === null ? ' · SQL NULL' : value === '' ? ' · пустая строка' : ''}</p></div><button className="icon-button close-dialog" aria-label="Закрыть значение ячейки" onClick={onClose}><X size={18} /></button></div>
    <div className="dialog-body"><textarea aria-label="Полное значение ячейки" readOnly spellCheck={false} value={cellText(value)} /></div>
    <div className="dialog-footer"><span role="status">{notice || 'Только чтение'}</span><div className="spacer" /><button className="button secondary" onClick={() => void window.studio.copyText(cellText(value)).then(() => setNotice('Значение скопировано')).catch(error => setNotice(error.message))}><Copy size={13} />Копировать значение</button><button className="button primary" onClick={onClose}>Закрыть</button></div>
  </dialog>;
}
