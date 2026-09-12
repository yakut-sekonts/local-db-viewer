import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export interface ReleaseAsset { id: number; name: string; size: number; digest: string }
export interface UpdateRelease { version: string; notes: string; asset: ReleaseAsset }
export type UpdateFetch = (url: string, options: RequestInit) => Promise<Response>;
const MAX_DOWNLOAD = 2 * 1024 ** 3;
const DOWNLOAD_HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export function validRepository(value: string): string {
  const repository = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    throw new Error('Укажите GitHub-репозиторий в формате owner/repository.');
  }
  return repository;
}
export function newerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): number[] => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Некорректная стабильная версия релиза.');
    const values = version.split('.').map(Number);
    if (!values.every(Number.isSafeInteger)) throw new Error('Номер версии слишком большой.');
    return values;
  };
  const a = parse(candidate), b = parse(current);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export function selectRelease(data: any, current: string, platform: NodeJS.Platform, arch: string): UpdateRelease | undefined {
  if (data.draft || data.prerelease) return;
  if (typeof data.tag_name !== 'string') throw new Error('В релизе отсутствует версия.');
  const version = data.tag_name.replace(/^v/, '');
  if (!newerVersion(version, current)) return;
  const suffix = platform === 'darwin' && arch === 'arm64' ? 'mac-arm64.zip'
    : platform === 'win32' && arch === 'x64' ? 'windows-x64-setup.exe' : undefined;
  if (!suffix) throw new Error('Обновления доступны для macOS ARM64 и Windows x64.');
  const name = `Local-DB-Viewer-${version}-${suffix}`;
  const asset = Array.isArray(data.assets) ? data.assets.find((item: ReleaseAsset) => item.name === name) : undefined;
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('Релиз не содержит подходящего установщика с контрольной суммой SHA256.');
  }
  return { version, notes: typeof data.body === 'string' ? data.body.slice(0, 16000) : '', asset: { id: asset.id, name, size: asset.size, digest: asset.digest } };
}
function headers(token: string | undefined, accept: string): Record<string, string> {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Local DB Viewer' };
}
function responseError(response: Response): Error {
  const status = response.status;
  if (status === 401) return new Error('GitHub: HTTP 401. Токен недействителен или истёк. Для публичного репозитория удалите токен в настройках обновлений.');
  if (status === 429 || (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    return new Error(`GitHub: HTTP ${status}. Превышен лимит запросов. Повторите проверку позже; личный токен может увеличить лимит для публичного репозитория.`);
  }
  if (status === 403) return new Error('GitHub: HTTP 403. Доступ запрещён. Проверьте права токена и ограничения доступа к GitHub.');
  if (status === 404) return new Error('GitHub: HTTP 404. Репозиторий, опубликованный релиз или файл не найден. Для приватного репозитория нужен токен с доступом к релизам (Contents: read).');
  if (status === 407) return new Error('Proxy: HTTP 407. Требуется авторизация на корпоративном proxy. Проверьте системные настройки сети.');
  return new Error(`Сервер обновлений: HTTP ${status}. Повторите попытку позже.`);
}
export function updateNetworkError(error: unknown, hostname: string): Error {
  // Only known network codes reach the UI. Raw errors can contain signed URLs or credentials.
  const knownCode = /\b(ERR_[A-Z_]+|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/;
  let code = '';
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    code = `${current.code ?? ''} ${current.message ?? ''}`.match(knownCode)?.[0] ?? '';
    if (code) break;
    if (current.name === 'TimeoutError' || current.name === 'AbortError') code = 'ETIMEDOUT';
    if (code) break;
  }
  let reason = 'Проверьте соединение, VPN и доступ к GitHub в системных настройках сети.';
  if (/CERT|ISSUER|VERIFY_LEAF|SELF_SIGNED/.test(code)) reason = 'Не удалось проверить TLS-сертификат. Проверьте системную дату и доверенный корпоративный CA в хранилище сертификатов ОС.';
  else if (/PROXY|TUNNEL/.test(code)) reason = 'Не удалось подключиться через proxy. Проверьте системные настройки proxy и авторизацию в корпоративной сети.';
  else if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(code)) reason = 'Не удалось определить адрес сервера. Проверьте DNS и VPN.';
  else if (/TIMEOUT|TIMED_OUT|ETIMEDOUT/.test(code)) reason = 'Сервер не ответил вовремя. Проверьте сеть, VPN и proxy и повторите попытку.';
  return new Error(`Сеть обновлений (${hostname}${code ? `, ${code}` : ''}): ${reason}`);
}
async function request(url: string, options: RequestInit, fetchUpdate: UpdateFetch): Promise<Response> {
  try { return await fetchUpdate(url, { ...options, cache: 'no-store', credentials: 'omit' }); }
  catch (error) { throw updateNetworkError(error, new URL(url).hostname); }
}
async function apiRequest(url: string, token: string | undefined, accept: string, options: RequestInit, fetchUpdate: UpdateFetch): Promise<Response> {
  const response = await request(url, { ...options, headers: headers(token, accept) }, fetchUpdate);
  if (token && [401, 403].includes(response.status)) {
    // A saved token must not prevent access after a repository becomes public.
    const error = responseError(response);
    await response.body?.cancel();
    const anonymous = await request(url, { ...options, headers: headers(undefined, accept) }, fetchUpdate);
    if (anonymous.ok || [301, 302, 303, 307, 308].includes(anonymous.status)) return anonymous;
    await anonymous.body?.cancel();
    throw error;
  }
  return response;
}
export async function latestRelease(repository: string, token: string | undefined, fetchUpdate: UpdateFetch): Promise<unknown> {
  const response = await apiRequest(`https://api.github.com/repos/${validRepository(repository)}/releases/latest`, token, 'application/vnd.github+json', {
    redirect: 'error', signal: AbortSignal.timeout(30000),
  }, fetchUpdate);
  if (!response.ok) { await response.body?.cancel(); throw responseError(response); }
  if (!response.body) throw new Error('GitHub вернул пустой ответ вместо описания релиза.');
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read().catch(error => { throw updateNetworkError(error, 'api.github.com'); }); if (done) break; size += value.length; if (size > 2 * 1024 ** 2) throw new Error('Ответ GitHub слишком большой.'); parts.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('Сервер вернул некорректное описание релиза. Проверьте, не заменяет ли proxy ответ GitHub страницей авторизации.'); }
}
export async function downloadAsset(repository: string, token: string | undefined, asset: ReleaseAsset, destination: string, progress: (percent: number) => void, fetchUpdate: UpdateFetch): Promise<void> {
  let url = new URL(`https://api.github.com/repos/${validRepository(repository)}/releases/assets/${asset.id}`);
  let response: Response | undefined;
  const signal = AbortSignal.timeout(30 * 60 * 1000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== 'https:' || url.username || url.password || !DOWNLOAD_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('GitHub вернул недопустимый адрес загрузки.');
    response = url.origin === 'https://api.github.com'
      ? await apiRequest(url.href, token, 'application/octet-stream', { redirect: 'manual', signal }, fetchUpdate)
      : await request(url.href, { redirect: 'manual', signal, headers: { Accept: 'application/octet-stream' } }, fetchUpdate);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirect === 5) throw new Error('Слишком много перенаправлений GitHub.');
    url = new URL(location, url);
  }
  if (!response) throw new Error('Сервер обновлений не вернул ответ.');
  if (!response.ok) { await response.body?.cancel(); throw responseError(response); }
  if (!response.body) throw new Error('Сервер обновлений вернул пустой файл.');
  const temporary = `${destination}.part`;
  const file = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0, lastProgress = -1;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(error => { throw updateNetworkError(error, url.hostname); }); if (done) break;
      size += value.byteLength;
      if (size > asset.size || size > MAX_DOWNLOAD) throw new Error('Размер загрузки не соответствует релизу.');
      hash.update(value);
      let offset = 0;
      while (offset < value.length) { const { bytesWritten } = await file.write(value, offset, value.length - offset); if (!bytesWritten) throw new Error('Не удалось записать обновление.'); offset += bytesWritten; }
      const percent = Math.floor(size / asset.size * 100); if (percent !== lastProgress) { lastProgress = percent; progress(percent); }
    }
    if (size !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('Проверка SHA256 обновления не пройдена. Файл удалён.');
    await file.sync(); await file.close();
    await rename(temporary, destination);
  } finally { await reader.cancel().catch(() => {}); await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}
