import { useEffect, useRef, useState } from 'react';
import { Database, History, Settings2, Plus, Play, Square, X, Terminal, ChevronDown, FolderOpen, Save, Command, Activity, Circle, PanelLeftClose, Folder, Files, Menu, ChevronRight, Link2, RefreshCw, Unplug } from 'lucide-react';
import { SqlEditor, type EditorHandle } from './Editor';
import { DriverCenter } from './DriverCenter';
import { productName } from './drivers';
import { UpdateCenter } from './UpdateCenter';
import { DdlDialog } from './DdlDialog';
import { ConnectionDialog } from './ConnectionDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { Explorer } from './Explorer';
import { Results } from './Results';
import { useSchema } from './useSchema';
import { RelationshipsDialog } from './RelationshipsDialog';
import { ENGINES, type Profile, type QuerySnapshot, type SchemaIndex } from './shared';
import { previewSQL } from '../electron/sql';

interface Tab { ddlMappingId?: string; templateId?: string; id: string; name: string; sql: string; profileId: string; catalog: string; schema: string; result?: QuerySnapshot }
interface HistoryItem { id: string; sql: string; profileId: string; profileName: string; catalog: string; schema: string; state: string; time: number; duration: number }
const INITIAL_SQL = '-- Local DB Viewer\n-- Выберите подключение: ⌘ / Ctrl + Enter выполняет запрос\n\nSELECT 1 AS connected;\n';
const newTab = (profile?: Profile, sql = INITIAL_SQL, name = 'console.sql'): Tab => ({ id: crypto.randomUUID(), name, sql, profileId: profile?.id ?? '', catalog: profile?.catalog ?? '', schema: profile?.schema ?? '' });
function restoreTabs(): [Tab, ...Tab[]] {
  try {
    const items = JSON.parse(localStorage.getItem('studio.tabs') ?? '[]');
    if (Array.isArray(items)) {
      const valid = items.filter((item: any) => ['name', 'sql', 'profileId', 'catalog', 'schema'].every(key => typeof item?.[key] === 'string') && item.sql.length <= 1_000_000).slice(0, 20);
      const restored: Tab[] = valid.map((item: Tab) => ({ id: crypto.randomUUID(), name: item.name, sql: item.sql, profileId: item.profileId, catalog: item.catalog, schema: item.schema, templateId: typeof item.templateId === 'string' ? item.templateId : undefined, ddlMappingId: typeof item.ddlMappingId === 'string' ? item.ddlMappingId : undefined }));
      const [first, ...rest] = restored;
      if (first) return [first, ...rest];
    }
  } catch { /* Invalid draft data must not prevent opening the workspace. */ }
  return [newTab()];
}
function restoreHistory(): HistoryItem[] {
  try {
    const data = JSON.parse(localStorage.getItem('studio.history') ?? '[]');
    return Array.isArray(data) ? data.filter(item => ['id', 'sql', 'profileId', 'profileName', 'catalog', 'schema', 'state'].every(name => typeof item?.[name] === 'string') && typeof item.time === 'number' && Number.isFinite(item.time) && typeof item.duration === 'number').slice(0, 100) : [];
  } catch { return []; }
}
const labelState = (state?: string) => ({ RUNNING: 'Выполняется', FINISHED: 'Готово', FAILED: 'Ошибка', CANCELED: 'Отменён' })[state ?? ''] ?? 'Готов к работе';
const bytes = (value = 0): string => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;

export function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, storeTabs] = useState<[Tab, ...Tab[]]>(restoreTabs);
  const setTabs = (value: Tab[] | ((tabs: Tab[]) => Tab[])) => storeTabs(previous => {
    const result = typeof value === 'function' ? value(previous) : value;
    const [first, ...rest] = result;
    return first ? [first, ...rest] : [newTab()];
  });
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [history, setHistory] = useState<HistoryItem[]>(restoreHistory);
  const [panel, setPanel] = useState<'database' | 'history'>('database');
  const [sidebar, setSidebar] = useState(true);
  const [filesPanel, setFilesPanel] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(225);
  const [filesWidth, setFilesWidth] = useState(235);
  const [servicesHeight, setServicesHeight] = useState(Math.round(window.innerHeight * 0.34));
  const [dialog, setDialog] = useState<{ profile?: Profile } | null>(null);
  const [ddlDialog, setDdlDialog] = useState(false);
  const [error, setError] = useState('');
  const [schemaRevision, setSchemaRevision] = useState(0);
  const [relationsDialog, setRelationsDialog] = useState<SchemaIndex>();
  const [maxRows, setMaxRows] = useState(1000);
  const editor = useRef<EditorHandle>(null);
  const tabsRef = useRef(tabs);
  const profilesRef = useRef(profiles);
  tabsRef.current = tabs; profilesRef.current = profiles;
  const requests = useRef(new Map<string, { tabId: string; sql: string; profileId: string; catalog: string; schema: string }>());
  const tab = tabs.find(item => item.id === activeId) ?? tabs[0];
  const profile = profiles.find(item => item.id === tab.profileId);
  const running = tab.result?.state === 'RUNNING';
  const completion = useSchema(profile, tab.catalog, tab.schema, schemaRevision, tab.ddlMappingId);

  useEffect(() => { void window.studio.profiles.list().then(setProfiles).catch(error => setError(error.message)); }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem('studio.tabs', JSON.stringify(tabs.map(({ result: _, ...tab }) => tab))); }
      catch { setError('Не удалось сохранить SQL-черновики. Сохраните нужные запросы в .sql.'); }
    }, 500);
    return () => clearTimeout(timer);
  }, [tabs]);
  useEffect(() => {
    try { localStorage.setItem('studio.history', JSON.stringify(history)); }
    catch { setError('Не удалось сохранить историю запросов.'); }
  }, [history]);
  useEffect(() => window.studio.query.onUpdate(result => {
    const request = requests.current.get(result.requestId);
    if (!request) return;
    setTabs(items => items.map(item => item.id === request.tabId ? { ...item, result, catalog: result.catalog ?? item.catalog, schema: result.schema ?? item.schema } : item));
    if (result.state !== 'RUNNING') {
      const profileName = profilesRef.current.find(item => item.id === request.profileId)?.name ?? 'Trino';
      setHistory(items => [{ id: crypto.randomUUID(), sql: request.sql, profileId: request.profileId, profileName, catalog: request.catalog, schema: request.schema, time: Date.now(), state: result.state, duration: result.stats.elapsedTimeMillis ?? 0 }, ...items].slice(0, 100));
      requests.current.delete(result.requestId);
    }
  }), []);
  const updateTab = (values: Partial<Tab>) => setTabs(items => items.map(item => item.id === tab.id ? { ...item, ...values } : item));

  function addTab(sql = INITIAL_SQL, name?: string, selectedProfile = profile, context?: { catalog: string; schema: string; ddlMappingId?: string }) {
    if (tabsRef.current.length >= 20) { setError('Доступно до 20 консолей. Закройте ненужную вкладку.'); return; }
    const item = { ...newTab(selectedProfile, sql, name ?? `console-${tabsRef.current.length + 1}.sql`), ...context };
    setTabs(items => [...items, item]); setActiveId(item.id);
  }
  async function closeTab(item: Tab) {
    try {
      await window.studio.query.release(item.id);
      const remaining = tabsRef.current.filter(other => other.id !== item.id);
      if (!remaining.length) remaining.push(newTab(profile));
      setTabs(remaining);
      if (activeId === item.id) setActiveId(remaining.at(-1)?.id ?? '');
    } catch (error) { setError((error as Error).message); }
  }
  async function selectProfile(id: string) {
    try {
      await window.studio.query.release(tab.id, true);
      const next = profiles.find(item => item.id === id);
      updateTab({ ddlMappingId: undefined, templateId: undefined, profileId: id, catalog: next?.catalog ?? '', schema: next?.schema ?? '', result: undefined });
    } catch (error) { setError((error as Error).message); }
  }
  async function run(sql: string) {
    if (running || [...requests.current.values()].some(request => request.tabId === tab.id)) return;
    if (!profile) { setDialog({}); return; }
    if (!sql.trim()) return;
    const requestId = crypto.randomUUID();
    const result: QuerySnapshot = { requestId, queryId: '', state: 'RUNNING', rows: [], columns: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: tab.result?.inTransaction ?? false };
    requests.current.set(requestId, { tabId: tab.id, sql, profileId: profile.id, catalog: tab.catalog, schema: tab.schema });
    updateTab({ result }); setError('');
    try { await window.studio.query.run({ requestId, sessionId: tab.id, profileId: profile.id, templateId: tab.templateId, ddlMappingId: tab.ddlMappingId, sql, catalog: tab.catalog, schema: tab.schema, maxRows }); }
    catch (error) {
      requests.current.delete(requestId);
      setTabs(items => items.map(item => item.id === tab.id ? { ...item, result: { ...result, state: 'FAILED', error: (error as Error).message } } : item));
    }
  }
  async function saveSQL() { try { await window.studio.files.save(tab.sql); } catch (error) { setError((error as Error).message); } }
  async function openSQL() {
    try { const file = await window.studio.files.open(); if (file) addTab(file.sql, file.name); }
    catch (error) { setError((error as Error).message); }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || dialog || ddlDialog || relationsDialog) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveSQL(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openSQL(); }
      if (event.key.toLowerCase() === 't') { event.preventDefault(); addTab(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });

  function resize(event: React.PointerEvent, axis: 'x' | 'y', initial: number, direction: number, setter: (value: number) => void) {
    event.preventDefault();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const move = (next: PointerEvent) => setter(Math.max(axis === 'x' ? 165 : 180, Math.min(axis === 'x' ? 430 : window.innerHeight * 0.65, initial + ((axis === 'x' ? next.clientX : next.clientY) - start) * direction)));
    const done = () => { window.removeEventListener('pointermove', move); document.body.style.cursor = ''; };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', done, { once: true });
  }
  return <div className="app-shell">
    <header className="titlebar"><div className="window-controls-space" /><button className="icon-button" aria-label="Показать Database Explorer" onClick={() => setSidebar(!sidebar)}><Menu size={18} /></button><div className="brand"><span className="brand-mark">DB</span>Local DB Viewer</div><div className="title-divider" /><span className="workspace-name">Database workspace</span><div className="spacer" /><button className="icon-button" aria-label="Database Explorer" onClick={() => { setPanel('database'); setSidebar(true); }}><Database size={18} /></button><button className="icon-button" aria-label="История запросов" onClick={() => { setPanel('history'); setSidebar(true); }}><History size={18} /></button><button className="icon-button" aria-label="Панель Files" onClick={() => setFilesPanel(!filesPanel)}><Files size={18} /></button><button className="icon-button" aria-label="Настройки подключения" onClick={() => setDialog({ profile })}><Settings2 size={18} /></button><button className="icon-button" aria-label="DDL mappings" title="DDL mappings" onClick={() => setDdlDialog(true)}><FolderOpen size={18} /></button><DriverCenter /><UpdateCenter beforeRestart={() => {
      if (requests.current.size || tabsRef.current.some(item => item.result?.inTransaction)) throw new Error('Завершите запросы и транзакции перед обновлением.');
      localStorage.setItem('studio.tabs', JSON.stringify(tabsRef.current.map(({ result: _, ...item }) => item)));
      localStorage.setItem('studio.history', JSON.stringify(history));
    }} /></header>
    <div className="app-body" style={{ gridTemplateColumns: `${sidebar ? sidebarWidth : 0}px ${sidebar ? 3 : 0}px minmax(360px, 1fr) ${filesPanel ? 3 : 0}px ${filesPanel ? filesWidth : 0}px`, gridTemplateRows: `minmax(230px, 1fr) 4px ${servicesHeight}px` }}>
      {sidebar && <aside className="sidebar">{panel === 'database' ? tab.ddlMappingId ? <><div className="panel-heading">DDL · локальные файлы</div><div className="ddl-local-tree">{completion.index?.tables.map(table => <details key={JSON.stringify([table.catalog,table.schema,table.name])}><summary>{table.name}</summary>{table.columns.map(column => <div key={column.name}>{column.name} <small>{column.type}</small></div>)}</details>)}</div><button className="button secondary" onClick={() => setDdlDialog(true)}>DDL mappings</button></> : <ErrorBoundary resetKey={profile?.id} retry><Explorer profile={profile} onAdd={() => setDialog({})} onSelectSchema={(catalog, schema) => { if (!running && !tab.result?.inTransaction) updateTab({ catalog, schema }); }} onRefresh={() => setSchemaRevision(value => value + 1)} onPreview={(catalog, schema, table) => {
        if (profile!.engine === 'jdbc') void window.studio.jdbc.preview({ profileId: profile!.id, kind: 'columns', catalog, schema, table }).then(sql => addTab(sql, `${table}.sql`, profile, { catalog, schema })).catch(error => setError(error.message));
        else addTab(previewSQL(profile!.engine, catalog, schema, table), `${table}.sql`, profile, { catalog, schema });
      }} /></ErrorBoundary> : <><div className="panel-heading"><span>ИСТОРИЯ ЗАПРОСОВ</span><span className="count">{history.length}</span></div><div className="history-list">{!history.length && <div className="explorer-empty"><History size={27} /><h3>Каждый запрос под рукой</h3><p>Здесь будут последние 100<br />выполненных запросов.</p></div>}{history.map(item => <button key={item.id} className="history-item" onClick={() => addTab(item.sql, 'history.sql', profiles.find(profile => profile.id === item.profileId), { catalog: item.catalog, schema: item.schema })}><div><span className={`history-dot ${item.state.toLowerCase()}`} /><strong>{item.profileName}</strong><time>{new Date(item.time).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time></div><code>{item.sql}</code><small>{labelState(item.state)} · {(item.duration / 1000).toFixed(2)} s</small></button>)}</div><div className="sidebar-foot">Нажмите запрос, чтобы открыть в консоли</div></>}</aside>}
      {sidebar && <div className="pane-splitter left-splitter" role="separator" aria-label="Ширина Database Explorer" onPointerDown={event => resize(event, 'x', sidebarWidth, 1, setSidebarWidth)} />}
      <main className="workspace">
        <div className="tabbar"><button className="icon-button sidebar-toggle" title="Свернуть / развернуть боковую панель" onClick={() => setSidebar(!sidebar)}><PanelLeftClose size={16} /></button><div className="tabs" role="tablist">{tabs.map(item => <div key={item.id} className={`console-tab ${item.id === tab.id ? 'active' : ''}`}><button role="tab" aria-selected={item.id === tab.id} onClick={() => setActiveId(item.id)}><Terminal size={14} /><span>{item.name}</span>{item.result?.state === 'RUNNING' && <span className="running-dot" />}</button><button className="close-tab" disabled={item.result?.state === 'RUNNING'} aria-label={`Закрыть ${item.name}`} title={item.result?.inTransaction ? 'Закрыть консоль и выполнить ROLLBACK' : 'Закрыть консоль'} onClick={() => void closeTab(item)}><X size={12} /></button></div>)}</div><button className="icon-button new-tab" aria-label="Новая консоль" onClick={() => addTab()}><Plus size={17} /></button><div className="spacer" /><button className="icon-button" aria-label="Открыть SQL-файл" onClick={() => void openSQL()}><FolderOpen size={15} /></button><button className="icon-button" aria-label="Сохранить SQL-файл" onClick={() => void saveSQL()}><Save size={15} /></button></div>
        <div className="query-toolbar"><div className="connection-select"><Database size={14} /><select aria-label="Подключение" value={profile?.id ?? ''} disabled={running || tab.result?.inTransaction} onChange={event => void selectProfile(event.target.value)}><option value="">Выберите подключение</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={12} /></div>{Boolean(profile?.jdbc?.sessionTemplates?.length) && <select className="session-template-select" aria-label="Шаблон SQL-сессии" value={tab.templateId ?? '@default'} disabled={running || tab.result?.inTransaction} onChange={event => { const id = event.target.value; void window.studio.query.release(tab.id, true).then(() => updateTab({ templateId: id === '@default' ? undefined : id, result: undefined })).catch(error => setError(error.message)); }}><option value="@default">Шаблон по умолчанию</option><option value="">Настройки подключения</option>{profile?.jdbc?.sessionTemplates?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<div className="toolbar-separator" /><label className="context-input"><span>{profile?.engine === 'trino' ? 'catalog' : 'database'}</span><input aria-label="Catalog" placeholder="по умолчанию" value={tab.catalog} disabled={running || !!tab.ddlMappingId || (profile && ['postgres', 'sqlite', 'mssql'].includes(profile.engine))} onChange={event => updateTab({ catalog: event.target.value })} /></label><span className="context-slash">/</span><label className="context-input"><span>schema</span><input aria-label="Schema" placeholder="по умолчанию" value={tab.schema} disabled={running || !!tab.ddlMappingId || tab.result?.inTransaction || (profile && !['trino', 'postgres', 'mssql', 'jdbc'].includes(profile.engine))} onChange={event => updateTab({ schema: event.target.value })} /></label><button className="icon-button" aria-label="Отключить сессию" title="Отключить сессию, сохранив SQL в консоли" disabled={running || tab.result?.inTransaction} onClick={() => void window.studio.query.release(tab.id, true).then(() => updateTab({ result: undefined })).catch(error => setError(error.message))}><Unplug size={14} /></button><div className="spacer" />{running ? <button className="button cancel-button" onClick={() => void window.studio.query.cancel(tab.result!.requestId).catch(error => setError(error.message))}><Square size={12} fill="currentColor" />Отменить</button> : <button className="button run-button" onClick={() => void run(editor.current?.selection() ?? tab.sql)}><Play size={13} fill="currentColor" />Выполнить<kbd>Ctrl / ⌘ ↵</kbd></button>}</div>
        {error && <div role="alert" className="global-error"><span>{error}</span><button className="icon-button" aria-label="Скрыть сообщение" onClick={() => setError('')}><X size={14} /></button></div>}
        {!profiles.length && <div className="welcome-banner"><div><span className="eyebrow">ВАШ НОВЫЙ SQL WORKSPACE</span><h1>От подключения — к данным.</h1><p>Catalogs, SQL и результаты в одном окне.</p></div><button className="button secondary" onClick={() => setDialog({})}><Plus size={15} />Подключить базу</button></div>}
        <div className="editor-pane"><SqlEditor key={tab.id} ref={editor} value={tab.sql} onChange={sql => updateTab({ sql })} onRun={sql => void run(sql)} engine={profile?.engine ?? 'trino'} getSchema={completion.forQuery} /></div>
        <div className="editor-footer"><span><Circle size={7} fill="currentColor" />{profile ? productName(profile) : 'SQL'}</span><span>UTF-8</span><button className="completion-status" title={completion.status || "Автодополнение колонок и JOIN: Ctrl + Space"} onClick={() => { if (completion.status) setError(completion.status); }}>{completion.busy ? "Индексирование…" : completion.status ? "Метаданные: есть замечания" : completion.index ? `${tab.ddlMappingId ? "DDL · " : ""}${completion.index.tables.length} tables · ${completion.index.relationships.length} links` : "Ctrl + Space"}</button><button className="icon-button" aria-label="Обновить автодополнение" disabled={!profile || completion.busy} onClick={() => setSchemaRevision(value => value + 1)}><RefreshCw size={12} /></button><button className="icon-button" aria-label="Связи таблиц" title="Foreign keys и виртуальные связи" disabled={!completion.index || !!tab.ddlMappingId} onClick={() => setRelationsDialog(completion.index)}><Link2 size={14} /></button><div className="spacer" /><label>Сохранять строк<select aria-label="Лимит строк" value={maxRows} disabled={running} onChange={event => setMaxRows(Number(event.target.value))}><option value={100}>100</option><option value={1000}>1 000</option><option value={5000}>5 000</option><option value={10000}>10 000</option></select></label></div>
      </main>
      {filesPanel && <><div className="pane-splitter right-splitter" role="separator" aria-label="Ширина Files" onPointerDown={event => resize(event, 'x', filesWidth, -1, setFilesWidth)} /><aside className="files-panel"><div className="panel-heading"><span>Files</span><div><button className="icon-button" aria-label="Открыть файл из Files" onClick={() => void openSQL()}><FolderOpen size={15} /></button><button className="icon-button" aria-label="Скрыть Files" onClick={() => setFilesPanel(false)}><X size={14} /></button></div></div><div className="files-tree"><div className="files-root"><Folder size={15} /><span>Local DB Viewer</span></div><details open><summary><Folder size={14} />Scratches and Consoles</summary><details open><summary><Terminal size={14} />Database Consoles</summary>{tabs.map(item => <button key={item.id} className={`file-node ${item.id === tab.id ? 'active' : ''}`} onClick={() => setActiveId(item.id)}><Terminal size={13} /><span>{item.name}</span></button>)}</details></details></div><div className="spacer" /><button className="files-new-console" onClick={() => addTab()}><Plus size={14} />Новая SQL-консоль</button></aside></>}
      <div className="pane-splitter horizontal-splitter" role="separator" aria-label="Высота Services" onPointerDown={event => resize(event, 'y', servicesHeight, -1, setServicesHeight)} />
      <section className="services-panel"><div className="services-heading"><span>Services</span><div className="spacer" /><span>{tabs.filter(item => item.result).length} consoles</span></div><div className="services-body"><aside className="services-list" style={{ width: sidebar ? sidebarWidth : 170 }}><div className="services-list-toolbar"><span>Tx</span><button className="icon-button" aria-label="Новая консоль в Services" onClick={() => addTab()}><Plus size={15} /></button><span className="muted">Sessions</span></div>{tabs.map(item => <button key={item.id} className={`service-item ${item.id === tab.id ? 'active' : ''}`} onClick={() => setActiveId(item.id)}><Terminal size={13} /><span>{item.name}</span><span className={`service-status ${(item.result?.state ?? '').toLowerCase()}`} /></button>)}</aside><Results result={tab.result} onError={setError} /></div></section>
    </div>
    <footer className="statusbar"><div className={`status-indicator ${running ? 'busy' : ''}`} /><span>{labelState(tab.result?.state)}</span>{tab.result?.stats.state && running && <span className="muted">{tab.result.stats.state}</span>}<div className="status-divider" /><Activity size={12} /><span>{((tab.result?.stats.elapsedTimeMillis ?? 0) / 1000).toFixed(2)} s</span><span className="muted">·</span><span>{bytes(tab.result?.stats.processedBytes)} прочитано</span><div className="spacer" />{tab.result?.inTransaction && <span className="transaction-label">TRANSACTION OPEN</span>}<span className="muted">{profile ? `${profile.user} @ ${profile.name}` : 'Нет подключения'}</span><div className="status-divider" /><Command size={12} /><span>Local DB Viewer</span></footer>
    {ddlDialog && <DdlDialog profiles={profiles} profile={profile} onClose={() => setDdlDialog(false)} onOpen={(mapping, sql, name) => { const selectedProfile = profiles.find(item => item.id === mapping.profileId); if (!selectedProfile) { setDdlDialog(false); setError('Подключение DDL mapping удалено. Выберите существующее подключение в настройках mapping.'); return; } addTab(sql, name, selectedProfile, { catalog: mapping.catalog, schema: mapping.schema, ddlMappingId: mapping.id }); setDdlDialog(false); setSchemaRevision(value => value + 1); }} />}
    {relationsDialog && <RelationshipsDialog index={relationsDialog} onClose={() => setRelationsDialog(undefined)} onChanged={() => setSchemaRevision(value => value + 1)} />}
    {dialog && <ConnectionDialog profile={dialog.profile} onClose={() => setDialog(null)} onSaved={saved => {
      setProfiles(items => [...items.filter(item => item.id !== saved.id), saved]);
      if (!profile) updateTab({ profileId: saved.id, catalog: saved.catalog, schema: saved.schema });
      setDialog(null);
    }} onDeleted={id => { setProfiles(items => items.filter(item => item.id !== id)); setTabs(items => items.map(item => item.profileId === id ? { ...item, profileId: '', result: undefined } : item)); setDialog(null); }} />}
  </div>;
}
