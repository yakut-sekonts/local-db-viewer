import { createHash } from 'node:crypto';
import { driverDefinition, type DriverRelease, type DriverUpdateSource } from '../src/drivers';
import { updateNetworkError, type UpdateFetch } from './update-source';

export interface DriverFeedManifest {
  format: 1; driverId: string; driverClass: string; revision: number; version: string;
  files: { url: string; size: number; sha256: string }[];
}
export interface SavedDriverSource extends DriverUpdateSource { manifest?: DriverFeedManifest; checkedAt?: number }
const CLASS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const SHA = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function driverFeedURL(value: unknown, redirect = false): string {
  if (typeof value !== 'string' || value.length > (redirect ? 16000 : 2048) || /[\s\\]/.test(value)) throw new Error('Укажите корректный HTTPS URL источника драйвера.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Укажите корректный HTTPS URL источника драйвера.'); }
  // Configured URLs are persisted as plain text. Signed CDN query parameters
  // are accepted only in transient redirects and never saved or logged.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!redirect && url.search)) throw new Error('Источник драйвера требует HTTPS URL без пароля, query-параметров и fragment.');
  return url.href;
}
export function validateDriverSource(value: unknown): DriverUpdateSource {
  if (!object(value) || typeof value.driverClass !== 'string' || value.driverClass.length > 512 || !CLASS.test(value.driverClass)) throw new Error('Укажите полный JDBC Driver class для проверки комплекта.');
  return { url: driverFeedURL(value.url), driverClass: value.driverClass };
}
export function validateDriverFeed(value: unknown, id: string, driverClass: string): DriverFeedManifest {
  driverDefinition(id);
  if (!object(value) || value.format !== 1 || value.driverId !== id || value.driverClass !== driverClass || !CLASS.test(driverClass) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.version !== 'string' || !value.version.trim() || value.version.length > 100 || /[\x00-\x1f\x7f]/.test(value.version) || !Array.isArray(value.files) || !value.files.length || value.files.length > 250) throw new Error('Некорректный манифест драйвера: проверьте driverId, driverClass, revision, version и files.');
  const urls = new Set<string>(), hashes = new Set<string>(); let total = 0;
  const files = value.files.map((file: unknown) => {
    if (!object(file) || typeof file.sha256 !== 'string' || !SHA.test(file.sha256) || !Number.isSafeInteger(file.size) || Number(file.size) <= 0 || Number(file.size) > 512 * 1024 ** 2) throw new Error('Некорректный размер или SHA256 JAR в манифесте.');
    const url = driverFeedURL(file.url), size = Number(file.size);
    if (urls.has(url) || hashes.has(file.sha256)) throw new Error('JAR-файлы в манифесте не должны повторяться.');
    urls.add(url); hashes.add(file.sha256); total += size;
    if (total > 1024 ** 3) throw new Error('Размер драйвера превышает 1 GiB.');
    return { url, size, sha256: file.sha256 };
  });
  return { format: 1, driverId: id, driverClass, revision: Number(value.revision), version: value.version.trim(), files };
}
export function driverFeedRelease(manifest: DriverFeedManifest): DriverRelease {
  return { key: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), version: manifest.version,
    files: manifest.files.map(file => ({ path: file.url, size: file.size, sha256: file.sha256 })) };
}
export function validateFeedAdvance(next: DriverFeedManifest, previous?: DriverFeedManifest): void {
  if (!previous) return;
  if (next.revision < previous.revision) throw new Error('Источник вернул устаревшую revision. Сохранена последняя проверенная версия.');
  if (next.revision === previous.revision && driverFeedRelease(next).key !== driverFeedRelease(previous).key) throw new Error('Источник изменил комплект без увеличения revision. Увеличьте revision в манифесте.');
}
export async function fetchDriverFeedFile(url: string, signal: AbortSignal, fetchUpdate: UpdateFetch): Promise<Response> {
  let current = driverFeedURL(url);
  for (let hop = 0; hop <= 5; hop++) {
    let response: Response;
    try { response = await fetchUpdate(current, { redirect: 'manual', signal, cache: 'no-store', credentials: 'omit' }); }
    catch (error) { throw updateNetworkError(error, new URL(current).hostname); }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`Источник JDBC-драйвера: HTTP ${response.status}. Нужен прямой доступ к файлу без авторизации.`); }
      return response;
    }
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || hop === 5) throw new Error('Слишком много перенаправлений источника JDBC-драйвера.');
    try { current = driverFeedURL(new URL(location, current).href, true); }
    catch { throw new Error('Источник JDBC-драйвера вернул недопустимое перенаправление.'); }
  }
  throw new Error('Источник JDBC-драйвера не вернул файл.');
}
export async function readDriverFeed(source: DriverUpdateSource, id: string, fetchUpdate: UpdateFetch): Promise<DriverFeedManifest> {
  const response = await fetchDriverFeedFile(source.url, AbortSignal.timeout(30000), fetchUpdate);
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(error => { throw updateNetworkError(error, new URL(source.url).hostname); });
      if (done) break;
      size += value.byteLength;
      if (size > 1024 ** 2) throw new Error('Манифест JDBC-драйвера превышает 1 MiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Источник вернул некорректный JSON-манифест JDBC-драйвера.'); }
  return validateDriverFeed(value, id, source.driverClass);
}
