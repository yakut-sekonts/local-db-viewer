import { parse } from 'lossless-json';
import { ENGINES, type Column, type Profile, type QuerySnapshot, type QueryStats } from '../src/shared';
import { isAbsolute } from 'node:path';
import { sslEnabled } from '../src/connectionSettings';
import { connectionError, httpAgent, validateSSL } from './tls';
import { validateJdbc } from './jdbc-config';

export type Connection = Omit<Profile, 'hasSecret'> & { secret?: string };
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export function validateConnection(input: Connection): Connection {
  if (!Object.hasOwn(ENGINES, input.engine)) throw new Error('Неизвестная СУБД.');
  validateSSL(input);
  validateJdbc(input.jdbc);
  if (input.engine === 'mssql' && input.sslVerification === 'CA') throw new Error('SQL Server поддерживает SSLVerification FULL или NONE.');
  for (const [key, value] of Object.entries({ name: input.name, user: input.user, catalog: input.catalog, schema: input.schema })) {
    if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw new Error(`Некорректное поле: ${key}`);
  }
  if (!input.name.trim() || (!input.jdbc && input.engine !== 'sqlite' && !input.user.trim())) throw new Error('Укажите название и пользователя.');
  if (input.engine === 'sqlite') {
    if (!isAbsolute(input.endpoint) && !input.jdbc?.url) throw new Error('Выберите SQLite-файл с абсолютным путём.');
    return { ...input, tls: false, auth: 'none', secret: undefined };
  }
  const endpoint = new URL(input.endpoint);
  const protocols = { trino: ['http:', 'https:'], clickhouse: ['http:', 'https:'], postgres: ['postgresql:', 'postgres:'], mysql: ['mysql:'], mariadb: ['mysql:'], mssql: ['mssql:'] }[input.engine];
  if (!protocols.includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Некорректный URL. Укажите credentials в отдельных полях.');
  if (!['none', 'basic', 'bearer'].includes(input.auth)) throw new Error('Неизвестный метод аутентификации.');
  const jdbcSSL = input.jdbc?.properties?.SSL === 'true' || /[?&]SSL=true(?:&|$)/.test(input.jdbc?.url ?? '') || input.jdbc?.url?.startsWith('jdbc:clickhouse:https:');
  if (input.auth !== 'none' && ['trino', 'clickhouse'].includes(input.engine) && endpoint.protocol !== 'https:' && !jdbcSSL) throw new Error('Для пароля и Bearer token требуется HTTPS.');
  if (input.auth === 'bearer' && input.engine !== 'trino') throw new Error('Bearer token поддерживается для Trino.');
  if (input.auth !== 'none' && !input.secret && !input.jdbc?.properties?.password && !input.jdbc?.properties?.accessToken) throw new Error('Укажите пароль или token.');
  if (input.auth === 'basic' && input.user.includes(':')) throw new Error('Basic Auth: имя пользователя не может содержать двоеточие.');
  return { ...input, tls: sslEnabled(input), sslVerification: input.sslVerification ?? 'FULL', endpoint: endpoint.href.replace(/\/$/, '') };
}

export class TrinoSession {
  catalog = '';
  schema = '';
  transaction = 'NONE';
  private properties = new Map<string, string>();
  private roles = new Map<string, string>();
  private prepared = new Map<string, string>();

  headers(): Record<string, string> {
    const headers: Record<string, string> = { 'X-Trino-Transaction-Id': this.transaction };
    if (this.catalog) headers['X-Trino-Catalog'] = this.catalog;
    if (this.schema) headers['X-Trino-Schema'] = this.schema;
    for (const [name, values] of [['X-Trino-Session', this.properties], ['X-Trino-Role', this.roles], ['X-Trino-Prepared-Statement', this.prepared]] as const) {
      if (values.size) headers[name] = [...values].map(([k, v]) => `${k}=${v}`).join(',');
    }
    return headers;
  }

  apply(headers: Headers): void {
    this.catalog = headers.get('x-trino-set-catalog') ?? this.catalog;
    this.schema = headers.get('x-trino-set-schema') ?? this.schema;
    this.transaction = headers.get('x-trino-started-transaction-id') ?? this.transaction;
    if (headers.has('x-trino-clear-transaction-id')) this.transaction = 'NONE';
    for (const [name, values] of [['x-trino-set-session', this.properties], ['x-trino-set-role', this.roles], ['x-trino-added-prepare', this.prepared]] as const) {
      for (const entry of (headers.get(name) ?? '').split(',')) {
        const index = entry.indexOf('=');
        if (index > 0) values.set(entry.slice(0, index).trim(), entry.slice(index + 1).trim());
      }
    }
    for (const [name, values] of [['x-trino-clear-session', this.properties], ['x-trino-deallocated-prepare', this.prepared]] as const) {
      for (const entry of (headers.get(name) ?? '').split(',')) values.delete(entry.trim());
    }
  }
}

interface Page {
  id: string;
  nextUri?: string;
  columns?: Column[];
  data?: unknown[][];
  stats?: QueryStats;
  updateType?: string;
  updateCount?: number | string;
  error?: { message: string; errorName?: string; errorLocation?: QuerySnapshot['errorLocation'] };
  warnings?: { message: string }[];
}

const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

async function responseText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) {
    await response.body?.cancel();
    throw new Error('Страница результата превышает 32 MB. Уменьшите размер выбираемых данных.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Trino вернул пустой HTTP response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error('Страница результата превышает 32 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class TrinoQuery {
  private nextUri?: string;
  private cancelRequested = false;
  private cancellation?: Promise<void>;
  private retainedBytes = 0;
  private lastNotification = 0;
  private readonly connection: Connection;
  private agent: ReturnType<typeof httpAgent>;
  readonly snapshot: QuerySnapshot;

  constructor(connection: Connection, readonly session: TrinoSession, requestId: string, private maxRows = 1000,
    private notify: (snapshot: QuerySnapshot) => void = () => {}, private requestTimeoutMs = 30_000) {
    this.connection = validateConnection(connection);
    this.agent = httpAgent(this.connection);
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error('Лимит строк должен быть от 1 до 10000.');
    this.snapshot = { requestId, queryId: '', state: 'RUNNING', columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction: false };
  }

  private trustedURL(value: string): URL {
    const url = new URL(value);
    if (url.origin !== new URL(this.connection.endpoint).origin || url.username || url.password) {
      throw new Error('Trino вернул nextUri другого origin. Настройте внешний URL coordinator / reverse proxy.');
    }
    return url;
  }

  private async request(url: string, method: 'POST' | 'GET' | 'DELETE', body?: string): Promise<Response> {
    this.trustedURL(url);
    const headers: Record<string, string> = {
      'X-Trino-User': this.connection.user,
      'X-Trino-Source': 'local-db-viewer',
      'X-Trino-Client-Capabilities': 'PARAMETRIC_DATETIME',
      'Content-Type': 'text/plain; charset=utf-8',
      ...this.session.headers(),
    };
    if (this.connection.auth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${this.connection.user}:${this.connection.secret}`).toString('base64')}`;
    if (this.connection.auth === 'bearer') headers.Authorization = `Bearer ${this.connection.secret}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        const options = { method, headers, body, redirect: 'error' as const, signal: AbortSignal.timeout(this.requestTimeoutMs), dispatcher: this.agent };
        response = await fetch(url, options);
      } catch (error) {
        throw new Error(`Ошибка соединения: ${connectionError(error)}. ${method === 'POST' ? 'Автоматический повтор POST отключён.' : ''}`);
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 5) {
        const retryAfter = response.headers.get('retry-after');
        const delay = response.status === 429 && retryAfter
          ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()))
          : 100;
        await response.body?.cancel();
        if (!Number.isFinite(delay) || delay > 60_000) throw new Error(`Trino ограничил запросы. Retry-After: ${retryAfter}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (method === 'DELETE' && response.ok) { await response.body?.cancel(); return response; }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Trino HTTP ${response.status}${response.status === 401 ? ': проверьте аутентификацию' : response.status === 403 ? ': доступ запрещён' : ''}.`);
      }
      return response;
    }
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.nextUri && !this.cancellation) {
      this.cancellation = this.request(this.nextUri, 'DELETE').then(() => {});
      // Keep the rejection observed even if a network poll is still pending.
      void this.cancellation.catch(() => {});
    }
    await this.cancellation;
  }

  private publish(force = false): void {
    if (force || Date.now() - this.lastNotification > 150) {
      this.snapshot.catalog = this.session.catalog;
      this.snapshot.schema = this.session.schema;
      this.snapshot.inTransaction = this.session.transaction !== 'NONE';
      this.lastNotification = Date.now();
      this.notify(structuredClone(this.snapshot));
    }
  }

  async run(sql: string): Promise<QuerySnapshot> {
    const statement = sql.trim().replace(/;\s*$/, '');
    if (!statement || statement.length > 1_000_000) throw new Error('SQL пустой или превышает 1 MB.');
    let url = `${this.connection.endpoint}/v1/statement`;
    let method: 'POST' | 'GET' = 'POST';
    const started = Date.now();
    try {
      for (;;) {
        if (this.cancelRequested && method === 'POST') { this.snapshot.state = 'CANCELED'; break; }
        const response = await this.request(url, method, method === 'POST' ? statement : undefined);
        this.session.apply(response.headers);
        const page = parse(await responseText(response), undefined, (value: string) => {
          const number = Number(value);
          return Number.isSafeInteger(number) && /^-?\d+$/.test(value) ? number : value;
        }) as Page;
        if (!page || typeof page.id !== 'string' || (page.data !== undefined && (!Array.isArray(page.data) || !page.data.every(Array.isArray)))) {
          throw new Error('Некорректный ответ Trino REST API.');
        }
        this.snapshot.queryId = page.id;
        this.nextUri = page.nextUri;
        if (this.nextUri) this.trustedURL(this.nextUri);
        if (page.columns) this.snapshot.columns = page.columns;
        if (page.stats) this.snapshot.stats = page.stats;
        this.snapshot.updateType = page.updateType ?? this.snapshot.updateType;
        this.snapshot.updateCount = page.updateCount ?? this.snapshot.updateCount;
        for (const warning of page.warnings ?? []) {
          if (!this.snapshot.warnings.includes(warning.message)) this.snapshot.warnings.push(warning.message);
        }
        for (const row of page.data ?? []) {
          this.snapshot.totalRows++;
          if (this.snapshot.rows.length < this.maxRows && !this.snapshot.truncated) {
            this.retainedBytes += Buffer.byteLength(JSON.stringify(row));
            if (this.retainedBytes <= MAX_RESULT_BYTES) this.snapshot.rows.push(row);
            else this.snapshot.truncated = true;
          } else this.snapshot.truncated = true;
        }
        if (this.cancelRequested) {
          await this.cancel();
          this.snapshot.state = page.error?.errorName === 'USER_CANCELED' || this.nextUri || this.cancellation ? 'CANCELED' : 'FINISHED';
          break;
        }
        if (page.error) {
          this.snapshot.error = `${page.error.errorName ?? 'QUERY_ERROR'}: ${page.error.message}`;
          this.snapshot.errorLocation = page.error.errorLocation;
          this.snapshot.state = 'FAILED';
          break;
        }
        if (!this.nextUri) { this.snapshot.state = 'FINISHED'; break; }
        this.publish();
        url = this.nextUri;
        method = 'GET';
      }
    } catch (error) {
      this.snapshot.state = 'FAILED';
      this.snapshot.error = error instanceof Error ? error.message : String(error);
      if (this.nextUri) {
        try { await this.cancel(); }
        catch { this.snapshot.error += ' Отмена на сервере не подтверждена.'; }
      }
    }
    this.snapshot.stats.elapsedTimeMillis ??= Date.now() - started;
    await this.agent?.close();
    this.publish(true);
    return this.snapshot;
  }
}
