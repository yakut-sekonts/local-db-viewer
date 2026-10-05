import { open, readFile, writeFile, rename, rm, lstat, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assetResponse, downloadAsset, MAX_BLOCKMAP, validAsset, releaseByVersion, selectRelease, type ReleaseAsset, type UpdateFetch, type UpdateRelease } from './update-source';
import { parseBlockmap, planPatch, type Block, type PatchPlan } from './update-blockmap';
import type { UpdateTransfer } from '../src/updates';

interface Cache { format: 1; repository: string; folder: string; asset: ReleaseAsset; blockmap: ReleaseAsset }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INSTALLER = /^Local-DB-Viewer-\d+\.\d+\.\d+(?:-beta\.\d+)?-(?:mac-arm64\.zip|windows-x64-setup\.exe)$/;

async function verifiedFile(path: string, asset: ReleaseAsset): Promise<FileHandle> {
  const info = await lstat(path);
  if (!info.isFile() || info.size !== asset.size) throw new Error('Invalid cached file');
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024); let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead; if (position > asset.size) throw new Error('Cached file grew');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (position !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('Cached SHA256 mismatch');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function loadCache(directory: string, repository: string): Promise<Cache | undefined> {
  try {
    const path = join(directory, 'delta-cache.json');
    if ((await lstat(path)).size > 8192) return;
    const data = JSON.parse(await readFile(path, 'utf8')) as Cache;
    if (data?.format !== 1 || data.repository !== repository || !UUID.test(data.folder) || !validAsset(data.asset) || !INSTALLER.test(data.asset.name) || !validAsset(data.blockmap, MAX_BLOCKMAP) || data.blockmap.name !== `${data.asset.name}.blockmap`) return;
    if (!(await lstat(join(directory, data.folder))).isDirectory()) return;
    return data;
  } catch { return; }
}
async function saveCache(directory: string, repository: string, path: string, release: UpdateRelease): Promise<void> {
  if (!release.blockmap) return;
  const temporary = join(directory, `delta-cache.${randomUUID()}.tmp`);
  const record: Cache = { format: 1, repository, folder: basename(dirname(path)), asset: release.asset, blockmap: release.blockmap };
  try { await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, 'delta-cache.json')); }
  finally { await rm(temporary, { force: true }); }
}
async function cachedBlocks(directory: string, cache: Cache): Promise<{ handle: FileHandle; blocks: Block[] }> {
  const folder = join(directory, cache.folder);
  const map = await verifiedFile(join(folder, cache.blockmap.name), cache.blockmap);
  let blocks: Block[];
  try { blocks = await parseBlockmap(await map.readFile(), cache.asset.size); } finally { await map.close(); }
  return { handle: await verifiedFile(join(folder, cache.asset.name), cache.asset), blocks };
}

async function writeAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Не удалось записать обновление.');
    offset += bytesWritten;
  }
}
export async function reconstructInstaller(options: {
  repository: string; token?: string; asset: ReleaseAsset; destination: string; previous: FileHandle; plan: PatchPlan;
  fetchUpdate: UpdateFetch; progress(percent: number): void; received(bytes: number): void;
}): Promise<void> {
  const { asset, destination, previous, plan } = options, temporary = `${destination}.part`;
  const output = await open(temporary, 'wx', 0o600), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024);
  const signal = AbortSignal.timeout(2 * 60 * 1000); let url: string | undefined, position = 0, lastProgress = -1;
  async function append(bytes: Uint8Array) {
    if (signal.aborted) throw new Error('Delta timeout');
    if (position + bytes.length > asset.size) throw new Error('Delta exceeds installer');
    await writeAll(output, bytes, position); hash.update(bytes); position += bytes.length;
    const percent = Math.floor(position / asset.size * 100);
    if (percent !== lastProgress) { lastProgress = percent; options.progress(percent); }
  }
  try {
    for (const op of plan.operations) {
      if (op.start !== position || op.end <= op.start || op.end > asset.size) throw new Error('Invalid delta coverage');
      if (op.source !== undefined) {
        let offset = op.source;
        while (position < op.end) {
          const { bytesRead } = await previous.read(buffer, 0, Math.min(buffer.length, op.end - position), offset);
          if (!bytesRead) throw new Error('Cached installer truncated');
          await append(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
      } else {
        const result = await assetResponse(options.repository, options.token, asset, options.fetchUpdate, signal, op, url);
        url = result.url; const response = result.response;
        const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${op.start}-${op.end - 1}/${asset.size}` || (length !== null && length !== String(op.end - op.start)) || (encoding !== null && encoding !== 'identity') || !response.body) {
          await response.body?.cancel(); throw new Error('Server does not support exact byte ranges');
        }
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            options.received(value.byteLength);
            if (position + value.byteLength > op.end) throw new Error('Oversized range');
            await append(value);
          }
          if (position !== op.end) throw new Error('Truncated range');
        } finally { await reader.cancel().catch(() => {}); }
      }
    }
    if (position !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('Delta SHA256 mismatch');
    await output.sync(); await output.close(); await rename(temporary, destination);
  } finally { await output.close().catch(() => {}); await rm(temporary, { force: true }); }
}

// Adopt a previously downloaded installer from the old updater. No installed app
// files are patched or trusted, and no base installer is downloaded just for delta.
async function legacyBase(directory: string, repository: string, version: string, suffix: string, token: string | undefined, fetchUpdate: UpdateFetch, received: (bytes: number) => void): Promise<Cache | undefined> {
  const name = `Local-DB-Viewer-${version}-${suffix}`;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const path = join(directory, entry.name, name);
    if (!(await lstat(path).catch(() => undefined))?.isFile()) continue;
    const release = selectRelease(await releaseByVersion(repository, token, version, fetchUpdate), '0.0.0', suffix.startsWith('mac') ? 'darwin' : 'win32', suffix.startsWith('mac') ? 'arm64' : 'x64', 'beta');
    if (!release?.blockmap || release.asset.name !== name) return;
    await (await verifiedFile(path, release.asset)).close();
    await downloadAsset(repository, token, release.blockmap, `${path}.blockmap`, () => {}, fetchUpdate, received, AbortSignal.timeout(30000));
    await saveCache(directory, repository, path, release);
    return loadCache(directory, repository);
  }
}

export async function downloadUpdate(options: {
  directory: string; repository: string; currentVersion: string; token?: string; release: UpdateRelease; destination: string; fetchUpdate: UpdateFetch;
  progress(percent: number, transfer: UpdateTransfer): void;
}): Promise<UpdateTransfer> {
  const { directory, repository, token, release, destination, fetchUpdate } = options;
  const transfer: UpdateTransfer = { mode: 'full', downloadedBytes: 0, reusedBytes: 0, totalBytes: release.asset.size };
  const received = (bytes: number) => { transfer.downloadedBytes += bytes; };
  const progress = (percent: number) => options.progress(percent, { ...transfer });
  let blocks: Block[] | undefined;
  if (release.blockmap) {
    try {
      await downloadAsset(repository, token, release.blockmap, `${destination}.blockmap`, () => {}, fetchUpdate, received, AbortSignal.timeout(30000));
      blocks = await parseBlockmap(await readFile(`${destination}.blockmap`), release.asset.size);
      const suffix = release.asset.name.endsWith('mac-arm64.zip') ? 'mac-arm64.zip' : 'windows-x64-setup.exe';
      const cache = await loadCache(directory, repository) ?? await legacyBase(directory, repository, options.currentVersion, suffix, token, fetchUpdate, received);
      if (cache && cache.asset.name.endsWith(suffix)) {
        const base = await cachedBlocks(directory, cache);
        try {
          const plan = planPatch(base.blocks, blocks);
          if (plan.reusedBytes > 0) {
            transfer.mode = 'delta'; transfer.reusedBytes = plan.reusedBytes; progress(0);
            await reconstructInstaller({ repository, token, asset: release.asset, destination, previous: base.handle, plan, fetchUpdate, progress, received });
            await saveCache(directory, repository, destination, release).catch(() => {});
            return transfer;
          }
        } finally { await base.handle.close(); }
      }
    } catch {
      // Maps, caches, Range support and delta integrity are optional. The full
      // download independently verifies the release's size and SHA256 again.
      transfer.fallback = true;
    }
  }
  transfer.mode = 'full'; transfer.reusedBytes = 0; progress(0);
  await downloadAsset(repository, token, release.asset, destination, progress, fetchUpdate, received);
  if (blocks) await saveCache(directory, repository, destination, release).catch(() => {});
  return transfer;
}
