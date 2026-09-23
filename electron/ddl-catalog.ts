import type { Cell } from '../src/shared';
import { ddlFileName } from './ddl-store';

export type CatalogQuery = (sql: string) => Promise<Cell[][]>;
export type CatalogRow = Record<string, unknown>;
export async function catalogRows(query: CatalogQuery, sql: string): Promise<CatalogRow[]> {
  return (await query(sql)).map(row => {
    if (typeof row[0] !== 'string') throw new Error('DDL: сервер не вернул JSON метаданных.');
    const value: unknown = JSON.parse(row[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DDL: некорректные метаданные.');
    return value as CatalogRow;
  });
}
export function text(row: CatalogRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`DDL: отсутствует ${key}. Проверьте права на определения объектов.`);
  return value;
}
export function optionalText(row: CatalogRow, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}
export function flag(row: CatalogRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`DDL: некорректный признак ${key}.`);
  return value;
}
export function number(row: CatalogRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`DDL: некорректное число ${key}.`);
  return value;
}
export function unsupported(object: string, feature: string): never {
  throw new Error(`DDL: ${object} — пока не поддерживается ${feature}. Выгрузка остановлена без записи файлов.`);
}
export class DdlFiles {
  readonly files: { file: string; sql: string }[] = [];
  private size = 0;
  add(kind: string, name: string, sql: string): void {
    if (!sql.trim()) throw new Error(`DDL: пустое определение ${name}.`);
    sql = sql.trimEnd().replace(/;?$/, ';') + '\n';
    const bytes = Buffer.byteLength(sql);
    if (bytes > 1_000_000 || this.size + bytes > 8 * 1024 * 1024 || this.files.length >= 1000) throw new Error('DDL: лимит 1 MB на файл, 8 MB и 1000 файлов на выгрузку.');
    const file = ddlFileName(kind, name);
    if (this.files.some(item => item.file === file)) throw new Error(`DDL: повторное определение ${name}.`);
    this.files.push({ file, sql }); this.size += bytes;
  }
}
