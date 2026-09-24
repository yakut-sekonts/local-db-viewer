import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { Profile } from './shared';
import type { ObjectSource, SourceIndex } from './sources';

export function SourcesDialog({ profile, catalog, schema, onClose, onOpen }: {
  profile: Profile; catalog: string; schema: string; onClose(): void; onOpen(source: ObjectSource): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0);
  const [context, setContext] = useState({ catalog, schema });
  const [index, setIndex] = useState<SourceIndex>();
  const [selected, setSelected] = useState(''), [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const objects = index?.objects.filter(object => `${object.kind} ${object.name}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const source = objects.find(object => object.id === selected) ?? objects[0];
  async function load(refresh: boolean) {
    const current = ++generation.current;
    setBusy(true); setError(''); setIndex(undefined);
    try {
      const result = await window.studio.sources.load({ profileId: profile.id, ...context, refresh });
      if (generation.current === current) setIndex(result);
    } catch (error) { if (generation.current === current) setError((error as Error).message); }
    finally { if (generation.current === current) setBusy(false); }
  }
  useEffect(() => { dialog.current?.showModal(); void load(false); return () => { generation.current++; }; }, []);
  function change(values: Partial<typeof context>) { setContext(value => ({ ...value, ...values })); setIndex(undefined); setError(''); }
  return <dialog ref={dialog} className="connection-dialog sources-dialog" onCancel={onClose}>
    <div className="dialog-heading"><div><h2>Исходники объектов</h2><p>{profile.name} · views, routines, triggers</p></div><button className="icon-button close-dialog" aria-label="Закрыть исходники" onClick={onClose}><X size={18} /></button></div>
    <div className="dialog-body">
      <div className="form-row"><label>Catalog<input value={context.catalog} disabled={busy} onChange={event => change({ catalog: event.target.value })} /></label><label>Schema<input value={context.schema} disabled={busy} onChange={event => change({ schema: event.target.value })} /></label><button className="button secondary" disabled={busy} onClick={() => void load(true)}><RefreshCw size={14} />Обновить исходники</button></div>
      {error && <div role="alert" className="form-message error">{error}</div>}
      {index?.warnings.map((warning, i) => <small key={i}>{warning}</small>)}
      <label>Поиск объекта<input value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <div className="sources-layout" aria-busy={busy}>
        <div className="sources-list" role="list" aria-label="Объекты с исходниками">{objects.map(object => <button key={object.id} aria-pressed={source?.id === object.id} onClick={() => setSelected(object.id)}><span>{object.name}</span><small>{object.kind}</small></button>)}{!objects.length && <p>{busy ? 'Загрузка…' : index?.skipped ? 'Загрузка недоступна для выбранного контекста или отключена фильтром schemas.' : 'Объекты не найдены.'}</p>}</div>
        <textarea aria-label="SQL исходника" readOnly spellCheck={false} value={source ? source.sql ?? 'Определение недоступно: проверьте права подключения и шифрование объекта.' : ''} />
      </div>
      <small>Только чтение. Открытие в консоли не выполняет SQL. Кэш хранится в памяти до 5 минут; «Обновить исходники» перечитывает сервер.</small>
    </div>
    <div className="dialog-footer"><span className="muted">{index ? `${index.objects.length} объектов · ${new Date(index.loadedAt).toLocaleTimeString()}` : ''}</span><div className="spacer" /><button className="button primary" disabled={busy || !source?.sql} onClick={() => { if (source?.sql) onOpen(source); }}>Открыть в SQL-консоли</button></div>
  </dialog>;
}
