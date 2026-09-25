import { confirmExecution } from './ui-helpers.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const data = await mkdtemp(join(tmpdir(), 'completion-desktop-'));
await mkdir(join(data, 'updates'));
await writeFile(join(data, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
await mkdir(join(data, 'drivers'));
await writeFile(join(data, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
await mkdir('test-artifacts', { recursive: true });
const app = await electron.launch({
  executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE,
  args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')],
  env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: data },
});
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const database = join(data, 'completion.sqlite');
  await app.evaluate((_electron, path) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE customers (tenant_id INTEGER, id INTEGER, name TEXT, PRIMARY KEY (tenant_id, id));
      CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id INTEGER, customer_id INTEGER, amount INTEGER,
        FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id));
      INSERT INTO customers VALUES (1, 10, 'First'), (2, 10, 'Second');
      INSERT INTO orders VALUES (101, 1, 10, 100), (102, 2, 10, 200);
    `);
    db.close();
  }, database);
  await page.getByRole('button', { name: 'Подключить базу', exact: true }).click();
  await page.getByLabel('СУБД', { exact: true }).selectOption('sqlite');
  await page.getByLabel('Название', { exact: true }).fill('Completion fixture');
  await page.locator('.endpoint-field input').fill(database);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('dialog')).toHaveCount(0);

  const popup = page.locator('.suggest-widget.visible');
  async function suggest(sql) {
    const caret = sql.indexOf('|');
    expect(caret).toBeGreaterThanOrEqual(0);
    await page.locator('.monaco-editor').click({ position: { x: 100, y: 20 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.insertText(sql.replace('|', ''));
    await page.keyboard.press('Escape');
    for (let i = caret; i < sql.length - 1; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(popup).toBeVisible({ timeout: 30000 });
  }
  async function run(rows) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Выполнить' }).click();
    await confirmExecution(page);
    await expect(page.locator('.result-state')).toHaveText('FINISHED', { timeout: 30000 });
    await expect(page.locator('tbody tr')).toHaveCount(rows);
  }

  await suggest('SELECT * FROM (SELECT [customer_id] AS [cid], amount+1 AS total FROM [orders]) d WHERE d.|');
  await expect(popup).toContainText('cid');
  await expect(popup).toContainText('total');
  await popup.locator('.monaco-list-row').filter({ hasText: 'total' }).first().click();
  await page.keyboard.insertText(' > 150');
  await run(1);

  await suggest('WITH projected AS (SELECT tenant_id AS tenant, customer_id AS cid, amount FROM orders) SELECT * FROM projected d JOIN |');
  const joinItem = popup.locator('.monaco-list-row').filter({ hasText: 'customers — ON' }).first();
  await expect(joinItem).toBeVisible();
  await page.screenshot({ path: 'test-artifacts/completion-projected-join.png' });
  await joinItem.click();
  await expect(page.locator('.view-lines')).toContainText('"d"."tenant"');
  await expect(page.locator('.view-lines')).toContainText('"d"."cid"');
  await run(2); // Missing either FK pair would incorrectly produce four rows.

  await suggest('SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.|)');
  await expect(popup).toContainText('customer_id');
  await popup.locator('.monaco-list-row').filter({ hasText: 'customer_id' }).first().click();
  await run(2);

  await suggest('SELECT amount AS total FROM orders UNION ALL SELECT id AS other FROM customers ORDER BY |');
  await expect(popup).toContainText('total');
  await expect(popup).not.toContainText('other');
  await popup.locator('.monaco-list-row').filter({ hasText: 'total' }).first().click();
  await run(4);

  await suggest('SELECT * FROM orders o JOIN customers c USING (|)');
  await expect(popup).toContainText('tenant_id');
  await expect(popup).not.toContainText('customer_id');
  await expect(popup).not.toContainText('amount');
  await expect(popup).not.toContainText('LEFT JOIN');
  await popup.locator('.monaco-list-row').filter({ hasText: 'tenant_id' }).first().click();
  await run(2);

  await suggest('WITH joined AS (SELECT * FROM orders o JOIN customers c USING (tenant_id)) SELECT j.| FROM joined j');
  await expect(popup).toContainText('tenant_id');
  await popup.locator('.monaco-list-row').filter({ hasText: 'tenant_id' }).first().click();
  await run(2);
  await expect(page.locator('thead')).toContainText('tenant_id');

  await suggest('WITH joined AS (SELECT * FROM (SELECT tenant_id, customer_id AS id, amount FROM orders) o NATURAL JOIN customers c) SELECT j.| FROM joined j');
  await expect(popup).toContainText('id');
  await expect(popup).toContainText('name');
  await popup.locator('.monaco-list-row').filter({ hasText: 'name' }).first().click();
  await run(2);
  await expect(page.locator('tbody')).toContainText('First');
  await expect(page.locator('tbody')).toContainText('Second');
  await page.screenshot({ path: 'test-artifacts/completion-using-natural.png' });
  expect(errors).toEqual([]);
  await writeFile('test-artifacts/completion-desktop-results.json', JSON.stringify({
    passed: true, platform: process.platform, derivedColumns: true, projectedCompositeJoin: true,
    correlatedScope: true, unionOutputOrder: true, usingCandidates: true, usingCTE: true, naturalJoinCTE: true, executedAcceptedSQL: true,
  }, null, 2));
  console.log('PASS: actual Monaco completion and executed derived columns, composite JOIN, USING/NATURAL CTE, correlated query and UNION ORDER BY');
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: 'test-artifacts/completion-failure.png' }).catch(() => {});
  throw error;
} finally {
  await app.close();
}
