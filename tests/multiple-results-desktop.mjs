import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { confirmExecution } from './ui-helpers.mjs';
import { buildMultipleResultsFixture } from './multiple-results-fixture.mjs';

const fixture=buildMultipleResultsFixture(), directory=await mkdtemp(join(tmpdir(),'local-db-viewer-results-'));
await mkdir('test-artifacts',{recursive:true});
await mkdir(join(directory,'updates'));
await writeFile(join(directory,'updates/settings.json'),JSON.stringify({repository:'fixture/public',automatic:false}));
await mkdir(join(directory,'drivers'));
await writeFile(join(directory,'drivers/settings.json'),JSON.stringify({automatic:false,installed:{},selected:{}}));
const app=await electron.launch({executablePath:process.env.LOCAL_DB_VIEWER_EXECUTABLE,args:process.env.LOCAL_DB_VIEWER_EXECUTABLE?[]:[resolve('.')],env:{...process.env,LOCAL_DB_VIEWER_DATA_DIR:directory}});
const page=await app.firstWindow(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const modifier=process.platform==='darwin'?'Meta':'Control';
try {
  await expect(page.locator('.monaco-editor')).toBeVisible();
  const profile=await page.evaluate(fixture=>window.studio.profiles.save({name:'Multiple results fixture',engine:'jdbc',endpoint:'jdbc:fixture:multiple',user:'',auth:'none',tls:false,catalog:'',schema:'',jdbc:{driverId:'custom',driverClass:'fixture.MultipleResultsDriver',classpath:[fixture],options:{autoSync:false}}}),fixture);
  await page.reload();await page.getByLabel('Подключение',{exact:true}).selectOption(profile.id);
  async function run(text) {
    await page.locator('.monaco-editor').click({position:{x:120,y:20}});
    await page.keyboard.press(`${modifier}+a`);await page.keyboard.insertText(text);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Выполнить'}).click();await confirmExecution(page);
  }
  const tabs=page.getByRole('tablist',{name:'Результаты запроса'}).getByRole('tab');
  await run('CALL mixed()');
  await expect(page.locator('.query-state')).toHaveText('Запрос · FINISHED',{timeout:30000});
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(0)).toHaveText('1 · Изменено: 0');await expect(tabs.nth(2)).toHaveText('3 · Изменено: 9007199254740993');
  await expect(tabs.nth(4)).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.grid-scroll tbody')).toContainText('second');
  await tabs.nth(1).click();await expect(page.locator('.grid-scroll tbody tr')).toHaveCount(2);
  await page.locator('.grid-scroll td[data-column="0"]').first().click();
  await page.keyboard.press(`${modifier}+c`);
  await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText())).toBe('first');
  const exportPath=resolve('test-artifacts/multiple-results-selected.csv');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},exportPath);
  await page.getByRole('button',{name:'CSV',exact:true}).click();
  await expect.poll(()=>readFile(exportPath,'utf8').catch(()=>'' )).toContain('first');
  expect(await readFile(exportPath,'utf8')).not.toContain('second');
  await tabs.nth(3).click();await expect(page.locator('.grid-scroll thead')).toContainText('empty');await expect(page.locator('.no-rows')).toBeVisible();
  await expect(page.getByRole('button',{name:'Копировать выделение',exact:true})).toBeDisabled();
  await tabs.nth(2).click();await expect(page.locator('.result-empty')).toContainText('9007199254740993');
  checks.push('five ordered result tabs, zero/64-bit counts, empty table, selected CSV export');

  await run('CALL error()');
  await expect(page.locator('.query-state')).toHaveText('Запрос · FAILED',{timeout:30000});
  await expect(page.locator('.query-results > [role=alert]')).toContainText('fixture later error');
  await expect(page.locator('.grid-scroll tbody')).toContainText('first');await expect(page.locator('.result-state')).toHaveText('FINISHED');
  await run('CALL partial()');
  await expect(page.locator('.query-state')).toHaveText('Запрос · FAILED',{timeout:30000});
  await expect(page.locator('.grid-scroll tbody')).toContainText('partial');await expect(page.locator('.result-state')).toHaveText('FAILED');
  await tabs.nth(0).click();await expect(page.locator('.grid-scroll tbody')).toContainText('kept');await expect(page.locator('.result-state')).toHaveText('FINISHED');
  checks.push('late failure and partially read table retain earlier usable results');

  await run('CALL cancel()');
  await expect(page.locator('.query-state')).toHaveText('Запрос · RUNNING',{timeout:30000});
  await expect(page.locator('.grid-scroll tbody')).toContainText('first');
  await page.getByRole('button',{name:'Отменить',exact:true}).click();
  await expect(page.locator('.query-state')).toHaveText('Запрос · CANCELED',{timeout:30000});
  await expect(page.locator('.grid-scroll tbody')).toContainText('first');
  await run('CALL mixed()');await expect(page.locator('.query-state')).toHaveText('Запрос · FINISHED',{timeout:30000});
  await expect(tabs.nth(4)).toHaveAttribute('aria-selected','true');
  await page.screenshot({path:'test-artifacts/multiple-results-desktop.png'});
  checks.push('cancel between results, retained rows, rerun and selection reset');
  expect(errors).toEqual([]);
  await writeFile('test-artifacts/multiple-results-desktop.json',JSON.stringify({passed:true,platform:process.platform,checks,rendererErrors:errors},null,2));
  checks.forEach(check=>console.log(`PASS: ${check}`));
} catch(error) {await page.screenshot({path:'test-artifacts/multiple-results-failure.png'}).catch(()=>{});throw error;}
finally {await app.close();}
