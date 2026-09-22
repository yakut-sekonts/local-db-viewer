import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, link, rm, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import type { DdlFile, DdlMapping, DdlPreview } from '../src/ddl';

export const ddlHash = (sql: string) => createHash('sha256').update(sql).digest('hex');
const text = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.length <= limit && !/[\r\n\0]/.test(value);
export function validateMapping(value: DdlMapping): void {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || !text(value.name, 100) || !value.name.trim() || !text(value.profileId) || !value.profileId || !text(value.directory, 4096) || !isAbsolute(value.directory) || !text(value.catalog) || !text(value.schema)) throw new Error('Некорректный DDL mapping.');
}
const fileName = (file: string) => typeof file === 'string' && file === basename(file) && !/[\\/\0\r\n]/.test(file) && file.length <= 220 && /\.sql$/i.test(file) && !file.startsWith('.');
export const ddlFileName = (kind: string, name: string) => `${kind}-${name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 70)}-${ddlHash(kind + ':' + name).slice(0, 12)}.sql`;
const maximumBytes = 8 * 1024 * 1024;
async function boundedFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('DDL: нужен обычный файл.');
    const bytes = Buffer.alloc(1_000_001); let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > 1_000_000) throw new Error('DDL-файл превышает 1 MB.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0,size));
  } finally { await handle.close(); }
}
export class DdlStore {
  private queue: Promise<unknown> = Promise.resolve();
  private plans = new Map<string, { mapping: DdlMapping; expires: number; local: DdlFile[]; preview: DdlPreview }>();
  constructor(private path: string) {}
  async list(): Promise<DdlMapping[]> {
    try {
      const values: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(values) || values.length > 100) throw new Error('Файл DDL mappings повреждён.');
      values.forEach(validateMapping);
      if (new Set(values.map(item => item.id)).size !== values.length) throw new Error('Повторяющиеся DDL mapping IDs.');
      return values;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async get(id: string): Promise<DdlMapping> {
    const value = (await this.list()).find(item => item.id === id);
    if (!value) throw new Error('DDL mapping не найден.');
    return value;
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  private async persist(values: DdlMapping[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(values, null, 2), { mode: 0o600 }); await rename(tmp, this.path);
  }
  save(value: DdlMapping): Promise<DdlMapping> { return this.serialized(async () => {
    validateMapping(value);
    const directory = await realpath(value.directory);
    if (!(await lstat(directory)).isDirectory()) throw new Error('Выберите каталог DDL.');
    const mapping = { ...value, directory }, values = await this.list();
    if (values.some(item => item.id !== mapping.id && item.directory === directory)) throw new Error('Каталог уже используется другим DDL mapping.');
    const next = [...values.filter(item => item.id !== value.id), mapping];
    if (next.length > 100) throw new Error('Лимит: 100 DDL mappings.');
    await this.persist(next); return mapping;
  }); }
  remove(id: string): Promise<void> { return this.serialized(async () => this.persist((await this.list()).filter(item => item.id !== id))); }
  private async directory(mapping: DdlMapping): Promise<string> {
    const directory = await realpath(mapping.directory);
    if (directory !== mapping.directory) throw new Error('Каталог DDL изменён или заменён ссылкой. Выберите его заново.');
    return directory;
  }
  async files(id: string): Promise<DdlFile[]> {
    const directory = await this.directory(await this.get(id)), result: DdlFile[] = []; let size = 0;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      if (!/\.sql$/i.test(entry.name)) continue;
      if (!fileName(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error(`DDL: недопустимый файл ${entry.name}.`);
      const path = join(directory, entry.name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000 || (size += info.size) > maximumBytes || result.length >= 1000) throw new Error('DDL: лимит 1 MB на файл, 8 MB и 1000 файлов на каталог; ссылки не поддерживаются.');
      const sql = await boundedFile(path);
      if (Buffer.byteLength(sql) > 1_000_000) throw new Error('DDL-файл изменился и превысил лимит.');
      result.push({ file: entry.name, sql, hash: ddlHash(sql) });
    }
    return result;
  }
  async preview(id: string, remote: { file: string; sql: string }[], warnings: string[]): Promise<DdlPreview> {
    if (remote.length > 1000 || new Set(remote.map(item => item.file)).size !== remote.length || remote.some(item => !fileName(item.file) || Buffer.byteLength(item.sql) > 1_000_000) || remote.reduce((sum, item) => sum + Buffer.byteLength(item.sql), 0) > maximumBytes) throw new Error('Выгрузка DDL превышает лимит или содержит повторяющиеся файлы.');
    const mapping = await this.get(id), local = await this.files(id), byName = new Map(local.map(item => [item.file,item]));
    const preview: DdlPreview = { token: randomUUID(), warnings, differences: remote.map(item => ({ file: item.file, remote: item.sql, local: byName.get(item.file)?.sql, status: !byName.has(item.file) ? 'new' : byName.get(item.file)!.sql === item.sql ? 'same' : 'changed' })) };
    preview.differences.push(...local.filter(item => !remote.some(other => other.file === item.file)).map(item => ({ file: item.file, local: item.sql, status: 'local-only' as const })));
    for (const [key, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(key);
    while (this.plans.size >= 3) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(preview.token, { mapping, expires: Date.now() + 600000, local, preview }); return preview;
  }
  private async replace(mapping: DdlMapping, file: string, sql: string, old: DdlFile | undefined, backup: string): Promise<void> {
    const directory = await this.directory(mapping), destination = join(directory, file);
    if (old) {
      const root = dirname(backup);
      await mkdir(root, { recursive: true });
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('Каталог резервных копий DDL заменён ссылкой.');
      await mkdir(backup, { recursive: true });
      await writeFile(join(backup, file), old.sql, { mode: 0o600, flag: 'wx' });
    }
    const tmp = join(directory, `.local-db-viewer-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, sql, { mode: 0o600, flag: 'wx' });
      if (old) {
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink() || ddlHash(await boundedFile(destination)) !== old.hash) throw new Error('DDL-файл изменён другим приложением. Обновите сравнение.');
        await rename(tmp, destination);
      } else {
        // Exclusive create preserves unrelated/new files created after the preview.
        await link(tmp, destination);
      }
    } finally { await rm(tmp, { force: true }); }
  }
  writeFile(id: string, file: string, sql: string, expectedHash: string): Promise<void> { return this.serialized(async () => {
    if (!fileName(file) || typeof sql !== 'string' || Buffer.byteLength(sql) > 1_000_000 || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Некорректный DDL-файл.');
    const mapping = await this.get(id), current = (await this.files(id)).find(item => item.file === file);
    if (!current || current.hash !== expectedHash) throw new Error('DDL-файл изменён снаружи. Перечитайте его перед сохранением.');
    await this.replace(mapping, file, sql, current, join(mapping.directory, '.local-db-viewer-backup', randomUUID()));
  }); }
  writePreview(token: string, files: string[]): Promise<void> { return this.serialized(async () => {
    const plan = this.plans.get(token);
    if (!plan || plan.expires < Date.now()) throw new Error('Сравнение устарело. Повторите чтение DDL.');
    if (!Array.isArray(files) || !files.length || files.length > 1000 || new Set(files).size !== files.length || files.some(file => !plan.preview.differences.some(item => item.file === file && item.remote !== undefined && item.status !== 'same'))) throw new Error('Выберите изменённые файлы из сравнения.');
    const mapping = await this.get(plan.mapping.id);
    if (JSON.stringify(mapping) !== JSON.stringify(plan.mapping)) throw new Error('Настройки mapping изменились. Повторите сравнение.');
    const current = new Map((await this.files(mapping.id)).map(item => [item.file,item]));
    for (const file of files) if (current.get(file)?.hash !== plan.local.find(item => item.file === file)?.hash) throw new Error(`Файл ${file} изменён снаружи. Повторите сравнение.`);
    this.plans.delete(token);
    const backup = join(mapping.directory, '.local-db-viewer-backup', randomUUID());
    for (const file of files) await this.replace(mapping, file, plan.preview.differences.find(item => item.file === file)!.remote!, current.get(file), backup);
  }); }
}
