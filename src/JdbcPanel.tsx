import { PathField } from './ConnectionExtras';
import { useEffect, useState } from 'react';
import { driverDefinition, profileDriver } from './drivers';
import type { ProfileDraft } from './shared';
import { secretProperty, type JdbcProperty, type JdbcSettings } from './jdbc';

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
  useEffect(() => { void load(); }, [draft.engine, draft.jdbc?.driverId, draft.jdbc?.driverVersion]);
  const names = [...new Set([...properties.map(item => item.name), ...Object.keys(settings.properties ?? {}), ...(draft.jdbcSecrets ?? [])])].sort();
  const help = new Map(properties.map(item => [item.name, item]));
  return <div className="jdbc-settings">
    <div className="jdbc-driver-heading"><strong>JDBC · {settings.driverClass || driverDefinition(profileDriver(draft)).className}</strong><button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Чтение…' : 'Обновить свойства'}</button></div>
    <input aria-label="Поиск JDBC-параметров" placeholder="Поиск: SSL, accessToken, Kerberos…" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="jdbc-properties"><div className="jdbc-property-header"><span>Name</span><span>Value</span></div>{names.filter(name => name.toLowerCase().includes(search.toLowerCase())).map(name => {
      const info = help.get(name); const saved = draft.jdbcSecrets?.includes(name);
      return <label key={name} className="jdbc-property" title={info?.description ?? name}><span>{name}{info?.required && ' *'}</span>{info?.choices?.length && !secretProperty(name) ? <select aria-label={name} value={settings.properties?.[name] ?? ''} onChange={event => property(name, event.target.value || undefined)}><option value="">По умолчанию{info.value ? `: ${info.value}` : ''}</option>{info.choices.map(value => <option key={value}>{value}</option>)}</select> : <input aria-label={name} type={secretProperty(name) ? 'password' : 'text'} autoComplete="off" value={settings.properties?.[name] ?? ''} placeholder={saved ? 'Сохранён · введите новое значение для замены' : info?.value ?? 'По умолчанию драйвера'} onChange={event => property(name, event.target.value)} />}</label>;
    })}</div>
    <div className="form-row"><input aria-label="Имя пользовательского JDBC-параметра" placeholder="Дополнительный параметр" value={customName} onChange={event => setCustomName(event.target.value)} /><button type="button" className="button secondary" disabled={!customName.trim()} onClick={() => { property(customName.trim(), ''); setSearch(customName.trim()); setCustomName(''); }}>Добавить</button></div>
    <small>Заданные значения передаются JDBC-драйверу напрямую и заменяют значения General. Параметры в JDBC URL имеют приоритет.</small>
    <label>JDBC URL <span>переопределяет General</span><input value={settings.url ?? ''} placeholder="jdbc:…" onChange={event => change({ url: event.target.value })} /></label>
    <label>Driver class<input value={settings.driverClass ?? ''} placeholder={driverDefinition(profileDriver(draft)).className} onChange={event => change({ driverClass: event.target.value })} /></label>
    <label>VM options <span>один аргумент на строку</span><textarea rows={3} placeholder={'-Xmx1024m\n-Djava.security.krb5.conf=/path/to/krb5.conf'} value={(settings.vmOptions ?? []).join('\n')} onChange={event => change({ vmOptions: event.target.value.split('\n') })} /></label>
    <label>Внешний комплект JAR <span>заменяет управляемый драйвер; абсолютные пути, по одному на строку</span><textarea rows={2} value={(settings.classpath ?? []).join('\n')} onChange={event => change({ classpath: event.target.value.split('\n') })} /></label>
    <label>Working directory<input value={settings.workingDirectory ?? ''} placeholder="По умолчанию приложения" onChange={event => change({ workingDirectory: event.target.value })} /></label>
    <label>VM environment <span>NAME=value, по одному на строку</span><textarea rows={3} placeholder={draft.jdbcEnvironmentNames?.length ? `Сохранены: ${draft.jdbcEnvironmentNames.join(', ')}. Укажите NAME= для очистки значения.` : 'KRB5_CONFIG=/path/to/krb5.conf'} value={environmentText} onChange={event => {
      setEnvironmentText(event.target.value);
      const values: Record<string, string> = {};
      for (const line of event.target.value.split('\n')) { const separator = line.indexOf('='); if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1); }
      change({ environment: values });
    }} /></label>
  </div>;
}

export function JdbcOptions({ draft, onChange, onError }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void }) {
  const options = draft.jdbc?.options ?? {};
  const change = (values: Partial<NonNullable<JdbcSettings['options']>>) => onChange({ ...draft, jdbc: { ...draft.jdbc, options: { ...options, ...values } } });
  return <div className="jdbc-options">
    <h3>Connection</h3>
    <label className="checkbox-row"><input type="checkbox" checked={options.readOnly ?? false} onChange={event => change({ readOnly: event.target.checked })} />Read-only</label>
    <label>Transaction control<select value={options.autoCommit === false ? 'manual' : 'auto'} onChange={event => change({ autoCommit: event.target.value === 'auto' })}><option value="auto">Auto</option><option value="manual">Manual</option></select><small>В Manual завершайте транзакцию командой COMMIT или ROLLBACK.</small></label>
    <label>Transaction isolation<select value={options.isolation ?? 'default'} onChange={event => change({ isolation: event.target.value as any })}><option value="default">Driver default</option><option value="read-uncommitted">Read uncommitted</option><option value="read-committed">Read committed</option><option value="repeatable-read">Repeatable read</option><option value="serializable">Serializable</option></select></label>
    <div className="form-row"><label>Connection timeout, sec<input type="number" min={0} max={86400} value={options.connectTimeoutSeconds ?? 30} onChange={event => change({ connectTimeoutSeconds: Number(event.target.value) })} /></label><label>Query timeout, sec<input type="number" min={0} max={86400} value={options.queryTimeoutSeconds ?? 0} onChange={event => change({ queryTimeoutSeconds: Number(event.target.value) })} /><small>0 — без ограничения</small></label></div>
    <label className="checkbox-row"><input type="checkbox" checked={options.singleSession ?? false} onChange={event => change({ singleSession: event.target.checked })} />Single session mode</label>
    <small>Все консоли и метаданные этого подключения используют одну JDBC-сессию. Запросы выполняются последовательно; транзакция общая.</small>
    <div className="form-row"><label>Keep-alive interval, sec<input type="number" min={0} max={86400} value={options.keepAliveSeconds ?? 0} onChange={event => change({ keepAliveSeconds: Number(event.target.value) })} /></label><label>Auto-disconnect after, sec<input type="number" min={0} max={86400} value={options.autoDisconnectSeconds ?? 0} onChange={event => change({ autoDisconnectSeconds: Number(event.target.value) })} /></label></div>
    <label>Keep-alive query<input placeholder="Driver connection.isValid" value={options.keepAliveQuery ?? ''} onChange={event => change({ keepAliveQuery: event.target.value })} /><small>0 отключает таймер. Минимальный интервал — 5 секунд. Во время запроса или открытой транзакции keep-alive и auto-disconnect не выполняются.</small></label>
    <h3>Introspection</h3>
    <label className="checkbox-row"><input type="checkbox" checked={options.autoSync ?? true} onChange={event => change({ autoSync: event.target.checked })} />Auto sync</label>
    <label>Automatic introspection interval, minutes<input type="number" min={0} max={1440} value={options.introspectionMinutes ?? 0} onChange={event => change({ introspectionMinutes: Number(event.target.value) })} /><small>0 — без периодического обновления. Ручное обновление доступно всегда.</small></label>
    <label className="checkbox-row"><input type="checkbox" checked={options.trackSchemaChanges ?? true} onChange={event => change({ trackSchemaChanges: event.target.checked })} />Track databases / schemas creation and deletion</label>
    <label className="checkbox-row"><input type="checkbox" checked={options.loadSystemSchemas ?? true} onChange={event => change({ loadSystemSchemas: event.target.checked })} />Load system schemas</label>
    <h3>Before connection</h3>
    {(options.beforeConnect ?? []).map(task => <fieldset key={task.id}><label className="checkbox-row"><input type="checkbox" checked={task.enabled} onChange={event => change({ beforeConnect: options.beforeConnect?.map(item => item.id === task.id ? { ...item, enabled: event.target.checked } : item) })} />Enabled</label><label>Name<input value={task.name} onChange={event => change({ beforeConnect: options.beforeConnect?.map(item => item.id === task.id ? { ...item, name: event.target.value } : item) })} /></label><PathField label="Executable" value={task.executable} kind="executable" onError={onError} onChange={executable => change({ beforeConnect: options.beforeConnect?.map(item => item.id === task.id ? { ...item, executable } : item) })} /><label>Arguments · один на строку<textarea rows={3} value={task.args.join('\n')} onChange={event => change({ beforeConnect: options.beforeConnect?.map(item => item.id === task.id ? { ...item, args: event.target.value ? event.target.value.split('\n') : [] } : item) })} /></label><label>Timeout, sec<input type="number" min={1} max={300} value={task.timeoutSeconds} onChange={event => change({ beforeConnect: options.beforeConnect?.map(item => item.id === task.id ? { ...item, timeoutSeconds: Number(event.target.value) } : item) })} /></label><button className="button secondary" type="button" onClick={() => change({ beforeConnect: options.beforeConnect?.filter(item => item.id !== task.id) })}>Удалить задачу</button></fieldset>)}
    <button className="button secondary" type="button" onClick={() => change({ beforeConnect: [...(options.beforeConnect ?? []), { id: crypto.randomUUID(), name: 'Before connection', executable: '', args: [], timeoutSeconds: 30, enabled: true }] })}>Добавить задачу</button>
    <small>Задачи выполняются по порядку перед новой JDBC-сессией, включая проверку подключения. Без shell; при ошибке подключение прекращается.</small>
    <label>Startup script<textarea rows={6} placeholder="SQL выполняется при открытии каждой JDBC-сессии" value={(options.startupStatements ?? []).join('\n-- next statement --\n')} onChange={event => change({ startupStatements: event.target.value.trim() ? event.target.value.split('\n-- next statement --\n') : [] })} /><small>Каждый блок — один SQL-запрос. Разделитель блоков: -- next statement -- на отдельной строке.</small></label>
  </div>;
}
