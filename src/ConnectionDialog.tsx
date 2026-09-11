import { useEffect, useRef, useState } from 'react';
import { Database, X, Check, LoaderCircle, PlugZap, Trash2 } from 'lucide-react';
import { ENGINES, type DatabaseEngine, type Profile, type ProfileDraft } from './shared';
import { sslEnabled, usesHTTP } from './connectionSettings';
import { JdbcPanel, JdbcOptions } from './JdbcPanel';
import { SSLPanel } from './SSLPanel';

export function ConnectionDialog({ profile, onClose, onSaved, onDeleted }: {
  profile?: Profile; onClose(): void; onSaved(profile: Profile): void; onDeleted(id: string): void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(profile ? { ...profile, tls: sslEnabled(profile), jdbc: profile.jdbc ?? {} } : { name: '', endpoint: 'http://localhost:8080', user: '', auth: 'none', engine: 'trino', tls: false, sslVerification: 'FULL', catalog: '', schema: '', jdbc: {} });
  const [section, setSection] = useState<'general' | 'options' | 'ssl' | 'advanced'>('general');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const update = (key: keyof ProfileDraft, value: string) => { setDraft(current => ({ ...current, [key]: value, ...(key === 'endpoint' && usesHTTP(current.engine) ? { tls: /^https:\/\//i.test(value) } : {}) })); setMessage(''); };
  async function perform(action: 'test' | 'save' | 'delete') {
    setBusy(action); setMessage(''); setSuccess(false);
    try {
      const input = { ...draft, secret: draft.secret || undefined, jdbc: { ...draft.jdbc, vmOptions: draft.jdbc?.vmOptions?.filter(Boolean), classpath: draft.jdbc?.classpath?.filter(Boolean) } };
      if (action === 'test') { setMessage(await window.studio.profiles.test(input)); setSuccess(true); }
      if (action === 'save') onSaved(await window.studio.profiles.save(input));
      if (action === 'delete' && profile) { await window.studio.profiles.remove(profile.id); onDeleted(profile.id); }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(''); }
  }
  return <dialog ref={dialog} className="connection-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void perform('save'); }}>
      <div className="dialog-heading"><div className="large-icon"><Database size={22} /></div><div><h2>{profile ? 'Настройки подключения' : 'Новое подключение'}</h2><p>Local DB Viewer · {ENGINES[draft.engine].name}</p></div><button type="button" className="icon-button close-dialog" aria-label="Закрыть" disabled={!!busy} onClick={onClose}><X size={18} /></button></div>
      <div className="connection-tabs" role="tablist" aria-label="Настройки подключения">{(['general', 'options', 'ssl', 'advanced'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={section === value} onClick={() => setSection(value)}>{{general: 'General', options: 'Options', ssl: 'SSL/TLS', advanced: 'Advanced'}[value]}</button>)}</div>
      <div className="dialog-body">
        <div className="general-settings" hidden={section !== 'general'}>
        <label>СУБД<select aria-label="СУБД" value={draft.engine} disabled={!!profile || !!busy} onChange={event => {
          const engine = event.target.value as DatabaseEngine;
          setDraft(current => ({ ...current, engine, endpoint: ENGINES[engine].endpoint, user: ENGINES[engine].user, auth: ['trino', 'clickhouse', 'sqlite'].includes(engine) ? 'none' : 'basic', tls: !['trino', 'clickhouse', 'sqlite'].includes(engine), sslVerification: 'FULL', sslCa: '', secret: undefined, catalog: '', schema: '', jdbc: {}, jdbcSecrets: [], jdbcEnvironmentNames: [] })); setMessage('');
        }}>{Object.entries(ENGINES).map(([id, engine]) => <option key={id} value={id}>{engine.name}</option>)}</select></label>
        <label>Название<input autoFocus required placeholder="Например, Analytics" value={draft.name} onChange={event => update('name', event.target.value)} /></label>
        <label>{draft.engine === 'sqlite' ? 'SQLite-файл' : draft.engine === 'trino' ? 'Coordinator URL' : 'URL подключения'}<div className="endpoint-field"><input required type={draft.engine === 'sqlite' ? 'text' : 'url'} placeholder={ENGINES[draft.engine].endpoint || '/path/to/database.sqlite'} value={draft.endpoint} onChange={event => update('endpoint', event.target.value)} />{draft.engine === 'sqlite' && <button type="button" className="button secondary" onClick={() => void window.studio.files.database().then(path => { if (path) update('endpoint', path); }).catch(error => setMessage(error.message))}>Выбрать</button>}</div><small>{draft.engine === 'trino' ? 'Адрес coordinator или reverse proxy, без /v1/statement.' : draft.engine === 'sqlite' ? 'Локальный файл SQLite. Изменения записываются непосредственно в файл.' : draft.engine === 'clickhouse' ? 'HTTP endpoint ClickHouse. Имя базы укажите отдельно в поле Database.' : 'Имя базы можно указать в URL после порта. Credentials — в отдельных полях.'}</small></label>
        {draft.engine !== 'sqlite' && <div className="form-row"><label>Пользователь<input required placeholder="username" value={draft.user} onChange={event => update('user', event.target.value)} /></label><label>Аутентификация<select value={draft.auth} onChange={event => update('auth', event.target.value)}><option value="none">Без пароля</option><option value="basic">Username / password</option>{draft.engine === 'trino' && <option value="bearer">Bearer token</option>}</select></label></div>}
        {draft.auth !== 'none' && <label>{draft.auth === 'basic' ? 'Пароль' : 'Bearer token'}<input type="password" autoComplete="new-password" value={draft.secret ?? ''} placeholder={profile?.hasSecret && profile.auth === draft.auth ? 'Сохранён · оставьте пустым, чтобы сохранить' : 'Секрет будет зашифрован средствами ОС'} onChange={event => update('secret', event.target.value)} /></label>}
        {draft.engine !== 'sqlite' && <div className="form-row">{draft.engine !== 'postgres' && draft.engine !== 'mssql' && <label>{draft.engine === 'trino' ? 'Catalog' : 'Database'} <span>необязательно</span><input placeholder="по умолчанию" value={draft.catalog} onChange={event => update('catalog', event.target.value)} /></label>}{['trino', 'postgres'].includes(draft.engine) && <label>Schema <span>необязательно</span><input placeholder="по умолчанию" value={draft.schema} onChange={event => update('schema', event.target.value)} /></label>}</div>}
        {draft.engine !== 'sqlite' && <button type="button" className="ssl-summary" onClick={() => setSection('ssl')}>SSL = {String(sslEnabled(draft))} · SSLVerification = {draft.sslVerification ?? 'FULL'} · Настроить…</button>}
        </div>
        {section === 'advanced' && <JdbcPanel draft={draft} onChange={setDraft} onError={setMessage} />}
        {section === 'options' && <JdbcOptions draft={draft} onChange={setDraft} />}
        {section === 'ssl' && <SSLPanel draft={draft} busy={!!busy} onError={setMessage} onChange={value => { setDraft(value); setMessage(''); }} />}
        {message && <div role="status" className={`form-message ${success ? 'success' : 'error'}`}>{success && <Check size={16} />}<span>{message}</span></div>}
      </div>
      <div className="dialog-footer">{profile && <button type="button" className="icon-button danger" aria-label="Удалить подключение" disabled={!!busy} onClick={() => void perform('delete')}><Trash2 size={17} /></button>}<button type="button" className="button secondary" disabled={!!busy} onClick={() => void perform('test')}>{busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}Проверить</button><div className="spacer" /><button className="button primary" type="submit" disabled={!!busy}>{busy === 'save' && <LoaderCircle className="spin" size={15} />}Сохранить</button></div>
    </form>
  </dialog>;
}
