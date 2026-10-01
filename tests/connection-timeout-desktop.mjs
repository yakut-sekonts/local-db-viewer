import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const data = await mkdtemp(join(tmpdir(), 'connection-timeout-desktop-'));
await mkdir(join(data, 'updates')); await writeFile(join(data, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/public', automatic: false }));
await mkdir(join(data, 'drivers')); await writeFile(join(data, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
await mkdir('test-artifacts', { recursive: true });
const sockets = new Set();
const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: data } });
try {
  const page = await app.firstWindow();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Подключить базу', exact: true }).click();
  await page.getByRole('tab', { name: 'Options', exact: true }).click();
  const control = page.getByRole('spinbutton', { name: /^Connection timeout, sec/ });
  await expect(control).toHaveValue('30'); await control.fill('0');
  await expect(control).toHaveValue('0');
  await expect(page.getByText('Общий лимит открытия JDBC-соединения.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-artifacts/connection-timeout-options.png' });
  const result = await page.evaluate(async port => {
    const draft = { name: 'Silent Trino', engine: 'trino', endpoint: `http://127.0.0.1:${port}`, user: 'fixture', auth: 'none', tls: false, catalog: '', schema: '', jdbc: { options: { connectTimeoutSeconds: 2, autoSync: false } } };
    const started = Date.now();
    let testError;
    try { await window.studio.profiles.test(draft); } catch (error) { testError = error.message; }
    const profile = await window.studio.profiles.save(draft);
    const requestId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    const query = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Query never reported timeout')); }, 15000);
      const off = window.studio.query.onUpdate(value => {
        if (value.requestId === requestId && value.state !== 'RUNNING') { clearTimeout(timer); off(); resolve(value); }
      });
      window.studio.query.run({ requestId, sessionId, profileId: profile.id, sql: 'SELECT 123', catalog: '', schema: '', maxRows: 10 }).catch(error => { clearTimeout(timer); off(); reject(error); });
    });
    return { testError, queryState: query.state, queryError: query.error, elapsed: Date.now() - started };
  }, server.address().port);
  expect(result.testError).toContain('лимит подключения JDBC (2 сек.)');
  expect(result.queryState).toBe('FAILED'); expect(result.queryError).toContain('лимит подключения JDBC (2 сек.)');
  expect(result.elapsed).toBeLessThan(20000);
  await writeFile('test-artifacts/connection-timeout-desktop-results.json', JSON.stringify({ passed: true, platform: process.platform, checks: ['Options zero and explanatory text', 'real Trino profiles:test IPC', 'query timeout reaches renderer without hanging'], ...result }, null, 2));
  console.log('PASS: timeout setting, Test Connection and query error through the desktop IPC');
} finally {
  await app.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
