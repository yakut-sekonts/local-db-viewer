import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NETWORK_BLOCKED_CODE, NETWORK_BLOCKED_MESSAGE, type NetworkMode, type NetworkState } from '../src/network';
import type { UpdateFetch } from './update-source';

export class NetworkBlockedError extends Error {
  readonly code = NETWORK_BLOCKED_CODE;
  constructor() { super(NETWORK_BLOCKED_MESSAGE); }
}

// This controls IDE downloads, not network access of third-party JDBC code.
export class NetworkPolicy {
  private status: NetworkState = { mode: 'database-only' };
  private initialized = false;
  private epoch = new AbortController();
  private operations = new AsyncLocalStorage<AbortSignal>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string, private notify: (state: NetworkState) => void = () => {}) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const text = await readFile(this.path, 'utf8');
      if (text.length > 4096) throw new Error('Invalid network settings');
      const value = JSON.parse(text);
      if (!value || value.format !== 1 || !['online', 'database-only'].includes(value.mode)) throw new Error('Invalid network settings');
      this.status = { mode: value.mode };
    } catch (error) {
      this.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? { mode: 'online' }
        : { mode: 'database-only', error: 'Не удалось прочитать сетевые настройки. Внешние загрузки заблокированы; выберите и сохраните режим повторно.' };
    }
    this.initialized = true;
    this.notify(this.state());
  }
  state(): NetworkState { return { ...this.status }; }
  allowed(): boolean { return this.initialized && this.status.mode === 'online'; }
  private assertAllowed(): void {
    if (!this.allowed()) throw new NetworkBlockedError();
    this.operations.getStore()?.throwIfAborted();
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.assertAllowed();
    // Retain the aborted epoch across retries/redirects/delta fallback, even if
    // the user re-enables downloads before the original operation finishes.
    return this.operations.run(this.operations.getStore() ?? this.epoch.signal, action);
  }
  guard(fetch: UpdateFetch): UpdateFetch {
    return async (url, options) => {
      this.assertAllowed();
      const epoch = this.operations.getStore() ?? this.epoch.signal;
      const signal = options.signal ? AbortSignal.any([epoch, options.signal]) : epoch;
      signal.throwIfAborted();
      return fetch(url, { ...options, signal });
    };
  }
  async configure(mode: NetworkMode): Promise<NetworkState> {
    if (mode !== 'online' && mode !== 'database-only') throw new Error('Некорректный сетевой режим.');
    if (!this.initialized) throw new Error('Сетевые настройки ещё загружаются.');
    const task = this.queue.then(async () => {
      if (mode === 'database-only') {
        this.status = { mode }; this.epoch.abort(new NetworkBlockedError()); this.notify(this.state());
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ format: 1, mode }), { mode: 0o600 });
        await rename(temporary, this.path);
        if (mode === 'online' && this.epoch.signal.aborted) this.epoch = new AbortController();
        this.status = { mode }; this.notify(this.state()); return this.state();
      } catch {
        // Never reopen the network after a failed attempt to persist a policy.
        this.status = { mode: 'database-only', error: 'Не удалось сохранить сетевой режим. Внешние загрузки заблокированы до успешного сохранения; настройка после перезапуска не гарантирована.' };
        this.epoch.abort(new NetworkBlockedError()); this.notify(this.state());
        throw new Error(this.status.error);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.queue = task.catch(() => {}); return task;
  }
  dispose(): void { this.initialized = false; this.epoch.abort(new NetworkBlockedError()); }
}

export function externalOperation<T>(network: NetworkPolicy | undefined, action: () => Promise<T>): Promise<T> {
  return network ? network.run(action) : action();
}
