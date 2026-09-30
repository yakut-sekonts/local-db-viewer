import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-licenses-'));
for (const name of ['updates', 'drivers']) await mkdir(join(directory, name));
await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ automatic: false }));
await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
const app = await electron.launch({ executablePath: process.env.LOCAL_DB_VIEWER_EXECUTABLE, args: process.env.LOCAL_DB_VIEWER_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory } });
try {
  await app.firstWindow();
  const opened = await app.evaluate(async ({ Menu, shell, app }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('licenses');
    if (!item) throw new Error('License menu item missing');
    const original = shell.openPath;
    const paths = [];
    shell.openPath = async path => { paths.push(path); return ''; };
    try { await item.click(); } finally { shell.openPath = original; }
    return { paths, version: app.getVersion() };
  });
  expect(opened.paths).toHaveLength(1);
  const file = opened.paths[0];
  expect(file.endsWith(join('legal', 'index.html'))).toBe(true);
  const text = await readFile(file, 'utf8');
  expect(text).toContain(`Версия ${opened.version}`);
  expect(text).toContain('GNU GENERAL PUBLIC LICENSE');
  expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
  expect(text).toContain('Chromium');
  expect(text).toContain("default-src 'none'");
  expect(text).not.toContain('<script');
  const manifest = JSON.parse(await readFile(join(file, '..', 'distribution-manifest.json'), 'utf8'));
  expect(manifest.files['electron/LICENSES.chromium.html']).toMatch(/^[a-f0-9]{64}$/);
  expect((await stat(join(file, '..', 'licenses', 'npm-manifest.json'))).size).toBeGreaterThan(1000);
  await mkdir('test-artifacts', { recursive: true });
  await writeFile('test-artifacts/licenses-results.json', JSON.stringify({ version: opened.version, menu: true, offlineViewer: true, gplAndLgpl: true, documentCount: Object.keys(manifest.files).length }, null, 2));
  console.log('License menu and offline legal package verified.');
} finally {
  await app.close();
}
