import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { parse } from 'lossless-json';
import { Client, Query, types } from 'pg';
import mysql, { type Connection as MySQLConnection } from 'mysql2';
import { Connection as SQLServerConnection, Request } from 'tedious';
import { DatabaseSync } from 'node:sqlite';
import type { Connection } from './trino';
import type { Column, QuerySnapshot } from '../src/shared';
import { singleStatement, identifier } from './sql';
import { tlsOptions, httpAgent, connectionError } from './tls';

const profile: Connection = workerData;
const port = parentPort!;
let pg: Client | undefined;
let my: MySQLConnection | undefined;
let ms: SQLServerConnection | undefined;
let sqlite: DatabaseSync | undefined;
let stop: (() => Promise<void>) | undefined;
let canceled = false;
let busy = false;
let inTransaction = false;
let snapshot: QuerySnapshot;
let retained = 0;
let limit = 1000;
let lastUpdate = 0;
const clickhouseSession = randomUUID();

const lossless = (text: string) => parse(text, undefined, (value: string) => Number.isSafeInteger(Number(value)) && /^-?\d+$/.test(value) ? Number(value) : value);
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, normalize(value)]));
  return value;
}
function addRow(row: unknown[]): void {
  snapshot.totalRows++;
  if (snapshot.rows.length < limit && !snapshot.truncated) {
    const normalized = row.map(normalize);
    retained += Buffer.byteLength(JSON.stringify(normalized));
    if (retained <= 8 * 1024 * 1024) snapshot.rows.push(normalized); else snapshot.truncated = true;
  } else snapshot.truncated = true;
  if (Date.now() - lastUpdate > 150) { lastUpdate = Date.now(); port.postMessage({ kind: 'update', snapshot }); }
}
function checkCanceled(): void { if (canceled) throw new Error('Запрос отменён до отправки.'); }
const endpoint = profile.engine === 'sqlite' ? null : new URL(profile.endpoint);
function pgConfig() {
  return { host: endpoint!.hostname, port: Number(endpoint!.port || 5432), database: decodeURIComponent(endpoint!.pathname.slice(1)) || 'postgres', user: profile.user, password: profile.secret, ssl: profile.tls ? tlsOptions(profile) : false as const, connectionTimeoutMillis: 15000,
    application_name: 'Local DB Viewer', types: { getTypeParser(oid: number) {
      if ([1082, 1114, 1184, 1186, 1182, 1115, 1185].includes(oid)) return (value: string) => value;
      if ([114, 3802].includes(oid)) return lossless;
      return types.getTypeParser(oid);
    } },
  };
}

async function postgres(sql: string, schema: string): Promise<void> {
  if (!pg) {
    pg = new Client(pgConfig());
    pg.on('error', () => {});
    (pg as any).connection.on('readyForQuery', (message: { status: string }) => { inTransaction = message.status !== 'I'; });
    await pg.connect();
  }
  checkCanceled();
  const pid = (pg as any).processID as number;
  stop = async () => {
    const cancellation = new Client({ ...pgConfig(), query_timeout: 15000 });
    try { await cancellation.connect(); await cancellation.query('SELECT pg_cancel_backend($1)', [pid]); }
    finally { await cancellation.end(); }
  };
  if (schema && !inTransaction) await pg.query('SELECT set_config($1, $2, false)', ['search_path', identifier(schema, 'postgres')]);
  checkCanceled();
  await new Promise<void>((resolve, reject) => {
    const config = { text: sql, rowMode: 'array' };
    const query = new Query(config);
    query.on('row', (row: unknown[], result) => {
      if (!snapshot.columns.length) snapshot.columns = (result?.fields ?? []).map(field => ({ name: field.name, type: pgType(field.dataTypeID) }));
      addRow(row);
    });
    query.on('error', reject);
    query.on('end', (result: any) => {
      snapshot.columns = result.fields.map((field: any) => ({ name: field.name, type: pgType(field.dataTypeID) }));
      snapshot.updateType = result.command;
      if (!result.fields.length) snapshot.updateCount = result.rowCount;
      resolve();
    });
    pg!.query(query);
  });
}
function pgType(oid: number): string {
  return ({ 16: 'boolean', 17: 'bytea', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 114: 'json', 700: 'real', 701: 'double precision', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' } as Record<number, string>)[oid] ?? `OID ${oid}`;
}

function mysqlConfig() {
  return { host: endpoint!.hostname, port: Number(endpoint!.port || 3306), database: decodeURIComponent(endpoint!.pathname.slice(1)) || undefined,
    user: profile.user, password: profile.secret, ssl: profile.tls ? { ...tlsOptions(profile), verifyIdentity: (profile.sslVerification ?? 'FULL') === 'FULL' } : undefined,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true, decimalNumbers: false,
    connectTimeout: 15000, multipleStatements: false,
  };
}
async function mysqlQuery(sql: string, catalog: string): Promise<void> {
  if (!my) { my = mysql.createConnection(mysqlConfig()); my.on('error', () => {}); await new Promise<void>((resolve, reject) => my!.connect(error => error ? reject(error) : resolve())); }
  checkCanceled();
  stop = async () => {
    const cancellation = mysql.createConnection(mysqlConfig()).promise();
    try { await cancellation.query({ sql: `KILL QUERY ${Number(my!.threadId)}`, timeout: 15000 }); } finally { await cancellation.end(); }
  };
  if (catalog) await my.promise().query(`USE ${identifier(catalog, profile.engine)}`);
  checkCanceled();
  await new Promise<void>((resolve, reject) => {
    let resultSet = 0;
    const query = my!.query({ sql, rowsAsArray: true });
    query.on('fields', (fields: any[] | undefined) => {
      if (!fields) return;
      resultSet++;
      if (resultSet === 1) snapshot.columns = fields.map(field => ({ name: field.name, type: String((mysql.Types as any)[field.type] ?? field.type) }));
      else if (resultSet === 2) snapshot.warnings.push('Показан первый result set. Дополнительные результаты прочитаны без отображения.');
    });
    query.on('result', (row: unknown[] | { affectedRows?: number; serverStatus?: number }) => {
      if (Array.isArray(row)) { if (resultSet === 1) addRow(row); }
      else { snapshot.updateCount = row.affectedRows; if (row.serverStatus !== undefined) inTransaction = Boolean(row.serverStatus & 1); }
    });
    query.on('error', reject); query.on('end', resolve);
  });
}

async function sqlserver(sql: string): Promise<void> {
  if (!ms) {
    ms = new SQLServerConnection({ server: endpoint!.hostname,
      authentication: { type: 'default', options: { userName: profile.user, password: profile.secret ?? '' } },
      options: { port: Number(endpoint!.port || 1433), database: decodeURIComponent(endpoint!.pathname.slice(1)) || 'master', encrypt: profile.tls, trustServerCertificate: profile.sslVerification === 'NONE', cryptoCredentialsDetails: profile.tls ? tlsOptions(profile) : {}, connectTimeout: 15000, requestTimeout: 0, rowCollectionOnDone: false, rowCollectionOnRequestCompletion: false, appName: 'Local DB Viewer' },
    });
    ms.on('error', () => {});
    await new Promise<void>((resolve, reject) => ms!.connect(error => error ? reject(error) : resolve()));
  }
  checkCanceled();
  await new Promise<void>((resolve, reject) => {
    let unsafePrecision = false;
    let resultSet = 0;
    const request = new Request(sql, (error, count) => { if (error) reject(error); else if (unsafePrecision) reject(new Error('SQL Server: DECIMAL/NUMERIC с precision > 15 и MONEY требуют явного CAST(... AS varchar) для сохранения точности.')); else { if (!snapshot.columns.length) snapshot.updateCount = count; resolve(); } });
    stop = async () => { request.cancel(); };
    request.on('columnMetadata', columns => {
      if (!Array.isArray(columns)) throw new Error('Ожидалась metadata в виде массива.');
      resultSet++;
      if (resultSet > 1) { if (resultSet === 2) snapshot.warnings.push('Показан первый result set. Дополнительные результаты прочитаны без отображения.'); return; }
      snapshot.columns = columns.map(column => ({ name: column.colName, type: column.type.name }));
      unsafePrecision = columns.some(column => ['Money', 'MoneyN'].includes(column.type.name) || (['NumericN', 'DecimalN', 'Numeric', 'Decimal'].includes(column.type.name) && (column.precision ?? 38) > 15));
    });
    request.on('row', columns => { if (resultSet === 1 && !unsafePrecision && Array.isArray(columns)) addRow(columns.map((column: { value: unknown }) => column.value)); });
    ms!.execSqlBatch(request);
  });
  if (/^\s*BEGIN\s+TRAN/i.test(sql)) inTransaction = true;
  if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) inTransaction = false;
}

function sqliteQuery(sql: string): void {
  sqlite ??= new DatabaseSync(profile.endpoint, { timeout: 5000, allowExtension: false });
  checkCanceled();
  const statement = sqlite.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  snapshot.columns = statement.columns().map(column => ({ name: column.name, type: column.type ?? 'expression' }));
  if (snapshot.columns.length) for (const row of statement.iterate()) addRow(row as unknown as unknown[]);
  else { const result = statement.run(); snapshot.updateCount = String(result.changes); }
  inTransaction = sqlite.isTransaction;
}

async function clickhouse(sql: string, catalog: string): Promise<void> {
  const agent = httpAgent(profile);
  try {
  const id = randomUUID(); snapshot.queryId = id;
  const headers = { 'X-ClickHouse-User': profile.user, 'X-ClickHouse-Key': profile.secret ?? '', 'Content-Type': 'text/plain; charset=utf-8' };
  const controller = new AbortController();
  stop = async () => {
    const killURL = new URL(profile.endpoint);
    const options = { method: 'POST', headers, body: `KILL QUERY WHERE query_id = '${id}' SYNC`, redirect: 'error' as const, signal: AbortSignal.timeout(15000), dispatcher: agent };
    const response = await fetch(killURL, options);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Отмена ClickHouse не подтверждена: HTTP ${response.status}`); }
    await response.body?.cancel(); controller.abort();
  };
  const url = new URL(profile.endpoint);
  url.searchParams.set('query_id', id); url.searchParams.set('session_id', clickhouseSession);
  url.searchParams.set('default_format', 'JSONCompactEachRowWithNamesAndTypes');
  url.searchParams.set('output_format_json_quote_64bit_integers', '1'); url.searchParams.set('output_format_json_quote_decimals', '1');
  if (catalog) url.searchParams.set('database', catalog);
  checkCanceled();
  const options = { method: 'POST', headers, body: sql, redirect: 'error' as const, signal: controller.signal, dispatcher: agent };
  const response = await fetch(url, options);
  if (!response.ok) {
    const reader = response.body?.getReader(); const first = await reader?.read(); await reader?.cancel();
    throw new Error(`ClickHouse HTTP ${response.status}: ${first?.value ? new TextDecoder().decode(first.value).slice(0, 4000) : ''}`);
  }
  if (!response.body) return;
  const stream = Readable.fromWeb(response.body as any);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineIndex = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 32 * 1024 * 1024) throw new Error('Строка ClickHouse превышает 32 MB.');
      const row = lossless(line);
      if (!Array.isArray(row)) throw new Error('Ожидался ClickHouse JSONCompactEachRowWithNamesAndTypes. Уберите явный FORMAT.');
      if (lineIndex === 0) snapshot.columns = row.map(name => ({ name: String(name), type: '' }));
      else if (lineIndex === 1) snapshot.columns = snapshot.columns.map((column, index) => ({ ...column, type: String(row[index]) }));
      else addRow(row);
      lineIndex++;
    }
  } finally { lines.close(); stream.destroy(); }
  } finally { await agent?.close(); }
}

async function close(): Promise<void> {
  await pg?.end();
  if (my) await my.promise().end();
  if (ms) ms.close();
  sqlite?.close();
}
port.on('message', async (message) => {
  if (message.kind === 'cancel') {
    canceled = true;
    try { await stop?.(); port.postMessage({ kind: 'cancel' }); }
    catch (error) { canceled = false; port.postMessage({ kind: 'cancel', error: (error as Error).message }); }
    return;
  }
  if (message.kind === 'close') {
    try { await close(); port.postMessage({ kind: 'closed' }); } catch (error) { port.postMessage({ kind: 'closed', error: (error as Error).message }); }
    return;
  }
  if (message.kind !== 'run' || busy) return;
  busy = true; canceled = false; stop = undefined; retained = 0; lastUpdate = 0; limit = message.maxRows;
  const started = Date.now();
  snapshot = { requestId: message.requestId, queryId: '', state: 'RUNNING', columns: [], rows: [], totalRows: 0, truncated: false, stats: {}, warnings: [], inTransaction, catalog: message.catalog, schema: message.schema };
  try {
    const sql = singleStatement(message.sql);
    if (profile.engine === 'postgres') await postgres(sql, message.schema);
    else if (profile.engine === 'mysql' || profile.engine === 'mariadb') await mysqlQuery(sql, message.catalog);
    else if (profile.engine === 'mssql') await sqlserver(sql);
    else if (profile.engine === 'sqlite') sqliteQuery(sql);
    else if (profile.engine === 'clickhouse') await clickhouse(sql, message.catalog);
    snapshot.state = 'FINISHED';
  } catch (error) { snapshot.state = canceled ? 'CANCELED' : 'FAILED'; snapshot.error = canceled ? undefined : (error as Error).message; }
  snapshot.stats.elapsedTimeMillis = Date.now() - started; snapshot.inTransaction = inTransaction;
  busy = false; stop = undefined;
  port.postMessage({ kind: 'done', snapshot });
});
