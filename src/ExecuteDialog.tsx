import { useEffect, useRef } from 'react';
import { Play, X } from 'lucide-react';
import type { ExecutionTarget } from './execution';

export interface ExecutionConfirmation {
  target: ExecutionTarget;
  connectionName: string;
  catalog: string;
  schema: string;
  searchPath?: string;
  templateName?: string;
  limit: number;
}
export function ExecuteDialog({ request, onCancel, onConfirm }: { request: ExecutionConfirmation; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), submitted = useRef(false), confirm = useRef<HTMLButtonElement>(null);
  const { target } = request;
  useEffect(() => { dialog.current?.showModal(); confirm.current?.focus(); }, []);
  function submit() { if (submitted.current) return; submitted.current = true; onConfirm(); }
  const source = { cursor: 'Команда под курсором', selection: 'Выделенный SQL', script: 'Вся консоль' }[target.source];
  return <dialog ref={dialog} className="connection-dialog execute-dialog" aria-labelledby="execute-heading" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!event.repeat) submit(); }
    else if (event.key === 'Enter' && event.repeat) event.preventDefault();
  }}>
    <div className="dialog-heading"><div><h2 id="execute-heading">{target.mode === 'script' ? 'Подтвердить запуск скрипта' : 'Подтвердить выполнение запроса'}</h2><p>{source} · строки {target.startLine}{target.endLine !== target.startLine ? `–${target.endLine}` : ''}{target.mode === 'script' ? ` · команд: ${target.count}` : ''}</p></div><button className="icon-button close-dialog" aria-label="Закрыть подтверждение" onClick={onCancel}><X size={18} /></button></div>
    <div className="dialog-body">
      <dl className="execute-context"><div><dt>Подключение</dt><dd>{request.connectionName}</dd></div><div><dt>Catalog / schema</dt><dd>{request.catalog || 'по умолчанию'} / {request.schema || 'по умолчанию'}</dd></div>{request.searchPath !== undefined && <div><dt>search_path</dt><dd>{request.searchPath || '(пустой)'}</dd></div>}{request.templateName && <div><dt>Сессия</dt><dd>{request.templateName}</dd></div>}</dl>
      <label>SQL к выполнению<textarea aria-label="SQL к выполнению" readOnly spellCheck={false} value={target.sql} /></label>
      <small>Сохранять до {request.limit.toLocaleString('ru')} строк на результат.{target.mode === 'script' && ' Команды выполняются последовательно до первой ошибки. Автоматического отката нет.'}</small>
    </div>
    <div className="dialog-footer"><span className="muted">Esc — отменить · Ctrl / ⌘ + Enter — подтвердить</span><div className="spacer" /><button className="button secondary" onClick={onCancel}>Отмена</button><button ref={confirm} className="button primary" onClick={submit}><Play size={13} />{target.mode === 'script' ? 'Выполнить скрипт' : 'Выполнить запрос'}</button></div>
  </dialog>;
}
