import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { confirmExecution } from './ui-helpers.mjs';

const directory=await mkdtemp(join(tmpdir(),'local-db-viewer-grid-'));
await mkdir('test-artifacts',{recursive:true});await mkdir(join(directory,'updates'));
await writeFile(join(directory,'updates/settings.json'),JSON.stringify({repository:'fixture/public',automatic:false}));
await mkdir(join(directory,'drivers/objects'),{recursive:true});
const h2=JSON.parse(await readFile('tests/driver-fixtures.json','utf8')).drivers.h2;
for(const file of h2.files) await copyFile(resolve('.runtime-cache/maven/repository',file.path),join(directory,'drivers/objects',file.sha256+'.jar'));
await writeFile(join(directory,'drivers/settings.json'),JSON.stringify({automatic:false,installed:{h2:[{...h2,source:'download',paths:[]}]},selected:{h2:h2.key}}));
const app=await electron.launch({executablePath:process.env.LOCAL_DB_VIEWER_EXECUTABLE,args:process.env.LOCAL_DB_VIEWER_EXECUTABLE?[]:[resolve('.')],env:{...process.env,LOCAL_DB_VIEWER_DATA_DIR:directory}});
const page=await app.firstWindow(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const modifier=process.platform==='darwin'?'Meta':'Control', clipboard=()=>app.evaluate(({clipboard})=>clipboard.readText());
try {
  await expect(page.locator('.monaco-editor')).toBeVisible();
  const profile=await page.evaluate(()=>window.studio.profiles.save({name:'Grid fixture',engine:'jdbc',endpoint:'jdbc:h2:mem:grid;DB_CLOSE_DELAY=-1',user:'sa',auth:'none',tls:false,catalog:'',schema:'',jdbc:{driverId:'h2',productId:'h2',options:{singleSession:true,autoSync:false}}}));
  const long='名'.repeat(4000)+'\nlast line', first='line\n"quote"\t雪';
  await page.evaluate(async({profileId,long,first})=>{
    const requestId=crypto.randomUUID(),literal=value=>"'"+value.replaceAll("'","''")+"'";
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{off();reject(new Error('Grid setup timed out'));},30000);
      const off=window.studio.query.onUpdate(value=>{if(value.requestId!==requestId||(value.script?.state??value.state)==='RUNNING')return;clearTimeout(timer);off();value.state==='FINISHED'?resolve():reject(new Error(value.error));});
      window.studio.query.run({requestId,sessionId:'grid-setup',profileId,sql:`CREATE TABLE cells (id BIGINT, amount DECIMAL(30,6), label VARCHAR(40), note CLOB);
        INSERT INTO cells VALUES (9007199254740993,12345678901234567890.123456,'β',${literal(first)}), (9007199254740992,12345678901234567890.123455,'Alpha',''), (2,NULL,'Alpha',${literal(long)}), (-10,-0.000001,'=2+2',NULL), (NULL,0,'Null','');`,catalog:'',schema:'',maxRows:1000,mode:'script'}).catch(error=>{clearTimeout(timer);off();reject(error);});
    });
  },{profileId:profile.id,long,first});
  await page.reload();await page.getByLabel('Подключение',{exact:true}).selectOption(profile.id);
  async function run(sql) {
    await page.locator('.monaco-editor').click({position:{x:120,y:20}});await page.keyboard.press(`${modifier}+a`);await page.keyboard.insertText(sql);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Выполнить'}).click();await confirmExecution(page);
    await expect(page.locator('.result-state')).toHaveText('FINISHED',{timeout:30000});
  }
  const grid=page.locator('.result-grid'), cells=column=>grid.locator(`tbody td[data-column="${column}"]`);
  const sort=column=>grid.getByRole('button',{name:new RegExp(`^Сортировать колонку ${column+1}:`)});
  const ids=()=>cells(0).allTextContents();
  await run('SELECT id, amount, label AS "duplicate", note AS "duplicate" FROM cells ORDER BY id DESC NULLS LAST');
  await expect(cells(0)).toHaveCount(5);
  await sort(0).click();expect(await ids()).toEqual(['-10','2','9007199254740992','9007199254740993','NULL']);
  await expect(grid.locator('th').nth(1)).toHaveAttribute('aria-sort','ascending');
  await sort(0).click();expect(await ids()).toEqual(['9007199254740993','9007199254740992','2','-10','NULL']);
  await sort(0).click();await expect(grid.locator('th').nth(1)).toHaveAttribute('aria-sort','none');
  await sort(1).click();expect(await ids()).toEqual(['-10','NULL','9007199254740992','9007199254740993','2']);
  await sort(1).click();expect(await ids()).toEqual(['9007199254740993','9007199254740992','NULL','-10','2']);
  await sort(1).click();
  checks.push('real H2 bigint/decimal sorting without rounding, NULL last, reset to original order');

  await cells(0).nth(0).click();await page.keyboard.press(`${modifier}+c`);
  await expect.poll(clipboard).toBe('9007199254740993');
  await cells(1).nth(1).click({modifiers:['Shift']});await page.keyboard.press(`${modifier}+c`);
  await expect.poll(clipboard).toBe('9007199254740993\t12345678901234567890.123456\r\n9007199254740992\t12345678901234567890.123455');
  await cells(2).nth(0).click();await cells(3).nth(1).click({modifiers:['Shift']});
  await page.getByRole('button',{name:'С заголовками',exact:true}).click();
  await expect.poll(clipboard).toBe('duplicate\tduplicate\r\nβ\t"line\n""quote""\t雪"\r\nAlpha\t');
  checks.push('native clipboard shortcuts, rectangular Shift selection, duplicate headers and multiline TSV');

  await cells(3).nth(0).dblclick();const dialog=page.getByRole('dialog',{name:'Значение ячейки'});
  await expect(dialog.getByLabel('Полное значение ячейки')).toHaveValue(first);
  await dialog.getByRole('button',{name:'Копировать значение'}).click();await expect.poll(clipboard).toBe(first);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(grid).toBeFocused();
  await cells(3).nth(2).dblclick();await expect(dialog.getByLabel('Полное значение ячейки')).toHaveValue(long);
  await dialog.getByRole('button',{name:'Копировать значение'}).click();await expect.poll(clipboard).toBe(long);await page.keyboard.press('Escape');
  await cells(3).nth(1).click();await page.keyboard.press('Enter');await expect(dialog).toContainText('пустая строка');
  await dialog.getByRole('button',{name:'Копировать значение'}).click();await expect.poll(clipboard).toBe('');await page.keyboard.press('Escape');
  await cells(3).nth(3).dblclick();await expect(dialog).toContainText('SQL NULL');await expect(dialog.getByLabel('Полное значение ячейки')).toHaveValue('NULL');await page.keyboard.press('Escape');
  checks.push('read-only full cell view: long Unicode, literal multiline text, empty string, SQL NULL, keyboard/focus');

  await page.getByPlaceholder('Фильтр загруженных строк…').fill('=2+2');await expect(cells(0)).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Копировать выделение',exact:true})).toBeDisabled();
  await grid.getByRole('button',{name:'Выделить строку 1',exact:true}).click();await page.keyboard.press(`${modifier}+c`);
  await expect.poll(clipboard).toBe("-10\t-0.000001\t'=2+2\tNULL");
  await run('SELECT x AS id, CAST(x AS DECIMAL(10,2)) AS amount, \'row-\' || x AS label FROM system_range(1,205) ORDER BY x');
  await expect(cells(0)).toHaveCount(100);await expect(page.getByPlaceholder('Фильтр загруженных строк…')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Копировать выделение',exact:true})).toBeDisabled();
  await cells(0).nth(99).click();await page.keyboard.press('Shift+ArrowDown');
  await expect(cells(0).nth(0)).toHaveText('101');await page.keyboard.press(`${modifier}+c`);await expect.poll(clipboard).toBe('100\r\n101');
  await page.keyboard.press(`${modifier}+a`);await page.keyboard.press(`${modifier}+Shift+c`);
  const all=await clipboard();expect(all.split('\r\n')).toHaveLength(206);expect(all).toContain('ID\tAMOUNT\tLABEL');expect(all).toContain('205\t205.00\trow-205');
  await sort(0).click();await sort(0).click();await expect(cells(0).nth(0)).toHaveText('205');
  await page.getByPlaceholder('Фильтр загруженных строк…').fill('row-20');await expect(cells(0)).toHaveCount(7);
  await page.getByRole('button',{name:'Сообщения',exact:true}).click();await expect(grid).toBeHidden();
  await page.locator('.results-heading .result-tab').first().click();await expect(grid).toBeVisible();
  await expect(page.getByPlaceholder('Фильтр загруженных строк…')).toHaveValue('row-20');await expect(cells(0).first()).toHaveText('205');
  const exportPath=resolve('test-artifacts/result-grid-original.csv');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},exportPath);
  await page.getByRole('button',{name:'CSV',exact:true}).click();
  await expect.poll(()=>readFile(exportPath,'utf8').catch(()=>'' )).toContain('"1","1.00","row-1"');
  expect((await readFile(exportPath,'utf8')).trim().split('\r\n')).toHaveLength(206);
  checks.push('filter clears selection, new query resets view, Shift navigation across pages, select all loaded rows, original CSV unchanged');

  await page.locator('.monaco-editor').click({position:{x:120,y:20}});await page.keyboard.press(`${modifier}+a`);await page.keyboard.press(`${modifier}+c`);
  await expect.poll(clipboard).toContain('system_range(1,205)');
  const validation=await page.evaluate(async()=>{try{await window.studio.copyText({bad:true});return '';}catch(error){return error.message;}});
  expect(validation).toContain('Некорректный текст');
  expect(errors).toEqual([]);await page.screenshot({path:'test-artifacts/result-grid-desktop.png'});
  await writeFile('test-artifacts/result-grid-desktop.json',JSON.stringify({passed:true,platform:process.platform,checks,rendererErrors:errors},null,2));
  checks.forEach(check=>console.log(`PASS: ${check}`));
} catch(error) {await page.screenshot({path:'test-artifacts/result-grid-failure.png'}).catch(()=>{});throw error;}
finally {await app.close();}
