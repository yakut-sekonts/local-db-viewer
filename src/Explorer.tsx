import { useEffect, useState } from 'react';
import { ChevronRight, Database, Folder, Table2, Columns3, LoaderCircle, ArrowUpRight, RefreshCw, Search, Plus, Check } from 'lucide-react';
import { ENGINES, type Profile } from './shared';

interface NodeProps { profileId: string; kind: 'schemas' | 'tables' | 'columns'; name: string; catalog: string; schema?: string; table?: string; onPreview(catalog: string, schema: string, table: string): void; onSelectSchema(catalog: string, schema: string): void }
function TreeNode(props: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<unknown[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const Icon = props.kind === 'schemas' ? Database : props.kind === 'tables' ? Folder : Table2;
  async function toggle() {
    setExpanded(!expanded);
    if (children || busy || expanded) return;
    setBusy(true); setError('');
    try {
      const result = await window.studio.metadata({ profileId: props.profileId, kind: props.kind, catalog: props.catalog, schema: props.schema, table: props.table });
      setChildren(result.rows); setTruncated(result.truncated);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="tree-branch">
    <div className={`tree-row ${props.kind}`}>
      <button className="tree-node" onClick={() => void toggle()} aria-expanded={expanded} title={props.name}><ChevronRight className={expanded ? 'expanded' : ''} size={13} /><Icon size={15} /><span>{props.name}</span>{busy && <LoaderCircle size={13} className="spin" />}</button>
      {props.kind === 'tables' && <button className="preview-table icon-button" aria-label={`Выбрать schema ${props.name}`} title="Выбрать schema для запроса и автодополнения" onClick={() => props.onSelectSchema(props.catalog, props.schema!)}><Check size={13} /></button>}
      {props.kind === 'columns' && <button className="preview-table icon-button" aria-label={`Открыть SELECT ${props.name}`} onClick={() => props.onPreview(props.catalog, props.schema!, props.table!)}><ArrowUpRight size={13} /></button>}
    </div>
    {expanded && <div className="tree-children">
      {error && <p className="tree-error">{error}<button onClick={() => { setExpanded(false); setError(''); }}>Повторить</button></p>}
      {!busy && !error && children?.length === 0 && <p className="tree-empty">Нет объектов</p>}
      {truncated && <p className="tree-empty">Список ограничен 10 000 строк / 8 MB</p>}
      {children?.map((row, index) => props.kind === 'columns' ? <div className="column-node" key={index} title={`${row[0]} · ${row[1]}`}><Columns3 size={12} /><span>{String(row[0])}</span><small>{String(row[1])}</small></div>
        : <TreeNode key={String(row[0])} {...props} kind={props.kind === 'schemas' ? 'tables' : 'columns'} name={String(row[0])} schema={props.kind === 'schemas' ? String(row[0]) : props.schema} table={props.kind === 'tables' ? String(row[0]) : undefined} />)}
    </div>}
  </div>;
}

export function Explorer({ profile, onAdd, onPreview, onSelectSchema, onRefresh }: { profile?: Profile; onAdd(): void; onPreview(catalog: string, schema: string, table: string): void; onSelectSchema(catalog: string, schema: string): void; onRefresh(): void }) {
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let disposed = false;
    setCatalogs([]); setError(''); setFilter(''); setTruncated(false);
    if (!profile) { setBusy(false); return; }
    setBusy(true);
    void window.studio.metadata({ profileId: profile.id, kind: 'catalogs' }).then(result => {
      if (disposed) return;
      const names = result.rows.map(row => String(row[0]));
      setCatalogs(names); setTruncated(result.truncated);
    }).catch(error => { if (!disposed) setError(error.message); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [profile, revision]);
  return <>
    <div className="panel-heading"><span>Database Explorer</span><div><button className="icon-button" aria-label="Обновить дерево" disabled={!profile || busy} onClick={() => { setRevision(value => value + 1); onRefresh(); }}><RefreshCw size={14} className={busy ? 'spin' : ''} /></button><button className="icon-button" aria-label="Добавить подключение" onClick={onAdd}><Plus size={17} /></button></div></div>
    <label className="explorer-search"><Search size={14} /><input placeholder="Фильтр catalog…" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <div className="explorer-content">
      {!profile ? <div className="explorer-empty"><Database size={28} strokeWidth={1.2} /><h3>Ваши данные — здесь</h3><p>Подключите базу данных,<br />чтобы открыть schemas и tables.</p><button className="button secondary" onClick={onAdd}><Plus size={14} />Подключение</button></div>
        : <><div className="connection-root"><div className="connection-mark"><Database size={15} /></div><div><strong>{profile.name}</strong><small>{profile.engine === 'sqlite' ? 'Локальный файл' : new URL(profile.endpoint).host}</small></div><span className="engine-tag">{ENGINES[profile.engine].name}</span></div>
        {busy && <div className="tree-loading"><LoaderCircle size={14} className="spin" />Загрузка catalogs…</div>}
        {error && <div role="alert" className="explorer-error">{error}<button className="button secondary" onClick={() => { setRevision(value => value + 1); onRefresh(); }}>Повторить</button></div>}
        {truncated && <p className="tree-empty">Список catalogs ограничен</p>}
        {catalogs.filter(name => name.toLowerCase().includes(filter.toLowerCase())).map(name => <TreeNode key={`${revision}:${profile.id}:${name}`} profileId={profile.id} kind="schemas" catalog={name} name={name} onPreview={onPreview} onSelectSchema={onSelectSchema} />)}
        {!busy && !error && !catalogs.length && <p className="tree-empty">Нет доступных catalogs</p>}</>}
    </div>
    <div className="sidebar-foot"><span className="tiny-square" />Объекты загружаются по запросу</div>
  </>;
}
