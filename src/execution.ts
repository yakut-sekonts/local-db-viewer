import type { DatabaseEngine } from './shared';
import { singleStatement, splitSqlScript, statementAtCursor } from '../electron/sql';

export interface ExecutionTarget {
  sql: string;
  mode: 'statement' | 'script';
  source: 'cursor' | 'selection' | 'script';
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  count: number;
}
export function executionTarget(text: string, cursor: number, selection: { start: number; end: number }, requested: 'statement' | 'script', engine: DatabaseEngine): ExecutionTarget {
  if (text.length > 1_000_000) throw new Error('SQL превышает 1 000 000 символов.');
  if (![selection.start, selection.end].every(value => Number.isInteger(value) && value >= 0 && value <= text.length) || selection.start > selection.end) throw new Error('Некорректное выделение SQL.');
  const selected = selection.end > selection.start;
  let start = selected ? selection.start : 0, end = selected ? selection.end : text.length;
  let mode = requested, count = 1;
  if (!selected && requested === 'statement') {
    const part = statementAtCursor(text, cursor, engine);
    start = part.start; end = part.end;
  } else {
    const raw = text.slice(start, end);
    start += raw.length - raw.trimStart().length;
    end -= raw.length - raw.trimEnd().length;
    if (start >= end) throw new Error('В выделении нет SQL-команды.');
    const sql = text.slice(start, end);
    if (requested === 'script') count = splitSqlScript(sql, engine).length;
    else {
      // Explicit selections retain the existing single-command capability
      // (including dollar-quoted routine definitions). Several selected commands
      // use the sequential runner and are labelled as a script in confirmation.
      try { singleStatement(sql, engine); }
      catch { count = splitSqlScript(sql, engine).length; mode = 'script'; }
    }
  }
  const line = (offset: number) => text.slice(0, offset).split('\n').length;
  return { sql: text.slice(start, end), start, end, startLine: line(start), endLine: line(Math.max(start, end - 1)), mode, source: selected ? 'selection' : requested === 'script' ? 'script' : 'cursor', count };
}
