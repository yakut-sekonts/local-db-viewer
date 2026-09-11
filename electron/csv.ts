import type { Cell, Column } from '../src/shared';

export function csv(columns: Column[], rows: Cell[][]): string {
  function field(value: unknown): string {
    if (value === null || value === undefined) return '';
    let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Protect spreadsheet imports while retaining typed negative numeric cells.
    if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  return '\ufeff' + [columns.map(column => field(column.name)).join(','), ...rows.map(row => row.map(field).join(','))].join('\r\n') + '\r\n';
}
