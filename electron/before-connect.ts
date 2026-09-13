import { spawn } from 'node:child_process';
import type { JdbcSettings } from '../src/jdbc';

export async function beforeConnect(settings: JdbcSettings | undefined, signal: AbortSignal): Promise<void> {
  for (const task of settings?.options?.beforeConnect ?? []) {
    if (!task.enabled) continue;
    if (signal.aborted) throw new Error('Подключение отменено.');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(task.executable, task.args, { windowsHide: true, shell: false, stdio: 'ignore', cwd: settings?.workingDirectory, env: { ...process.env, ...settings?.environment } });
      let failure = '';
      const stop = () => { failure ||= 'Подключение отменено.'; child.kill('SIGKILL'); };
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => { failure = `Before connection «${task.name}»: timeout ${task.timeoutSeconds} секунд.`; stop(); }, task.timeoutSeconds * 1000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(new Error(`Before connection «${task.name}»: ${error.message}`)); });
      child.once('exit', code => { cleanup(); if (failure || code !== 0) reject(new Error(failure || `Before connection «${task.name}»: exit code ${code}.`)); else resolve(); });
      if (signal.aborted) stop();
    });
  }
}
