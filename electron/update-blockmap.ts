import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { MAX_BLOCKMAP, MAX_DOWNLOAD } from './update-source';

export interface Block { offset: number; size: number; checksum: string }
export interface PatchOperation { start: number; end: number; source?: number }
export interface PatchPlan { operations: PatchOperation[]; reusedBytes: number; downloadBytes: number }

// Only the external, gzipped v2 maps emitted for our NSIS and ZIP targets are supported.
// Block checksums select candidates; the final installer SHA256 is the integrity boundary.
export async function parseBlockmap(bytes: Buffer, expectedSize: number): Promise<Block[]> {
  if (bytes.length > MAX_BLOCKMAP || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_DOWNLOAD) throw new Error('Invalid blockmap size');
  const data = JSON.parse((await promisify(gunzip)(bytes, { maxOutputLength: 24 * 1024 ** 2 })).toString('utf8'));
  if (data?.version !== '2' || !Array.isArray(data.files) || data.files.length !== 1) throw new Error('Unsupported blockmap');
  const file = data.files[0];
  if (file?.offset !== 0 || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) || !file.sizes.length || file.sizes.length > 262144 || file.sizes.length !== file.checksums.length) throw new Error('Invalid blockmap entries');
  const blocks: Block[] = []; let offset = 0;
  for (let i = 0; i < file.sizes.length; i++) {
    const size: unknown = file.sizes[i], checksum: unknown = file.checksums[i];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > 4 * 1024 ** 2 || typeof checksum !== 'string' || !/^[A-Za-z0-9+/]{24}$/.test(checksum)) throw new Error('Invalid block');
    blocks.push({ offset, size, checksum }); offset += size;
    if (offset > expectedSize) throw new Error('Blockmap exceeds installer');
  }
  if (offset !== expectedSize) throw new Error('Incomplete blockmap');
  return blocks;
}

export function planPatch(previous: Block[], next: Block[]): PatchPlan {
  const candidates = new Map<string, number>();
  for (const block of previous) {
    const key = `${block.checksum}:${block.size}`;
    if (!candidates.has(key)) candidates.set(key, block.offset);
  }
  const initial: PatchOperation[] = [];
  for (const block of next) {
    const source = candidates.get(`${block.checksum}:${block.size}`), last = initial.at(-1);
    if (last && last.end === block.offset && (last.source === undefined ? source === undefined : source === last.source + last.end - last.start)) last.end += block.size;
    else initial.push({ start: block.offset, end: block.offset + block.size, source });
  }
  // Merge changed spans across small unchanged gaps. Bound round trips without
  // multipart HTTP parsing or one GitHub API call for every changed block.
  let ranges: { start: number; end: number }[] = [];
  for (let gap = 64 * 1024; gap <= 1024 * 1024; gap *= 2) {
    ranges = [];
    for (const op of initial) {
      if (op.source !== undefined) continue;
      const last = ranges.at(-1);
      if (last && op.start - last.end <= gap) last.end = op.end;
      else ranges.push({ start: op.start, end: op.end });
    }
    if (ranges.length <= 64) break;
  }
  const operations: PatchOperation[] = []; let index = 0;
  for (const range of ranges) {
    while (initial[index] && initial[index]!.end <= range.start) operations.push(initial[index++]!);
    operations.push(range);
    while (initial[index] && initial[index]!.start < range.end) index++;
  }
  operations.push(...initial.slice(index));
  const total = next.reduce((sum, block) => sum + block.size, 0);
  const downloadBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (ranges.length > 64 || downloadBytes >= total * 0.9) return { operations: [{ start: 0, end: total }], reusedBytes: 0, downloadBytes: total };
  return { operations, reusedBytes: total - downloadBytes, downloadBytes };
}
