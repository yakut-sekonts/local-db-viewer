import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { testUpdateNetwork } from './update-network.mjs';
import { installUpdateFixture, restoreUpdateFixture } from './update-fixture.mjs';
import { createHash } from 'node:crypto';

const root = resolve('.');
const artifacts = join(root, 'test-artifacts');
await mkdir(artifacts, { recursive: true });
const dataDirectory = await mkdtemp(join(tmpdir(), 'local-db-viewer-desktop-'));
await mkdir(join(dataDirectory, 'updates'));
await writeFile(join(dataDirectory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [root], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: dataDirectory }, timeout: 30000 });
const errors = [];
const page = await app.firstWindow();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await expect(page.getByText('От подключения — к данным.')).toBeVisible();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'welcome.png') });
  console.log('PASS: desktop opens, IPC bridge available, Monaco renders');
  await testUpdateNetwork(app, page, dataDirectory, artifacts);
  const database = join(dataDirectory, 'integration.sqlite');
  await app.evaluate(async (_electron, database) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, name TEXT, amount TEXT, note TEXT); INSERT INTO metrics VALUES (9223372036854775807, 'Revenue', '12345678901234567890.123456', NULL), (2, 'Orders', '4200.00', 'Quarterly report'), (3, 'Customers', '1800.00', 'Active');");
    db.exec("CREATE TABLE customers (tenant_id INTEGER, id INTEGER, name TEXT, PRIMARY KEY (tenant_id, id)); CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id INTEGER, customer_id INTEGER, amount TEXT, FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)); INSERT INTO customers VALUES (1, 10, 'Acme'); INSERT INTO orders VALUES (1, 1, 10, '120.00'), (2, 1, 10, '250.00');");
    db.close();
  }, database);
  await page.getByRole('button', { name: 'Подключить базу', exact: true }).click();
  await page.getByLabel('СУБД', { exact: true }).selectOption('sqlite');
  await page.getByLabel('Название', { exact: true }).fill('Local analytics');
  await page.locator('.endpoint-field input').fill(database);
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Соединение установлено', { timeout: 30000 });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'main', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.result-state')).toHaveText('FINISHED', { timeout: 30000 });
  await expect(page.locator('tbody tr')).toHaveCount(1);
  console.log('PASS: SQLite profile test, save, metadata and real SQL execution');

  async function execute(sql, expectedState = 'FINISHED') {
    return await page.evaluate(async ({ sql, expectedState }) => {
      const [profile] = await window.studio.profiles.list();
      const requestId = crypto.randomUUID();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Query timeout')); }, 20000);
        const unsubscribe = window.studio.query.onUpdate(result => {
          if (result.requestId !== requestId || result.state === 'RUNNING') return;
          clearTimeout(timeout); unsubscribe();
          if (result.state !== expectedState) reject(new Error(result.error ?? result.state)); else resolve(result);
        });
        window.studio.query.run({ requestId, sessionId: 'integration-session', profileId: profile.id, sql, catalog: '', schema: '', maxRows: 100 }).catch(error => { clearTimeout(timeout); unsubscribe(); reject(error); });
      });
    }, { sql, expectedState });
  }
  const result = await execute('SELECT id, amount, note FROM metrics WHERE name = \'Revenue\'');
  expect(result.rows).toEqual([['9223372036854775807', '12345678901234567890.123456', null]]);
  const duplicate = await execute('SELECT 1 AS x, 2 AS x');
  expect(duplicate.rows).toEqual([['1', '2']]);
  const begin = await execute('-- Start a transaction\n/* comment */ BEGIN'); expect(begin.inTransaction).toBe(true);
  await execute('SAVEPOINT retained');
  const savepoint = await execute('ROLLBACK TO retained'); expect(savepoint.inTransaction).toBe(true);
  await execute("INSERT INTO metrics VALUES (4, 'rollback-test', '0', NULL)");
  await page.evaluate(() => window.studio.query.release('integration-session'));
  const rollback = await execute("SELECT COUNT(*) FROM metrics WHERE name = 'rollback-test'");
  expect(rollback.rows).toEqual([['0']]);
  expect((await execute('SAVEPOINT outside_begin')).inTransaction).toBe(true);
  await execute("INSERT INTO metrics VALUES (4, 'savepoint-test', '0', NULL)");
  await page.evaluate(() => window.studio.query.release('integration-session'));
  expect((await execute("SELECT COUNT(*) FROM metrics WHERE name = 'savepoint-test'")).rows).toEqual([['0']]);
  await execute('SAVEPOINT already_released'); await execute('RELEASE already_released');
  await page.evaluate(() => window.studio.query.release('integration-session'));
  await execute('SELECT * FROM missing_table', 'FAILED');
  await execute('SELECT 1; SELECT 2').then(() => { throw new Error('Multiple statements accepted'); }, error => expect(error.message).toContain('одну SQL-команду'));
  expect((await execute('SELECT 1')).rows).toEqual([['1']]);
  console.log('PASS: bigint, NULL, duplicate column names, transaction rollback on close, SQL errors');

  const cancel = await page.evaluate(async () => {
    const [profile] = await window.studio.profiles.list();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Cancellation timeout')); }, 15000);
      const unsubscribe = window.studio.query.onUpdate(result => {
        if (result.requestId === requestId && result.state !== 'RUNNING') { clearTimeout(timeout); unsubscribe(); resolve(result); }
      });
      window.studio.query.run({ requestId, sessionId: 'cancel-session', profileId: profile.id, sql: 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<100000000) SELECT sum(n) FROM x', catalog: '', schema: '', maxRows: 100 }).then(() => window.studio.query.cancel(requestId)).catch(reject);
    });
  });
  expect(cancel.state).toBe('CANCELED');
  console.log('PASS: SQLite long-running query cancellation keeps UI responsive');

  // Open metadata through the actual tree and preview a table in Monaco.
  await page.getByRole('button', { name: 'main', exact: true }).click();
  await expect(page.getByRole('button', { name: 'main', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'main', exact: true }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Открыть SELECT metrics' })).toBeAttached({ timeout: 30000 });
  await page.getByRole('button', { name: 'metrics', exact: true }).hover();
  await page.getByRole('button', { name: 'Открыть SELECT metrics' }).click();
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.result-state')).toHaveText('FINISHED', { timeout: 30000 });
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.screenshot({ path: join(artifacts, 'local-db-viewer-desktop.png') });
  console.log('PASS: database tree → table preview → real result grid');

  const csvPath = join(artifacts, 'result.csv');
  await app.evaluate(({ dialog }, csvPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: csvPath }); }, csvPath);
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await expect.poll(async () => { try { return await readFile(csvPath, 'utf8'); } catch { return ''; } }).toContain('9223372036854775807');
  console.log('PASS: CSV exported through native save workflow');

  const schemaIndex = await page.evaluate(async () => {
    const [profile] = await window.studio.profiles.list();
    return window.studio.schema.load({ profileId: profile.id, catalog: '', schema: '' });
  });
  expect(schemaIndex.tables.map(table => table.name)).toEqual(['customers', 'metrics', 'orders']);
  expect(schemaIndex.relationships[0].columns).toEqual([{ source: 'tenant_id', target: 'tenant_id' }, { source: 'customer_id', target: 'id' }]);
  expect(schemaIndex.warnings).toEqual([]);
  console.log('PASS: real SQLite schema introspection with composite foreign key');

  async function setSQL(sql) {
    await page.locator('.monaco-editor').click({ position: { x: 100, y: 20 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.insertText(sql);
    await page.keyboard.press('Escape');
  }
  await setSQL('SELECT * FROM orders o WHERE o.');
  await page.keyboard.press('Control+Space');
  const popup = page.locator('.suggest-widget.visible');
  await expect(popup).toBeVisible({ timeout: 30000 });
  await expect(popup).toContainText('customer_id');
  await popup.locator('.monaco-list-row').filter({ hasText: 'customer_id' }).first().click();
  await expect(page.locator('.view-lines')).toContainText('"customer_id"');
  console.log('PASS: Monaco alias.column popup and accepted completion');

  await setSQL('SELECT * FROM orders o JOIN ');
  await page.keyboard.press('Control+Space');
  await expect(popup).toBeVisible({ timeout: 30000 });
  const joinItem = popup.locator('.monaco-list-row').filter({ hasText: 'customers — ON' }).first();
  await expect(joinItem).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'local-db-viewer-autocomplete.png') });
  await joinItem.click();
  await expect(page.locator('.view-lines')).toContainText('AND');
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.result-state')).toHaveText('FINISHED', { timeout: 30000 });
  await expect(page.locator('tbody tr')).toHaveCount(2);
  console.log('PASS: accepted composite JOIN executes against SQLite');

  await page.getByRole('button', { name: 'Связи таблиц', exact: true }).click();
  await expect(page.locator('.relationships-dialog')).toBeVisible();
  await expect(page.locator('.relation-list')).toContainText('Foreign key');
  await page.getByLabel('Исходная таблица', { exact: true }).selectOption({ label: 'main.main.metrics' });
  await page.getByLabel('Связанная таблица', { exact: true }).selectOption({ label: 'main.main.orders' });
  await page.getByLabel('Исходная колонка 1', { exact: true }).selectOption('id');
  await page.getByLabel('Связанная колонка 1', { exact: true }).selectOption('id');
  await page.getByLabel('Название связи', { exact: true }).fill('metrics_orders_virtual');
  await page.getByRole('button', { name: 'Добавить связь', exact: true }).click();
  await expect(page.locator('.relation-list')).toContainText('metrics_orders_virtual');
  const savedRelations = JSON.parse(await readFile(join(dataDirectory, 'relationships.json'), 'utf8'));
  expect(Object.values(savedRelations)[0][0].kind).toBe('virtual');
  await page.getByRole('button', { name: 'Закрыть связи', exact: true }).click();
  await setSQL('SELECT * FROM metrics m JOIN ');
  await page.keyboard.press('Control+Space');
  await expect(popup).toContainText('orders — ON', { timeout: 30000 });
  await page.keyboard.press('Escape');
  console.log('PASS: virtual relation saved through UI, persisted and offered as JOIN');

  const architecture = await app.evaluate(() => process.arch);
  if ((process.platform === 'darwin' && architecture === 'arm64') || (process.platform === 'win32' && architecture === 'x64')) {
    const bytes = 'local update fixture';
    await installUpdateFixture(app, { version: '9.9.9', bytes, size: Buffer.byteLength(bytes), digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
    await page.getByRole('button', { name: 'Обновления Local DB Viewer', exact: true }).click();
    await expect(page.locator('.update-dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Проверить обновления', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Настройки доступа к обновлениям', exact: true }).click();
    await page.getByLabel('GitHub-репозиторий', { exact: true }).fill('owner/releases');
    await page.getByLabel(/^Личный токен GitHub/).fill('fixture-private-update-token');
    await page.getByLabel('Проверять при запуске и каждые 15 минут').uncheck();
    await page.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
    await expect(page.locator('.release-notes')).toContainText('Test release notes');
    await page.getByRole('button', { name: 'Закрыть обновления', exact: true }).click();
    await expect(page.locator('.update-toast')).toContainText('9.9.9');
    await page.getByRole('button', { name: 'Посмотреть обновление', exact: true }).click();
    await execute('BEGIN');
    await page.getByRole('button', { name: 'Обновить и перезапустить', exact: true }).click();
    await expect(page.locator('.update-dialog .form-message')).toContainText('COMMIT', { timeout: 30000 });
    const updateState = await page.evaluate(() => window.studio.updates.state());
    expect(updateState.phase).toBe('ready');
    expect(JSON.stringify(updateState)).not.toContain('fixture-private-update-token');
    expect(await readFile(join(dataDirectory, 'updates/settings.json'), 'utf8')).not.toContain('fixture-private-update-token');
    await execute('ROLLBACK');
    await page.screenshot({ path: join(artifacts, 'updates.png') });
    await page.getByRole('button', { name: 'Закрыть обновления', exact: true }).click();
    await restoreUpdateFixture(app);
    console.log('PASS: update notification, private credentials, verified download and transaction-safe restart guard');
  }
  expect(errors).toEqual([]);
  console.log('PASS: no renderer errors');
  await writeFile(join(artifacts, 'desktop-results.json'), JSON.stringify({ passed: true, checks: 14, platform: process.platform, architecture: await app.evaluate(() => process.arch), testedAt: new Date().toISOString() }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally { await app.close(); }
