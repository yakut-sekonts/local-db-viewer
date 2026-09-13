import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENGINES, type Profile, type ProfileDraft } from '../src/shared';
import { validateConnection, type Connection } from './trino';
import { sslEnabled } from '../src/connectionSettings';
import { secretProperty, type JdbcSettings } from '../src/jdbc';
import { validateJdbc } from './jdbc-config';

interface StoredProfile extends Omit<Profile, 'hasSecret'> { encryptedSecret?: string; encryptedJdbc?: string }
interface Encryption { encrypt(value: string): string; decrypt(value: string): string }

export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string, private encryption: Encryption) {}
  private async read(): Promise<StoredProfile[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(data) || data.length > 1000) throw new Error('Файл подключений повреждён.');
      const ids = new Set<string>();
      for (const [index, value] of data.entries()) {
        const invalid = () => new Error(`Файл подключений повреждён: запись ${index + 1}. Исходный файл сохранён без изменений.`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        for (const name of ['id', 'name', 'endpoint', 'user', 'auth', 'catalog', 'schema', 'engine']) if (typeof value[name] !== 'string' || /[\r\n\0]/.test(value[name])) throw invalid();
        if (!value.id || ids.has(value.id) || !Object.hasOwn(ENGINES, value.engine) || !['none', 'basic', 'bearer'].includes(value.auth) || typeof value.tls !== 'boolean') throw invalid();
        ids.add(value.id);
        for (const name of ['encryptedSecret', 'encryptedJdbc']) if (value[name] !== undefined && (typeof value[name] !== 'string' || !value[name])) throw invalid();
        try {
          validateJdbc(value.jdbc);
          if (!['sqlite', 'jdbc'].includes(value.engine)) {
            const endpoint = new URL(value.endpoint);
            if (!endpoint.hostname || endpoint.username || endpoint.password) throw invalid();
          }
        } catch { throw invalid(); }
      }
      return data as StoredProfile[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private public(profile: StoredProfile): Profile {
    const { encryptedSecret, encryptedJdbc, ...rest } = profile;
    const jdbc: JdbcSettings | undefined = encryptedJdbc ? JSON.parse(this.encryption.decrypt(encryptedJdbc)) : rest.jdbc;
    validateJdbc(jdbc);
    const jdbcSecrets = Object.keys(jdbc?.properties ?? {}).filter(secretProperty);
    const jdbcEnvironmentNames = Object.keys(jdbc?.environment ?? {});
    const visibleJdbc = jdbc ? { ...jdbc, properties: Object.fromEntries(Object.entries(jdbc.properties ?? {}).filter(([name]) => !secretProperty(name))), environment: {} } : undefined;
    return { ...rest, jdbc: visibleJdbc, jdbcSecrets, jdbcEnvironmentNames, tls: sslEnabled(rest), sslVerification: rest.sslVerification ?? 'FULL', hasSecret: Boolean(encryptedSecret) };
  }
  async list(): Promise<Profile[]> { return (await this.read()).map(profile => this.public(profile)); }
  async get(id: string): Promise<Connection> {
    const profile = (await this.read()).find(item => item.id === id);
    if (!profile) throw new Error('Подключение не найдено.');
    const { encryptedSecret, encryptedJdbc, ...rest } = profile;
    return { ...rest, jdbc: encryptedJdbc ? JSON.parse(this.encryption.decrypt(encryptedJdbc)) : rest.jdbc, tls: sslEnabled(rest), sslVerification: rest.sslVerification ?? 'FULL', secret: encryptedSecret ? this.encryption.decrypt(encryptedSecret) : undefined };
  }
  async resolve(draft: ProfileDraft): Promise<Connection> {
    const previous = draft.id ? await this.get(draft.id) : undefined;
    validateJdbc(draft.jdbc);
    const jdbc = draft.jdbc ? { ...draft.jdbc,
      properties: { ...Object.fromEntries(Object.entries(previous?.jdbc?.properties ?? {}).filter(([name]) => secretProperty(name))), ...draft.jdbc.properties },
      environment: { ...previous?.jdbc?.environment, ...draft.jdbc.environment },
    } : undefined;
    return validateConnection({
      id: draft.id ?? randomUUID(), name: draft.name, endpoint: draft.endpoint,
      user: draft.user, auth: draft.auth, catalog: draft.catalog, schema: draft.schema,
      engine: draft.engine, tls: draft.tls,
      sslVerification: draft.sslVerification ?? 'FULL', sslCa: draft.sslCa,
      jdbc,
      secret: draft.auth === 'none' ? undefined : draft.secret ?? (previous?.auth === draft.auth ? previous.secret : undefined),
    });
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch(() => {});
    return task;
  }
  private async write(profiles: StoredProfile[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(profiles, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  save(draft: ProfileDraft): Promise<Profile> {
    return this.mutate(async () => {
      const connection = await this.resolve(draft);
      const { secret, jdbc, jdbcSecrets: _, jdbcEnvironmentNames: __, ...rest } = connection;
      const stored: StoredProfile = { ...rest, encryptedJdbc: jdbc ? this.encryption.encrypt(JSON.stringify(jdbc)) : undefined, encryptedSecret: secret ? this.encryption.encrypt(secret) : undefined };
      const profiles = await this.read();
      const index = profiles.findIndex(profile => profile.id === stored.id);
      if (index < 0) profiles.push(stored); else profiles[index] = stored;
      await this.write(profiles);
      return this.public(stored);
    });
  }
  remove(id: string): Promise<void> { return this.mutate(async () => this.write((await this.read()).filter(profile => profile.id !== id))); }
}
