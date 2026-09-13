import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-boundary-'));
for (const name of ['drivers','updates']) await mkdir(join(directory,name));
await writeFile(join(directory,'drivers/settings.json'),JSON.stringify({automatic:false,installed:{},selected:{}}));
await writeFile(join(directory,'updates/settings.json'),JSON.stringify({repository:'fixture/public',automatic:false}));
const broken = '[null]'; await writeFile(join(directory,'connections.json'),broken);
const app = await electron.launch({executablePath:process.env.LOCAL_DB_VIEWER_EXECUTABLE,args:process.env.LOCAL_DB_VIEWER_EXECUTABLE?[]:[resolve('.')],env:{...process.env,LOCAL_DB_VIEWER_DATA_DIR:directory}});
try {
  const page = await app.firstWindow();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.global-error')).toContainText('Файл подключений повреждён');
  expect(await readFile(join(directory,'connections.json'),'utf8')).toBe(broken);
  console.log('PASS: corrupt profile file is preserved and cannot crash the renderer');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('profiles:list');
    ipcMain.handle('profiles:list',() => [{id:'broken-render',name:'Render fixture',endpoint:'not a URL',engine:'trino',user:'fixture',auth:'none',tls:false,catalog:'',schema:'',hasSecret:false}]);
  });
  await page.evaluate(() => localStorage.setItem('studio.tabs',JSON.stringify([{name:'preserved.sql',sql:'SELECT 42 AS preserved_draft',profileId:'broken-render',catalog:'',schema:''}])));
  await page.reload();
  await expect(page.locator('.sidebar .boundary-error')).toContainText('Не удалось показать');
  await expect(page.locator('.monaco-editor')).toContainText('preserved_draft');
  await expect(page.getByRole('button',{name:'Выполнить'})).toBeVisible();
  console.log('PASS: ErrorBoundary isolates an unexpected Explorer render failure while keeping editor and SQL');
  await mkdir('test-artifacts',{recursive:true}); await page.screenshot({path:'test-artifacts/error-boundary.png'});
} finally {await app.close();}
