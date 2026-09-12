import { useEffect, useRef, useState } from 'react';
import { Bell, Download, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from './updates';

export function UpdateCenter({ beforeRestart }: { beforeRestart(): void }) {
  const [state, setState] = useState<UpdateState>();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [error, setError] = useState('');
  const [repository, setRepository] = useState('');
  const [token, setToken] = useState('');
  const [automatic, setAutomatic] = useState(true);
  const [editing, setEditing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    void window.studio.updates.state().then(setState).catch(error => setError(error.message));
    return window.studio.updates.onChange(setState);
  }, []);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  function show() { setRepository(state?.settings.repository ?? ''); setAutomatic(state?.settings.automatic ?? true); setToken(''); setError(''); setEditing(!state?.settings.repository); setOpen(true); }
  async function perform(task: () => Promise<unknown>) { setError(''); try { await task(); } catch (error) { setError((error as Error).message); } }
  const busy = !!state && ['checking', 'downloading', 'installing'].includes(state.phase);
  const available = !!state?.version && ['available', 'ready', 'downloading', 'installing'].includes(state.phase);
  const restart = async () => { beforeRestart(); await window.studio.updates.install(); };
  const update = async () => { const next = await window.studio.updates.download(); if (next.phase === 'ready') await restart(); };
  return <>
    <button className={`update-indicator ${available ? 'has-update' : ''}`} aria-label="Обновления Local DB Viewer" onClick={show}><Bell size={15} />{state?.currentVersion ?? '…'}{available && <span className="update-dot" />}</button>
    {available && state.version !== dismissed && !open && <aside className="update-toast" role="status">
      <div><Download size={18} /><strong>Доступна Local DB Viewer {state.version}</strong><button className="icon-button" aria-label="Скрыть уведомление об обновлении" onClick={() => setDismissed(state.version!)}><X size={14} /></button></div>
      <p>{state.phase === 'downloading' ? `Загрузка ${state.progress ?? 0}%` : 'Установите новую версию с сохранением подключений и SQL-консолей.'}</p>
      <button className="button primary" onClick={show}>Посмотреть обновление</button>
    </aside>}
    {open && <dialog ref={dialog} className="connection-dialog update-dialog" onCancel={event => { if (state?.phase === 'installing') event.preventDefault(); else setOpen(false); }}>
      <div className="dialog-heading"><div><h2>Обновления Local DB Viewer</h2><p>Установлена версия {state?.currentVersion}</p></div><button className="icon-button" aria-label="Закрыть обновления" disabled={state?.phase === 'installing'} onClick={() => setOpen(false)}><X size={18} /></button></div>
      <div className="dialog-body">
        {state?.version && <><h3>Версия {state.version}</h3><pre className="release-notes">{state.notes || 'Новая версия Local DB Viewer.'}</pre></>}
        {state?.phase === 'idle' && state.checkedAt && <p>У вас последняя доступная версия.</p>}
        {state?.phase === 'downloading' && <label>Загрузка: {state.progress ?? 0}%<progress max={100} value={state.progress ?? 0} /></label>}
        {state?.phase === 'installing' && <p>Подготовка обновления и перезапуска…</p>}
        {state?.phase === 'ready' && <p>Обновление загружено и проверено. Приложение готово к перезапуску.</p>}
        {state?.checkedAt && <small>Последняя проверка: {new Date(state.checkedAt).toLocaleString('ru')}</small>}
        <button className="ssl-summary" onClick={() => setEditing(!editing)}>{editing ? 'Скрыть настройки доступа' : 'Настройки доступа к обновлениям'}</button>
        {editing && <div className="update-access">
          <label>GitHub-репозиторий<input placeholder="owner/local-db-viewer-releases" value={repository} disabled={busy} onChange={event => setRepository(event.target.value)} /></label>
          <label>Личный токен GitHub (необязательно)<input type="password" autoComplete="off" placeholder={state?.settings.hasToken ? 'Сохранён · оставьте пустым, чтобы сохранить' : 'Для приватного репозитория'} value={token} disabled={busy} onChange={event => setToken(event.target.value)} /><small>Для публичного репозитория токен не нужен. Сохранённый токен можно удалить кнопкой ниже. Токен хранится зашифрованным только на этом устройстве.</small></label>
          <small>Обновления используют системные настройки proxy и проверку TLS-сертификатов.</small>
          <label className="checkbox-row"><input type="checkbox" checked={automatic} disabled={busy} onChange={event => setAutomatic(event.target.checked)} />Проверять при запуске и каждые 15 минут</label>
          <button className="button secondary" disabled={busy} onClick={() => void perform(async () => { await window.studio.updates.configure({ repository, automatic, token: token || undefined }); setToken(''); setEditing(false); await window.studio.updates.check(); })}>Сохранить и проверить</button>
          {state?.settings.hasToken && <button className="button secondary" disabled={busy} onClick={() => void perform(() => window.studio.updates.configure({ repository, automatic, token: '' }))}>Удалить токен с устройства</button>}
        </div>}
        {(error || state?.error) && <div className="form-message error" role="alert">{error || state?.error}</div>}
      </div>
      <div className="dialog-footer"><button className="button secondary" disabled={busy || !state?.settings.repository} onClick={() => void perform(() => window.studio.updates.check())}><RefreshCw size={14} className={state?.phase === 'checking' ? 'spin' : ''} />Проверить обновления</button><div className="spacer" />{state?.phase === 'available' && <button className="button primary" onClick={() => void perform(update)}><Download size={15} />Обновить и перезапустить</button>}{state?.phase === 'ready' && <button className="button primary" onClick={() => void perform(restart)}>Перезапустить и обновить</button>}</div>
    </dialog>}
  </>;
}
