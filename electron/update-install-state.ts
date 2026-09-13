import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
export interface InstallState { phase: 'waiting' | 'installing' | 'restarting' | 'complete' | 'error'; message: string; version: string; token: string; timestamp: string }
export async function installState(directory: string): Promise<InstallState | undefined> {
  try {
    const input: unknown = JSON.parse(await readFile(join(directory, 'install-state.json'), 'utf8'));
    if (!input || typeof input !== 'object') return;
    const value = input as InstallState;
    if (!['waiting','installing','restarting','complete','error'].includes(value.phase) || typeof value.message !== 'string' || value.message.length > 8000 || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isFinite(Date.parse(value.timestamp))) return;
    return value;
  } catch { return; }
}
export async function confirmUpdateStartup(directory: string, version: string): Promise<void> {
  const state = await installState(directory);
  if (!state || state.phase !== 'restarting' || state.version !== version || Date.now() - Date.parse(state.timestamp) > 120000) return;
  const path = join(directory, 'startup-ack.json'), temporary = `${path}.${state.token}.tmp`;
  await writeFile(temporary, JSON.stringify({ version, token: state.token, pid: process.pid }), { mode: 0o600 });
  await rename(temporary, path);
}
