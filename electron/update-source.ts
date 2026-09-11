import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export interface ReleaseAsset { id: number; name: string; size: number; digest: string }
export interface UpdateRelease { version: string; notes: string; asset: ReleaseAsset }
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
function headers(token: string, accept: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Local DB Viewer' };
}
function responseError(status: number): Error {
  return new Error(status === 401 || status === 403 || status === 404
    ? 'GitHub не предоставил доступ к релизу. Проверьте репозиторий, приглашение и срок действия токена.'
    : `GitHub: HTTP ${status}. Повторите попытку позже.`);
}
export async function latestRelease(repository: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${validRepository(repository)}/releases/latest`, {
    headers: headers(token, 'application/vnd.github+json'), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) { await response.body?.cancel(); throw responseError(response.status); }
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 ** 2) throw new Error('Ответ GitHub слишком большой.'); parts.push(value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function downloadAsset(repository: string, token: string, asset: ReleaseAsset, destination: string, progress: (percent: number) => void): Promise<void> {
  let url = new URL(`https://api.github.com/repos/${validRepository(repository)}/releases/assets/${asset.id}`);
  let response: Response | undefined;
  const signal = AbortSignal.timeout(30 * 60 * 1000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== 'https:' || url.username || url.password || !DOWNLOAD_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('GitHub вернул недопустимый адрес загрузки.');
    response = await fetch(url, { redirect: 'manual', signal, headers: url.origin === 'https://api.github.com' ? headers(token, 'application/octet-stream') : { Accept: 'application/octet-stream' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirect === 5) throw new Error('Слишком много перенаправлений GitHub.');
    url = new URL(location, url);
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw responseError(response?.status ?? 0); }
  const temporary = `${destination}.part`;
  const file = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0, lastProgress = -1;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
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
