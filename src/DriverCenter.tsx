import { useEffect, useRef, useState } from 'react';
import { Download, Package, RefreshCw, X } from 'lucide-react';
import { DRIVERS, driverDefinition, driverSourceLabel, profileDriver, type DriversState, type DriverStatus } from './drivers';
import type { ProfileDraft } from './shared';

function useDrivers() {
  const [state, setState] = useState<DriversState>();
  const [error, setError] = useState('');
  useEffect(() => {
    const unsubscribe = window.studio.drivers.onChange(setState);
    void window.studio.drivers.state().then(setState).catch(error => setError(error.message));
    return unsubscribe;
  }, []);
  const act = async (action: () => Promise<unknown>) => { setError(''); try { await action(); } catch (error) { setError((error as Error).message); } };
  return { state, error, act };
}

export function DriverSelection({ draft, onChange }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void }) {
  const { state, error, act } = useDrivers();
  const id = profileDriver(draft), definition = driverDefinition(id), driver = state?.drivers.find(driver => driver.id === id);
  const [version, setVersion] = useState('local');
  const busy = !!state?.configuring || state?.drivers.some(driver => driver.phase);
  return <div className="driver-selection">
    <strong>JDBC · {definition.name}</strong>
    <label>Версия драйвера<select aria-label="Версия драйвера подключения" value={draft.jdbc?.driverVersion ?? ''} onChange={event => onChange({ ...draft, jdbc: { ...draft.jdbc, driverVersion: event.target.value || undefined } })}>
      <option value="">Выбранная в IDE{driver?.selected ? ` · ${driver.installed.find(item => item.key === driver.selected)?.version}` : ' · не установлен'}</option>
      {driver?.installed.map(item => <option key={item.key} value={item.key}>{item.version} · {driverSourceLabel(item.source)}</option>)}
    </select></label>
    {definition.note && <small>{definition.note}</small>}
    <div className="driver-actions">
      {driver?.latest && <button type="button" className="button secondary" disabled={busy} onClick={() => void act(() => window.studio.drivers.install(id))}>{driver.phase ? `${driver.phase === 'verifying' ? 'Проверка' : 'Загрузка'} ${driver.progress ?? 0}%` : `Установить ${driver.latest}`}</button>}
      <input aria-label="Версия импортируемого драйвера" placeholder="Версия JAR" value={version} onChange={event => setVersion(event.target.value)} />
      <button type="button" className="button secondary" disabled={busy || !version.trim()} onClick={() => void act(() => window.studio.drivers.import(id, version))}>Импорт JAR…</button>
    </div>
    <small>Новая версия применяется к новым сессиям. В выпадающем списке можно закрепить версию для этого подключения.</small>
    {error && <div role="alert" className="form-message error">{error}</div>}
  </div>;
}

export function DriverCenter() {
  const { state, error, act } = useDrivers();
  const [opened, setOpened] = useState(false), [search, setSearch] = useState(''), [selected, setSelected] = useState('trino');
  const [version, setVersion] = useState('local'), [dismissed, setDismissed] = useState('');
  const updates = state?.drivers.filter(driver => driver.available) ?? [];
  const signature = updates.map(driver => `${driver.id}:${driver.latestKey}`).join('|');
  const definition = driverDefinition(selected), driver = state?.drivers.find(driver => driver.id === selected);
  const busy = !!state?.configuring || state?.drivers.some(driver => driver.phase);
  return <>
    <button className="icon-button driver-center-button" aria-label="JDBC-драйверы" title={`JDBC-драйверы${updates.length ? ` · обновлений: ${updates.length}` : ''}`} onClick={() => setOpened(true)}><Package size={18} />{updates.length > 0 && <span className="driver-badge">{updates.length}</span>}</button>
    {signature && signature !== dismissed && !opened && <div className="driver-toast" role="status"><Package size={18} /><span>Доступны обновления JDBC-драйверов: {updates.length}</span><button className="button secondary" onClick={() => { const first = updates[0]; if (first) setSelected(first.id); setOpened(true); setDismissed(signature); }}>Посмотреть</button><button className="icon-button" aria-label="Скрыть уведомление о драйверах" onClick={() => setDismissed(signature)}><X size={16} /></button></div>}
    {opened && <DriverDialog onClose={() => setOpened(false)}>
      <div className="dialog-heading"><Package size={24} /><div><h2>JDBC-драйверы</h2><p>Версии и обновления · {DRIVERS.length} драйверов</p></div><div className="spacer" /><button className="icon-button" aria-label="Закрыть драйверы" onClick={() => setOpened(false)}><X size={18} /></button></div>
      <div className="driver-center-body"><aside><input aria-label="Поиск драйвера" placeholder="Поиск драйвера…" value={search} onChange={event => setSearch(event.target.value)} /><div className="driver-list">{DRIVERS.filter(driver => driver.name.toLowerCase().includes(search.toLowerCase())).map(definition => {
        const item = state?.drivers.find(driver => driver.id === definition.id);
        return <button key={definition.id} className={selected === definition.id ? 'active' : ''} onClick={() => setSelected(definition.id)}><span>{definition.name}</span><small>{item?.available ? `↑ ${item.latest}` : item?.installed.find(version => version.key === item.selected)?.version || (item?.latest ? 'Доступен' : 'Импорт JAR')}</small></button>;
      })}</div></aside><section>
        <h3>{definition.name}</h3><code className="driver-class">{definition.className || 'Укажите Driver class в Advanced подключения'}</code>
        {definition.note && <p>{definition.note}</p>}
        <p>{driver?.latest ? `Доступная версия: ${driver.latest}` : 'Импортируйте комплект JAR производителя или настройте источник обновлений.'}</p>
        <label>Использовать в новых сессиях<select aria-label="Активная версия драйвера" disabled={busy || !driver?.installed.length} value={driver?.selected ?? ''} onChange={event => void act(() => window.studio.drivers.select(selected, event.target.value))}>
          {!driver?.installed.length && <option value="">Не установлен</option>}
          {driver?.installed.map(item => <option key={item.key} value={item.key}>{item.version} · {driverSourceLabel(item.source)}</option>)}
        </select></label>
        {driver?.latest && <button className="button primary" disabled={busy} onClick={() => void act(() => window.studio.drivers.install(selected))}><Download size={15} />{driver.phase ? `${driver.phase === 'verifying' ? 'Проверка' : 'Загрузка'} · ${driver.progress ?? 0}%` : `Установить ${driver.latest}`}</button>}
        {driver?.phase && <progress max={100} value={driver.progress ?? 0} />}
        <p>Открытые сессии сохраняют свою версию. Для возврата выберите предыдущую версию и откройте новую консоль. Закреплённая в подключении версия имеет приоритет.</p>
        <label>Версия комплекта JAR<input aria-label="Версия комплекта JAR" value={version} onChange={event => setVersion(event.target.value)} placeholder="Например, 3.1.0" /></label>
        <button className="button secondary" disabled={busy || !version.trim()} onClick={() => void act(() => window.studio.drivers.import(selected, version))}>Импортировать JAR и зависимости…</button>
        <small>Файлы копируются в папку текущего пользователя. Выбирайте весь комплект зависимостей из доверенного источника. Для уведомлений о новых версиях укажите источник ниже.</small>
        <DriverSourceSettings key={selected} id={selected} driver={driver} busy={!!busy || !!state?.checking} configuring={state?.configuring === selected} />
        <small className="driver-documentation">Документация: {definition.documentation}</small>
        {(error || driver?.error) && <div role="alert" className="form-message error">{error || driver?.error}</div>}
      </section></div>
      <div className="driver-catalog-footer"><label className="checkbox-row"><input type="checkbox" checked={state?.automatic ?? true} onChange={event => void act(() => window.studio.drivers.automatic(event.target.checked))} />Проверять при запуске и каждый час</label>{state?.checkedAt && <small>Каталог проверен: {new Date(state.checkedAt).toLocaleString('ru')}</small>}{state?.error && <div role="alert" className="form-message error">{state.error}</div>}<button className="button secondary" disabled={state?.checking || !!state?.configuring} onClick={() => void act(() => window.studio.drivers.check())}><RefreshCw size={14} className={state?.checking ? 'spin' : ''} />Проверить версии драйверов</button></div>
    </DriverDialog>}
  </>;
}
function DriverSourceSettings({ id, driver, busy, configuring }: { id: string; driver?: DriverStatus; busy: boolean; configuring: boolean }) {
  const definition = driverDefinition(id);
  const [url, setURL] = useState(driver?.updateSource?.url ?? '');
  const [driverClass, setDriverClass] = useState(driver?.updateSource?.driverClass ?? definition.className);
  const [error, setError] = useState('');
  useEffect(() => { setURL(driver?.updateSource?.url ?? ''); setDriverClass(driver?.updateSource?.driverClass ?? definition.className); }, [driver?.updateSource?.url, driver?.updateSource?.driverClass, definition.className]);
  const configure = async (remove = false) => {
    setError('');
    try { await window.studio.drivers.configureSource(id, remove ? null : { url: url.trim(), driverClass: driverClass.trim() }); }
    catch (error) { setError((error as Error).message); }
  };
  return <div className="driver-source-settings">
    <h4>Источник обновлений</h4>
    <small>{driver?.updateSource ? 'Подключён отдельный источник версий. Уведомления действуют и для импортированных JAR.' : definition.maven ? 'По умолчанию используется проверяемый каталог Maven Central. Можно указать другой источник.' : 'Автопроверка станет доступна после подключения JSON-манифеста производителя или вашей команды.'}</small>
    <label>HTTPS URL манифеста<input aria-label="HTTPS URL манифеста драйвера" value={url} onChange={event => setURL(event.target.value)} placeholder="https://updates.example.org/jdbc/driver.json" spellCheck={false} /></label>
    <label>Driver class комплекта<input aria-label="Driver class источника" value={driverClass} onChange={event => setDriverClass(event.target.value)} spellCheck={false} /></label>
    <small>Класс должен совпадать с Advanced подключения. JAR и зависимости проверяются перед установкой. Нужен HTTPS-доступ без токена; поддерживаются системные proxy и сертификаты.</small>
    <div className="driver-actions"><button className="button secondary" disabled={busy || !url.trim() || !driverClass.trim()} onClick={() => void configure()}>{configuring ? 'Проверка источника…' : 'Сохранить и проверить источник'}</button>{driver?.updateSource && <button className="button secondary" disabled={busy} onClick={() => void configure(true)}>Удалить источник</button>}</div>
    {driver?.checkedAt && <small>Источник проверен: {new Date(driver.checkedAt).toLocaleString('ru')}</small>}
    <details><summary>Формат манифеста</summary><small>revision — возрастающее целое число. Укажите полный комплект JAR в порядке classpath, точный размер в байтах и SHA256 каждого файла.</small><pre>{JSON.stringify({ format: 1, driverId: id, driverClass: driverClass || 'com.vendor.jdbc.Driver', revision: 1, version: '1.0.0', files: [{ url: 'https://updates.example.org/jdbc/driver-1.0.0.jar', size: 12345, sha256: '<SHA256 файла: 64 символа>' }] }, null, 2)}</pre></details>
    {(error || driver?.sourceError) && <div role="alert" className="form-message error">{error || driver?.sourceError}</div>}
  </div>;
}
function DriverDialog({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="driver-dialog" onCancel={onClose}>{children}</dialog>;
}
