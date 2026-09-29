import type { Cell, Column } from './shared';
import { CLIPBOARD_BYTES, validateClipboardText } from './clipboard';

export const cellText = (value: unknown): string => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export interface GridPoint { row: number; column: number }
export interface GridSelection { anchor: GridPoint; focus: GridPoint }
export interface GridSort { column: number; direction: 'asc' | 'desc' }

interface Decimal { negative: boolean; digits: string; magnitude: number }
// Compare decimal coefficients, never a rounded JS Number. Exponents from SQL
// numeric types are bounded; unrecognized vendor values retain a lexical order.
function decimal(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,7}))?$/.exec(String(value));
  if (!match) return;
  const integer = match[2] ?? '', fraction = match[3] ?? match[4] ?? '';
  const coefficient = integer + fraction, digits = coefficient.replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) return { negative: false, digits: '0', magnitude: 0 };
  return { negative: match[1] === '-', digits, magnitude: integer.length - (coefficient.match(/^0*/)?.[0].length ?? 0) + Number(match[5] ?? 0) };
}
function decimalOrder(a: Decimal, b: Decimal): number {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  if (a.digits === '0' || b.digits === '0') {
    if (a.digits === b.digits) return 0;
    return a.digits === '0' ? (b.negative ? 1 : -1) : (a.negative ? -1 : 1);
  }
  let order = Math.sign(a.magnitude - b.magnitude);
  if (!order) {
    // Equal magnitudes: compare fractional positions, treating missing digits as zero.
    for (let index = 0; index < Math.max(a.digits.length, b.digits.length); index++) {
      const left = a.digits[index] ?? '0', right = b.digits[index] ?? '0';
      if (left !== right) { order = left < right ? -1 : 1; break; }
    }
  }
  return a.negative ? -order : order;
}
function columnKind(type: string): 'numeric' | 'boolean' | 'text' {
  if (typeof type !== 'string') return 'text';
  const base = type.toLowerCase().replace(/\b(?:nullable|lowcardinality)\s*\(/g, '').replace(/^unsigned\s+/, '').trim();
  if (/^(?:bool|boolean|bit)\b/.test(base)) return 'boolean';
  if (/^(?:u?int(?:8|16|32|64|128|256)?|integer|bigint|smallint|tinyint|mediumint|serial[248]?|bigserial|smallserial|decimal(?:32|64|128|256)?|numeric|number|real|float(?:4|8|32|64)?|double(?: precision)?|money|smallmoney)\b/.test(base)) return 'numeric';
  return 'text';
}
function booleanValue(value: unknown): number | undefined {
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
}
export function gridRows(rows: Cell[][], columns: Column[], filter: string, sort?: GridSort): Cell[][] {
  const needle = filter.toLowerCase();
  const filtered = needle ? rows.filter(row => row.some(value => cellText(value).toLowerCase().includes(needle))) : rows;
  if (!sort || !columns[sort.column]) return filtered;
  const kind = columnKind(columns[sort.column]!.type);
  const prepared = filtered.map((row, index) => {
    const value = row[sort.column];
    return { row, index, value, text: cellText(value), decimal: kind === 'numeric' ? decimal(value) : undefined, boolean: kind === 'boolean' ? booleanValue(value) : undefined };
  });
  prepared.sort((a, b) => {
    // Missing / SQL NULL values stay last in either direction.
    if (a.value == null || b.value == null) return a.value == null && b.value == null ? a.index - b.index : a.value == null ? 1 : -1;
    let order: number;
    if (a.decimal && b.decimal) order = decimalOrder(a.decimal, b.decimal);
    else if (a.decimal || b.decimal) order = a.decimal ? -1 : 1;
    else if (a.boolean !== undefined && b.boolean !== undefined) order = a.boolean - b.boolean;
    else if (a.boolean !== undefined || b.boolean !== undefined) order = a.boolean !== undefined ? -1 : 1;
    else order = a.text === b.text ? 0 : a.text < b.text ? -1 : 1;
    return (sort.direction === 'desc' ? -order : order) || a.index - b.index;
  });
  return prepared.map(item => item.row);
}
export function selectionBounds(selection: GridSelection) {
  return { top: Math.min(selection.anchor.row, selection.focus.row), bottom: Math.max(selection.anchor.row, selection.focus.row), left: Math.min(selection.anchor.column, selection.focus.column), right: Math.max(selection.anchor.column, selection.focus.column) };
}
export function copyGridRange(columns: Column[], rows: Cell[][], selection: GridSelection, headers = false): string {
  const bounds = selectionBounds(selection);
  if (Object.values(bounds).some(value => !Number.isInteger(value) || value < 0) || bounds.bottom >= rows.length || bounds.right >= columns.length) throw new Error('Выделение больше не соответствует результату. Выберите ячейки заново.');
  if ((bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) > 1_000_000) throw new Error('Для копирования выберите не более 1 000 000 ячеек.');
  if (!headers && bounds.top === bounds.bottom && bounds.left === bounds.right) {
    const text = cellText(rows[bounds.top]?.[bounds.left]); validateClipboardText(text); return text;
  }
  const lines: string[] = []; let bytes = 0;
  const encoder = new TextEncoder();
  function field(value: unknown, numeric: boolean): string {
    let text = cellText(value);
    // TSV is destined for a spreadsheet; keep exact numeric text, escape formulas.
    if (typeof value === 'string' && !(numeric && decimal(value)) && /^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[\t\r\n"]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
    bytes += encoder.encode(text).length + 2;
    if (bytes > CLIPBOARD_BYTES) throw new Error('Текст для копирования превышает 16 MiB. Выделите меньший диапазон.');
    return text;
  }
  const selected = columns.slice(bounds.left, bounds.right + 1);
  if (headers) lines.push(selected.map(column => field(column.name, false)).join('\t'));
  for (let row = bounds.top; row <= bounds.bottom; row++) lines.push(selected.map((column, offset) => field(rows[row]?.[bounds.left + offset], columnKind(column.type) === 'numeric')).join('\t'));
  return lines.join('\r\n');
}
