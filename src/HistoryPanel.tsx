import { useEffect, useRef, useState } from 'react';
import { Copy, History, Pin, Search, Trash2, X } from 'lucide-react';
import { filterHistory, historyContext, HISTORY_LIMIT, HISTORY_PIN_LIMIT, HISTORY_STATES, type HistoryItem } from './history';
import type { Profile } from './shared';

interface HistoryProps {
  items: HistoryItem[];
  profiles: Profile[];
  onPin(id: string): void;
  onDelete(id: string): void;
  onOpen(item: HistoryItem): boolean;
}

export function HistoryPanel(props: HistoryProps) {
  const [text, setText] = useState(''), [profileId, setProfileId] = useState(''), [state, setState] = useState(''), [pinned, setPinned] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState('');
  const selected = props.items.find(item => item.id === selectedId);
  const visible = filterHistory(props.items, { text, profileId, state, pinned });
  const connections = new Map<string, string>();
  for (const item of props.items) if (!connections.has(item.profileId)) {
    const profile = props.profiles.find(profile => profile.id === item.profileId);
    connections.set(item.profileId, profile?.name ?? `${item.profileName} (удалено)`);
  }
  return <>
    <div className="panel-heading"><span>ИСТОРИЯ ЗАПРОСОВ</span><span className="count" aria-label="Количество записей истории">{visible.length} / {props.items.length}</span></div>
    <div className="history-filters">
      <label className="history-search"><Search size={13} /><input aria-label="Поиск в истории" placeholder="SQL, подключение, schema…" value={text} maxLength={1000} onChange={event => setText(event.target.value)} /></label>
      <select aria-label="Подключение в истории" value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">Все подключения</option>{[...connections].map(([id, name]) => <option key={id} value={id}>{name}</option>)}{profileId && !connections.has(profileId) && <option value={profileId}>Нет записей подключения</option>}</select>
      <select aria-label="Результат в истории" value={state} onChange={event => setState(event.target.value)}><option value="">Все результаты</option>{Object.entries(HISTORY_STATES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
      <div><label><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} />Закреплённые</label><button onClick={() => { setText(''); setProfileId(''); setState(''); setPinned(false); }}>Сбросить</button></div>
    </div>
    {notice && <p className="history-notice" role="alert">{notice}</p>}
    <div className="history-list">
      {!visible.length && <div className="explorer-empty"><History size={27} /><h3>{props.items.length ? 'Ничего не найдено' : 'История пуста'}</h3><p>{props.items.length ? 'Измените фильтры или поиск.' : 'Выполненные запросы появятся здесь.'}</p></div>}
      {visible.map(item => <div key={item.id} className="history-entry" data-history-id={item.id}>
        <button className="history-item" aria-label={`Просмотреть запрос: ${item.profileName}`} onClick={() => setSelectedId(item.id)}>
          <div><span className={`history-dot ${item.state.toLowerCase()}`} /><strong>{item.profileName}</strong></div>
          <time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleString('ru')}</time>
          <code>{item.sql.slice(0, 500)}</code><small>{item.mode === 'script' ? 'Скрипт · ' : ''}{HISTORY_STATES[item.state]} · {(item.duration / 1000).toFixed(2)} s</small>
        </button>
        <button className="icon-button history-pin" aria-label={item.pinned ? 'Открепить запрос' : 'Закрепить запрос'} aria-pressed={!!item.pinned} onClick={() => { try { props.onPin(item.id); setNotice(''); } catch (error) { setNotice((error as Error).message); } }}><Pin size={13} /></button>
      </div>)}
    </div>
    <div className="sidebar-foot history-foot">До {HISTORY_LIMIT} записей · до {HISTORY_PIN_LIMIT} закреплённых<br />Нажмите запрос для просмотра</div>
    {selected && <HistoryDialog key={selected.id} {...props} item={selected} onClose={() => setSelectedId(undefined)} />}
  </>;
}

function HistoryDialog({ item, profiles, onClose, onOpen, onDelete, onPin }: HistoryProps & { item: HistoryItem; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState(''), [deleting, setDeleting] = useState(false);
  const target = historyContext(item, profiles);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="connection-dialog execute-dialog history-dialog" aria-labelledby="history-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="dialog-heading"><div><h2 id="history-heading">{item.mode === 'script' ? 'Скрипт из истории' : 'Запрос из истории'}</h2><p>{new Date(item.time).toLocaleString('ru')} · {HISTORY_STATES[item.state]} · {(item.duration / 1000).toFixed(2)} s</p></div><button className="icon-button close-dialog" aria-label="Закрыть просмотр истории" onClick={onClose}><X size={18} /></button></div>
    <div className="dialog-body">
      <dl className="execute-context"><div><dt>Подключение при запуске</dt><dd>{item.profileName}{target.profile && target.profile.name !== item.profileName ? ` → ${target.profile.name}` : ''}</dd></div><div><dt>Catalog / schema</dt><dd>{item.catalog || 'по умолчанию'} / {item.schema || 'по умолчанию'}</dd></div>
        {item.searchPath !== undefined && <div><dt>search_path</dt><dd>{item.searchPath || '(пустой)'}</dd></div>}
        <div><dt>Шаблон сессии</dt><dd>{item.templateId === undefined ? 'Не записан старой версией' : item.templateId ? item.templateName || item.templateId : 'Настройки подключения'}</dd></div>
        {item.maxRows !== undefined && <div><dt>Лимит строк при запуске</dt><dd>{item.maxRows.toLocaleString('ru')}</dd></div>}
      </dl>
      {target.warning && <p className="history-warning">{target.warning}</p>}
      <label>SQL из истории<textarea aria-label="SQL из истории" value={item.sql} readOnly spellCheck={false} /></label>
      <small>Открытие создаёт новую консоль. SQL выполняется отдельно, после подтверждения. Используются текущие настройки профиля и шаблона; состояние прежней SQL-сессии не восстанавливается.{item.mode === 'script' && ' Для всего скрипта используйте кнопку «Скрипт».'}</small>
      {deleting && <div className="history-delete-confirm" role="group" aria-label="Удаление записи истории"><span>Удалить эту запись{item.pinned ? ', включая закрепление' : ''}?</span><button className="button secondary" onClick={() => setDeleting(false)}>Оставить</button><button className="button secondary" onClick={() => { onDelete(item.id); onClose(); }}>Подтвердить удаление</button></div>}
      <span role="status">{notice}</span>
    </div>
    <div className="dialog-footer history-actions">
      <button className="button secondary" onClick={() => setDeleting(true)}><Trash2 size={13} />Удалить запись</button>
      <button className="button secondary" aria-pressed={!!item.pinned} onClick={() => { try { onPin(item.id); setNotice(''); } catch (error) { setNotice((error as Error).message); } }}><Pin size={13} />{item.pinned ? 'Открепить' : 'Закрепить'}</button>
      <div className="spacer" />
      <button className="button secondary" onClick={() => void window.studio.copyText(item.sql).then(() => setNotice('SQL скопирован')).catch(error => setNotice(error.message))}><Copy size={13} />Копировать SQL</button>
      <button className="button primary" onClick={() => { if (onOpen(item)) onClose(); else setNotice('Не удалось открыть консоль. Закройте одну из существующих вкладок.'); }}>Открыть в новой консоли</button>
    </div>
  </dialog>;
}
