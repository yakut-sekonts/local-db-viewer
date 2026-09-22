import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root=resolve('.'),data=await mkdtemp(join(tmpdir(),'ddl-desktop-')),directory=join(data,'SQL files');
await mkdir(directory);await mkdir(join(data,'updates'));await writeFile(join(data,'updates/settings.json'),JSON.stringify({repository:'fixture/public',automatic:false}));
await mkdir(join(data,'drivers'));await writeFile(join(data,'drivers/settings.json'),JSON.stringify({automatic:false,installed:{},selected:{}}));
await mkdir('test-artifacts',{recursive:true});
const app=await electron.launch({executablePath:process.env.LOCAL_DB_VIEWER_EXECUTABLE,args:process.env.LOCAL_DB_VIEWER_EXECUTABLE?[]:[root],env:{...process.env,LOCAL_DB_VIEWER_DATA_DIR:data}});
try {
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const database=join(data,'ddl.sqlite');
  await app.evaluate((_electron,path)=>{const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync(path);db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id)); CREATE INDEX child_parent ON child(parent_id)');db.close();},database);
  await page.getByRole('button',{name:'Подключить базу',exact:true}).click();
  await page.getByLabel('СУБД',{exact:true}).selectOption('sqlite');await page.getByLabel('Название',{exact:true}).fill('DDL fixture');await page.locator('.endpoint-field input').fill(database);
  await page.getByRole('tab',{name:'Sessions',exact:true}).click();await page.getByRole('button',{name:'Добавить шаблон',exact:true}).click();
  await page.getByLabel('Имя шаблона',{exact:true}).fill('Analysis');await page.getByLabel('Startup script override',{exact:true}).selectOption('replace');
  await page.getByLabel('SQL шаблона',{exact:true}).fill('PRAGMA cache_size = -321');
  await page.getByLabel('defaultSessionTemplate',{exact:true}).selectOption({label:'Analysis'});
  await page.screenshot({path:'test-artifacts/session-templates.png'});
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.locator('dialog')).toHaveCount(0);
  await page.evaluate(async()=>{
    const [profile]=await window.studio.profiles.list();
    await new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();const unsubscribe=window.studio.query.onUpdate(result=>{if(result.requestId!==id||result.state==='RUNNING')return;unsubscribe();result.rows[0]?.[0]==='-321'?resolve():reject(new Error(JSON.stringify(result)));});
      window.studio.query.run({profileId:profile.id,sessionId:'template-fixture',requestId:id,sql:'PRAGMA cache_size',catalog:'',schema:'',maxRows:10}).catch(reject);
    });
    await window.studio.query.release('template-fixture');
  });
  await page.getByRole('button',{name:'DDL mappings',exact:true}).click();await page.getByRole('button',{name:'Новый mapping',exact:true}).click();
  await page.getByLabel('Имя mapping',{exact:true}).fill('Fixture SQL');await page.getByLabel('Каталог DDL',{exact:true}).fill(directory);
  await page.getByLabel('DDL catalog',{exact:true}).fill('main');await page.getByLabel('DDL schema',{exact:true}).fill('main');
  await page.getByRole('button',{name:'Сохранить mapping',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Mapping сохранён.');
  await page.getByRole('button',{name:'Сравнить с БД',exact:true}).click();await expect(page.getByRole('button',{name:'Сохранить выбранные файлы (3)',exact:true})).toBeEnabled();
  await page.screenshot({path:'test-artifacts/ddl-comparison.png'});
  await page.getByRole('button',{name:'Сохранить выбранные файлы (3)',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Выбранные файлы сохранены.');
  expect((await readdir(directory)).filter(name=>name.endsWith('.sql'))).toHaveLength(3);
  const mapping=(await page.evaluate(()=>window.studio.ddl.list()))[0];
  const index=await page.evaluate(id=>window.studio.ddl.index(id),mapping.id);
  expect(index.tables.map(table=>table.name).sort()).toEqual(['child','parent']);expect(index.relationships).toHaveLength(1);
  const chosen=(await page.evaluate(id=>window.studio.ddl.files(id),mapping.id)).find(file=>file.file.startsWith('table-parent'));
  await page.getByLabel('DDL файл',{exact:true}).selectOption(chosen.file);
  await page.getByLabel('DDL SQL',{exact:true}).fill(chosen.sql.replace('name TEXT','renamed TEXT'));
  await writeFile(join(directory,chosen.file),'-- changed outside\n'+chosen.sql);
  await page.getByRole('button',{name:'Сохранить SQL',exact:true}).click();await expect(page.locator('.ddl-dialog').getByRole('alert')).toContainText('изменён снаружи');
  expect(await readFile(join(directory,chosen.file),'utf8')).toContain('-- changed outside');
  await page.getByRole('button',{name:'Отменить правки',exact:true}).click();await page.getByRole('button',{name:'Перечитать файлы',exact:true}).click();
  await page.getByRole('button',{name:'Консоль с DDL-подсказками',exact:true}).click();await expect(page.locator('.ddl-local-tree')).toContainText('parent');
  // Completion stays available when the database is gone; the DDL index only reads local SQL.
  await app.evaluate(({ipcMain})=>{for(const channel of ['metadata','schema:load']) {ipcMain.removeHandler(channel);ipcMain.handle(channel,()=>{throw new Error('Network must not be used');});}});
  await page.locator('.monaco-editor').click({position:{x:100,y:80}});await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');await page.keyboard.insertText('SELECT p. FROM main.parent p');
  for(let i=9;i<'SELECT p. FROM main.parent p'.length;i++)await page.keyboard.press('ArrowLeft');await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget.visible')).toBeVisible();await expect(page.locator('.suggest-widget.visible')).toContainText('name');
  await page.evaluate(async mapping=>{
    await window.studio.ddl.save({...mapping,schema:'changed_scope'});
    try { await window.studio.query.run({profileId:mapping.profileId,ddlMappingId:mapping.id,sessionId:'stale-ddl',requestId:crypto.randomUUID(),sql:'SELECT 1',catalog:mapping.catalog,schema:mapping.schema,maxRows:1});throw new Error('Stale mapping was accepted'); }
    catch(error) { if(!error.message.includes('DDL mapping изменился'))throw error; }
  },mapping);
  expect(errors).toEqual([]);
  await writeFile('test-artifacts/ddl-desktop-results.json',JSON.stringify({passed:true,sessionStartup:true,nativeSQLiteDDL:true,offlineColumns:true,foreignKeys:true,staleFileProtected:true},null,2));
  console.log('PASS: session template UI/startup SQL, native DDL export, stale-file protection, offline columns and foreign keys');
} finally {await app.close();}
