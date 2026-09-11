import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
    const helper = join(work, 'update.ps1'); await copyFile(join(helperRoot, 'update-windows.ps1'), helper);
    await readyToQuit();
    await detached(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', helper, '-ParentProcessId', String(process.pid), '-Installer', artifact, '-Application', executable, '-LogPath', log]);
    app.quit();
  } else throw new Error('Эта платформа не поддерживает установку обновления.');
}
