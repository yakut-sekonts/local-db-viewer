import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const fixtures = JSON.parse(await readFile('tests/driver-fixtures.json', 'utf8')).drivers;
const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-jdbc-ui-'));
await mkdir(join(directory, 'drivers/objects'), { recursive: true });
await mkdir(join(directory, 'updates'));
await mkdir('test-artifacts', { recursive: true });
await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
const old = fixtures['h2-old'];
for (const file of old.files) await copyFile(resolve('.runtime-cache/maven/repository', file.path), join(directory, 'drivers/objects', file.sha256 + '.jar'));
await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: { h2: [{ ...old, source: 'download', paths: [] }] }, selected: { h2: old.key } }));
await writeFile(join(directory, 'drivers/catalog.json'), JSON.stringify({ format: 1, drivers: { h2: old } }));
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory } });
const page = await app.firstWindow(), errors = [];
page.on('pageerror', error => errors.push(error.message));
let server;
try {
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await app.evaluate(({ net }, { fixtures, root }) => {
    const { EventEmitter } = process.getBuiltinModule('node:events'), { Readable } = process.getBuiltinModule('node:stream'), { createReadStream } = process.getBuiltinModule('node:fs'), { join } = process.getBuiltinModule('node:path');
    net.request = options => {
      const url = String(options.url); let source;
      if (url === 'https://api.github.com/repos/fixture/public/contents/catalog.json?ref=driver-catalog') source = () => Readable.from([Buffer.from(JSON.stringify({ format: 1, drivers: { h2: fixtures.h2, duckdb: fixtures.duckdb } }))]);
      else if (url.startsWith('https://repo.maven.apache.org/maven2/')) source = () => createReadStream(join(root, url.slice('https://repo.maven.apache.org/maven2/'.length)));
      else throw new Error('Unexpected driver fixture URL');
      const request = new EventEmitter(); let response;
      request.setHeader = () => {}; request.abort = () => { response?.destroy(); request.emit('close'); };
      request.end = () => queueMicrotask(() => { response = source(); response.statusCode = 200; response.headers = {}; response.once('close', () => request.emit('close')); request.emit('response', response); });
      return request;
    };
  }, { fixtures, root: resolve('.runtime-cache/maven/repository') });
  async function query(profileId, sessionId, sql) {
    return page.evaluate(async ({ profileId, sessionId, sql }) => {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Query timed out')); }, 30000);
        const off = window.studio.query.onUpdate(value => { if (value.requestId === requestId && value.state !== 'RUNNING') { clearTimeout(timer); off(); value.state === 'FINISHED' ? resolve(value) : reject(new Error(value.error)); } });
        window.studio.query.run({ requestId, sessionId, profileId, sql, catalog: '', schema: '', maxRows: 100 }).catch(error => { clearTimeout(timer); off(); reject(error); });
      });
    }, { profileId, sessionId, sql });
  }
  const draft = { name: 'H2 versions', engine: 'jdbc', endpoint: 'jdbc:h2:mem:version_fixture', user: 'sa', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { driverId: 'h2', productId: 'h2' } };
  const profile = await page.evaluate(draft => window.studio.profiles.save(draft), draft);
  expect((await query(profile.id, 'old-session', 'SELECT H2VERSION()')).rows).toEqual([['2.3.232']]);
  await page.evaluate(() => window.studio.drivers.check());
  await expect(page.locator('.driver-toast')).toContainText('Доступны обновления');
  await page.getByRole('button', { name: 'Посмотреть', exact: true }).click();
  await page.getByRole('button', { name: `Установить ${fixtures.h2.version}`, exact: true }).click();
  await expect(page.getByLabel('Активная версия драйвера')).toHaveValue(fixtures.h2.key, { timeout: 45000 });
  expect((await query(profile.id, 'new-session', 'SELECT H2VERSION()')).rows).toEqual([[fixtures.h2.version]]);
  expect((await query(profile.id, 'old-session', 'SELECT H2VERSION()')).rows).toEqual([['2.3.232']]);
  await page.getByLabel('Активная версия драйвера').selectOption(old.key);
  expect((await query(profile.id, 'rollback-session', 'SELECT H2VERSION()')).rows).toEqual([['2.3.232']]);
  await page.getByLabel('Активная версия драйвера').selectOption(fixtures.h2.key);
  await page.screenshot({ path: 'test-artifacts/driver-center.png' });
  await page.getByRole('button', { name: 'Закрыть драйверы', exact: true }).click();
  console.log('PASS: driver notification, verified download, two actual H2 versions, existing-session isolation and rollback');
  for (const session of ['old-session','new-session','rollback-session']) await page.evaluate(id => window.studio.query.release(id), session);

  // Create a generic JDBC profile through the actual form.
  await page.getByRole('button', { name: 'Добавить подключение', exact: true }).click();
  await page.getByLabel('СУБД', { exact: true }).selectOption('h2');
  await page.getByLabel('Название', { exact: true }).fill('H2 metadata');
  const endpoint = 'jdbc:h2:' + join(directory, 'metadata').replaceAll('\\', '/') + ';AUTO_SERVER=TRUE';
  await page.locator('.endpoint-field input').fill(endpoint);
  await page.getByLabel('Пользователь', { exact: true }).fill('sa');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.locator('.connection-dialog [role=status]')).toContainText('Соединение установлено', { timeout: 30000 });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const h2 = await page.evaluate(async () => (await window.studio.profiles.list()).find(profile => profile.name === 'H2 metadata'));
  for (const sql of [
    'CREATE TABLE parents (tenant INT, id INT, PRIMARY KEY(tenant,id))',
    'CREATE TABLE children (tenant INT, id INT, note VARCHAR(100), CONSTRAINT fk_parent FOREIGN KEY(tenant,id) REFERENCES parents(tenant,id))',
    'CREATE TABLE childXren (wrong INT)',
    'CREATE TABLE "under_score" (expected INT)',
    'CREATE TABLE "underXscore" (unexpected INT)',
    "INSERT INTO parents VALUES (1, 2)", "INSERT INTO children VALUES (1, 2, 'Готово 🌍')",
  ]) await query(h2.id, 'metadata', sql);
  await page.evaluate(() => window.studio.query.release('metadata'));
  const index = await page.evaluate(profileId => window.studio.schema.load({ profileId, catalog: '', schema: '' }), h2.id);
  expect(index.tables.find(table => table.name === 'CHILDREN').columns.map(column => column.name)).toEqual(['TENANT','ID','NOTE']);
  expect(index.relationships.find(relation => relation.name === 'FK_PARENT').columns).toEqual([{source:'TENANT',target:'TENANT'},{source:'ID',target:'ID'}]);
  const columns = await page.evaluate(input => window.studio.metadata(input), { profileId: h2.id, kind: 'columns', catalog: index.catalog, schema: index.schema, table: 'under_score' });
  expect(columns.rows.map(row => row[0])).toEqual(['EXPECTED']);
  const preview = await page.evaluate(input => window.studio.jdbc.preview(input), { profileId: h2.id, kind: 'columns', catalog: index.catalog, schema: index.schema, table: 'CHILDREN' });
  expect((await query(h2.id, 'preview', preview)).rows).toEqual([['1','2','Готово 🌍']]);
  await page.evaluate(() => window.studio.query.release('preview'));
  await page.getByRole('button', { name: 'Обновить дерево', exact: true }).click();
  await page.getByRole('button', { name: index.catalog, exact: true }).click();
  await page.getByRole('button', { name: index.schema, exact: true }).click();
  await page.getByRole('button', { name: 'CHILDREN', exact: true }).click();
  await expect(page.locator('.column-node').filter({ hasText: 'NOTE' })).toBeVisible();
  await page.getByRole('button', { name: 'Обновить автодополнение', exact: true }).click();
  await page.locator('.monaco-editor').click({ position: { x: 100, y: 20 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText('SELECT * FROM CHILDREN c JOIN '); await page.keyboard.press('Escape'); await page.keyboard.press('Control+Space');
  const popup = page.locator('.suggest-widget.visible');
  await expect(popup).toContainText('PARENTS — ON', { timeout: 30000 });
  await popup.getByText(/^PARENTS — ON/).click(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.locator('.result-state')).toHaveText('FINISHED', { timeout: 30000 });
  await expect(page.locator('tbody tr')).toHaveCount(1);
  console.log('PASS: H2 connection UI, generic catalogs/schemas/tables/columns, escaped metadata patterns, composite FK, quoted preview and Unicode data');
  console.log('PASS: accepted generic JDBC JOIN uses driver quoting and H2 uppercase alias rules');

  await page.evaluate(() => window.studio.drivers.install('duckdb'));
  const duck = await page.evaluate(draft => window.studio.profiles.save(draft), { ...draft, name: 'DuckDB fixture', endpoint: 'jdbc:duckdb:', jdbc: { driverId: 'duckdb', productId: 'duckdb' } });
  expect((await query(duck.id, 'duckdb', "SELECT 9223372036854775807::BIGINT AS id, 'Данные' AS note")).rows).toEqual([['9223372036854775807', 'Данные']]);
  await page.evaluate(() => window.studio.query.release('duckdb'));
  console.log('PASS: DuckDB native library loads and returns exact BIGINT/Unicode on host architecture');

  const requests = [];
  server = createServer(async (request, response) => {
    let sql = ''; for await (const chunk of request) sql += chunk; requests.push(sql);
    let rows = [], error;
    if (sql === 'SHOW CATALOGS') rows = [['hive'], ['iceberg']];
    else if (sql.includes('SHOW SCHEMAS')) rows = [['ods']];
    else if (sql.includes('SHOW TABLES')) rows = [['shk_on_place']];
    else if (sql.includes('SHOW COLUMNS') && sql.includes('"hive"')) error = { message: "Cannot query Iceberg table 'ods.shk_on_place'", errorCode: 1, errorName: 'UNSUPPORTED_TABLE_TYPE', errorType: 'USER_ERROR' };
    else if (sql.includes('SHOW COLUMNS')) rows = [['id', 'bigint']];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'iceberg-fixture', infoUri: 'http://localhost/query', columns: [{name:'name',type:'varchar'},{name:'type',type:'varchar'}], data: rows, ...(error ? { error } : {}), stats: { state: 'FINISHED' }, warnings: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const trino = await page.evaluate(draft => window.studio.profiles.save(draft), { name: 'Iceberg routing', engine: 'trino', endpoint: `http://127.0.0.1:${server.address().port}`, user: 'fixture', auth: 'none', tls: false, catalog: '', schema: '' });
  // Reload profiles from disk, as saving by IPC does not update React's list.
  await page.reload(); await page.getByLabel('Подключение', { exact: true }).selectOption(trino.id);
  await page.getByRole('button', { name: 'hive', exact: true }).click();
  await page.getByRole('button', { name: 'ods', exact: true }).click();
  await page.getByRole('button', { name: 'shk_on_place', exact: true }).click();
  await expect(page.locator('.tree-recovery')).toContainText('connector');
  expect(requests.filter(sql => sql.includes('SHOW COLUMNS') && sql.includes('"iceberg"'))).toHaveLength(0);
  await page.getByLabel('Другой каталог для shk_on_place').selectOption('iceberg');
  await page.getByRole('button', { name: 'Открыть в выбранном каталоге' }).click();
  await expect(page.locator('.column-node')).toContainText('id');
  await expect(page.locator('.tree-catalog-override')).toHaveText('Каталог: iceberg');
  await page.getByRole('button', { name: 'Открыть SELECT shk_on_place' }).click();
  await expect(page.locator('.monaco-editor')).toContainText('iceberg');
  await page.screenshot({ path: 'test-artifacts/iceberg-recovery.png' });
  expect(errors).toEqual([]);
  console.log('PASS: Hive/Iceberg metadata error, explicit catalog selection, corrected columns and preview; no silent substitution');
  await writeFile('test-artifacts/driver-desktop-results.json', JSON.stringify({ passed: true, platform: process.platform, arch: await app.evaluate(() => process.arch), versions: [old.version, fixtures.h2.version], checks: ['updates','session-isolation','rollback','H2-metadata','composite-FK','DuckDB','Iceberg-routing'] }, null, 2));
} catch (error) { await page.screenshot({ path: 'test-artifacts/driver-failure.png' }).catch(() => {}); throw error; }
finally { server?.close(); await app.close(); }
