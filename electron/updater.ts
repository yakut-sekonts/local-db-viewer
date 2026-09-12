import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { downloadAsset, latestRelease, selectRelease, validRepository, type UpdateRelease, type UpdateFetch } from './update-source';
import type { UpdateState } from '../src/updates';

interface StoredSettings { repository: string; automatic: boolean; encryptedToken?: string }
interface Encryption { encrypt(value: string): string; decrypt(value: string): string }
export class Updater {
  private settings: StoredSettings = { repository: '', automatic: true };
  private status: UpdateState;
  private release?: UpdateRelease;
  private downloaded?: string;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private directory: string, private version: string, private encryption: Encryption,
    private notify: (value: UpdateState) => void, private installer: (path: string, version: string) => Promise<void>, private fetchUpdate: UpdateFetch) {
    this.status = { currentVersion: version, phase: 'unconfigured', settings: { repository: '', automatic: true, hasToken: false } };
  }
  async initialize(defaultRepository = ''): Promise<void> {
    try {
      const input: StoredSettings = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
      this.settings = { repository: input.repository ? validRepository(input.repository) : '', automatic: input.automatic !== false, encryptedToken: input.encryptedToken };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.status.error = 'Не удалось прочитать настройки обновления. Настройте доступ повторно.';
      if (defaultRepository) this.settings.repository = validRepository(defaultRepository);
    }
    this.publish({ phase: this.configured() ? 'idle' : 'unconfigured' });
    this.timer = setInterval(() => { if (this.settings.automatic && this.configured() && !this.busy && this.status.phase !== 'ready') void this.check().catch(() => {}); }, 15 * 60 * 1000);
    this.timer.unref();
    if (this.settings.automatic && this.configured()) void this.check().catch(() => {});
  }
  dispose(): void { clearInterval(this.timer); }
  state(): UpdateState { return structuredClone(this.status); }
  private configured(): boolean { return !!this.settings.repository; }
  private token(): string | undefined { return this.settings.encryptedToken ? this.encryption.decrypt(this.settings.encryptedToken) : undefined; }
  private publish(values: Partial<UpdateState>): UpdateState {
    this.status = { ...this.status, ...values, settings: { repository: this.settings.repository, automatic: this.settings.automatic, hasToken: !!this.settings.encryptedToken } };
    this.notify(this.state()); return this.state();
  }
  async configure(input: { repository: string; automatic: boolean; token?: string }): Promise<UpdateState> {
    if (this.busy) throw new Error('Дождитесь завершения операции обновления.');
    if (!input || typeof input.repository !== 'string' || typeof input.automatic !== 'boolean' || (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096 || /\s/.test(input.token)))) throw new Error('Некорректные настройки обновления.');
    const repository = validRepository(input.repository);
    const encryptedToken = input.token === undefined ? this.settings.encryptedToken : input.token ? this.encryption.encrypt(input.token) : undefined;
    const settings = { repository, automatic: input.automatic, encryptedToken };
    this.busy = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, 'settings.json'), temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
      this.settings = settings; this.release = undefined; this.downloaded = undefined;
      return this.publish({ phase: this.configured() ? 'idle' : 'unconfigured', error: undefined, version: undefined, notes: undefined, progress: undefined, checkedAt: undefined });
    } finally { this.busy = false; }
  }
  async check(): Promise<UpdateState> {
    if (this.busy) return this.state();
    if (!this.configured()) return this.publish({ phase: 'unconfigured' });
    if (this.downloaded && this.release) return this.publish({ phase: 'ready' });
    this.busy = true; this.publish({ phase: 'checking', error: undefined });
    try {
      const data = await latestRelease(this.settings.repository, this.token(), this.fetchUpdate);
      this.release = selectRelease(data, this.version, process.platform, process.arch);
      return this.publish({ phase: this.release ? 'available' : 'idle', version: this.release?.version, notes: this.release?.notes, checkedAt: Date.now() });
    } catch (error) { return this.publish({ phase: 'error', error: (error as Error).message }); }
    finally { this.busy = false; }
  }
  async download(): Promise<UpdateState> {
    if (this.busy) throw new Error('Обновление уже выполняется.');
    if (!this.release || !this.configured()) throw new Error('Сначала проверьте наличие новой версии.');
    this.busy = true; this.publish({ phase: 'downloading', progress: 0, error: undefined });
    const directory = join(this.directory, randomUUID());
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, this.release.asset.name);
      await downloadAsset(this.settings.repository, this.token(), this.release.asset, path, progress => this.publish({ progress }), this.fetchUpdate);
      this.downloaded = path; return this.publish({ phase: 'ready', progress: 100 });
    } catch (error) { await rm(directory, { recursive: true, force: true }); return this.publish({ phase: 'error', error: (error as Error).message }); }
    finally { this.busy = false; }
  }
  async install(): Promise<void> {
    if (this.busy || !this.downloaded || !this.release) throw new Error('Обновление ещё не загружено.');
    this.busy = true; this.publish({ phase: 'installing', error: undefined });
    try {
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(this.downloaded)) { size += chunk.length; hash.update(chunk); }
      if (size !== this.release.asset.size || `sha256:${hash.digest('hex')}` !== this.release.asset.digest) {
        await rm(this.downloaded, { force: true }); this.downloaded = undefined;
        this.publish({ phase: 'available' }); throw new Error('Загруженный файл изменился. Скачайте обновление повторно.');
      }
      await this.installer(this.downloaded, this.release.version);
    }
    catch (error) { this.publish({ phase: this.downloaded ? 'ready' : 'available', error: (error as Error).message }); throw error; }
    finally { this.busy = false; }
  }
}
