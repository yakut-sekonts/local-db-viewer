import { isAbsolute } from 'node:path';
import { DRIVER_CLASSES, secretProperty, type JdbcSettings } from '../src/jdbc';
import type { ProfileDraft } from '../src/shared';
import type { Connection } from './trino';
import { singleStatement } from './sql';

export function validateJdbc(input: JdbcSettings | undefined): void {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 256000) throw new Error('Некорректные настройки JDBC.');
  for (const values of [input.properties, input.environment]) if (values !== undefined) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Свойства JDBC должны быть объектом.');
    for (const [key, value] of Object.entries(values)) if (!key || key.length > 512 || /[\0\r\n=]/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32000) throw new Error('Некорректное свойство JDBC.');
  }
  for (const [name, values] of Object.entries({ vmOptions: input.vmOptions, classpath: input.classpath })) if (values !== undefined && (!Array.isArray(values) || values.length > 128 || values.some(value => typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || (name === 'classpath' && !isAbsolute(value))))) throw new Error(`Некорректное поле JDBC: ${name}.`);
  if (input.vmOptions?.some(value => !value.startsWith('-') || /^(?:-cp|-classpath|--class-path|-jar|--module|-m)$/.test(value))) throw new Error('В VM options допустимы только параметры JVM. JAR и classpath задаются отдельно.');
  if (input.url !== undefined && (typeof input.url !== 'string' || input.url.length > 16000 || /[\r\n\0]/.test(input.url) || (input.url && !input.url.startsWith('jdbc:')))) throw new Error('JDBC URL должен начинаться с jdbc:.');
  if (input.url && /(?:[?;&]|\/\/)(?:[^=;&]*password|accessToken|token|extraCredentials)=/i.test(input.url)) throw new Error('Секретные JDBC-параметры укажите в таблице Advanced, а не в URL.');
  if (input.driverClass && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(input.driverClass)) throw new Error('Некорректный JDBC driver class.');
  if (input.workingDirectory && !isAbsolute(input.workingDirectory)) throw new Error('Working directory должен быть абсолютным путём.');
  const options = input.options;
  if (options) {
    for (const key of ['readOnly', 'autoCommit'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`Некорректная настройка ${key}.`);
    for (const key of ['connectTimeoutSeconds', 'queryTimeoutSeconds'] as const) if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key]! < 0 || options[key]! > 86400)) throw new Error(`Некорректный timeout: ${key}.`);
    if (options.isolation && !['default', 'read-uncommitted', 'read-committed', 'repeatable-read', 'serializable'].includes(options.isolation)) throw new Error('Неизвестный уровень изоляции.');
    if (options.startupStatements && (!Array.isArray(options.startupStatements) || options.startupStatements.length > 100 || options.startupStatements.some(sql => typeof sql !== 'string' || !sql.trim() || sql.length > 100000))) throw new Error('Некорректный startup script.');
    options.startupStatements?.forEach(singleStatement);
  }
}
export function jdbcConfig(profile: Connection | ProfileDraft) {
  validateJdbc(profile.jdbc);
  const engine = profile.engine;
  const custom = profile.jdbc ?? {};
  const properties: Record<string, string> = {};
  let url: string;
  if (engine === 'sqlite') url = `jdbc:sqlite:${profile.endpoint}`;
  else {
    const endpoint = new URL(profile.endpoint);
    const host = endpoint.host;
    const database = profile.catalog || decodeURIComponent(endpoint.pathname.slice(1));
    const secure = ['trino', 'clickhouse'].includes(engine) ? endpoint.protocol === 'https:' : profile.tls;
    const verify = profile.sslVerification ?? 'FULL';
    const segment = (value: string) => encodeURIComponent(value);
    if (engine === 'trino') {
      url = `jdbc:trino://${host}${profile.catalog ? `/${segment(profile.catalog)}${profile.schema ? `/${segment(profile.schema)}` : ''}` : ''}`;
      properties.SSL = String(secure); properties.SSLVerification = verify;
      if (!secure) delete properties.SSLVerification;
      properties.source = 'Local DB Viewer';
    } else if (engine === 'postgres') {
      url = `jdbc:postgresql://${host}/${segment(decodeURIComponent(endpoint.pathname.slice(1)) || 'postgres')}`;
      properties.sslmode = secure ? ({ FULL: 'verify-full', CA: 'verify-ca', NONE: 'require' } as const)[verify] : 'disable';
      if (profile.schema) properties.currentSchema = profile.schema;
      properties.ApplicationName = 'Local DB Viewer';
    } else if (engine === 'mysql' || engine === 'mariadb') {
      url = `jdbc:${engine}://${host}/${segment(database)}`;
      properties.sslMode = engine === 'mysql' ? secure ? ({ FULL: 'VERIFY_IDENTITY', CA: 'VERIFY_CA', NONE: 'REQUIRED' } as const)[verify] : 'DISABLED'
        : secure ? ({ FULL: 'verify-full', CA: 'verify-ca', NONE: 'trust' } as const)[verify] : 'disable';
    } else if (engine === 'mssql') {
      url = `jdbc:sqlserver://${host}`;
      properties.databaseName = decodeURIComponent(endpoint.pathname.slice(1)) || 'master';
      properties.encrypt = String(secure); properties.trustServerCertificate = String(verify === 'NONE');
      properties.applicationName = 'Local DB Viewer';
    } else {
      url = `jdbc:clickhouse:${secure ? 'https' : 'http'}://${host}/${segment(database || 'default')}`;
      if (secure) properties.sslmode = verify === 'NONE' ? 'none' : 'strict';
    }
    if (profile.user) properties.user = profile.user;
    if (profile.auth === 'basic' && profile.secret) properties.password = profile.secret;
    if (profile.auth === 'bearer' && profile.secret) properties.accessToken = profile.secret;
  }
  if (custom.url) url = custom.url;
  // Explicit Advanced values win over General defaults. Parameters in a custom URL
  // stay in the URL; Trino rejects duplicate values in Properties and the URL.
  Object.assign(properties, custom.properties);
  if (custom.url) for (const key of [...new URLSearchParams(custom.url.split('?')[1] ?? '').keys()]) delete properties[key];
  for (const [key, value] of Object.entries(properties)) if (value === '' && secretProperty(key)) delete properties[key];
  return { url, properties, driverClass: custom.driverClass || DRIVER_CLASSES[engine], options: custom.options ?? {}, startupStatements: custom.options?.startupStatements ?? [] };
}
