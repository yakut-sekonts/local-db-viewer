import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Globe, WifiOff, X } from 'lucide-react';
import type { NetworkMode, NetworkState } from './network';

const NetworkContext = createContext<NetworkState>({ mode: 'database-only' });
export const useNetwork = () => useContext(NetworkContext);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NetworkState>({ mode: 'database-only' });
  useEffect(() => {
    let live = true, changed = false;
    const off = window.studio.network.onChange(value => { changed = true; if (live) setState(value); });
    void window.studio.network.state().then(value => { if (live && !changed) setState(value); })
      .catch(() => { if (live && !changed) setState({ mode: 'database-only', error: 'Не удалось прочитать сетевой режим.' }); });
    return () => { live = false; off(); };
  }, []);
  return <NetworkContext.Provider value={state}>{children}</NetworkContext.Provider>;
}

export function NetworkCenter() {
  const state = useNetwork(), restricted = state.mode === 'database-only';
  const [opened, setOpened] = useState(false), [mode, setMode] = useState<NetworkMode>(state.mode);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (opened) dialog.current?.showModal(); }, [opened]);
  async function save() {
    setBusy(true); setError('');
    try { await window.studio.network.configure(mode); setOpened(false); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <button className="update-indicator" aria-label="Сетевые настройки" title={state.error || (restricted ? 'Только БД · внешние загрузки отключены' : 'Сетевые настройки')} onClick={() => { setMode(state.mode); setError(''); setOpened(true); }}>
      {restricted ? <WifiOff size={16} /> : <Globe size={16} />}{restricted && 'Только БД'}{state.error && ' !'}
    </button>
    {opened && <dialog ref={dialog} className="connection-dialog update-dialog" onCancel={event => { if (busy) event.preventDefault(); else setOpened(false); }}>
      <div className="dialog-heading"><div><h2>Сетевые настройки</h2><p>Внешние загрузки Local DB Viewer</p></div><button className="icon-button" aria-label="Закрыть сетевые настройки" disabled={busy} onClick={() => setOpened(false)}><X size={18} /></button></div>
      <div className="dialog-body">
        <label>Сетевой режим<select aria-label="Сетевой режим" value={mode} disabled={busy} onChange={event => setMode(event.target.value as NetworkMode)}>
          <option value="online">Обычный — подключения и загрузки IDE</option>
          <option value="database-only">Только БД — без внешних загрузок IDE</option>
        </select></label>
        <p>«Только БД» запрещает автоматические и ручные проверки обновлений, обращения к каталогу JDBC, Maven Central и сторонним источникам драйверов. Начатые загрузки прерываются.</p>
        <p>Подключения к БД и SSH, установленные драйверы, импорт локальных JAR и установка уже загруженного обновления доступны. Режим сохраняется после перезапуска.</p>
        <p>Сетевые обращения самих JDBC-драйверов, включая аутентификацию и поиск серверов, определяются настройками подключения. Этот режим не заменяет сетевые ограничения ОС.</p>
        <small>В обычном режиме загрузки IDE используют системный proxy/PAC. Обращения к БД идут по настройкам драйвера и SSH; системный proxy IDE на них автоматически не распространяется.</small>
        {(error || state.error) && <div className="form-message error" role="alert">{error || state.error}</div>}
      </div>
      <div className="dialog-footer"><small>После разрешения загрузок проверки продолжатся по расписанию или по вашей команде.</small><div className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохранение…' : 'Применить'}</button></div>
    </dialog>}
  </>;
}
