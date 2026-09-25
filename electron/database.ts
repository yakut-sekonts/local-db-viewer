import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { TrinoQuery, TrinoSession, type Connection } from './trino';
import type { QuerySnapshot } from '../src/shared';
import { singleStatement, transactionAction } from './sql';
import { sqlEngine } from '../src/drivers';
import { JdbcWorker } from './jdbc-worker';
import { startupTimeout } from './before-connect';
import { createScriptTask } from './script-runner';

export interface QueryTask { run(sql: string): Promise<QuerySnapshot>; cancel(): Promise<void> }
export class DatabaseSession {
  private trino = new TrinoSession();
  private worker?: Worker | JdbcWorker;
  private current?: { requestId: string; resolve(result: QuerySnapshot): void; notify(result: QuerySnapshot): void; latest: QuerySnapshot };
  private cancelResolve?: { resolve(): void; reject(error: Error): void };
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private lastPing = Date.now();
  inTransaction = false;
  constructor(private connection: Connection) {}
  private enqueue<T>(work: () => Promise<T>, activity = true): Promise<T> {
    this.pending++;
    const result = this.queue.then(work).finally(() => { this.pending--; if (activity) this.lastActivity = Date.now(); });
    this.queue = result.catch(() => {}); return result;
  }
  private schedule(): void {
    const options = this.connection.jdbc?.options;
    if (this.timer || !options || !options.keepAliveSeconds && !options.autoDisconnectSeconds) return;
    this.timer = setInterval(() => {
      if (this.pending || this.inTransaction || !this.worker) return;
      const now = Date.now();
      if (options.autoDisconnectSeconds && now - this.lastActivity >= options.autoDisconnectSeconds * 1000) {
        void this.close().catch(() => {});
      } else if (options.keepAliveSeconds && now - this.lastPing >= options.keepAliveSeconds * 1000) {
        this.lastPing = now;
        void this.enqueue(() => this.inspectNow({ kind: 'ping', sql: options.keepAliveQuery ?? '' }, 15000), false).catch(() => this.close()).catch(() => {});
      }
    }, 1000);
    this.timer.unref();
  }
  private ensureWorker(): Worker | JdbcWorker {
    if (this.worker) return this.worker;
    const worker = this.connection.jdbc ? new JdbcWorker(this.connection) : new Worker(join(__dirname, 'database-worker.cjs'), { workerData: this.connection });
    this.worker = worker;
    this.schedule();
    worker.on('message', message => {
      if ((message.kind === 'done' || message.kind === 'update') && this.current) {
        this.current.latest = message.snapshot;
        this.inTransaction = message.snapshot.inTransaction;
        this.current.notify(message.snapshot);
        if (message.kind === 'done') { this.current.resolve(message.snapshot); this.current = undefined; }
      }
      if (message.kind === 'cancel') {
        if (message.error) this.cancelResolve?.reject(new Error(message.error)); else this.cancelResolve?.resolve();
        this.cancelResolve = undefined;
      }
    });
    worker.on('error', error => { this.fail(error); if (this.worker === worker) this.worker = undefined; void worker.terminate(); });
    worker.on('exit', code => { if (this.worker === worker) { this.worker = undefined; this.inTransaction = false; if (this.current) this.fail(new Error(`Драйвер завершился (${code}). Сессия закрыта.`)); } });
    return worker;
  }
  private fail(error: Error): void {
    this.inTransaction = false;
    if (this.current) {
      const result: QuerySnapshot = { ...this.current.latest, state: 'FAILED', error: error.message, inTransaction: false };
      this.current.notify(result); this.current.resolve(result); this.current = undefined;
    }
    this.cancelResolve?.reject(error); this.cancelResolve = undefined;
  }
  createQuery(requestId: string, maxRows = 1000, notify: (result: QuerySnapshot) => void = () => {}, catalog = '', schema = '', context?: { apply: boolean; searchPath?: string }): QueryTask {
    let task: QueryTask | undefined, canceled = false;
    return {
      run: sql => this.enqueue(async () => {
        if (canceled) {
          const result: QuerySnapshot = { requestId, queryId: '', state: 'CANCELED', columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: this.inTransaction };
          notify(result); return result;
        }
        try {
          task = this.directQuery(requestId, maxRows, result => { this.inTransaction = result.inTransaction; notify(result); }, catalog, schema, context);
          return await task.run(sql);
        } catch (error) {
          const result: QuerySnapshot = { requestId, queryId: '', state: 'FAILED', error: (error as Error).message, columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: this.inTransaction };
          notify(result); return result;
        }
      }),
      cancel: async () => { canceled = true; await task?.cancel(); },
    };
  }
  createScript(requestId: string, maxRows: number, notify: (result: QuerySnapshot) => void, catalog: string, schema: string, context?: { apply: boolean; searchPath?: string }): QueryTask {
    return createScriptTask({ requestId, engine: sqlEngine(this.connection), enqueue: work => this.enqueue(work), notify, inTransaction: () => this.inTransaction,
      createQuery: (id, update, first) => this.directQuery(id, maxRows, result => { this.inTransaction = result.inTransaction; update(result); }, catalog, schema, first ? context : { apply: false }),
    });
  }
  inspect<T>(request: { kind: string; [key: string]: unknown }, timeout = 60000): Promise<T> { return this.enqueue(() => this.inspectNow<T>(request, timeout)); }
  private async inspectNow<T>(request: { kind: string; [key: string]: unknown }, timeout: number): Promise<T> {
    if (!this.connection.jdbc) throw new Error('Inspection требует JDBC.');
    if (!this.worker) timeout += startupTimeout(this.connection.jdbc);
    const worker = this.ensureWorker(), requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', failure); worker.off('exit', exited); };
      const failure = (error: Error) => { cleanup(); reject(error); };
      const exited = () => failure(new Error('JDBC-сессия закрыта.'));
      const message = (value: any) => {
        if (value.requestId !== requestId || value.kind !== request.kind) return;
        cleanup(); this.inTransaction = Boolean(value.inTransaction);
        if (value.error) reject(new Error(value.error)); else resolve(value.value);
      };
      const timer = setTimeout(() => { failure(new Error('Таймаут JDBC metadata/keep-alive.')); void worker.terminate(); }, timeout);
      worker.on('message', message); worker.once('error', failure); worker.once('exit', exited);
      try { worker.postMessage({ ...request, requestId }); } catch (error) { failure(error as Error); }
    });
  }
  private directQuery(requestId: string, maxRows = 1000, notify: (result: QuerySnapshot) => void = () => {}, catalog = '', schema = '', context?: { apply: boolean; searchPath?: string }): QueryTask {
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error('Лимит строк должен быть от 1 до 10000.');
    if (this.connection.engine === 'trino' && !this.connection.jdbc) {
      if (context?.apply !== false) { this.trino.catalog = catalog; this.trino.schema = schema; }
      const task = new TrinoQuery(this.connection, this.trino, requestId, maxRows, notify);
      return { run: sql => task.run(singleStatement(sql, sqlEngine(this.connection))), cancel: () => task.cancel() };
    }
    return {
      run: sql => {
        if (this.current) throw new Error('В сессии уже выполняется запрос.');
        const statement = singleStatement(sql, sqlEngine(this.connection));
        const worker = this.ensureWorker();
        return new Promise(resolve => {
          this.current = { requestId, resolve, notify, latest: { requestId, queryId: '', state: 'RUNNING', columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: false, catalog, schema } };
          try { worker.postMessage({ kind: 'run', requestId, sql: statement, transactionAction: transactionAction(statement), maxRows, catalog: context?.apply === false && !this.connection.jdbc ? '' : catalog, schema: context?.apply === false && !this.connection.jdbc ? '' : schema, applyContext: context?.apply ?? true, searchPath: context?.searchPath }); }
          catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        });
      },
      cancel: async () => {
        if (!this.current || this.current.requestId !== requestId) return;
        if (this.connection.engine === 'sqlite') {
          const worker = this.worker; this.worker = undefined;
          await worker?.terminate();
          if (this.current) {
            const result: QuerySnapshot = { ...this.current.latest, state: 'CANCELED', inTransaction: false, warnings: ['SQLite-сессия закрыта. Незавершённая транзакция откатывается.'] };
            this.current.notify(result); this.current.resolve(result); this.current = undefined;
          }
          return;
        }
        if (this.cancelResolve) return;
        await new Promise<void>((resolve, reject) => { this.cancelResolve = { resolve, reject }; this.worker?.postMessage({ kind: 'cancel' }); });
      },
    };
  }
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    return this.enqueue(() => this.closeNow(), false);
  }
  private async closeNow(): Promise<void> {
    if (this.connection.engine === 'trino' && !this.connection.jdbc && this.trino.transaction !== 'NONE') {
      const result = await new TrinoQuery(this.connection, this.trino, crypto.randomUUID()).run('ROLLBACK');
      if (result.state !== 'FINISHED') throw new Error(result.error ?? 'Не удалось выполнить ROLLBACK.');
    }
    if (this.worker) {
      const worker = this.worker;
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => { clearTimeout(timeout); worker.off('message', listener); worker.off('exit', exited); if (error) reject(error); else resolve(); };
          const listener = (message: any) => { if (message.kind === 'closed') finish(message.error ? new Error(message.error) : undefined); };
          const exited = () => finish();
          const timeout = setTimeout(() => finish(new Error('Таймаут закрытия сессии.')), 10000);
          worker.on('message', listener); worker.once('exit', exited);
          try { worker.postMessage({ kind: 'close' }); } catch (error) { finish(error as Error); }
        });
      } finally { this.worker = undefined; this.inTransaction = false; await worker.terminate(); }
    }
  }
  async abort(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const worker = this.worker; this.worker = undefined;
    this.fail(new Error('Приложение закрывается.'));
    await worker?.terminate();
  }
}
