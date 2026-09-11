import { useEffect, useRef, useState } from 'react';
import { Link2, Plus, Trash2, X } from 'lucide-react';
import type { Relationship, SchemaIndex, TableRef } from './shared';
import { tableKey } from './completion';

const reference = (table: TableRef): TableRef => ({ catalog: table.catalog, schema: table.schema, name: table.name });
export function RelationshipsDialog({ index, onClose, onChanged }: { index: SchemaIndex; onClose(): void; onChanged(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tables, setTables] = useState(index.tables);
  const [relations, setRelations] = useState(index.relationships);
  const [sourceKey, setSourceKey] = useState(index.tables[0] ? tableKey(index.tables[0]) : '');
  const [targetKey, setTargetKey] = useState(index.tables[1] ? tableKey(index.tables[1]) : '');
  const [columns, setColumns] = useState([{ source: '', target: '' }]);
  const [name, setName] = useState('');
  const [catalog, setCatalog] = useState(index.catalog);
  const [schema, setSchema] = useState(index.schema);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = tables.find(table => tableKey(table) === sourceKey);
  const target = tables.find(table => tableKey(table) === targetKey);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function save() {
    if (!source || !target || !columns.every(pair => source.columns.some(column => column.name === pair.source) && target.columns.some(column => column.name === pair.target))) { setError('Выберите таблицы и все пары колонок.'); return; }
    setBusy(true); setError('');
    try {
      const relation: Relationship = { id: crypto.randomUUID(), name: name.trim() || `${source.name}_${target.name}`, source: reference(source), target: reference(target), columns, kind: 'virtual' };
      await window.studio.schema.saveRelation(index.profileId, relation);
      setRelations(items => [...items, relation]); setName(''); setColumns([{ source: '', target: '' }]); onChanged();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError('');
    try { await window.studio.schema.removeRelation(index.profileId, id); setRelations(items => items.filter(item => item.id !== id)); onChanged(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function loadOther() {
    setBusy(true); setError('');
    try {
      const extra = await window.studio.schema.load({ profileId: index.profileId, catalog, schema });
      setTables(items => [...new Map([...items, ...extra.tables].map(table => [tableKey(table), table])).values()]);
      if (extra.warnings.length) setError(extra.warnings.join('\n'));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="connection-dialog relationships-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="dialog-heading"><div className="large-icon"><Link2 size={21} /></div><div><h2>Связи таблиц</h2><p>Foreign keys и виртуальные связи для автодополнения JOIN</p></div><button className="icon-button close-dialog" aria-label="Закрыть связи" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <div className="dialog-body">
      <p className="relation-note">Виртуальные связи хранятся в Local DB Viewer для этого подключения. Их можно использовать в JOIN; структура базы данных не меняется.</p>
      <div className="relation-list">{relations.length ? relations.map(relation => <div className="relation-item" key={relation.id}><Link2 size={14} /><div><strong>{relation.source.name} → {relation.target.name}</strong><small>{relation.kind === 'virtual' ? 'Виртуальная' : 'Foreign key'} · {relation.name}</small><code>{relation.columns.map(pair => `${pair.source} = ${pair.target}`).join(' AND ')}</code></div>{relation.kind === 'virtual' && <button className="icon-button danger" disabled={busy} aria-label={`Удалить связь ${relation.name}`} onClick={() => void remove(relation.id)}><Trash2 size={14} /></button>}</div>) : <p className="muted">Связи не найдены. Добавьте виртуальную связь ниже.</p>}</div>
      <details><summary>Добавить таблицы из другой schema</summary><div className="form-row extra-schema"><label>Catalog для связи<input value={catalog} onChange={event => setCatalog(event.target.value)} /></label><label>Schema для связи<input value={schema} onChange={event => setSchema(event.target.value)} /></label><button className="button secondary" disabled={busy} onClick={() => void loadOther()}>Загрузить</button></div></details>
      <div className="form-row"><label>Исходная таблица<select aria-label="Исходная таблица" value={sourceKey} onChange={event => { setSourceKey(event.target.value); setColumns([{ source: '', target: '' }]); }}><option value="">Выберите таблицу</option>{tables.map(table => <option key={tableKey(table)} value={tableKey(table)}>{table.catalog}.{table.schema}.{table.name}</option>)}</select></label><label>Связанная таблица<select aria-label="Связанная таблица" value={targetKey} onChange={event => { setTargetKey(event.target.value); setColumns([{ source: '', target: '' }]); }}><option value="">Выберите таблицу</option>{tables.map(table => <option key={tableKey(table)} value={tableKey(table)}>{table.catalog}.{table.schema}.{table.name}</option>)}</select></label></div>
      {columns.map((pair, position) => <div className="form-row relation-columns" key={position}><label>Исходная колонка {position + 1}<select aria-label={`Исходная колонка ${position + 1}`} value={pair.source} onChange={event => setColumns(items => items.map((item, i) => i === position ? { ...item, source: event.target.value } : item))}><option value="">Выберите колонку</option>{source?.columns.map(column => <option key={column.name}>{column.name}</option>)}</select></label><span>=</span><label>Связанная колонка {position + 1}<select aria-label={`Связанная колонка ${position + 1}`} value={pair.target} onChange={event => setColumns(items => items.map((item, i) => i === position ? { ...item, target: event.target.value } : item))}><option value="">Выберите колонку</option>{target?.columns.map(column => <option key={column.name}>{column.name}</option>)}</select></label>{columns.length > 1 && <button className="icon-button" aria-label={`Удалить пару ${position + 1}`} onClick={() => setColumns(items => items.filter((_, i) => i !== position))}><X size={14} /></button>}</div>)}
      <button className="button secondary add-column-pair" disabled={columns.length >= 32} onClick={() => setColumns(items => [...items, { source: '', target: '' }])}><Plus size={14} />Пара колонок для составного ключа</button>
      <label>Название связи<input value={name} onChange={event => setName(event.target.value)} placeholder="Необязательно" /></label>
      {error && <div role="alert" className="form-message error">{error}</div>}
    </div>
    <div className="dialog-footer"><span className="muted">Подсказки: Ctrl + Space · после alias. и JOIN</span><div className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}>Добавить связь</button></div>
  </dialog>;
}
