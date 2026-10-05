import { assertReleaseFuses, enableFixtureInspector } from './fuses-helpers.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { installUpdateFixture, prepareDeltaFixture } from './update-fixture.mjs';
import { parseReleaseVersion } from '../src/release-version.ts';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Run only on a disposable Windows CI account.');
const root = resolve('.'), artifacts = join(root, 'test-artifacts'); await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(homedir(), 'LocalDBViewer-update-'));
const installation = join(work, 'Локальная БД Local DB Viewer'), executable = join(installation, 'Local DB Viewer.exe');
const dataDirectory = join(work, 'user-data'), marker = join(work, 'restarted.json');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const parsed = parseReleaseVersion(pkg.version);
if (!parsed) throw new Error('Invalid source version');
const { major, minor, patch } = parsed, betaUpdate = process.env.LDV_UPDATE_BETA === '1';
const version = `${major}.${minor}.${patch + 1}${betaUpdate ? '-beta.2' : ''}`;
const original = resolve(`release/Local-DB-Viewer-${pkg.version}-windows-x64-setup.exe`);
async function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file}: exit ${code}`)));
  });
}
let app, quit = false;
try {
  await mkdir(join(dataDirectory, 'updates'), { recursive: true });
  await writeFile(join(dataDirectory, 'updates/settings.json'), JSON.stringify({ repository: 'fixture/releases', automatic: false, channel: betaUpdate ? 'beta' : 'stable' }));
  await mkdir(join(dataDirectory, 'drivers'));
  await writeFile(join(dataDirectory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
  await run(original, ['/S', `/D=${installation}`], { windowsVerbatimArguments: true });
  await enableFixtureInspector(executable, work);
  const main = resolve('dist-electron/main.cjs'), content = await readFile(main, 'utf8');
  const bootstrap = `
process.env.LOCAL_DB_VIEWER_DATA_DIR = ${JSON.stringify(dataDirectory)};
require('electron').app.on('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', async () => {
  try {
    const profiles = await window.webContents.executeJavaScript('window.studio.profiles.list()');
    const tabs = await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem("studio.tabs") || "[]")');
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: require('electron').app.getVersion(), profiles, tabs, path: process.execPath }));
  } catch (error) { require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ error: error.message })); }
  setTimeout(() => require('electron').app.quit(), 2500);
}));
`;
  const output = join(work, 'replacement');
  try {
    await writeFile(main, bootstrap + content);
    await run(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never', `--config.extraMetadata.version=${version}`, `--config.buildVersion=${version}`, `--config.directories.output=${output}`]);
  } finally { await writeFile(main, content); }
  const name = (await readdir(output)).find(name => name.endsWith('-setup.exe'));
  if (!name) throw new Error('Missing replacement installer');
  const archive = join(output, name), hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(archive)) { size += chunk.length; hash.update(chunk); }
  app = await electron.launch({ executablePath: executable, args: [], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: dataDirectory } });
  const page = await app.firstWindow(); await expect(page.locator('.monaco-editor')).toBeVisible();
  const database = join(work, 'kept.sqlite');
  await app.evaluate((_electron, path) => { const { DatabaseSync } = process.getBuiltinModule('node:sqlite'); const db = new DatabaseSync(path); db.exec('CREATE TABLE kept(id INTEGER)'); db.close(); }, database);
  await page.evaluate(database => window.studio.profiles.save({ engine: 'sqlite', name: 'Kept Windows connection', endpoint: database, user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: {} }), database);
  await page.locator('.monaco-editor').click({ position: { x: 100, y: 20 } });
  await page.keyboard.press('Control+A'); await page.keyboard.insertText('SELECT 42 AS kept_sql;');
  const deltaFixture = betaUpdate ? undefined : await prepareDeltaFixture({ directory: join(dataDirectory, 'updates'), currentVersion: pkg.version, version, baseArchive: original, archive });
  await installUpdateFixture(app, deltaFixture ?? { archive, version, size, digest: `sha256:${hash.digest('hex')}` });
  await page.evaluate(async () => { await window.studio.updates.check(); const state = await window.studio.updates.download(); if (state.phase !== 'ready') throw new Error(state.error || state.phase); });
  const transfer = (await page.evaluate(() => window.studio.updates.state())).transfer;
  if (!betaUpdate) { expect(transfer.mode).toBe('delta'); expect(transfer.reusedBytes).toBeGreaterThan(size * 0.1); expect(transfer.downloadedBytes).toBeLessThan(size); }
  await page.getByRole('button', { name: 'Обновления Local DB Viewer', exact: true }).click();
  const closed = new Promise(resolve => app.once('close', resolve));
  await page.getByRole('button', { name: 'Перезапустить и обновить', exact: true }).click();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('App did not close after updater handshake')), 45000))]); quit = true;
  let result, state;
  for (let attempt = 0; attempt < 180; attempt++) {
    state = JSON.parse(await readFile(join(dataDirectory, 'updates/install-state.json'), 'utf8').catch(() => '{}'));
    result = JSON.parse(await readFile(marker, 'utf8').catch(() => '{}'));
    if (state.phase === 'error') throw new Error(state.message);
    if (state.phase === 'complete' && result.version) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  expect(state?.phase).toBe('complete'); expect(result?.error).toBeUndefined(); expect(result?.version).toBe(version);
  expect(result.path.toLowerCase()).toBe(executable.toLowerCase());
  expect(result.profiles.map(profile => profile.name)).toContain('Kept Windows connection');
  expect(result.tabs.some(tab => tab.sql.includes('SELECT 42 AS kept_sql'))).toBe(true);
  await assertReleaseFuses(executable);
  await writeFile(join(artifacts, betaUpdate ? 'update-install-windows-beta-results.json' : 'update-install-windows-results.json'), JSON.stringify({ passed: true, from: pkg.version, to: version, sameDirectory: true, unicodePath: true, restartConfirmed: true, releaseFusesRestored: true, retainedProfile: true, retainedSQL: true, transfer }, null, 2));
  console.log(`PASS: Windows click → NSIS in same Unicode path → restart ${version} confirmed → connection and SQL preserved`);
} catch (error) {
  const logs = [];
  for (const folder of await readdir(join(dataDirectory, 'updates')).catch(() => [])) {
    const text = await readFile(join(dataDirectory, 'updates', folder, 'install.log'), 'utf8').catch(() => ''); if (text) logs.push(text);
  }
  await writeFile(join(artifacts, betaUpdate ? 'update-install-windows-beta-failure.json' : 'update-install-windows-failure.json'), JSON.stringify({ error: error.message, logs, state: await readFile(join(dataDirectory, 'updates/install-state.json'), 'utf8').catch(() => '') }, null, 2));
  throw error;
} finally {
  if (app && !quit) await app.close().catch(() => {});
  const uninstaller = (await readdir(installation).catch(() => [])).find(name => /^uninstall.*\.exe$/i.test(name));
  if (uninstaller) { await new Promise(resolve => setTimeout(resolve, 3000)); await run(join(installation, uninstaller), ['/S']); }
}
