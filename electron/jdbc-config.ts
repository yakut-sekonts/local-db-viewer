import { isAbsolute } from 'node:path';
import { DRIVER_CLASSES, secretProperty, type JdbcSettings } from '../src/jdbc';
import type { ProfileDraft } from '../src/shared';
import type { Connection } from './trino';
import { singleStatement } from './sql';
import { driverDefinition, profileDriver, sqlEngine, DATABASE_PRODUCTS } from '../src/drivers';
import { validateConnectionOptions } from './connection-options';

export function validateJdbc(input: JdbcSettings | undefined): void {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 256000) throw new Error('Некорректные настройки JDBC.');
  validateConnectionOptions(input);
  const templates = input.sessionTemplates === undefined ? [] : input.sessionTemplates;
  if (!Array.isArray(templates) || templates.length > 32) throw new Error('Допустимо до 32 шаблонов сессий.');
  const templateIds = new Set<string>(), templateNames = new Set<string>();
  for (const template of templates) {
    if (!template || typeof template !== 'object' || Array.isArray(template) || typeof template.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(template.id) || templateIds.has(template.id) || typeof template.name !== 'string' || !template.name.trim() || template.name.length > 100 || /[\r\n\0]/.test(template.name) || templateNames.has(template.name.trim().toLowerCase())) throw new Error('Укажите уникальные имя и ID шаблона сессии.');
    templateIds.add(template.id); templateNames.add(template.name.trim().toLowerCase());
    for (const value of [template.driverVersion, template.driverClass]) if (value !== undefined && typeof value !== 'string') throw new Error('Некорректный драйвер шаблона.');
    const auth = template.authentication;
    if (auth !== undefined && (!auth || typeof auth !== 'object' || !['none','basic','bearer'].includes(auth.auth) || typeof auth.user !== 'string' || auth.user.length > 512 || /[\r\n\0]/.test(auth.user) || auth.secret !== undefined && (typeof auth.secret !== 'string' || auth.secret.length > 16384 || /[\r\n\0]/.test(auth.secret)))) throw new Error('Некорректная аутентификация шаблона.');
    if (template.options && Object.keys(template.options).some(key => !['readOnly','autoCommit','isolation','startupStatements','queryTimeoutSeconds'].includes(key))) throw new Error('Неизвестная настройка шаблона сессии.');
    validateJdbc({ driverVersion: template.driverVersion, driverClass: template.driverClass, classpath: template.classpath, options: template.options });
  }
  for (const id of [input.defaultSessionTemplate, input.introspectionSessionTemplate]) if (id !== undefined && (typeof id !== 'string' || id !== '' && !templateIds.has(id))) throw new Error('Выбранный шаблон сессии не существует.');
  if (input.driverId) driverDefinition(input.driverId);
  if (input.productId && !DATABASE_PRODUCTS.some(product => product.id === input.productId)) throw new Error('Неизвестный тип СУБД.');
  if (input.driverVersion && !/^(bundled|[a-f0-9]{64})$/.test(input.driverVersion)) throw new Error('Некорректная версия драйвера.');
  for (const values of [input.properties, input.environment]) if (values !== undefined) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Свойства JDBC должны быть объектом.');
    for (const [key, value] of Object.entries(values)) if (!key || key.length > 512 || /[\0\r\n=]/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32000) throw new Error('Некорректное свойство JDBC.');
  }
  for (const [name, values] of Object.entries({ vmOptions: input.vmOptions, classpath: input.classpath })) if (values !== undefined && (!Array.isArray(values) || values.length > 128 || values.some(value => typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || (name === 'classpath' && !isAbsolute(value))))) throw new Error(`Некорректное поле JDBC: ${name}.`);
  if (input.vmOptions?.some(value => !value.startsWith('-') || /^(?:-cp|-classpath|--class-path|-jar|--module|-m)$/.test(value))) throw new Error('В VM options допустимы только параметры JVM. JAR и classpath задаются отдельно.');
  if (input.url !== undefined && (typeof input.url !== 'string' || input.url.length > 16000 || /[\r\n\0]/.test(input.url) || (input.url && !input.url.startsWith('jdbc:')))) throw new Error('JDBC URL должен начинаться с jdbc:.');
  if (input.url && /(?:\/\/[^/?#]*@|jdbc:oracle:[^:]+:[^@]*\/[^@]*@|[?;&](?:[^=;&]*(?:password|token|secret|credential|passphrase)|user(?:name)?)=)/i.test(decodeURIComponent(input.url))) throw new Error('Секретные JDBC-параметры укажите в таблице Advanced, а не в URL.');
  if (input.driverClass && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(input.driverClass)) throw new Error('Некорректный JDBC driver class.');
  if (input.workingDirectory && !isAbsolute(input.workingDirectory)) throw new Error('Working directory должен быть абсолютным путём.');
  const options = input.options;
  if (options) {
    for (const key of ['readOnly', 'autoCommit'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`Некорректная настройка ${key}.`);
    for (const key of ['connectTimeoutSeconds', 'queryTimeoutSeconds'] as const) if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key]! < 0 || options[key]! > 86400)) throw new Error(`Некорректный timeout: ${key}.`);
    if (options.isolation && !['default', 'read-uncommitted', 'read-committed', 'repeatable-read', 'serializable'].includes(options.isolation)) throw new Error('Неизвестный уровень изоляции.');
    if (options.startupStatements && (!Array.isArray(options.startupStatements) || options.startupStatements.length > 100 || options.startupStatements.some(sql => typeof sql !== 'string' || !sql.trim() || sql.length > 100000))) throw new Error('Некорректный startup script.');

  }
}
export function jdbcConfig(profile: Connection | ProfileDraft) {
  validateJdbc(profile.jdbc);
  const engine = profile.engine;
  const custom = profile.jdbc ?? {};
  custom.options?.startupStatements?.forEach(sql => singleStatement(sql, sqlEngine(profile)));
  if (custom.options?.keepAliveQuery?.trim()) singleStatement(custom.options.keepAliveQuery, sqlEngine(profile));
  const properties: Record<string, string> = Object.create(null);
  let url: string;
  if (engine === 'jdbc') {
    url = custom.url || profile.endpoint;
    if (!url.startsWith('jdbc:')) throw new Error('URL должен начинаться с jdbc:.');
    if (profile.user) properties.user = profile.user;
    if (profile.auth === 'basic' && profile.secret) properties.password = profile.secret;
    if (profile.auth === 'bearer' && profile.secret) properties.accessToken = profile.secret;
  } else if (engine === 'sqlite') url = `jdbc:sqlite:${profile.endpoint}`;
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
      if (secure) properties.ssl_mode = ({ FULL: 'STRICT', CA: 'VERIFY_CA', NONE: 'TRUST' } as const)[verify];
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
  return { url, properties, driverClass: custom.driverClass || driverDefinition(profileDriver(profile)).className || DRIVER_CLASSES[engine], options: custom.options ?? {}, startupStatements: custom.options?.startupStatements ?? [] };
}
