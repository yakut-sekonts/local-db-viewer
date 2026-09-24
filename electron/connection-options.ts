import { isAbsolute } from 'node:path';
import type { JdbcSettings } from '../src/jdbc';

const text = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length <= maximum && !/[\0\r\n]/.test(value);
const number = (value: unknown, minimum: number, maximum: number) => Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
export function validateConnectionOptions(settings: JdbcSettings): void {
  const options = settings.options;
  if (options?.switchSchema !== undefined && !['automatic','manual','disabled'].includes(options.switchSchema)) throw new Error('Неизвестный режим Switch schema.');
  if (options?.loadSources !== undefined && !['all','user','none'].includes(options.loadSources)) throw new Error('Неизвестный режим Load sources for.');
  if (options?.preIntrospectedObjects !== undefined && typeof options.preIntrospectedObjects !== 'boolean') throw new Error('Некорректная настройка pre-introspected objects.');
  if (options?.codeStyle !== undefined) {
    const style = options.codeStyle;
    if (!style || typeof style !== 'object' || Array.isArray(style) || !['upper','lower','preserve'].includes(style.keywordCase) || !number(style.indentSize, 1, 8) || typeof style.useTabs !== 'boolean') throw new Error('Некорректный Code style.');
  }
  for (const key of ['ssh','certificates','schemas','options'] as const) if (settings[key] !== undefined && (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key]))) throw new Error(`Некорректные настройки ${key}.`);
  const ssh = settings.ssh;
  if (ssh) {
    if (typeof ssh !== 'object' || typeof ssh.enabled !== 'boolean' || !text(ssh.host) || !text(ssh.user) || !number(ssh.port, 1, 65535) || !['password','key','agent'].includes(ssh.authentication) || !text(ssh.fingerprint)) throw new Error('Некорректные настройки SSH.');
    if (ssh.enabled && (!ssh.host.trim() || !ssh.user.trim() || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(ssh.fingerprint))) throw new Error('Укажите SSH host, user и проверенный SHA256 fingerprint сервера.');
    if (ssh.privateKeyPath && (!text(ssh.privateKeyPath, 4096) || !isAbsolute(ssh.privateKeyPath))) throw new Error('SSH private key: нужен абсолютный путь.');
    if (ssh.enabled && ssh.authentication === 'key' && !ssh.privateKeyPath) throw new Error('Выберите SSH private key.');
    for (const secret of [ssh.password, ssh.passphrase]) if (secret !== undefined && !text(secret, 32000)) throw new Error('Некорректный секрет SSH.');
    if (ssh.localPort !== undefined && !number(ssh.localPort, 0, 65535)) throw new Error('Некорректный локальный SSH port.');
    if (ssh.connectTimeoutSeconds !== undefined && !number(ssh.connectTimeoutSeconds, 1, 300)) throw new Error('SSH timeout: от 1 до 300 секунд.');
  }
  const certificates = settings.certificates;
  if (certificates) {
    if (typeof certificates !== 'object' || Array.isArray(certificates)) throw new Error('Некорректные настройки сертификатов.');
    for (const [key, value] of Object.entries(certificates)) {
      if (value === undefined) continue;
      if (key === 'savedSecrets') { if (!Array.isArray(value) || value.some(key => !['trustStorePassword','clientKeyPassword','clientStorePassword'].includes(key))) throw new Error('Некорректные saved certificate secrets.'); continue; }
      if (!text(value, 32000)) throw new Error(`Некорректное поле сертификата: ${key}.`);
      if (key.endsWith('Path') && value && !isAbsolute(value)) throw new Error('Файл сертификата или ключа: нужен абсолютный путь.');
    }
    if (certificates.trustSource && !['driver','java','system','file'].includes(certificates.trustSource)) throw new Error('Неизвестный truststore.');
    if (certificates.clientMode && !['none','pem','store','system'].includes(certificates.clientMode)) throw new Error('Неизвестный режим client certificate.');
    if (certificates.trustStoreType && !['PEM','PKCS12','JKS'].includes(certificates.trustStoreType)) throw new Error('Неизвестный формат truststore.');
    if (certificates.clientStoreType && !['PKCS12','JKS'].includes(certificates.clientStoreType)) throw new Error('Неизвестный формат keystore.');
    if (certificates.trustSource === 'file' && !certificates.trustStorePath) throw new Error('Выберите truststore / CA file.');
    if (certificates.clientMode === 'store' && !certificates.clientStorePath) throw new Error('Выберите client keystore.');
    if (certificates.clientMode === 'pem' && (!certificates.clientCertificatePath || !certificates.clientKeyPath)) throw new Error('Выберите client certificate и private key.');
  }
  const schemas = settings.schemas;
  if (schemas) {
    if (!['all','selected'].includes(schemas.mode) || !Array.isArray(schemas.selected) || schemas.selected.length > 5000 || schemas.selected.some(item => !item || !text(item.catalog) || !text(item.schema))) throw new Error('Некорректный выбор schemas.');
    for (const pattern of [schemas.includePattern, schemas.excludePattern, schemas.objectInclude, schemas.objectExclude]) if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length > 16000 || pattern.includes('\0') || pattern.split('\n').length > 32 || pattern.split('\n').some(line => line.length > 512))) throw new Error('Фильтр: до 32 patterns по 512 символов.');
  }
  if (options) {
    for (const field of ['singleSession','autoSync','trackSchemaChanges','loadSystemSchemas'] as const) if (options[field] !== undefined && typeof options[field] !== 'boolean') throw new Error(`Некорректная настройка ${field}.`);
    for (const field of ['keepAliveSeconds','autoDisconnectSeconds'] as const) if (options[field] !== undefined && (!number(options[field], 0, 86400) || Number(options[field]) > 0 && Number(options[field]) < 5)) throw new Error(`${field}: 0 (отключено) либо от 5 до 86400 секунд.`);
    if (options.introspectionMinutes !== undefined && !number(options.introspectionMinutes, 0, 1440)) throw new Error('Интервал introspection: от 0 до 1440 минут.');
    if (options.keepAliveQuery !== undefined && (typeof options.keepAliveQuery !== 'string' || options.keepAliveQuery.length > 100000)) throw new Error('Keep-alive SQL превышает 100 KB.');
    if (options.beforeConnect && (!Array.isArray(options.beforeConnect) || options.beforeConnect.length > 16 || options.beforeConnect.some(task => !task || !text(task.id, 100) || !text(task.name, 100) || !text(task.executable, 4096) || !isAbsolute(task.executable) || !Array.isArray(task.args) || task.args.length > 128 || task.args.some(arg => !text(arg, 32000)) || !number(task.timeoutSeconds, 1, 300) || typeof task.enabled !== 'boolean'))) throw new Error('Некорректная задача Before connection. Укажите абсолютный executable, аргументы и timeout.');
  }
}
