import type { DatabaseEngine, QuerySnapshot } from '../src/shared';
import type { QueryTask } from './database';
import { splitSqlScript, type SqlStatement } from './sql';

export const SCRIPT_RESULT_BYTES = 16 * 1024 ** 2;
// Rows and columns from all statements share one retention budget. Drivers still
// drain results according to their normal cancellation/row-limit semantics.
export function retainScriptData(snapshot: QuerySnapshot, budget: number): { snapshot: QuerySnapshot; bytes: number; limited: boolean } {
  let bytes = Buffer.byteLength(JSON.stringify(snapshot.columns));
  if (bytes > budget) return { snapshot: { ...snapshot, columns: [], rows: [], truncated: snapshot.totalRows > 0 || snapshot.truncated }, bytes: 0, limited: true };
  const rows: QuerySnapshot['rows'] = []; let limited = false;
  for (const row of snapshot.rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > budget) { limited = true; break; }
    rows.push(row); bytes += size;
  }
  return { snapshot: { ...snapshot, rows, truncated: snapshot.truncated || limited }, bytes, limited };
}
interface ScriptOptions {
  requestId: string; engine: DatabaseEngine;
  enqueue(work: () => Promise<QuerySnapshot>): Promise<QuerySnapshot>;
  createQuery(id: string, notify: (result: QuerySnapshot) => void, first: boolean): QueryTask;
  notify(result: QuerySnapshot): void;
  inTransaction(): boolean;
}
export function createScriptTask(options: ScriptOptions): QueryTask {
  let task: QueryTask | undefined, canceled = false, used = false;
  const empty = (state: QuerySnapshot['state'], error?: string): QuerySnapshot => ({ requestId: options.requestId, queryId: '', state, columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: options.inTransaction(), ...(error ? { error } : {}) });
  return {
    cancel: async () => { canceled = true; await task?.cancel(); },
    run: sql => options.enqueue(async () => {
      if (used) throw new Error('SQL-скрипт уже запускался. Создайте новый request ID.');
      used = true;
      const started = Date.now(); let statements: SqlStatement[];
      try { statements = splitSqlScript(sql, options.engine); }
      catch (error) { const result = empty('FAILED', (error as Error).message); options.notify(result); return result; }
      let remaining = SCRIPT_RESULT_BYTES, completed = 0;
      let latest: QuerySnapshot | undefined;
      const emit = (snapshot: QuerySnapshot, part: SqlStatement, index: number, state: QuerySnapshot['state'], limited = false) => {
        const result: QuerySnapshot = { ...snapshot, requestId: options.requestId, script: { index, total: statements.length, completed, line: part.line, preview: part.sql.replace(/\s+/g, ' ').slice(0, 160), state, elapsedTimeMillis: Date.now() - started, ...(limited ? { dataLimited: true } : {}) } };
        options.notify(result); return result;
      };
      for (let index = 0; index < statements.length; index++) {
        const part = statements[index]; if (!part) break;
        // Give IPC cancellation a chance between statements while keeping the
        // session queue exclusively held for the entire script.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (canceled) {
          const result = latest ? { ...latest, script: { ...latest.script!, state: 'CANCELED' as const, elapsedTimeMillis: Date.now() - started } } : emit(empty('CANCELED'), part, index, 'CANCELED');
          if (latest) options.notify(result); return result;
        }
        let result: QuerySnapshot;
        try {
          task = options.createQuery(`${options.requestId}:${index}`, snapshot => {
            if (snapshot.state !== 'RUNNING') return;
            const retained = retainScriptData(snapshot, remaining);
            emit(retained.snapshot, part, index, 'RUNNING', retained.limited);
          }, index === 0);
          result = await task.run(part.sql);
        } catch (error) { result = empty('FAILED', (error as Error).message); }
        finally { task = undefined; }
        const retained = retainScriptData(result, remaining); remaining -= retained.bytes;
        if (result.state === 'FINISHED') completed++;
        const state = result.state !== 'FINISHED' ? result.state : canceled ? 'CANCELED' : index + 1 === statements.length ? 'FINISHED' : 'RUNNING';
        latest = emit(retained.snapshot, part, index, state, retained.limited);
        if (state !== 'RUNNING') return latest;
      }
      return latest ?? empty('CANCELED');
    }),
  };
}
