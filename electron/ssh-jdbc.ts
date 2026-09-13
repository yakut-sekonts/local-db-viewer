import type { Connection } from './trino';
import { profileDriver } from '../src/drivers';

export function sshProperties(profile: Connection, url: string, properties: Record<string, string>, port: number): Record<string, string> {
  const driver = profileDriver(profile);
  let added: Record<string, string>;
  if (driver === 'trino' || driver === 'presto') added = { socksProxy: `127.0.0.1:${port}` };
  else if (driver === 'mysql') added = { socksProxyHost: '127.0.0.1', socksProxyPort: String(port), socksProxyRemoteDns: 'true' };
  else if (['postgres','mariadb'].includes(driver)) added = { socketFactory: 'LocalDBViewerSocketFactory' };
  else if (driver === 'mssql') added = { socketFactoryClass: 'LocalDBViewerSocketFactory' };
  else if (driver === 'clickhouse') added = { proxy_type: 'HTTP', proxy_host: '127.0.0.1', proxy_port: String(port) };
  else throw new Error('SSH transport для этого JDBC-драйвера пока не поддерживается. Поддерживаются Trino, Presto, PostgreSQL, MySQL, MariaDB, SQL Server и ClickHouse.');
  for (const key of [...Object.keys(properties), ...new URLSearchParams(url.split('?')[1] ?? '').keys()]) {
    if (/proxy|socketfactory|dnssrv/i.test(key)) throw new Error(`SSH конфликтует с Advanced/URL параметром ${key}. Уберите его, чтобы использовать встроенный туннель.`);
  }
  if (/;(?:[^;=]*(?:proxy|socketfactory|dnssrv))=/i.test(url)) throw new Error('SSH конфликтует с proxy/socketFactory в JDBC URL.');
  return { ...properties, ...added };
}
