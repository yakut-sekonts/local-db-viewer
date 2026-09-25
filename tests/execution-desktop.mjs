import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { confirmExecution } from './ui-helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-execution-'));
for (const name of ['drivers','updates']) await mkdir(join(directory,name));
await writeFile(join(directory,'drivers/settings.json'),JSON.stringify({automatic:false,installed:{},selected:{}}));
await writeFile(join(directory,'updates/settings.json'),JSON.stringify({repository:'fixture/public',automatic:false}));
await mkdir('test-artifacts',{recursive:true});
const app = await electron.launch({executablePath:process.env.LOCAL_DB_VIEWER_EXECUTABLE,args:process.env.LOCAL_DB_VIEWER_EXECUTABLE?[]:[resolve('.')],env:{...process.env,LOCAL_DB_VIEWER_DATA_DIR:directory}});
const page = await app.firstWindow(), errors = [], checks = [], database = join(directory,'execute.sqlite');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
page.on('pageerror', error => errors.push(error.message));
try {
  await app.evaluate((_, path) => { const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync(path);db.exec('CREATE TABLE writes(id INTEGER PRIMARY KEY, label TEXT)');db.close(); }, database);
  const profile = await page.evaluate(endpoint => window.studio.profiles.save({name:'Cursor fixture',engine:'sqlite',endpoint,user:'',auth:'none',tls:false,catalog:'',schema:''}),database);
  await page.reload(); await page.getByLabel('Подключение',{exact:true}).selectOption(profile.id);
  const dialog = page.locator('.execute-dialog');
  const sqlPreview = page.getByLabel('SQL к выполнению',{exact:true});
  async function rows() { return app.evaluate((_, path) => { const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT id,label FROM writes ORDER BY id').all();}finally{db.close();} },database); }
  async function sql(text) {
    await page.locator('.monaco-editor').click({position:{x:120,y:20}});
    await page.keyboard.press(`${modifier}+a`);await page.keyboard.insertText(text);await page.keyboard.press('Escape');
  }
  async function cursor(line, column = 0) {
    await page.keyboard.press(`${modifier}+a`);await page.keyboard.press('ArrowLeft');
    for(let i=1;i<line;i++)await page.keyboard.press('ArrowDown');
    for(let i=0;i<column;i++)await page.keyboard.press('ArrowRight');
  }
  async function finished() { await expect(page.locator('.result-state')).toHaveText('FINISHED',{timeout:30000}); }
  const first = "INSERT INTO writes VALUES(1,'confirmed');\nSELECT 7;";
  await sql(first);await cursor(1,10);await page.keyboard.press(`${modifier}+Enter`);
  await expect(dialog).toBeVisible();await expect(sqlPreview).toHaveValue("INSERT INTO writes VALUES(1,'confirmed')");
  await expect(dialog).toContainText('Cursor fixture');await expect(dialog).toContainText('Команда под курсором');
  expect(await rows()).toEqual([]);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('studio.history')||'[]').length)).toBe(0);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect(await rows()).toEqual([]);
  checks.push('Ctrl/Cmd+Enter previews only the cursor statement; Escape makes no SQL changes or history entry');

  await page.getByRole('button',{name:'Выполнить',exact:false}).click();
  await expect(dialog).toBeVisible();await expect(sqlPreview).toHaveAttribute('readonly','');
  await page.keyboard.press(`${modifier}+t`);await expect(page.locator('.console-tab')).toHaveCount(1);
  await page.keyboard.press(`${modifier}+Enter`);await expect(dialog).toHaveCount(0);await finished();
  expect(await rows()).toEqual([{id:1,label:'confirmed'}]);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('studio.history')||'[]').length)).toBe(1);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('studio.history'))[0].sql)).toBe("INSERT INTO writes VALUES(1,'confirmed')");
  checks.push('toolbar shares cursor logic, confirmation is read-only, modal blocks workspace shortcuts, explicit confirmation executes once');

  const cte = "WITH t AS (\n  SELECT 42 AS n\n), u AS (SELECT n FROM t)\nSELECT t.n, 'semi;colon' AS label\nFROM t JOIN u ON t.n=u.n\nWHERE EXISTS (SELECT 1 FROM u)";
  await sql(`INSERT INTO writes VALUES(20,'wrong before');\n${cte};\nINSERT INTO writes VALUES(21,'wrong after');`);
  const currentSQL = () => page.evaluate(() => JSON.parse(localStorage.getItem('studio.tabs') || '[]')[0]?.sql?.replace(/\r\n/g,'\n') || '');
  await expect.poll(currentSQL).toContain("'wrong after'");
  // Monaco may apply indentation while keyboard text is inserted. Confirmation
  // must preserve the actual editor text, including those indentation changes.
  const cteDraft = await currentSQL();
  const displayedCte = cteDraft.slice(cteDraft.indexOf('WITH'), cteDraft.indexOf(';', cteDraft.indexOf('WHERE EXISTS')));
  await cursor(6,15);await page.keyboard.press(`${modifier}+Enter`);
  await expect(sqlPreview).toHaveValue(displayedCte);await expect(dialog).toContainText('строки 2–7');
  await page.screenshot({path:'test-artifacts/execute-confirmation.png'});
  await confirmExecution(page);await finished();
  await expect(page.locator('.grid-scroll tbody')).toContainText('42');await expect(page.locator('.grid-scroll tbody')).toContainText('semi;colon');
  expect((await rows()).length).toBe(1);
  checks.push('cursor inside JOIN/subquery chooses the complete CTE, with semicolon inside a literal preserved');

  const selected = "INSERT INTO writes VALUES(2,'selected a'); INSERT INTO writes VALUES(3,'selected b');";
  await sql(`${selected}\nINSERT INTO writes VALUES(4,'excluded');`);
  await cursor(1);await page.keyboard.press('Shift+ArrowDown');await page.keyboard.press(`${modifier}+Enter`);
  await expect(dialog).toContainText('Выделенный SQL');await expect(dialog).toContainText('команд: 2');await expect(sqlPreview).toHaveValue(selected);
  await confirmExecution(page);await expect(page.locator('.script-state')).toHaveText('Скрипт · FINISHED');
  expect((await rows()).map(row=>row.id)).toEqual([1,2,3]);
  checks.push('selection takes priority and multiple selected commands run sequentially after confirmation');

  const all = "INSERT INTO writes VALUES(4,'whole script');\nSELECT count(*) FROM writes;";
  await sql(all);await cursor(2,4);await page.getByRole('button',{name:'Запустить SQL-скрипт',exact:true}).click();
  await expect(sqlPreview).toHaveValue(all);await expect(dialog).toContainText('Вся консоль');
  await dialog.getByRole('button',{name:'Отмена',exact:true}).click();expect((await rows()).length).toBe(3);
  await page.getByRole('button',{name:'Запустить SQL-скрипт',exact:true}).click();await confirmExecution(page);
  await expect(page.locator('.script-state')).toHaveText('Скрипт · FINISHED');expect((await rows()).length).toBe(4);
  checks.push('explicit script execution still targets the full console and requires confirmation');

  await sql("INSERT INTO writes VALUES(5,'held key');");
  await page.keyboard.down(modifier);await page.keyboard.down('Enter');await expect(dialog).toBeVisible();
  await page.keyboard.down('Enter');await expect(dialog).toBeVisible();expect((await rows()).length).toBe(4);
  await page.keyboard.up('Enter');await page.keyboard.up(modifier);await page.keyboard.press('Escape');
  checks.push('held execution shortcut cannot auto-confirm through key repeat');

  await sql("SELECT 55;\nSELECT 'unfinished");await cursor(1,5);await page.keyboard.press(`${modifier}+Enter`);await expect(sqlPreview).toHaveValue('SELECT 55');
  await confirmExecution(page);await finished();await expect(page.locator('.grid-scroll tbody')).toContainText('55');
  await page.locator('.monaco-editor').click({position:{x:120,y:20}});await cursor(2,10);await page.keyboard.press(`${modifier}+Enter`);
  await expect(dialog).toHaveCount(0);await expect(page.locator('.global-error')).toContainText('Незакрытая');
  checks.push('unfinished later drafts leave earlier queries executable and ambiguous current SQL is rejected');
  expect(errors).toEqual([]);
  await writeFile('test-artifacts/execution-desktop-results.json',JSON.stringify({passed:true,platform:process.platform,checks,rendererErrors:errors},null,2));
  checks.forEach(check=>console.log(`PASS: ${check}`));
} catch(error) {await page.screenshot({path:'test-artifacts/execution-failure.png'}).catch(()=>{});throw error;}
finally {await app.close();}
