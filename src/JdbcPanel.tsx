import { useEffect, useState } from 'react';
import type { ProfileDraft } from './shared';
import { DRIVER_CLASSES, secretProperty, type JdbcProperty, type JdbcSettings } from './jdbc';

export function JdbcPanel({ draft, onChange, onError }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void }) {
  const [properties, setProperties] = useState<JdbcProperty[]>([]);
  const [search, setSearch] = useState('');
  const [customName, setCustomName] = useState('');
  const [busy, setBusy] = useState(false);
  const [environmentText, setEnvironmentText] = useState(() => Object.entries(draft.jdbc?.environment ?? {}).map(([name, value]) => `${name}=${value}`).join('\n'));
  const settings = draft.jdbc ?? {};
  const change = (values: Partial<JdbcSettings>) => onChange({ ...draft, jdbc: { ...settings, ...values } });
  const property = (name: string, value: string | undefined) => {
    const properties = { ...settings.properties };
    if (value === undefined) delete properties[name]; else properties[name] = value;
    change({ properties });
  };
  async function load() {
    setBusy(true);
    try { setProperties(await window.studio.jdbc.properties(draft)); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [draft.engine]);
  const names = [...new Set([...properties.map(item => item.name), ...Object.keys(settings.properties ?? {}), ...(draft.jdbcSecrets ?? [])])].sort();
  const help = new Map(properties.map(item => [item.name, item]));
  return <div className="jdbc-settings">
    <div className="jdbc-driver-heading"><strong>JDBC · {settings.driverClass || DRIVER_CLASSES[draft.engine]}</strong><button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Чтение…' : 'Обновить свойства'}</button></div>
    <input aria-label="Поиск JDBC-параметров" placeholder="Поиск: SSL, accessToken, Kerberos…" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="jdbc-properties"><div className="jdbc-property-header"><span>Name</span><span>Value</span></div>{names.filter(name => name.toLowerCase().includes(search.toLowerCase())).map(name => {
      const info = help.get(name); const saved = draft.jdbcSecrets?.includes(name);
      return <label key={name} className="jdbc-property" title={info?.description ?? name}><span>{name}{info?.required && ' *'}</span>{info?.choices?.length && !secretProperty(name) ? <select aria-label={name} value={settings.properties?.[name] ?? ''} onChange={event => property(name, event.target.value || undefined)}><option value="">По умолчанию{info.value ? `: ${info.value}` : ''}</option>{info.choices.map(value => <option key={value}>{value}</option>)}</select> : <input aria-label={name} type={secretProperty(name) ? 'password' : 'text'} autoComplete="off" value={settings.properties?.[name] ?? ''} placeholder={saved ? 'Сохранён · введите новое значение для замены' : info?.value ?? 'По умолчанию драйвера'} onChange={event => property(name, event.target.value)} />}</label>;
    })}</div>
    <div className="form-row"><input aria-label="Имя пользовательского JDBC-параметра" placeholder="Дополнительный параметр" value={customName} onChange={event => setCustomName(event.target.value)} /><button type="button" className="button secondary" disabled={!customName.trim()} onClick={() => { property(customName.trim(), ''); setSearch(customName.trim()); setCustomName(''); }}>Добавить</button></div>
    <small>Заданные значения передаются JDBC-драйверу напрямую и заменяют значения General. Параметры в JDBC URL имеют приоритет.</small>
    <label>JDBC URL <span>переопределяет General</span><input value={settings.url ?? ''} placeholder="jdbc:…" onChange={event => change({ url: event.target.value })} /></label>
    <label>Driver class<input value={settings.driverClass ?? ''} placeholder={DRIVER_CLASSES[draft.engine]} onChange={event => change({ driverClass: event.target.value })} /></label>
    <label>VM options <span>один аргумент на строку</span><textarea rows={3} placeholder={'-Xmx1024m\n-Djava.security.krb5.conf=/path/to/krb5.conf'} value={(settings.vmOptions ?? []).join('\n')} onChange={event => change({ vmOptions: event.target.value.split('\n') })} /></label>
    <label>Дополнительные JAR <span>абсолютные пути, по одному на строку</span><textarea rows={2} value={(settings.classpath ?? []).join('\n')} onChange={event => change({ classpath: event.target.value.split('\n') })} /></label>
    <label>Working directory<input value={settings.workingDirectory ?? ''} placeholder="По умолчанию приложения" onChange={event => change({ workingDirectory: event.target.value })} /></label>
    <label>VM environment <span>NAME=value, по одному на строку</span><textarea rows={3} placeholder={draft.jdbcEnvironmentNames?.length ? `Сохранены: ${draft.jdbcEnvironmentNames.join(', ')}. Укажите NAME= для очистки значения.` : 'KRB5_CONFIG=/path/to/krb5.conf'} value={environmentText} onChange={event => {
      setEnvironmentText(event.target.value);
      const values: Record<string, string> = {};
      for (const line of event.target.value.split('\n')) { const separator = line.indexOf('='); if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1); }
      change({ environment: values });
    }} /></label>
  </div>;
}

export function JdbcOptions({ draft, onChange }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void }) {
  const options = draft.jdbc?.options ?? {};
  const change = (values: Partial<NonNullable<JdbcSettings['options']>>) => onChange({ ...draft, jdbc: { ...draft.jdbc, options: { ...options, ...values } } });
  return <div className="jdbc-options">
    <h3>Connection</h3>
    <label className="checkbox-row"><input type="checkbox" checked={options.readOnly ?? false} onChange={event => change({ readOnly: event.target.checked })} />Read-only</label>
    <label>Transaction control<select value={options.autoCommit === false ? 'manual' : 'auto'} onChange={event => change({ autoCommit: event.target.value === 'auto' })}><option value="auto">Auto</option><option value="manual">Manual</option></select><small>В Manual завершайте транзакцию командой COMMIT или ROLLBACK.</small></label>
    <label>Transaction isolation<select value={options.isolation ?? 'default'} onChange={event => change({ isolation: event.target.value as any })}><option value="default">Driver default</option><option value="read-uncommitted">Read uncommitted</option><option value="read-committed">Read committed</option><option value="repeatable-read">Repeatable read</option><option value="serializable">Serializable</option></select></label>
    <div className="form-row"><label>Connection timeout, sec<input type="number" min={0} max={86400} value={options.connectTimeoutSeconds ?? 30} onChange={event => change({ connectTimeoutSeconds: Number(event.target.value) })} /></label><label>Query timeout, sec<input type="number" min={0} max={86400} value={options.queryTimeoutSeconds ?? 0} onChange={event => change({ queryTimeoutSeconds: Number(event.target.value) })} /><small>0 — без ограничения</small></label></div>
    <label>Startup script<textarea rows={6} placeholder="SQL выполняется при открытии каждой JDBC-сессии" value={(options.startupStatements ?? []).join('\n-- next statement --\n')} onChange={event => change({ startupStatements: event.target.value.trim() ? event.target.value.split('\n-- next statement --\n') : [] })} /><small>Каждый блок — один SQL-запрос. Разделитель блоков: -- next statement -- на отдельной строке.</small></label>
  </div>;
}
