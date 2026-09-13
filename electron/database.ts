import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { TrinoQuery, TrinoSession, type Connection } from './trino';
import type { QuerySnapshot } from '../src/shared';
import { singleStatement, transactionAction } from './sql';
import { sqlEngine } from '../src/drivers';
import { JdbcWorker } from './jdbc-worker';

export interface QueryTask { run(sql: string): Promise<QuerySnapshot>; cancel(): Promise<void> }
export class DatabaseSession {
  private trino = new TrinoSession();
  private worker?: Worker | JdbcWorker;
  private current?: { requestId: string; resolve(result: QuerySnapshot): void; notify(result: QuerySnapshot): void; latest: QuerySnapshot };
  private cancelResolve?: { resolve(): void; reject(error: Error): void };
  constructor(private connection: Connection) {}
  private ensureWorker(): Worker | JdbcWorker {
    if (this.worker) return this.worker;
    const worker = this.connection.jdbc ? new JdbcWorker(this.connection) : new Worker(join(__dirname, 'database-worker.cjs'), { workerData: this.connection });
    this.worker = worker;
    worker.on('message', message => {
      if ((message.kind === 'done' || message.kind === 'update') && this.current) {
        this.current.latest = message.snapshot;
        this.current.notify(message.snapshot);
        if (message.kind === 'done') { this.current.resolve(message.snapshot); this.current = undefined; }
      }
      if (message.kind === 'cancel') {
        if (message.error) this.cancelResolve?.reject(new Error(message.error)); else this.cancelResolve?.resolve();
        this.cancelResolve = undefined;
      }
    });
    worker.on('error', error => this.fail(error));
    worker.on('exit', code => { if (this.worker === worker) { this.worker = undefined; if (this.current) this.fail(new Error(`Драйвер завершился (${code}). Сессия закрыта.`)); } });
    return worker;
  }
  private fail(error: Error): void {
    if (this.current) {
      const result: QuerySnapshot = { ...this.current.latest, state: 'FAILED', error: error.message, inTransaction: false };
      this.current.notify(result); this.current.resolve(result); this.current = undefined;
    }
    this.cancelResolve?.reject(error); this.cancelResolve = undefined;
  }
  createQuery(requestId: string, maxRows = 1000, notify: (result: QuerySnapshot) => void = () => {}, catalog = '', schema = ''): QueryTask {
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error('Лимит строк должен быть от 1 до 10000.');
    if (this.connection.engine === 'trino' && !this.connection.jdbc) {
      this.trino.catalog = catalog; this.trino.schema = schema;
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
          try { worker.postMessage({ kind: 'run', requestId, sql: statement, transactionAction: transactionAction(statement), maxRows, catalog, schema }); }
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
      } finally { this.worker = undefined; await worker.terminate(); }
    }
  }
}
