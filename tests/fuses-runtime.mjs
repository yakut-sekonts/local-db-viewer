import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as asar from '@electron/asar';
import { assertReleaseFuses, bundlePaths, copyBundle, signTestBundle } from './fuses-helpers.mjs';

const executable = process.env.LOCAL_DB_VIEWER_RELEASE_EXECUTABLE;
assert.ok(executable, 'Test the actual release executable, with its Node inspector disabled');
const artifacts = resolve('test-artifacts');
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, 'fuses-runtime-'));
const production = await assertReleaseFuses(executable);
const report = { passed: false, production, checks: [] };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const exists = path => access(path).then(() => true, () => false);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
  });
}
async function profileDirectory(name) {
  const directory = join(work, name);
  await mkdir(join(directory, 'updates'), { recursive: true });
  await writeFile(join(directory, 'updates/settings.json'), JSON.stringify({ automatic: false, repository: 'fixture/public' }));
  await mkdir(join(directory, 'drivers'));
  await writeFile(join(directory, 'drivers/settings.json'), JSON.stringify({ automatic: false, installed: {}, selected: {} }));
  return directory;
}
function launch(file, args, directory, extraEnv = {}) {
  // Fuses must be exercised by the binary, without Playwright's Node debugger.
  const env = { ...process.env, LOCAL_DB_VIEWER_DATA_DIR: directory, ...extraEnv };
  if (!('ELECTRON_RUN_AS_NODE' in extraEnv)) delete env.ELECTRON_RUN_AS_NODE;
  if (!('NODE_OPTIONS' in extraEnv)) delete env.NODE_OPTIONS;
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 90000); watchdog.unref();
  let output = '', ended = false, failure;
  const collect = chunk => { output = (output + chunk.toString()).slice(-128 * 1024); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', error => { failure = error; ended = true; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); }));
  return {
    child, exited, get output() { return output; }, get ended() { return ended; },
    async endpoint() {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (failure) throw failure;
        const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(output)?.[1];
        if (endpoint) return endpoint;
        assert.ok(!ended, `Release application exited before opening a renderer: ${output}`);
        await delay(200);
      }
      throw new Error(`Renderer CDP endpoint not available: ${output}`);
    },
    async stop() {
      clearTimeout(watchdog);
      if (!ended) child.kill();
      for (let attempt = 0; !ended && attempt < 50; attempt++) await delay(100);
      if (!ended) child.kill('SIGKILL');
    },
  };
}

try {
  const injectionMarker = join(work, 'node-injection.txt');
  const injectionModule = join(work, 'node-injection.cjs');
  await writeFile(injectionModule, `require('node:fs').writeFileSync(${JSON.stringify(injectionMarker)}, 'executed');`);
  const inspectorPort = await freePort();
  const dataDirectory = await profileDirectory('production-user-data');
  // Secret-free legacy fixtures avoid accessing the developer's macOS Keychain.
  // Encrypted profile save/decrypt is covered by the isolated desktop CI suite.
  await writeFile(join(dataDirectory, 'connections.json'), JSON.stringify([false, true].map(jdbc => ({
    id: `fuses-${jdbc}`, engine: 'sqlite', name: jdbc ? 'JDBC fuse test' : 'Node worker fuse test',
    endpoint: join(work, jdbc ? 'jdbc.sqlite' : 'native.sqlite'), user: '', auth: 'none', tls: false, catalog: '', schema: '', ...(jdbc ? { jdbc: {} } : {}),
  }))));
  const app = launch(executable, ['--remote-debugging-port=0', `--inspect-brk=127.0.0.1:${inspectorPort}`], dataDirectory, {
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require=${JSON.stringify(injectionModule)}`,
  });
  let browser;
  try {
    // Only renderer CDP is used here. No main-process debugger or test code is
    // injected into the production application.
    browser = await chromium.connectOverCDP(await app.endpoint());
    const context = browser.contexts()[0];
    assert.ok(context);
    const page = context.pages()[0] ?? await context.waitForEvent('page');
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 });
    assert.equal(await exists(injectionMarker), false, 'NODE_OPTIONS injected code into the production application');
    assert.equal(await portOpen(inspectorPort), false, 'Main-process inspector must stay closed');
    report.checks.push('ELECTRON_RUN_AS_NODE ignored', 'NODE_OPTIONS require ignored', 'Node inspect-brk ignored');
    for (const jdbc of [false, true]) {
      const result = await page.evaluate(async jdbc => {
        const profile = (await window.studio.profiles.list()).find(item => item.id === `fuses-${jdbc}`);
        if (!profile) throw new Error('Missing fixture profile');
        const requestId = crypto.randomUUID(), sessionId = `fuses-${jdbc}`;
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { unsubscribe(); reject(new Error('SQL timeout in strict-fuse application')); }, 30000);
            const unsubscribe = window.studio.query.onUpdate(result => {
              if (result.requestId !== requestId || result.state === 'RUNNING') return;
              clearTimeout(timer); unsubscribe();
              if (result.state !== 'FINISHED') reject(new Error(result.error ?? result.state)); else resolve(result.rows);
            });
            window.studio.query.run({ requestId, sessionId, profileId: profile.id, sql: "SELECT 42 AS value, 'Кириллица 😀' AS label", catalog: '', schema: '', maxRows: 100 }).catch(error => { clearTimeout(timer); unsubscribe(); reject(error); });
          });
        } finally { await window.studio.query.release(sessionId); }
      }, jdbc);
      assert.deepEqual(result, [['42', 'Кириллица 😀']]);
      report.checks.push(jdbc ? 'bundled JDBC/JRE query' : 'native Node worker query');
    }
    await page.screenshot({ path: join(artifacts, 'fuses-production.png') });
    console.log('PASS: unmodified release starts with strict fuses, rejects Node injection/inspector and executes Node/JDBC SQLite queries');
  } finally {
    await app.stop();
    if (browser) await browser.close().catch(() => {});
    await writeFile(join(artifacts, 'fuses-production-output.txt'), app.output);
  }

  // Mutations target one disposable bundle; the original remains byte-identical.
  const damagedExecutable = await copyBundle(executable, join(work, 'damaged'));
  const damaged = bundlePaths(damagedExecutable), archive = join(damaged.resources, 'app.asar');
  const originalArchive = join(bundlePaths(executable).resources, 'app.asar');
  for (const mutation of ['payload', 'header', 'unpacked-fallback']) {
    await copyFile(originalArchive, archive);
    if (mutation === 'payload') {
      const bytes = await readFile(archive);
      const offset = 8 + asar.getRawHeader(archive).headerSize + Number(asar.statFile(archive, 'dist-electron/main.cjs').offset);
      bytes[offset] ^= 1;
      await writeFile(archive, bytes);
    } else if (mutation === 'header') {
      const bytes = await readFile(archive), header = asar.getRawHeader(archive);
      const hash = asar.statFile(archive, 'dist-electron/main.cjs').integrity.hash;
      const index = bytes.indexOf(Buffer.from(hash));
      assert.ok(index >= 0 && index < 8 + header.headerSize);
      bytes[index] = bytes[index] === 97 ? 98 : 97;
      await writeFile(archive, bytes);
    } else {
      await rm(archive);
      const fallback = join(damaged.resources, 'app');
      await mkdir(fallback);
      await writeFile(join(fallback, 'package.json'), JSON.stringify({ main: 'index.cjs', name: 'fuse-fallback-probe' }));
      await writeFile(join(fallback, 'index.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(injectionMarker)}, 'fallback'); require('electron').app.quit();`);
    }
    // Refresh the disposable ad-hoc signature's resource seal so the negative
    // test reaches Electron's ASAR checks, rather than failing macOS code signing.
    await signTestBundle(damagedExecutable);
    const app = launch(damagedExecutable, [], await profileDirectory(`negative-${mutation}`));
    try {
      for (let attempt = 0; !app.ended && attempt < 100; attempt++) await delay(100);
      assert.equal(await exists(injectionMarker), false, 'Electron loaded resources/app despite OnlyLoadAppFromAsar');
      assert.ok(app.ended, `Tampered ${mutation} application did not terminate: ${app.output}`);
      const exit = await app.exited;
      if (mutation !== 'unpacked-fallback') {
        assert.ok(exit.code !== 0 || exit.signal, 'Corrupted ASAR must fail startup');
        assert.match(app.output, /integrity|hash/i, 'Expected an Electron integrity failure');
      }
      report.checks.push(`reject ${mutation}`);
      console.log(`PASS: strict release rejects ${mutation}`);
    } finally {
      await app.stop();
      await writeFile(join(artifacts, `fuses-${mutation}-output.txt`), app.output);
    }
  }
  assert.deepEqual(await assertReleaseFuses(executable), production);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(join(artifacts, 'fuses-runtime-results.json'), JSON.stringify(report, null, 2));
  await rm(work, { recursive: true, force: true });
}
