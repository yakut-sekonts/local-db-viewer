import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { confirmExecution } from './ui-helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-history-'));
for (const name of ['drivers', 'updates']) await mkdir(join(directory, name));
await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
await mkdir('test-artifacts', { recursive: true });
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory } });
const page = await app.firstWindow(), errors = [], checks = [], database = join(directory, 'history.sqlite');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
page.on('pageerror', error => errors.push(error.message));
try {
  await app.evaluate((_, path) => { const { DatabaseSync } = process.getBuiltinModule('node:sqlite'); const db = new DatabaseSync(path); db.exec('CREATE TABLE writes(id INTEGER PRIMARY KEY, label TEXT)'); db.close(); }, database);
  const profiles = await page.evaluate(async endpoint => {
    const a = await window.studio.profiles.save({ name: 'История · SQLite', engine: 'sqlite', endpoint, user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { driverId: 'sqlite', defaultSessionTemplate: 'analyst', sessionTemplates: [{ id: 'analyst', name: 'Аналитик' }, { id: 'other', name: 'Другой шаблон' }], options: { autoSync: false, loadSources: 'none', switchSchema: 'manual' } } });
    const b = await window.studio.profiles.save({ name: 'Другое подключение', engine: 'sqlite', endpoint, user: '', auth: 'none', tls: false, catalog: '', schema: '' });
    const base = { profileId: a.id, profileName: a.name, catalog: '', schema: '', state: 'FINISHED', duration: 17, time: 100, sql: 'SELECT 1', templateId: '' };
    const history = [
      { ...base, id: 'pinned', sql: "-- Закреплённый 名🙂\nSELECT 'exact text';", pinned: true, time: 0 },
      { ...base, id: 'removed', profileId: 'deleted-profile', profileName: 'Удалённая БД', sql: 'SELECT removed', state: 'FAILED', time: 1 },
      { ...base, id: 'missing-template', templateId: 'deleted-template', templateName: 'Удалённый шаблон', sql: 'SELECT template', time: 2 },
      { ...base, id: 'legacy', templateId: undefined, sql: 'SELECT legacy', time: 3 },
      { ...base, id: 'context', catalog: 'saved_catalog', schema: 'saved_schema', searchPath: '"saved schema", public', templateId: 'analyst', templateName: 'Аналитик', sql: 'SELECT context', time: 4 },
      { ...base, id: 'canceled', profileId: b.id, profileName: b.name, sql: 'SELECT canceled', state: 'CANCELED', time: 5 },
      ...Array.from({ length: 93 }, (_, i) => ({ ...base, id: `old-${i}`, sql: `SELECT ${i} AS older`, time: i + 6 })),
      { ...base, id: 'oldest', time: 0 },
    ];
    localStorage.setItem('studio.history', JSON.stringify([null, { bad: true }, ...history]));
    return { a, b };
  }, database);
  await page.reload(); await page.getByLabel('Подключение', { exact: true }).selectOption(profiles.a.id);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('studio.history') || '[]'));
  const openPanel = () => page.getByRole('button', { name: 'История запросов', exact: true }).click();
  const entry = id => page.locator(`.history-entry[data-history-id="${id}"]`);
  const dialog = page.locator('.history-dialog');
  async function preview(id) { await entry(id).locator('.history-item').click(); await expect(dialog).toBeVisible(); }
  async function sql(text) { await page.locator('.monaco-editor').click({ position: { x: 120, y: 20 } }); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text); await page.keyboard.press('Escape'); }
  async function rows() { return app.evaluate((_, path) => { const { DatabaseSync } = process.getBuiltinModule('node:sqlite'); const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT * FROM writes ORDER BY id').all(); } finally { db.close(); } }, database); }
  await openPanel(); await expect(page.getByLabel('Количество записей истории')).toHaveText('100 / 100');
  await expect(page.locator('.history-entry').first()).toHaveAttribute('data-history-id', 'pinned');
  await page.getByLabel('Поиск в истории', { exact: true }).fill('ЗАКРЕПЛЁННЫЙ'); await expect(page.locator('.history-entry')).toHaveCount(1);
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.getByLabel('Подключение в истории').selectOption(profiles.b.id); await page.getByLabel('Результат в истории').selectOption('CANCELED');
  await expect(page.locator('.history-entry')).toHaveCount(1); await expect(entry('canceled')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await preview('pinned'); await expect(page.getByLabel('SQL из истории', { exact: true })).toHaveAttribute('readonly', '');
  await dialog.getByRole('button', { name: 'Копировать SQL', exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("-- Закреплённый 名🙂\nSELECT 'exact text';");
  await page.keyboard.press(`${modifier}+t`); await expect(page.locator('.console-tab')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(await rows()).toEqual([]);
  checks.push('legacy/corrupt records, Unicode search, connection/status filters, pinned ordering, literal clipboard and modal keyboard isolation');

  const script = "INSERT INTO writes VALUES(1, 'history confirmed');\nSELECT label FROM writes;";
  await sql(script); await page.getByLabel('Лимит строк').selectOption('100');
  await page.getByRole('button', { name: 'Запустить SQL-скрипт', exact: true }).click(); await confirmExecution(page);
  await expect(page.locator('.script-state')).toHaveText('Скрипт · FINISHED', { timeout: 30000 });
  await expect.poll(async () => (await stored()).filter(item => item.mode === 'script').length).toBe(1);
  const record = (await stored()).find(item => item.mode === 'script');
  expect(record.profileId).toBe(profiles.a.id); expect(record.templateId).toBe('analyst'); expect(record.templateName).toBe('Аналитик'); expect(record.maxRows).toBe(100);
  expect((await stored()).length).toBe(100); expect((await stored()).some(item => item.id === 'pinned')).toBe(true); expect((await stored()).some(item => item.id === 'oldest')).toBe(false);
  await page.getByLabel('Подключение', { exact: true }).selectOption(profiles.b.id);
  await preview(record.id); await expect(dialog).toContainText('Скрипт из истории');
  await dialog.getByRole('button', { name: 'Открыть в новой консоли', exact: true }).click();
  await expect(page.getByLabel('Подключение', { exact: true })).toHaveValue(profiles.a.id);
  await expect(page.getByLabel('Шаблон SQL-сессии', { exact: true })).toHaveValue('analyst');
  await expect(page.getByLabel('Лимит строк')).toHaveValue('100'); await expect(page.locator('.console-tab')).toHaveCount(2);
  expect((await rows()).length).toBe(1);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs') || '[]').at(-1)?.sql)).toBe(record.sql);
  expect((await stored()).filter(item => item.mode === 'script').length).toBe(1);
  checks.push('actual JDBC script records once with resolved default template and limit; reopening is a new console and never executes SQL');

  // Each fixture starts in the bounded history. New records only evict its oldest unpinned entry.
  await preview('removed'); await expect(dialog).toContainText('Подключение удалено');
  await dialog.getByRole('button', { name: 'Открыть в новой консоли', exact: true }).click();
  await expect(page.getByLabel('Подключение', { exact: true })).toHaveValue('');
  await page.getByLabel('Подключение', { exact: true }).selectOption(profiles.b.id);
  await preview('missing-template'); await expect(dialog).toContainText('Шаблон сессии удалён');
  await dialog.getByRole('button', { name: 'Открыть в новой консоли', exact: true }).click();
  await expect(page.getByLabel('Подключение', { exact: true })).toHaveValue('');
  await preview('legacy'); await expect(dialog).toContainText('текущий шаблон по умолчанию'); await page.keyboard.press('Escape');
  await preview('context'); await expect(dialog).toContainText('"saved schema", public');
  await dialog.getByRole('button', { name: 'Открыть в новой консоли', exact: true }).click();
  await expect(page.getByLabel('Catalog', { exact: true })).toHaveValue('saved_catalog'); await expect(page.getByLabel('Schema', { exact: true })).toHaveValue('saved_schema');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs') || '[]').at(-1)?.searchPath)).toBe('"saved schema", public');
  await page.reload(); await openPanel();
  const restoredTabs = await page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs') || '[]'));
  expect(restoredTabs.at(-1).catalog).toBe('saved_catalog'); expect(restoredTabs.at(-1).schema).toBe('saved_schema'); expect(restoredTabs.at(-1).templateId).toBe('analyst'); expect(restoredTabs.at(-1).applyContext).toBe(true);
  expect((await stored()).find(item => item.id === 'pinned').pinned).toBe(true); expect((await rows()).length).toBe(1);
  checks.push('removed connection/template cannot fall back to the active profile; saved schema/search_path/template and pins survive workspace reload');

  await preview('pinned'); await dialog.getByRole('button', { name: 'Удалить запись', exact: true }).click();
  await dialog.getByRole('button', { name: 'Оставить', exact: true }).click(); expect((await stored()).some(item => item.id === 'pinned')).toBe(true);
  await dialog.getByRole('button', { name: 'Удалить запись', exact: true }).click(); await dialog.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(entry('pinned')).toHaveCount(0);
  await preview('legacy'); await dialog.getByRole('button', { name: 'Закрепить', exact: true }).click();
  await dialog.getByRole('button', { name: 'Открепить', exact: true }).click();
  await dialog.getByRole('button', { name: 'Закрепить', exact: true }).click(); await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Закреплённые', exact: true }).check(); await expect(page.locator('.history-entry')).toHaveCount(1); await expect(entry('legacy')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  // A failed SQL execution is also searchable and does not replace the last successful history record.
  await page.getByLabel('Подключение', { exact: true }).selectOption(profiles.b.id); await sql('SELECT * FROM missing_history_table');
  await page.getByRole('button', { name: 'Выполнить', exact: false }).click(); await confirmExecution(page);
  await expect(page.locator('.result-state')).toHaveText('FAILED', { timeout: 30000 });
  await page.getByLabel('Поиск в истории', { exact: true }).fill('missing_history_table'); await page.getByLabel('Результат в истории').selectOption('FAILED');
  await expect(page.locator('.history-entry')).toHaveCount(1);
  // Remove the isolated fixture behind the renderer to fail before a query worker starts.
  await page.evaluate(id => window.studio.profiles.remove(id), profiles.b.id);
  await sql('SELECT 1 AS connection_missing'); await page.getByRole('button', { name: 'Выполнить', exact: false }).click(); await confirmExecution(page);
  await expect(page.locator('.result-state')).toHaveText('FAILED');
  await expect.poll(async () => (await stored()).filter(item => item.sql === 'SELECT 1 AS connection_missing' && item.state === 'FAILED').length).toBe(1);
  await page.reload(); await openPanel(); expect((await stored()).some(item => item.id === 'pinned')).toBe(false); expect((await stored()).find(item => item.id === 'legacy').pinned).toBe(true);
  await page.getByLabel('Поиск в истории', { exact: true }).fill('history confirmed'); await preview(record.id);
  await page.screenshot({ path: 'test-artifacts/history-desktop.png' });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.screenshot({ path: 'test-artifacts/history-panel.png' });
  checks.push('explicit delete confirmation, pin/unpin persistence, actual failed SQL search and a single record on connection setup rejection');
  expect(errors).toEqual([]);
  await writeFile('test-artifacts/history-desktop.json', JSON.stringify({ passed: true, platform: process.platform, checks, rendererErrors: errors }, null, 2));
  checks.forEach(check => console.log(`PASS: ${check}`));
} catch (error) { await page.screenshot({ path: 'test-artifacts/history-failure.png' }).catch(() => {}); throw error; }
finally { await app.close(); }
