import { Upload, Trash2 } from 'lucide-react';
import type { ProfileDraft, SSLVerification } from './shared';
import { sslEnabled, toggleSSL, usesHTTP } from './connectionSettings';

export function SSLPanel({ draft, onChange, onError, busy }: { draft: ProfileDraft; onChange(draft: ProfileDraft): void; onError(message: string): void; busy: boolean }) {
  const enabled = sslEnabled(draft);
  const verification = draft.sslVerification ?? 'FULL';
  async function importCA() {
    try {
      const file = await window.studio.files.certificate();
      if (file) onChange({ ...draft, sslCa: file.pem });
    } catch (error) { onError((error as Error).message); }
  }
  if (draft.engine === 'sqlite') return <p className="settings-note">SQLite работает с локальным файлом. SSL для него не используется.</p>;
  return <div className="ssl-panel">
    <label className="tls-setting"><input aria-label="Use SSL" type="checkbox" checked={enabled} disabled={busy} onChange={event => onChange(toggleSSL(draft, event.target.checked))} />Use SSL <code>SSL = {String(enabled)}</code></label>
    {usesHTTP(draft.engine) && <p className="settings-note">Для {draft.engine === 'trino' ? 'Trino' : 'ClickHouse'} SSL использует HTTPS. Порт сохраняется, например <code>https://host:8443</code>.</p>}
    <label>SSLVerification<select aria-label="SSLVerification" value={verification} disabled={!enabled || busy} onChange={event => onChange({ ...draft, sslVerification: event.target.value as SSLVerification })}>
      <option value="FULL">FULL — сертификат CA и имя сервера</option>
      {draft.engine !== 'mssql' && <option value="CA">CA — сертификат CA, без проверки имени сервера</option>}
      <option value="NONE">NONE — без проверки сертификата</option>
    </select></label>
    {enabled && verification !== 'FULL' && <p className="ssl-warning">{verification === 'NONE' ? 'Соединение шифруется, но подлинность сервера не проверяется.' : 'Цепочка сертификатов проверяется, несовпадение имени сервера допускается.'}</p>}
    <label>CA certificate / bundle<div className="certificate-actions"><button className="button secondary" type="button" disabled={!enabled || busy} onClick={() => void importCA()}><Upload size={14} />Импорт PEM</button><span>{draft.sslCa ? 'Сертификат сохранён в подключении' : 'Системные и встроенные CA'}</span>{draft.sslCa && <button className="icon-button" type="button" aria-label="Удалить CA" disabled={busy} onClick={() => onChange({ ...draft, sslCa: '' })}><Trash2 size={14} /></button>}</div><textarea aria-label="CA certificate PEM" rows={6} placeholder="-----BEGIN CERTIFICATE-----" value={draft.sslCa ?? ''} disabled={!enabled || busy} onChange={event => onChange({ ...draft, sslCa: event.target.value })} /><small>Публичные сертификаты PEM до 256 KB. Корпоративный CA дополняет сертификаты ОС и встроенный набор.</small></label>
    {usesHTTP(draft.engine) && <div className="effective-endpoint"><span>URL подключения</span><code>{draft.endpoint}</code></div>}
  </div>;
}
