import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { installState } from './update-install-state';

const execute = promisify(execFile);
function under(path: string, root: string): boolean { const value = relative(root, path); return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); }
async function detached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => { const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
export async function installUpdate(artifact: string, version: string, readyToQuit: () => Promise<void>): Promise<void> {
  if (!app.isPackaged) throw new Error('Установка обновлений доступна в установленной версии Local DB Viewer.');
  const helperRoot = join(process.resourcesPath, 'updater');
  const work = dirname(artifact);
  const log = join(work, 'install.log');
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const target = await realpath(join(dirname(process.execPath), '../..'));
    if (!target.endsWith('.app') || !under(target, await realpath(homedir()))) throw new Error('Для обновления без прав администратора переместите Local DB Viewer.app в ~/Applications и запустите оттуда.');
    const parent = dirname(target); await access(parent, constants.W_OK);
    const staging = join(parent, `.local-db-viewer-update-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    let launched = false;
    try {
      await execute('/usr/bin/ditto', ['-x', '-k', artifact, staging], { timeout: 180000 });
      const source = join(staging, 'Local DB Viewer.app');
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], { timeout: 60000 });
      const plist = join(source, 'Contents/Info.plist');
      const { stdout: id } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
      const { stdout: actualVersion } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
      if (id.trim() !== 'dev.localdbviewer.desktop' || actualVersion.trim() !== version) throw new Error('Содержимое обновления не соответствует Local DB Viewer и версии релиза.');
      const helper = join(work, 'update.sh'); await copyFile(join(helperRoot, 'update-mac.sh'), helper);
      await readyToQuit();
      await detached('/bin/sh', [helper, String(process.pid), source, target, join(parent, `.Local-DB-Viewer-backup-${app.getVersion()}-${randomUUID()}.app`), log]);
      launched = true;
      app.quit();
    } finally { if (!launched) await rm(staging, { recursive: true, force: true }); }
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    const executable = await realpath(process.execPath);
    if (!under(executable, await realpath(homedir()))) throw new Error('Для обновления без прав администратора установите Local DB Viewer для текущего пользователя.');
    await access(dirname(executable), constants.W_OK);
    const helper = join(work, 'update-windows.exe'); await copyFile(join(helperRoot, 'update-windows.exe'), helper);
    const request = join(work, 'install-request.json'), token = randomUUID(), ready = join(work, 'helper-ready.json');
    await rm(ready, { force: true });
    const hash = createHash('sha256'); for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    await writeFile(request, JSON.stringify({ parentId: process.pid, application: executable, installer: artifact, version, token, sha256: hash.digest('hex'), status: join(dirname(work), 'install-state.json') }), { mode: 0o600 });
    const child = spawn(helper, [request], { detached: true, stdio: 'ignore', windowsHide: true, cwd: work });
    let launchError: Error | undefined;
    child.once('error', error => { launchError = error; });
    try {
      const deadline = Date.now() + 20000;
      for (;;) {
        if (launchError) throw new Error(`Не удалось запустить Windows update helper: ${launchError.message}`);
        if (child.exitCode !== null) {
          const state = await installState(dirname(work));
          throw new Error(state?.token === token ? state.message : `Windows update helper завершился до запуска установщика (${child.exitCode}).`);
        }
        const response = await readFile(ready, 'utf8').then(text => JSON.parse(text) as { token: string }).catch(() => undefined);
        if (response?.token === token) break;
        if (Date.now() >= deadline) throw new Error('Windows не подтвердил запуск update helper за 20 секунд. Приложение оставлено открытым; проверьте блокировку запуска файла средствами организации.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await readyToQuit();
      child.unref(); app.quit();
    } catch (error) { child.kill(); throw error; }
  } else throw new Error('Эта платформа не поддерживает установку обновления.');
}
