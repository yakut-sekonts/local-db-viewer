import { useState } from 'react';
import type { ProfileDraft } from './shared';
import type { CertificateSettings, SshSettings, SchemaSettings } from './jdbc';
import { profileDriver } from './drivers';

export function PathField({ label, value, kind, onChange, onError }: { label: string; value?: string; kind: 'certificate' | 'key' | 'store' | 'ddl' | 'executable'; onChange(path: string): void; onError(message: string): void }) {
  return <label>{label}<div className="endpoint-field"><input aria-label={label} value={value ?? ''} onChange={event => onChange(event.target.value)} /><button type="button" className="button secondary" onClick={() => void window.studio.files.path(kind).then(path => { if (path) onChange(path); }).catch(error => onError(error.message))}>Выбрать</button></div></label>;
}
export function SSHPanel({ draft, onChange, onError }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void }) {
  const ssh = draft.jdbc?.ssh ?? { enabled: false, host: '', port: 22, user: '', authentication: 'key', fingerprint: '' };
  const change = (values: Partial<SshSettings>) => onChange({ ...draft, jdbc: { ...draft.jdbc, ssh: { ...ssh, ...values } } });
  const [fingerprint, setFingerprint] = useState<{ host: string; port: number; value: string }>();
  const [busy, setBusy] = useState(false);
  const supported = ['trino','presto','postgres','mysql','mariadb','mssql','clickhouse'].includes(profileDriver(draft));
  return <div className="jdbc-options"><h3>SSH tunnel</h3>
    <label className="checkbox-row"><input type="checkbox" disabled={!supported} checked={ssh.enabled} onChange={event => change({ enabled: event.target.checked })} />Use SSH tunnel</label>
    {!supported && <small>Для этого драйвера встроенный SSH transport пока недоступен.</small>}
    {ssh.enabled && <>
      <div className="form-row"><label>SSH host<input aria-label="SSH host" value={ssh.host} onChange={event => change({ host: event.target.value, fingerprint: '' })} /></label><label>SSH port<input type="number" min={1} max={65535} value={ssh.port} onChange={event => change({ port: Number(event.target.value), fingerprint: '' })} /></label></div>
      <label>SSH user<input value={ssh.user} onChange={event => change({ user: event.target.value })} /></label>
      <label>SSH authentication<select aria-label="SSH authentication" value={ssh.authentication} onChange={event => change({ authentication: event.target.value as SshSettings['authentication'] })}><option value="key">Private key</option><option value="password">Password</option><option value="agent">SSH agent / Pageant</option></select></label>
      {ssh.authentication === 'key' && <><PathField label="SSH private key" value={ssh.privateKeyPath} kind="key" onError={onError} onChange={privateKeyPath => change({ privateKeyPath })} /><label>Key passphrase<input type="password" autoComplete="new-password" placeholder={ssh.hasPassphrase ? 'Сохранена' : ''} value={ssh.passphrase ?? ''} onChange={event => change({ passphrase: event.target.value })} /></label></>}
      {ssh.authentication === 'password' && <label>SSH password<input type="password" autoComplete="new-password" placeholder={ssh.hasPassword ? 'Сохранён' : ''} value={ssh.password ?? ''} onChange={event => change({ password: event.target.value })} /></label>}
      <label>Server fingerprint<input aria-label="SSH fingerprint" placeholder="SHA256:…" value={ssh.fingerprint} onChange={event => change({ fingerprint: event.target.value })} /><small>Сверьте fingerprint с администратором SSH-сервера. При смене ключа соединение будет отклонено.</small></label>
      <button type="button" className="button secondary" disabled={busy || !ssh.host} onClick={() => { const { host, port } = ssh; setBusy(true); void window.studio.ssh.fingerprint(host, port).then(value => setFingerprint({ host, port, value })).catch(error => onError(error.message)).finally(() => setBusy(false)); }}>{busy ? 'Чтение ключа…' : 'Получить fingerprint'}</button>
      {fingerprint && fingerprint.host === ssh.host && fingerprint.port === ssh.port && <div className="settings-note"><code>{fingerprint.value}</code><button type="button" className="button secondary" onClick={() => { change({ fingerprint: fingerprint.value }); setFingerprint(undefined); }}>Ключ сверён — доверять</button></div>}
      <div className="form-row"><label>Local port<input type="number" min={0} max={65535} value={ssh.localPort ?? 0} onChange={event => change({ localPort: Number(event.target.value) })} /><small>0 — динамический порт; фиксированный порт допускает один туннель.</small></label><label>SSH timeout, sec<input type="number" min={1} max={300} value={ssh.connectTimeoutSeconds ?? 15} onChange={event => change({ connectTimeoutSeconds: Number(event.target.value) })} /></label></div>
      <small>Адрес БД остаётся в General/JDBC URL. DNS для JDBC transport выполняется через SSH-сервер.</small>
    </>}
  </div>;
}

export function CertificatePanel({ draft, onChange, onError }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void }) {
  const c = draft.jdbc?.certificates ?? {}, driver = profileDriver(draft);
  const change = (values: Partial<CertificateSettings>) => onChange({ ...draft, jdbc: { ...draft.jdbc, certificates: { ...c, ...values } } });
  const secret = (label: string, key: 'trustStorePassword' | 'clientKeyPassword' | 'clientStorePassword') => <label>{label}<input type="password" autoComplete="new-password" value={c[key] ?? ''} placeholder={c.savedSecrets?.includes(key) ? 'Сохранён' : ''} onChange={event => change({ [key]: event.target.value })} /></label>;
  if (!['trino','presto','postgres','mysql','mariadb','mssql','clickhouse'].includes(driver)) return null;
  return <div className="jdbc-options"><h3>Truststore / client certificate</h3><small>SSL должен быть включён в General или Advanced. Конфликтующие параметры сертификатов в Advanced нужно удалить.</small>
    <label>Use truststore<select aria-label="Use truststore" value={c.trustSource ?? 'driver'} onChange={event => change({ trustSource: event.target.value as CertificateSettings['trustSource'] })}><option value="driver">Driver default / CA bundle выше</option><option value="java">Bundled Java</option><option value="system">System certificates</option><option value="file">Файл PEM / PKCS12 / JKS</option></select></label>
    {c.trustSource === 'file' && <><PathField label="Truststore / CA file" value={c.trustStorePath} kind="store" onError={onError} onChange={trustStorePath => change({ trustStorePath })} /><label>Truststore type<select value={c.trustStoreType ?? 'PKCS12'} onChange={event => change({ trustStoreType: event.target.value as CertificateSettings['trustStoreType'] })}><option>PKCS12</option><option>JKS</option><option>PEM</option></select></label>{c.trustStoreType !== 'PEM' && secret('Truststore password', 'trustStorePassword')}</>}
    {!['mssql'].includes(driver) && <label>Client certificate<select aria-label="Client certificate" value={c.clientMode ?? 'none'} onChange={event => change({ clientMode: event.target.value as CertificateSettings['clientMode'] })}><option value="none">None</option>{['trino','presto','postgres','clickhouse'].includes(driver) && <option value="pem">Certificate + private key files</option>}{driver !== 'clickhouse' && <option value="store">PKCS12 / JKS keystore</option>}{['trino','presto'].includes(driver) && <option value="system">System keystore</option>}</select></label>}
    {c.clientMode === 'pem' && <><PathField label="Client certificate file" value={c.clientCertificatePath} kind="certificate" onError={onError} onChange={clientCertificatePath => change({ clientCertificatePath })} /><PathField label="Client private key file" value={c.clientKeyPath} kind="key" onError={onError} onChange={clientKeyPath => change({ clientKeyPath })} />{secret('Client key password', 'clientKeyPassword')}<small>{driver === 'postgres' ? 'PostgreSQL: PKCS8 key или PKCS12 (alias user), в формате драйвера.' : 'Формат ключа должен поддерживаться выбранным JDBC-драйвером.'}</small></>}
    {c.clientMode === 'store' && <><PathField label="Client keystore file" value={c.clientStorePath} kind="store" onError={onError} onChange={clientStorePath => change({ clientStorePath })} /><label>Client keystore type<select value={c.clientStoreType ?? 'PKCS12'} onChange={event => change({ clientStoreType: event.target.value as CertificateSettings['clientStoreType'] })}><option>PKCS12</option><option>JKS</option></select></label>{secret('Client keystore password', 'clientStorePassword')}</>}
  </div>;
}

export function SchemasPanel({ draft, onChange, onError }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void }) {
  const settings = draft.jdbc?.schemas ?? { mode: 'all', selected: [] };
  const change = (values: Partial<SchemaSettings>) => onChange({ ...draft, jdbc: { ...draft.jdbc, schemas: { ...settings, ...values } } });
  const [catalogs, setCatalogs] = useState<string[]>(), [schemas, setSchemas] = useState<Record<string, string[]>>({}), [busy, setBusy] = useState(''), [search, setSearch] = useState('');
  async function browse(catalog?: string) {
    setBusy(catalog ?? 'catalogs');
    try {
      const result = await window.studio.jdbc.browse(draft, catalog === undefined ? { kind: 'catalogs' } : { kind: 'schemas', catalog });
      const names = result.rows.map(row => String(row[0] ?? ''));
      if (catalog === undefined) setCatalogs(names); else setSchemas(current => ({ ...current, [catalog]: names }));
      if (result.truncated) onError('Список ограничен 10 000 объектами. Уточните каталог.');
    } catch (error) { onError((error as Error).message); } finally { setBusy(''); }
  }
  return <div className="jdbc-options"><div className="form-row"><label>Introspection scope<select aria-label="Introspection scope" value={settings.mode} onChange={event => change({ mode: event.target.value as SchemaSettings['mode'] })}><option value="all">All databases / schemas</option><option value="selected">Selected schemas</option></select></label><button className="button secondary" type="button" disabled={!!busy} onClick={() => void browse()}>Загрузить каталоги</button></div>
    <input aria-label="Поиск схем" placeholder="Поиск схем…" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="schema-selection">{(catalogs ?? [...new Set(settings.selected.map(item => item.catalog))]).map(catalog => <div key={catalog}><button className="button secondary" type="button" disabled={!!busy} onClick={() => void browse(catalog)}>{catalog || '(default database)'} · загрузить schemas</button>{(schemas[catalog] ?? settings.selected.filter(item => item.catalog === catalog).map(item => item.schema)).filter(schema => `${catalog}.${schema}`.toLowerCase().includes(search.toLowerCase())).map(schema => <label className="checkbox-row" key={schema}><input type="checkbox" disabled={settings.mode === 'all'} checked={settings.mode === 'all' || settings.selected.some(item => item.catalog === catalog && item.schema === schema)} onChange={event => change({ mode: 'selected', selected: [...settings.selected.filter(item => item.catalog !== catalog || item.schema !== schema), ...(event.target.checked ? [{ catalog, schema }] : [])] })} />{schema || '(default schema)'}</label>)}</div>)}</div>
    <small>Selected schemas: {settings.selected.length}. Пустой список в этом режиме исключает все объекты из дерева и автодополнения. SQL выполняется независимо от фильтров.</small>
    {([['includePattern','Schema include patterns'],['excludePattern','Schema exclude patterns'],['objectInclude','Object include patterns'],['objectExclude','Object exclude patterns']] as const).map(([key, label]) => <label key={key}>{label}<textarea rows={2} value={settings[key] ?? ''} onChange={event => change({ [key]: event.target.value })} /></label>)}
    <small>По одному glob pattern на строку: * — любые символы, ? — один символ. Schema: catalog.schema; object: catalog.schema.table. Exclude имеет приоритет. Пустой include разрешает всё.</small>
  </div>;
}
