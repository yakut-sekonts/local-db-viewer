import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DRIVERS, compareDriverVersions, driverDefinition, type DriverCatalog, type DriverFile, type DriverInstallation, type DriverRelease, type DriversState, type DriverStatus, type DriverUpdateSource } from '../src/drivers';
import { updateNetworkError, type UpdateFetch } from './update-source';
import { driverFeedRelease, fetchDriverFeedFile, readDriverFeed, validateDriverFeed, validateDriverSource, validateFeedAdvance, type SavedDriverSource } from './driver-feed';

const CENTRAL = 'https://repo.maven.apache.org/maven2/';
const SHA = /^[a-f0-9]{64}$/;
interface Settings { automatic: boolean; installed: Record<string, DriverInstallation[]>; selected: Record<string, string>; sources?: Record<string, SavedDriverSource> }
export function validateDriverCatalog(value: unknown): DriverCatalog {
  const input = value as DriverCatalog;
  if (!input || input.format !== 1 || !input.drivers || typeof input.drivers !== 'object' || Array.isArray(input.drivers) || Object.keys(input.drivers).length > 500) throw new Error('Некорректный каталог JDBC-драйверов.');
  const drivers: Record<string, DriverRelease> = {};
  for (const [id, release] of Object.entries(input.drivers)) {
    if (!DRIVERS.some(driver => driver.id === id && driver.maven)) continue;
    if (!release || !SHA.test(release.key) || typeof release.version !== 'string' || !/^\d[\w.+-]{0,99}$/.test(release.version) || !Array.isArray(release.files) || !release.files.length || release.files.length > 250) throw new Error('Некорректная версия JDBC-драйвера.');
    const paths = new Set<string>(); let size = 0;
    for (const file of release.files) {
      if (!file || typeof file.path !== 'string' || file.path.length > 1000 || !/^[A-Za-z0-9_./+-]+\.jar$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 512 * 1024 ** 2 || paths.has(file.path)) throw new Error('Некорректный файл JDBC-драйвера.');
      size += file.size; paths.add(file.path);
    }
    if (size > 1024 ** 3) throw new Error('Размер драйвера превышает 1 GiB.');
    drivers[id] = structuredClone(release);
  }
  return { format: 1, drivers };
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex');
}

export class DriverManager {
  private settings: Settings = { automatic: true, installed: {}, selected: {} };
  private catalog: DriverCatalog;
  private checking = false;
  private installing = false;
  private configuring?: string;
  private sourceErrors = new Map<string, string>();
  private checkedAt?: number;
  private error?: string;
  private progress = new Map<string, Partial<DriverStatus>>();
  private timer?: ReturnType<typeof setInterval>;
  private verified = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private bundled: Record<string, DriverInstallation>, initial: unknown,
    private fetchUpdate: UpdateFetch, private fetchCatalog: () => Promise<unknown>, private probe: (id: string, paths: string[], driverClass?: string) => Promise<void>, private notify: (state: DriversState) => void) {
    this.catalog = validateDriverCatalog(initial);
  }
  async initialize(): Promise<void> {
    try {
      const settings: Settings = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
      if (!settings || typeof settings.automatic !== 'boolean' || !settings.installed || typeof settings.installed !== 'object' || Array.isArray(settings.installed) || !settings.selected || typeof settings.selected !== 'object' || Array.isArray(settings.selected)) throw new Error('Invalid settings');
      for (const [id, entries] of Object.entries(settings.installed)) {
        driverDefinition(id);
        if (!Array.isArray(entries) || entries.length > 100 || entries.some(item => !item || !SHA.test(item.key) || typeof item.version !== 'string' || !item.version.trim() || item.version.length > 100 || !['local', 'download', 'feed'].includes(item.source) || !Array.isArray(item.files) || !item.files.length || item.files.length > 250 || item.files.some(file => !file || !SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 512 * 1024 ** 2))) throw new Error('Invalid installation');
        for (const item of entries) if (item.source === 'feed') validateDriverSource({ url: 'https://validation.invalid/', driverClass: item.driverClass });
        for (const item of entries) item.paths = item.files.map(file => this.objectPath(file.sha256));
      }
      if (settings.sources !== undefined) {
        if (!settings.sources || typeof settings.sources !== 'object' || Array.isArray(settings.sources) || Object.keys(settings.sources).length > DRIVERS.length) {
          settings.sources = {}; this.error = 'Настройки источников драйверов повреждены. Установленные версии сохранены.';
        } else for (const [id, source] of Object.entries(settings.sources)) {
          try {
            driverDefinition(id);
            const validated = validateDriverSource(source);
            settings.sources[id] = { ...validated,
              ...(source.manifest ? { manifest: validateDriverFeed(source.manifest, id, validated.driverClass) } : {}),
              ...(Number.isSafeInteger(source.checkedAt) && source.checkedAt! > 0 ? { checkedAt: source.checkedAt } : {}) };
          } catch {
            delete settings.sources[id];
            this.sourceErrors.set(id, 'Сохранённый источник повреждён. Настройте его повторно; установленные версии сохранены.');
          }
        }
      }
      for (const [id, key] of Object.entries(settings.selected)) {
        driverDefinition(id);
        if (typeof key !== 'string' || ![...(settings.installed[id] ?? []), ...(this.bundled[id] ? [this.bundled[id]] : [])].some(item => item.key === key)) throw new Error('Invalid selection');
      }
      this.settings = settings;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = 'Не удалось прочитать настройки драйверов. Встроенные драйверы доступны.'; }
    try { this.catalog = validateDriverCatalog(JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8'))); } catch { /* Keep the bundled catalog when offline or cache is invalid. */ }
    this.publish();
    this.timer = setInterval(() => { if (this.settings.automatic) void this.check(); }, 60 * 60 * 1000); this.timer.unref();
    if (this.settings.automatic) void this.check();
  }
  isBusy(): boolean { return this.installing || !!this.configuring; }
  dispose(): void { clearInterval(this.timer); }
  private objectPath(sha256: string): string { return join(this.directory, 'objects', sha256 + '.jar'); }
  private installations(id: string): DriverInstallation[] { return [...(this.bundled[id] ? [this.bundled[id]] : []), ...(this.settings.installed[id] ?? [])]; }
  state(): DriversState {
    return { checking: this.checking, configuring: this.configuring, automatic: this.settings.automatic, checkedAt: this.checkedAt, error: this.error, drivers: DRIVERS.map(driver => {
      const installed = this.installations(driver.id); const selected = this.settings.selected[driver.id] || installed[0]?.key;
      const current = installed.find(item => item.key === selected), source = this.settings.sources?.[driver.id];
      const latest = source ? (source.manifest ? driverFeedRelease(source.manifest) : undefined) : this.catalog.drivers[driver.id];
      return { id: driver.id, selected, installed: installed.map(({ key, version, source }) => ({ key, version, source })), latest: latest?.version, latestKey: latest?.key,
        available: !!current && !!latest && (source ? current.key !== latest.key : ['bundled', 'download'].includes(current.source) && compareDriverVersions(latest.version, current.version) > 0),
        ...(source ? { updateSource: { url: source.url, driverClass: source.driverClass }, checkedAt: source.checkedAt } : {}),
        sourceError: this.sourceErrors.get(driver.id), ...this.progress.get(driver.id) };
    }) };
  }
  private publish(): void { this.notify(this.state()); }
  private async atomic(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, name), temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  private change(transform: (settings: Settings) => void | Promise<void>): Promise<void> {
    const task = this.queue.then(async () => { const next = structuredClone(this.settings); await transform(next); await this.atomic('settings.json', next); this.settings = next; this.publish(); });
    this.queue = task.catch(() => {}); return task;
  }
  automatic(enabled: boolean): Promise<void> { if (typeof enabled !== 'boolean') throw new Error('Некорректная настройка.'); return this.change(settings => { settings.automatic = enabled; }); }
  async configureSource(id: string, input: DriverUpdateSource | null): Promise<void> {
    driverDefinition(id);
    if (this.checking || this.isBusy()) throw new Error('Дождитесь проверки или установки драйверов.');
    this.configuring = id; this.publish();
    try {
      if (input === null) {
        await this.change(settings => { if (settings.sources) delete settings.sources[id]; });
      } else {
        const source = validateDriverSource(input), manifest = await readDriverFeed(source, id, this.fetchUpdate);
        const previous = this.settings.sources?.[id];
        if (previous?.url === source.url && previous.driverClass === source.driverClass) validateFeedAdvance(manifest, previous.manifest);
        await this.change(settings => { (settings.sources ??= {})[id] = { ...source, manifest, checkedAt: Date.now() }; });
      }
      this.sourceErrors.delete(id); this.progress.delete(id);
    } finally { this.configuring = undefined; this.publish(); }
  }
  async check(): Promise<DriversState> {
    if (this.checking || this.configuring) return this.state();
    this.checking = true; this.error = undefined; this.publish();
    try {
      // The public catalog and user sources fail independently. Bound network
      // concurrency so one unavailable vendor cannot hold up all other drivers.
      const publicCheck = async () => {
        try { const catalog = validateDriverCatalog(await this.fetchCatalog()); await this.atomic('catalog.json', catalog); this.catalog = catalog; this.checkedAt = Date.now(); }
        catch (error) { this.error = (error as Error).message; }
      };
      const pending = Object.entries(this.settings.sources ?? {});
      const worker = async () => {
        for (let entry = pending.shift(); entry; entry = pending.shift()) {
          const [id, source] = entry;
          try {
            const manifest = await readDriverFeed(source, id, this.fetchUpdate); validateFeedAdvance(manifest, source.manifest);
            await this.change(settings => { (settings.sources ??= {})[id] = { ...source, manifest, checkedAt: Date.now() }; });
            this.sourceErrors.delete(id);
          } catch (error) { this.sourceErrors.set(id, (error as Error).message); }
        }
      };
      await Promise.all([publicCheck(), ...Array.from({ length: Math.min(3, pending.length) }, worker)]);
    }
    finally { this.checking = false; this.publish(); }
    return this.state();
  }
  async paths(id: string, key?: string, driverClass?: string): Promise<string[]> {
    driverDefinition(id);
    // A query dispatched immediately after a version selection must observe
    // that selection once its verification and persistence have completed.
    await this.queue;
    const installed = this.installations(id), selected = key || this.settings.selected[id] || installed[0]?.key;
    const installation = installed.find(item => item.key === selected);
    if (!installation) throw new Error(`Драйвер ${driverDefinition(id).name} не установлен. Откройте «Драйверы» и установите его.`);
    if (driverClass && installation.driverClass && driverClass !== installation.driverClass) throw new Error(`Driver class подключения не совпадает с проверенным комплектом (${installation.driverClass}). Выберите подходящую версию или укажите этот класс в Advanced.`);
    if (installation.source !== 'bundled') for (const file of installation.files) await this.verify(file);
    return [...installation.paths];
  }
  private async verify(file: DriverFile): Promise<void> {
    const path = this.objectPath(file.sha256), info = await stat(path);
    const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (info.size !== file.size || (this.verified.get(path) !== fingerprint && await digest(path) !== file.sha256)) throw new Error('JDBC-драйвер изменён или повреждён. Установите его повторно.');
    this.verified.set(path, fingerprint);
  }
  select(id: string, key: string): Promise<void> {
    driverDefinition(id);
    return this.change(async settings => {
      const installation = this.installations(id).find(item => item.key === key);
      if (!installation) throw new Error('Выбранная версия JDBC-драйвера не установлена.');
      if (installation.source !== 'bundled') for (const file of installation.files) await this.verify(file);
      settings.selected[id] = key;
    });
  }
  private async download(file: DriverFile, progress: (size: number) => void, external = false): Promise<void> {
    try { await this.verify(file); progress(file.size); return; } catch { /* Fetch a verified replacement. */ }
    const signal = AbortSignal.timeout(10 * 60 * 1000);
    let response: Response;
    const hostname = external ? new URL(file.path).hostname : 'repo.maven.apache.org';
    if (external) response = await fetchDriverFeedFile(file.path, signal, this.fetchUpdate);
    else {
      try { response = await this.fetchUpdate(CENTRAL + file.path, { redirect: 'error', signal, cache: 'no-store' }); }
      catch (error) { throw updateNetworkError(error, hostname); }
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`Источник JDBC-драйвера: HTTP ${response.status}. Не удалось скачать драйвер.`); }
    const path = this.objectPath(file.sha256), temporary = `${path}.${randomUUID()}.part`;
    const reader = response.body.getReader(); let output;
    try {
      await mkdir(join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
      output = await open(temporary, 'wx', 0o600); let size = 0; const hash = createHash('sha256');
      for (;;) {
        const { done, value } = await reader.read().catch(error => { throw updateNetworkError(error, hostname); }); if (done) break;
        size += value.byteLength; if (size > file.size) throw new Error('Размер JAR не совпадает с каталогом.');
        hash.update(value); let offset = 0;
        while (offset < value.length) { const { bytesWritten } = await output.write(value, offset, value.length - offset); if (!bytesWritten) throw new Error('Не удалось записать JAR.'); offset += bytesWritten; }
        progress(size);
      }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('SHA256 JDBC-драйвера не совпадает. Установка отменена.');
      await output.sync(); await output.close(); output = undefined;
      await rename(temporary, path); this.verified.delete(path);
    } finally { await reader.cancel().catch(() => {}); await output?.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  async install(id: string): Promise<void> {
    driverDefinition(id); if (this.isBusy()) throw new Error('Дождитесь установки или настройки другого драйвера.');
    const source = this.settings.sources?.[id];
    const release = source ? (source.manifest ? driverFeedRelease(source.manifest) : undefined) : this.catalog.drivers[id];
    if (!release) throw new Error('Нет проверенной версии драйвера. Проверьте источник или импортируйте JAR производителя.');
    this.installing = true; this.progress.set(id, { phase: 'downloading', progress: 0 }); this.publish();
    try {
      const total = release.files.reduce((sum, file) => sum + file.size, 0); let completed = 0, lastProgress = -1;
      for (const file of release.files) { await this.download(file, size => { const percent = Math.floor((completed + size) / total * 100); if (percent !== lastProgress) { lastProgress = percent; this.progress.set(id, { phase: 'downloading', progress: percent }); this.publish(); } }, !!source); completed += file.size; }
      const paths = release.files.map(file => this.objectPath(file.sha256));
      this.progress.set(id, { phase: 'verifying', progress: 100 }); this.publish();
      await this.probe(id, paths, source?.driverClass);
      await this.change(settings => { settings.installed[id] = [...(settings.installed[id] ?? []).filter(item => item.key !== release.key), { ...release, paths, source: source ? 'feed' : 'download', ...(source ? { driverClass: source.driverClass } : {}) }]; settings.selected[id] = release.key; });
      this.progress.delete(id);
    } catch (error) { this.progress.set(id, { error: (error as Error).message }); throw error; }
    finally { this.installing = false; this.publish(); }
  }
  async import(id: string, version: string, paths: string[]): Promise<void> {
    const definition = driverDefinition(id);
    if (this.isBusy()) throw new Error('Дождитесь установки или настройки другого драйвера.');
    if (typeof version !== 'string' || !version.trim() || version.length > 100 || !paths.length || paths.length > 250) throw new Error('Укажите версию и JAR-файлы.');
    this.installing = true; this.progress.set(id, { phase: 'verifying', progress: 0 }); this.publish();
    try {
      const files: DriverFile[] = []; let total = 0;
      for (const path of paths) {
        const info = await stat(path); if (!info.isFile() || info.size <= 0 || info.size > 512 * 1024 ** 2 || !path.toLowerCase().endsWith('.jar')) throw new Error('Выберите JAR-файлы до 512 MB.');
        total += info.size; if (total > 1024 ** 3) throw new Error('Размер комплекта превышает 1 GiB.');
        const input = await open(path, 'r');
        try { const header = Buffer.alloc(4); await input.read(header, 0, 4, 0); if (!header.equals(Buffer.from([80, 75, 3, 4]))) throw new Error('Файл не является JAR/ZIP-архивом.'); } finally { await input.close(); }
        const sha256 = await digest(path); if (files.some(file => file.sha256 === sha256)) continue;
        const file = { path: sha256 + '.jar', size: info.size, sha256 }; files.push(file);
        try { await this.verify(file); continue; } catch { /* Import missing or damaged JAR. */ }
        await mkdir(join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
        const destination = this.objectPath(sha256), temporary = `${destination}.${randomUUID()}.part`;
        try { await copyFile(path, temporary); if (await digest(temporary) !== sha256) throw new Error('JAR изменился во время импорта.'); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
      }
      const stored = files.map(file => this.objectPath(file.sha256));
      if (definition.className) await this.probe(id, stored);
      const key = createHash('sha256').update(JSON.stringify({ version, files })).digest('hex');
      await this.change(settings => { settings.installed[id] = [...(settings.installed[id] ?? []).filter(item => item.key !== key), { key, version: version.trim(), files, paths: stored, source: 'local' }]; settings.selected[id] = key; });
      this.progress.delete(id);
    } catch (error) { this.progress.set(id, { error: (error as Error).message }); throw error; }
    finally { this.installing = false; this.publish(); }
  }
}
