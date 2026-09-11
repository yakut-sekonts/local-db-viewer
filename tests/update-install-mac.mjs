import { _electron as electron, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';

if (process.platform !== 'darwin') throw new Error('This test exercises the macOS updater.');
const execute = promisify(execFile);
const root = resolve('.');
const artifacts = join(root, 'test-artifacts'); await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, 'update-install-'));
const original = resolve('release/mac-arm64/Local DB Viewer.app');
const installed = join(work, 'installed/Local DB Viewer.app');
const replacement = join(work, 'replacement/Local DB Viewer.app');
const dataDirectory = join(work, 'user-data');
const marker = join(work, 'restarted.json');
const progressPath = join(work, 'restart-progress.json');
const sourceVersion = JSON.parse(asar.extractFile(join(original, 'Contents/Resources/app.asar'), 'package.json').toString('utf8')).version;
const [major, minor, patch] = sourceVersion.split('.').map(Number);
const version = `${major}.${minor}.${patch + 1}`;
await cp(original, installed, { recursive: true, verbatimSymlinks: true });
await cp(original, replacement, { recursive: true, verbatimSymlinks: true });
const unpacked = join(work, 'asar');
asar.extractAll(join(replacement, 'Contents/Resources/app.asar'), unpacked);
const pkg = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8')); pkg.version = version;
await writeFile(join(unpacked, 'package.json'), JSON.stringify(pkg));
const main = join(unpacked, 'dist-electron/main.cjs');
// Only the test replacement records the state after LaunchServices starts it.
const bootstrap = `
process.env.LOCAL_DB_VIEWER_DATA_DIR = ${JSON.stringify(dataDirectory)};
const updateTestProgress = stage => require('node:fs').writeFileSync(${JSON.stringify(progressPath)}, JSON.stringify({ stage, pid: process.pid }));
updateTestProgress('main-started');
require('electron').app.on('browser-window-created', (_event, window) => {
  updateTestProgress('window-created');
  window.webContents.once('did-finish-load', async () => {
    try {
      updateTestProgress('reading-profiles');
      const profiles = await window.webContents.executeJavaScript('window.studio.profiles.list()');
      const tabs = await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem("studio.tabs") || "[]")');
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: require('electron').app.getVersion(), profiles, tabs }));
    } catch (error) { require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ error: error.message })); }
    require('electron').app.quit();
  });
});
`;
await writeFile(main, bootstrap + await readFile(main, 'utf8'));
await asar.createPackage(unpacked, join(replacement, 'Contents/Resources/app.asar'));
const integrity = createHash('sha256').update(asar.getRawHeader(join(replacement, 'Contents/Resources/app.asar')).headerString).digest('hex');
await execute('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${integrity}`, join(replacement, 'Contents/Info.plist')]);
await execute('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, join(replacement, 'Contents/Info.plist')]);
await execute('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${version}`, join(replacement, 'Contents/Info.plist')]);
await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', replacement], { timeout: 120000 });
const archive = join(work, `Local-DB-Viewer-${version}-mac-arm64.zip`);
await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', replacement, archive], { timeout: 180000 });
const hash = createHash('sha256'); let size = 0;
for await (const chunk of createReadStream(archive)) { size += chunk.length; hash.update(chunk); }
const digest = `sha256:${hash.digest('hex')}`;
console.log('Prepared isolated application and verified replacement fixture');
let app;
let quit = false;
let restoreKeychain = async () => {};
try {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Only the disposable CI account gets a dedicated fixture keychain. Trust
    // precisely these two ad-hoc test binaries; production Keychain ACLs stay intact.
    const security = args => execute('/usr/bin/security', args);
    const oldSearch = (await security(['list-keychains', '-d', 'user'])).stdout.match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) ?? [];
    const oldDefault = (await security(['default-keychain', '-d', 'user'])).stdout.trim().replace(/^"|"$/g, '');
    const keychain = join(work, 'update-fixture.keychain-db');
    const keychainPassword = randomBytes(24).toString('base64');
    await security(['create-keychain', '-p', keychainPassword, keychain]);
    restoreKeychain = async () => {
      await security(['default-keychain', '-d', 'user', '-s', oldDefault]);
      await security(['list-keychains', '-d', 'user', '-s', ...oldSearch]);
      await security(['delete-keychain', keychain]);
    };
    await security(['unlock-keychain', '-p', keychainPassword, keychain]);
    await security(['set-keychain-settings', '-lut', '3600', keychain]);
    await security(['list-keychains', '-d', 'user', '-s', keychain, ...oldSearch]);
    await security(['default-keychain', '-d', 'user', '-s', keychain]);
    const executables = [installed, replacement].map(bundle => join(bundle, 'Contents/MacOS/Local DB Viewer'));
    const hashes = [];
    for (const executable of executables) {
      const { stderr } = await execute('/usr/bin/codesign', ['-d', '--verbose=4', executable]);
      const hash = /^CDHash=([a-f0-9]+)$/m.exec(stderr)?.[1]; if (!hash) throw new Error('Missing test binary CDHash');
      hashes.push(`cdhash:${hash}`);
    }
    await security(['add-generic-password', '-a', 'Local DB Viewer', '-s', 'Local DB Viewer Safe Storage', '-w', randomBytes(24).toString('base64'), ...executables.flatMap(path => ['-T', path]), keychain]);
    await security(['set-generic-password-partition-list', '-a', 'Local DB Viewer', '-s', 'Local DB Viewer Safe Storage', '-S', hashes.join(','), '-k', keychainPassword, keychain]);
    console.log('Prepared isolated CI Keychain for the two signed update fixtures');
  }
  app = await electron.launch({ executablePath: join(installed, 'Contents/MacOS/Local DB Viewer'), args: [], env: { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: dataDirectory } });
  const page = await app.firstWindow();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  const database = join(work, 'kept.sqlite');
  await app.evaluate((_electron, database) => { const { DatabaseSync } = process.getBuiltinModule('node:sqlite'); const db = new DatabaseSync(database); db.exec('CREATE TABLE kept (id INTEGER)'); db.close(); }, database);
  await page.evaluate(async database => { await window.studio.profiles.save({ engine: 'sqlite', name: 'Kept connection', endpoint: database, user: '', auth: 'none', tls: false, catalog: '', schema: '', jdbc: {} }); }, database);
  await page.locator('.monaco-editor').click({ position: { x: 100, y: 20 } });
  await page.keyboard.press('Meta+A'); await page.keyboard.insertText('SELECT 42 AS kept_sql;');
  await expect(page.locator('.view-lines')).toContainText('SELECT 42 AS kept_sql');
  await app.evaluate((_electron, { archive, version, size, digest }) => {
    const { createReadStream } = process.getBuiltinModule('node:fs');
    const { Readable } = process.getBuiltinModule('node:stream');
    globalThis.fetch = async url => String(url).includes('/releases/latest')
      ? new Response(JSON.stringify({ tag_name: `v${version}`, body: 'Isolated update test', assets: [{ id: 1, name: `Local-DB-Viewer-${version}-mac-arm64.zip`, size, digest }] }))
      : new Response(Readable.toWeb(createReadStream(archive)));
  }, { archive, version, size, digest });
  await page.evaluate(async () => {
    await window.studio.updates.configure({ repository: 'fixture/releases', automatic: false, token: 'isolated-token' });
    await window.studio.updates.check();
    const result = await window.studio.updates.download(); if (result.phase !== 'ready') throw new Error(result.error || result.phase);
  });
  await page.getByRole('button', { name: 'Обновления Local DB Viewer', exact: true }).click();
  const closed = new Promise(resolve => app.once('close', resolve));
  await page.getByRole('button', { name: 'Перезапустить и обновить', exact: true }).click();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Application did not quit for update')), 45000))]);
  quit = true;
  let result;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { result = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!result) throw new Error(`Updated application did not start; inspect ${work}`);
  expect(result.error).toBeUndefined();
  expect(result.version).toBe(version);
  expect(result.profiles.map(profile => profile.name)).toContain('Kept connection');
  expect(result.tabs.some(tab => tab.sql.includes('SELECT 42 AS kept_sql'))).toBe(true);
  expect((await readdir(join(work, 'installed'))).some(name => name.startsWith('.Local-DB-Viewer-backup-'))).toBe(true);
  await writeFile(join(artifacts, 'update-install-results.json'), JSON.stringify({ passed: true, from: sourceVersion, to: version, retainedProfile: true, retainedSQL: true, backup: true, testedAt: new Date().toISOString() }, null, 2));
  console.log(`PASS: click → replace application → restart ${version} → connection and SQL restored; previous app retained`);
} catch (error) {
  const diagnostics = { error: error.message, progress: await readFile(progressPath, 'utf8').catch(() => 'not started'), logs: [] };
  for (const folder of await readdir(join(dataDirectory, 'updates')).catch(() => [])) {
    const log = await readFile(join(dataDirectory, 'updates', folder, 'install.log'), 'utf8').catch(() => '');
    if (log) diagnostics.logs.push(log);
  }
  await writeFile(join(artifacts, 'update-install-failure.json'), JSON.stringify(diagnostics, null, 2));
  console.error(JSON.stringify(diagnostics)); throw error;
} finally { if (app && !quit) await app.close().catch(() => {}); await restoreKeychain(); }
