import { confirmExecution } from './ui-helpers.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-script-'));
await mkdir('test-artifacts', { recursive: true });
await mkdir(join(directory, 'updates'));
await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
await mkdir(join(directory, 'drivers/objects'), { recursive: true });
const h2 = JSON.parse(await readFile('tests/driver-fixtures.json', 'utf8')).drivers.h2;
for (const file of h2.files) await copyFile(resolve('.runtime-cache/maven/repository', file.path), join(directory, 'drivers/objects', file.sha256 + '.jar'));
await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: { h2: [{ ...h2, source: 'download', paths: [] }] }, selected: { h2: h2.key } }));
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory } });
const page = await app.firstWindow(), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
try {
  await expect(page.locator('.monaco-editor')).toBeVisible();
  const profile = await page.evaluate(endpoint => window.studio.profiles.save({ name: 'Script fixture', engine: 'sqlite', endpoint, user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: {} }), join(directory, 'fixture.sqlite'));
  await page.reload();
  await page.getByLabel('Подключение', { exact: true }).selectOption(profile.id);
  async function sql(text) {
    await page.locator('.monaco-editor').click({ position: { x: 120, y: 20 } });
    await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text); await page.keyboard.press('Escape');
  }
  async function execute(text, options = {}) {
    return page.evaluate(async ({ text, options, profileId }) => {
      const requestId = crypto.randomUUID(), events = [];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('SQL timeout')); }, 45000);
        const off = window.studio.query.onUpdate(value => {
          if (value.requestId !== requestId) return;
          events.push(value);
          if ((value.script?.state ?? value.state) === 'RUNNING') return;
          clearTimeout(timer); off(); resolve({ result: value, events });
        });
        window.studio.query.run({ requestId, sessionId: 'api-session', profileId, sql: text, catalog: '', schema: '', maxRows: 100, mode: 'script', ...options }).catch(error => { clearTimeout(timer); off(); reject(error); });
      });
    }, { text, options, profileId: profile.id });
  }
  const script = "CREATE TABLE script_rows (id INTEGER, label TEXT);\nINSERT INTO script_rows VALUES (9223372036854775807, 'a;б 名');\nSELECT id, label FROM script_rows;\nSELECT count(*) AS amount FROM script_rows;";
  await sql(script);
  await page.getByRole('button', { name: 'Запустить SQL-скрипт', exact: true }).click();
  await confirmExecution(page);
  await expect(page.locator('.script-state')).toHaveText('Скрипт · FINISHED', { timeout: 30000 });
  await expect(page.locator('.script-tabs [role=tab]')).toHaveCount(4);
  await expect(page.locator('.script-summary')).toContainText('Завершено 4 из 4');
  await page.locator('.script-tabs [role=tab]').nth(2).click();
  await expect(page.locator('.grid-scroll tbody')).toContainText('9223372036854775807');
  await expect(page.locator('.grid-scroll tbody')).toContainText('a;б 名');
  const exportPath = resolve('test-artifacts/script-selected.csv');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await expect.poll(() => readFile(exportPath, 'utf8').catch(() => '')).toContain('9223372036854775807');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('studio.history') || '[]').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs') || '[]')[0]?.sql)).toBe(script);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studio.history'))[0].mode)).toBe('script');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs')).some(tab => tab.result || tab.scriptResults))).toBe(false);
  await page.screenshot({ path: 'test-artifacts/script-results.png' });
  checks.push('JDBC SQLite script, per-command tabs, selected CSV, one history entry, SQL-only persistence');

  // Ordinary execution resolves the command at the caret. Selection and the script shortcut run
  // only the highlighted script and never the trailing INSERT.
  await sql('SELECT 1; SELECT 2;');
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await confirmExecution(page);
  await expect(page.locator('.result-state')).toHaveText('FINISHED');
  await expect(page.locator('.grid-scroll tbody')).toContainText('2');
  await sql('SELECT 41; SELECT 42;\nINSERT INTO script_rows VALUES (2, \'must not run\');');
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press(`${modifier}+Shift+Enter`);
  await confirmExecution(page);
  await expect(page.locator('.script-state')).toHaveText('Скрипт · FINISHED');
  await expect(page.locator('.script-tabs [role=tab]')).toHaveCount(2);
  await expect(page.locator('.grid-scroll tbody')).toContainText('42');
  expect((await execute('SELECT count(*) FROM script_rows')).result.rows).toEqual([['1']]);
  checks.push('single-command regression and selected script via Cmd/Ctrl+Shift+Enter');

  const failed = await execute("BEGIN; INSERT INTO script_rows VALUES (3, 'rollback'); SELECT * FROM absent_table; INSERT INTO script_rows VALUES (4, 'skipped'); COMMIT;");
  expect(failed.result.script.state).toBe('FAILED'); expect(failed.result.script.index).toBe(2); expect(failed.result.script.completed).toBe(2); expect(failed.result.inTransaction).toBe(true);
  expect((await execute('SELECT count(*) FROM script_rows')).result.rows).toEqual([['2']]);
  expect((await execute('ROLLBACK; SELECT count(*) FROM script_rows')).result.rows).toEqual([['1']]);
  const malformed = await execute("INSERT INTO script_rows VALUES (5, 'skipped'); SELECT 'unclosed");
  expect(malformed.result.state).toBe('FAILED'); expect(malformed.result.script).toBeUndefined();
  expect((await execute('SELECT count(*) FROM script_rows')).result.rows).toEqual([['1']]);
  checks.push('stop on database error, open transaction retained, explicit rollback, whole-script prevalidation');

  // Cancellation uses the actual UI and must skip the statement after the long SELECT.
  await sql("WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<100000000) SELECT sum(n) FROM x; INSERT INTO script_rows VALUES (6, 'canceled');");
  await page.getByRole('button', { name: 'Запустить SQL-скрипт', exact: true }).click();
  await confirmExecution(page);
  await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.locator('.script-state')).toHaveText('Скрипт · CANCELED', { timeout: 30000 });
  expect((await execute('SELECT count(*) FROM script_rows')).result.rows).toEqual([['1']]);
  const immediate = await page.evaluate(async profileId => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Immediate cancellation timed out')); }, 30000);
      const off = window.studio.query.onUpdate(value => { if (value.requestId === requestId && (value.script?.state ?? value.state) !== 'RUNNING') { clearTimeout(timer); off(); resolve(value); } });
      const run = window.studio.query.run({ requestId, sessionId: 'immediate-cancel', profileId, sql: "INSERT INTO script_rows VALUES (7, 'immediate cancel'); SELECT 1;", catalog: '', schema: '', maxRows: 100, mode: 'script' });
      Promise.all([run, window.studio.query.cancel(requestId)]).catch(reject);
    });
  }, profile.id);
  expect(immediate.script.state).toBe('CANCELED'); expect(immediate.script.completed).toBe(0);
  expect((await execute('SELECT count(*) FROM script_rows')).result.rows).toEqual([['1']]);
  checks.push('UI cancellation and immediate IPC cancellation prevent remaining writes');

  // The native SQLite path uses a worker, rather than JDBC; exercise it too.
  const native = await page.evaluate(endpoint => window.studio.profiles.save({ name: 'Native fixture', engine: 'sqlite', endpoint, user: '', auth: 'none', tls: false, catalog: '', schema: '' }), join(directory, 'native.sqlite'));
  expect((await execute('CREATE TABLE n (x int); INSERT INTO n VALUES(9); SELECT * FROM n', { profileId: native.id, sessionId: 'native' })).result.rows).toEqual([['9']]);
  checks.push('native SQLite worker sequential execution');

  // H2 supplies one persistent JVM connection shared by two logical consoles.
  const shared = await page.evaluate(() => window.studio.profiles.save({ name: 'Shared JDBC', engine: 'jdbc', endpoint: 'jdbc:h2:mem:script_shared;DB_CLOSE_DELAY=-1', user: 'sa', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { driverId: 'h2', productId: 'h2', options: { singleSession: true } } }));
  const options = { profileId: shared.id, sessionId: 'shared-a' };
  const context = await execute("CREATE SCHEMA script_context; SET SCHEMA script_context; CREATE TABLE rows_test (x int); INSERT INTO rows_test VALUES (1); SELECT current_schema, x FROM rows_test;", { ...options, schema: 'PUBLIC' });
  expect(context.result.script.state).toBe('FINISHED'); expect(context.result.rows).toEqual([['SCRIPT_CONTEXT', '1']]);
  const queue = await page.evaluate(async profileId => {
    const events = [], pending = new Map();
    const off = window.studio.query.onUpdate(value => {
      if (!pending.has(value.requestId)) return;
      if (value.script && value.state === 'FINISHED') events.push(`${value.requestId}:${value.script.index}`);
      if ((value.script?.state ?? value.state) !== 'RUNNING') { events.push(`${value.requestId}:done`); pending.get(value.requestId)(value); pending.delete(value.requestId); }
    });
    async function run(requestId, sessionId, sql) {
      const done = new Promise(resolve => pending.set(requestId, resolve));
      await window.studio.query.run({ requestId, sessionId, profileId, sql, catalog: '', schema: '', maxRows: 100, applyContext: false, mode: 'script' });
      return done;
    }
    try {
      const first = run('queue-first', 'shared-a', 'SELECT sum(x) FROM system_range(1, 5000000); INSERT INTO rows_test VALUES (2);');
      // IPC messages are ordered. Wait for the first statement to be running before
      // queuing the sibling, then cancel that queued job without touching its owner.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error('Shared query did not start')); }, 30000);
        const stop = window.studio.query.onUpdate(value => { if (value.requestId === 'queue-first' && value.state === 'RUNNING') { clearTimeout(timer); stop(); resolve(); } });
      });
      const canceled = run('queue-canceled', 'shared-b', 'INSERT INTO rows_test VALUES (999); SELECT 1;');
      await window.studio.query.cancel('queue-canceled');
      const second = run('queue-second', 'shared-c', 'SELECT count(*) FROM rows_test; SELECT sum(x) FROM rows_test;');
      return { first: await first, canceled: await canceled, second: await second, events };
    } finally { off(); }
  }, shared.id);
  expect(queue.first.script.state).toBe('FINISHED'); expect(queue.canceled.script.state).toBe('CANCELED'); expect(queue.canceled.script.completed).toBe(0);
  expect(queue.second.rows).toEqual([['3']]);
  expect(queue.events.indexOf('queue-first:done')).toBeLessThan(queue.events.indexOf('queue-second:0'));
  checks.push('H2 context preserved across commands, whole-script session queue, queued cancellation isolation');

  expect(errors).toEqual([]);
  await writeFile('test-artifacts/script-desktop-results.json', JSON.stringify({ passed: true, platform: process.platform, checks, rendererErrors: errors }, null, 2));
  for (const check of checks) console.log(`PASS: ${check}`);
} catch (error) {
  await page.screenshot({ path: 'test-artifacts/script-failure.png' }).catch(() => {});
  throw error;
} finally { await app.close(); }
