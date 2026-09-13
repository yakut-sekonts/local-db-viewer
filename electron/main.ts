import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session as electronSession } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSession, type QueryTask } from './database';
import { SessionPool, type SessionLease } from './session-pool';
import { sshFingerprint } from './ssh';
import { filterMetadata } from './metadata-settings';
import { filterSchema, schemaAllowed, isSystemSchema } from '../src/schemaSettings';
import { metadataSQL } from './sql';
import { ProfileStore } from './storage';
import { csv } from './csv';
import { MAX_CA_BYTES, validateCertificate, validateSSL } from './tls';
import { loadSchema, RelationStore, validateRelation } from './schema';
import { Updater } from './updater';
import { fetchUpdate } from './update-transport';
import { installUpdate } from './install-update';
import { confirmUpdateStartup } from './update-install-state';
import { validateJdbc } from './jdbc-config';
import { describeDriver, inspectJdbc } from './jdbc-worker';
import { DriverManager } from './driver-manager';
import { bundledDrivers } from './runtime-paths';
import { profileDriver, driverDefinition } from '../src/drivers';
import driverCatalogLock from '../drivers/catalog-lock.json';
import type { Connection } from './trino';
import type { SchemaIndex, MetadataResult, MetadataInput, ProfileDraft, QueryInput, Relationship, SchemaInput } from '../src/shared';

const productName = 'Local DB Viewer';
const legacyName = 'DataKhrip';
const legacyDirectory = join(app.getPath('appData'), legacyName);
const newDirectory = join(app.getPath('appData'), productName);
const explicitDataDirectory = process.env.LOCAL_DB_VIEWER_DATA_DIR || process.env.DATAKHRIP_DATA_DIR;
const useLegacyStorage = !explicitDataDirectory && !existsSync(newDirectory) && existsSync(legacyDirectory);
// Electron sets its macOS Keychain service during startup, before app.ready.
// Existing installations retain that service and userData path after a rename.
app.setName(useLegacyStorage ? legacyName : productName);
app.setPath('userData', explicitDataDirectory || (useLegacyStorage ? legacyDirectory : newDirectory));
const sessions = new Map<string, SessionLease>();
const sessionPool = new SessionPool(prepareDriver);
const active = new Map<string, { query: QueryTask; sessionId: string; done: Promise<unknown> }>();
let window: BrowserWindow;
let profiles: ProfileStore;
let relations: RelationStore;
let updater: Updater;
let drivers: DriverManager;
let driversReady: Promise<void>;
let installingUpdate = false;
let pendingDatabaseOperations = 0;
const openingSessions = new Set<string>();
const hasTransactions = () => [...sessions.values()].some(entry => entry.session.inTransaction);
const entry = join(__dirname, '../dist/index.html');

function string(value: unknown, name: string, limit = 512): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || /[\r\n\0]/.test(value)) throw new Error(`Некорректное поле: ${name}`);
}
function validateDraft(value: ProfileDraft): void {
  if (!value || typeof value !== 'object') throw new Error('Некорректное подключение.');
  for (const key of ['name', 'endpoint', 'user', 'auth', 'catalog', 'schema', 'engine'] as const) string(value[key], key);
  if (typeof value.tls !== 'boolean') throw new Error('Некорректный TLS flag.');
  validateSSL(value);
  validateJdbc(value.jdbc);
  if (value.id !== undefined) string(value.id, 'id');
  if (value.secret !== undefined) string(value.secret, 'secret', 16384);
}

async function prepareDriver(connection: Connection): Promise<Connection> {
  if (!connection.jdbc) return connection;
  await driversReady;
  const extra = connection.jdbc.classpath ?? [];
  // Explicit external classpaths are self-contained; they must not be shadowed by bundled classes.
  if (extra.length) return { ...connection, driverClasspath: extra };
  return { ...connection, driverClasspath: await drivers.paths(profileDriver(connection), connection.jdbc.driverVersion) };
}

async function readMetadata(connection: Connection, input: Omit<MetadataInput, 'profileId'>): Promise<MetadataResult> {
  if (!input || typeof input !== 'object') throw new Error('Некорректный metadata request.');
  const identifiers = [input.catalog, input.schema, input.table];
  const depth = { catalogs: 0, schemas: 1, tables: 2, columns: 3 }[input.kind];
  if (depth === undefined) throw new Error('Неизвестный metadata request.');
  for (let i = 0; i < depth; i++) { string(identifiers[i], 'identifier'); if (!identifiers[i] && (connection.engine !== 'jdbc' || i === 2)) throw new Error('Пустой identifier.'); }
  const lease = await sessionPool.acquire(connection), session = lease.session;
  try {
    if (connection.engine === 'jdbc') return await session.inspect<MetadataResult>({ ...input, kind: 'metadata', operation: input.kind });
    const result = await session.createQuery(randomUUID(), 10000).run(metadataSQL(connection.engine, { ...input, profileId: connection.id }));
    if (result.state !== 'FINISHED') throw new Error(result.error ?? 'Запрос отменён.');
    return { columns: result.columns, rows: result.rows, truncated: result.truncated };
  } finally { await lease.release(); }
}

async function release(id: string): Promise<void> {
  if ([...active.values()].some(job => job.sessionId === id)) throw new Error('Сначала завершите или отмените запрос.');
  const stored = sessions.get(id);
  await stored?.release();
  sessions.delete(id);
}

function handle(name: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(entry).href) {
      throw new Error('Недоверенный IPC sender.');
    }
    const databaseOperation = ['query:run', 'profiles:test', 'metadata', 'schema:load', 'jdbc:properties', 'jdbc:preview', 'jdbc:browse', 'ssh:fingerprint', 'drivers:install', 'drivers:import', 'drivers:select'].includes(name);
    if (!databaseOperation) return fn(...args);
    if (installingUpdate) throw new Error('Приложение обновляется.');
    pendingDatabaseOperations++;
    return Promise.resolve().then(() => fn(...args)).finally(() => { pendingDatabaseOperations--; });
  });
}

void app.whenReady().then(() => {
  app.setName(productName);
  relations = new RelationStore(join(app.getPath('userData'), 'relationships.json'));
  const encryption = {
    encrypt(value: string) {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('Системное защищённое хранилище недоступно.');
      }
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  profiles = new ProfileStore(join(app.getPath('userData'), 'connections.json'), encryption);
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 680,
    title: 'Local DB Viewer', backgroundColor: '#101216', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => { void confirmUpdateStartup(join(app.getPath('userData'), 'updates'), app.getVersion()).catch(() => {}); });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  updater = new Updater(join(app.getPath('userData'), 'updates'), app.getVersion(), encryption,
    value => { if (!window.isDestroyed()) window.webContents.send('updates:change', value); },
    async (path, version) => {
      if (active.size || hasTransactions() || pendingDatabaseOperations || drivers?.isBusy()) throw new Error('Завершите запросы и выполните COMMIT или ROLLBACK перед обновлением.');
      installingUpdate = true;
      try { await installUpdate(path, version, async () => {
        if (active.size || hasTransactions()) throw new Error('Обнаружена активная сессия. Обновление отложено.');
        for (const id of [...sessions.keys()]) await release(id);
        await window.webContents.session.flushStorageData();
      }); } catch (error) { installingUpdate = false; throw error; }
    }, fetchUpdate);
  handle('updates:state', () => updater.state());
  handle('updates:configure', input => updater.configure(input));
  handle('updates:check', () => updater.check());
  handle('updates:download', () => updater.download());
  handle('updates:install', () => updater.install());
  drivers = new DriverManager(join(app.getPath('userData'), 'drivers'), bundledDrivers(), driverCatalogLock, fetchUpdate,
    () => updater.readDriverCatalog(), async (id, paths) => {
      const driver = driverDefinition(id);
      await inspectJdbc({ id: 'driver-probe', name: driver.name, engine: 'jdbc', endpoint: driver.url, user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { driverId: id }, driverClasspath: paths }, { kind: 'probe' });
    }, value => { if (!window.isDestroyed()) window.webContents.send('drivers:change', value); });
  driversReady = readFile(join(process.resourcesPath, 'update-config.json'), 'utf8').then(value => JSON.parse(value).repository ?? '').catch(() => '')
    .then(repository => updater.initialize(repository)).then(() => drivers.initialize());
  handle('drivers:state', async () => { await driversReady; return drivers.state(); });
  handle('drivers:check', async () => { await driversReady; return drivers.check(); });
  handle('drivers:automatic', async enabled => { await driversReady; return drivers.automatic(enabled); });
  handle('drivers:install', async id => { await driversReady; return drivers.install(id); });
  handle('drivers:select', async (id, key) => { await driversReady; return drivers.select(id, key); });
  handle('drivers:import', async (id, version) => {
    await driversReady; driverDefinition(id);
    const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'JDBC driver and dependencies', extensions: ['jar'] }] });
    if (result.canceled) return false;
    await drivers.import(id, version, result.filePaths); return true;
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Local DB Viewer', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Вид', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));

  handle('profiles:list', () => profiles.list());
  handle('jdbc:properties', async (draft: ProfileDraft) => {
    validateDraft(draft);
    // DriverPropertyInfo does not require opening a database connection.
    return describeDriver(await prepareDriver({ ...draft, id: draft.id ?? randomUUID() }));
  });
  handle('profiles:save', async (draft: ProfileDraft) => {
    validateDraft(draft);
    if (draft.id && sessionPool.hasProfile(draft.id)) throw new Error('Отключите консоли и дождитесь загрузки метаданных перед изменением подключения.');
    return profiles.save(draft);
  });
  handle('profiles:remove', async (id: string) => {
    string(id, 'id');
    for (const [sessionId, entry] of sessions) if (entry.profileId === id) await release(sessionId);
    await profiles.remove(id);
  });
  handle('profiles:test', async (draft: ProfileDraft) => {
    if (installingUpdate) throw new Error('Приложение обновляется.');
    validateDraft(draft);
    const connection = await prepareDriver(await profiles.resolve(draft));
    if (connection.jdbc) return inspectJdbc<string>(connection, { kind: 'test' }, (connection.jdbc.options?.connectTimeoutSeconds || 30) * 1000);
    const session = new DatabaseSession(await prepareDriver(connection));
    const query = session.createQuery(randomUUID(), 1);
    const id = randomUUID();
    const done = query.run('SELECT 1');
    active.set(id, { query, done, sessionId: id });
    try {
      const result = await done;
      if (result.state !== 'FINISHED') throw new Error(result.error ?? 'Запрос отменён.');
      return 'Соединение установлено · SELECT 1 выполнен';
    } finally { active.delete(id); await session.close(); }
  });
  handle('query:run', async (input: QueryInput) => {
    if (installingUpdate) throw new Error('Приложение обновляется.');
    if (!input || typeof input !== 'object' || typeof input.sql !== 'string' || !input.sql.trim() || input.sql.length > 1_000_000) throw new Error('Некорректный SQL.');
    for (const key of ['requestId', 'sessionId', 'profileId', 'catalog', 'schema'] as const) string(input[key], key);
    if (!input.requestId || !input.sessionId || active.has(input.requestId)) throw new Error('Некорректный request ID.');
    if ([...active.values()].some(job => job.sessionId === input.sessionId)) throw new Error('В этой консоли уже выполняется запрос.');
    const connection = await profiles.get(input.profileId);
    if (installingUpdate) throw new Error('Приложение обновляется.');
    if ([...active.values()].some(job => job.sessionId === input.sessionId)) throw new Error('В этой консоли уже выполняется запрос.');
    const previous = sessions.get(input.sessionId);
    if (previous && previous.profileId !== input.profileId) throw new Error('Консоль привязана к другому подключению.');
    if (openingSessions.has(input.sessionId)) throw new Error('Сессия уже открывается.');
    openingSessions.add(input.sessionId);
    let lease: SessionLease;
    try { lease = previous ?? await sessionPool.acquire(connection, input.sessionId); } finally { openingSessions.delete(input.sessionId); }
    const session = lease.session;
    sessions.set(input.sessionId, lease);
    const query = session.createQuery(input.requestId, input.maxRows, result => {
      if (!window.isDestroyed()) window.webContents.send('query:update', result);
    }, input.catalog, input.schema);
    const done = query.run(input.sql).finally(() => active.delete(input.requestId));
    active.set(input.requestId, { query, sessionId: input.sessionId, done });
    void done.catch(() => {});
  });
  handle('query:cancel', async (id: string) => { string(id, 'requestId'); await active.get(id)?.query.cancel(); });
  handle('query:release', async (id: string) => { string(id, 'sessionId'); await release(id); });
  handle('schema:load', async (input: SchemaInput) => {
    if (installingUpdate) throw new Error('Приложение обновляется.');
    if (!input || typeof input !== 'object') throw new Error('Некорректный запрос схемы.');
    for (const name of ['profileId', 'catalog', 'schema'] as const) string(input[name], name);
    const connection = await profiles.get(input.profileId);
    if (!schemaAllowed(connection.jdbc?.schemas, input.catalog, input.schema) || connection.jdbc?.options?.loadSystemSchemas === false && isSystemSchema(input.catalog, input.schema)) return { ...input, tables: [], relationships: [], warnings: [] };
    const lease = await sessionPool.acquire(connection), session = lease.session;
    try {
    if (connection.engine === 'jdbc') {
      const index = await session.inspect<SchemaIndex>({ ...input, kind: 'schema' });
      const visible = new Set(index.tables.map(table => JSON.stringify([table.catalog, table.schema, table.name])));
      index.relationships.push(...(await relations.list(input.profileId)).filter(relation => [relation.source, relation.target].some(table => visible.has(JSON.stringify([table.catalog, table.schema, table.name])))));
      return filterSchema(index, connection.jdbc?.schemas);
    }
      return filterSchema(await loadSchema(connection, input, async sql => {
        const id = randomUUID();
        const query = session.createQuery(id, 10000);
        const done = query.run(sql);
        active.set(id, { query, done, sessionId: id });
        const timeout = setTimeout(() => { void query.cancel().catch(() => {}); }, 60000);
        try {
          const result = await done;
          if (result.state !== 'FINISHED') throw new Error(result.error ?? 'Загрузка метаданных отменена или превысила 60 секунд.');
          return { columns: result.columns, rows: result.rows, truncated: result.truncated };
        } finally { clearTimeout(timeout); active.delete(id); }
      }, await relations.list(input.profileId)), connection.jdbc?.schemas);
    } finally { await lease.release(); }
  });
  handle('schema:save-relation', async (profileId: string, relation: Relationship) => {
    string(profileId, 'profileId');
    await profiles.get(profileId);
    validateRelation(relation);
    await relations.change(profileId, items => [...items.filter(item => item.id !== relation.id), relation]);
  });
  handle('schema:remove-relation', async (profileId: string, id: string) => {
    string(profileId, 'profileId'); string(id, 'id');
    await profiles.get(profileId);
    await relations.change(profileId, items => items.filter(item => item.id !== id));
  });
  handle('metadata', async (input: MetadataInput) => {
    if (!input || typeof input !== 'object') throw new Error('Некорректный metadata request.');
    string(input.profileId, 'profileId');
    const connection = await profiles.get(input.profileId);
    return filterMetadata(connection, input, await readMetadata(connection, input));
  });
  handle('jdbc:browse', async (draft: ProfileDraft, input: Omit<MetadataInput, 'profileId'>) => {
    validateDraft(draft);
    return readMetadata({ ...await profiles.resolve(draft), id: `draft:${randomUUID()}` }, input);
  });
  handle('ssh:fingerprint', sshFingerprint);
  handle('files:path', async (kind: string) => {
    if (!['certificate','key','store','ddl','executable'].includes(kind)) throw new Error('Неизвестный тип файла.');
    const result = await dialog.showOpenDialog(window, { title: kind, properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('jdbc:preview', async (input: MetadataInput) => {
    if (!input || typeof input !== 'object') throw new Error('Некорректный запрос таблицы.');
    for (const name of ['profileId', 'catalog', 'schema', 'table'] as const) string(input[name], name);
    if (!input.table) throw new Error('Укажите таблицу.');
    const lease = await sessionPool.acquire(await profiles.get(input.profileId));
    try { return await lease.session.inspect<string>({ ...input, kind: 'preview' }); } finally { await lease.release(); }
  });
  handle('export:csv', async (input) => {
    if (!input || !Array.isArray(input.columns) || !Array.isArray(input.rows) || input.rows.length > 10000 || !input.rows.every(Array.isArray)) throw new Error('Некорректный результат.');
    const result = await dialog.showSaveDialog(window, { defaultPath: 'result.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, csv(input.columns, input.rows), 'utf8');
    return true;
  });
  handle('files:open', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if (!path) throw new Error('Файл не выбран.');
    if ((await stat(path)).size > 1_000_000) throw new Error('SQL-файл превышает 1 MB.');
    return { name: path.split(/[\\/]/).pop()!, sql: await readFile(path, 'utf8') };
  });
  handle('files:database', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'Все файлы', extensions: ['*'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('files:certificate', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'CA certificates (PEM)', extensions: ['pem', 'crt', 'cer'] }] });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if (!path) throw new Error('Файл не выбран.');
    if ((await stat(path)).size > MAX_CA_BYTES) throw new Error('CA bundle превышает 256 KB.');
    return { name: path.split(/[\\/]/).pop()!, pem: validateCertificate(await readFile(path, 'utf8')) };
  });
  handle('files:save', async (sql: string) => {
    if (typeof sql !== 'string' || sql.length > 1_000_000) throw new Error('Некорректный SQL.');
    const result = await dialog.showSaveDialog(window, { defaultPath: 'query.sql', filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, sql, 'utf8');
    return true;
  });
  void window.loadFile(entry);
});

let exiting = false;
app.on('before-quit', event => {
  if (exiting) return;
  exiting = true;
  updater?.dispose();
  drivers?.dispose();
  event.preventDefault();
  const shutdownTimeout = setTimeout(() => { void sessionPool.abortAll().finally(() => app.exit(0)); }, 20000);
  void (async () => {
    const jobs = [...active.values()];
    await Promise.allSettled(jobs.map(job => job.query.cancel()));
    await Promise.allSettled(jobs.map(job => job.done));
    await Promise.allSettled([...sessions.keys()].map(release));
    await sessionPool.abortAll();
    clearTimeout(shutdownTimeout);
    app.quit();
  })();
});
app.on('window-all-closed', () => app.quit());
