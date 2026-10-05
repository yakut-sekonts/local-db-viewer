import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlockmap, planPatch } from '../electron/update-blockmap';
import { downloadUpdate } from '../electron/update-delta';
import { selectRelease, type UpdateFetch, type UpdateRelease } from '../electron/update-source';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const a = Buffer.alloc(256 * 1024, 17), b = Buffer.alloc(256 * 1024, 31), c = Buffer.alloc(256 * 1024, 42), change = Buffer.alloc(10000, 67);
function fixture(version: string, chunks: Buffer[], id: number) {
  const bytes = Buffer.concat(chunks), name = `Local-DB-Viewer-${version}-mac-arm64.zip`;
  const raw = { version: '2', files: [{ name: 'file', offset: 0, sizes: chunks.map(b => b.length), checksums: chunks.map(b => createHash('sha256').update(b).digest().subarray(0, 18).toString('base64')) }] };
  const map = gzipSync(JSON.stringify(raw));
  const release: UpdateRelease = { version, notes: '', asset: { id, name, size: bytes.length, digest: digest(bytes) }, blockmap: { id: id + 1, name: `${name}.blockmap`, size: map.length, digest: digest(map) } };
  return { bytes, map, raw, release };
}
const old = fixture('1.0.0', [a, b, c], 10), next = fixture('1.0.1', [b, change, a, c], 20);

test('blockmaps reject unsupported, oversized, incomplete and hostile metadata', async () => {
  for (const raw of [null, {}, { ...next.raw, version: '3' }, { ...next.raw, files: [] },
    ...[{ offset: 1 }, { sizes: [-1] }, { sizes: [NaN] }, { sizes: [0] }, { sizes: [2 ** 53] }, { checksums: ['bad'] }, { sizes: [next.bytes.length + 1], checksums: ['a'.repeat(24)] }].map(patch => ({ version: '2', files: [{ ...next.raw.files[0], ...patch }] }))]) {
    await assert.rejects(parseBlockmap(gzipSync(JSON.stringify(raw)), next.bytes.length));
  }
  await assert.rejects(parseBlockmap(gzipSync(Buffer.alloc(25 * 1024 ** 2, 32)), next.bytes.length));
  const parsed = await parseBlockmap(next.map, next.bytes.length);
  assert.equal(parsed.length, 4); assert.equal(parsed.at(-1)!.offset + parsed.at(-1)!.size, next.bytes.length);
});

test('plan reuses reordered and duplicated blocks and bounds HTTP requests', async () => {
  const plan = planPatch(await parseBlockmap(old.map, old.bytes.length), await parseBlockmap(next.map, next.bytes.length));
  assert.equal(plan.downloadBytes, change.length); assert.equal(plan.reusedBytes, old.bytes.length);
  assert.deepEqual(plan.operations.map(o => o.source), [a.length, undefined, 0, a.length + b.length]);
  const duplicate = fixture('1.0.2', [a, a, a], 30);
  assert.equal(planPatch(await parseBlockmap(old.map, old.bytes.length), await parseBlockmap(duplicate.map, duplicate.bytes.length)).downloadBytes, 0);
  const unrelated = fixture('1.0.3', [change], 40);
  assert.equal(planPatch(await parseBlockmap(old.map, old.bytes.length), await parseBlockmap(unrelated.map, unrelated.bytes.length)).reusedBytes, 0);
  const alternating = Array.from({ length: 150 }, (_, i) => ({ offset: i * 2 ** 21, size: 2 ** 21, checksum: i % 2 ? 'missing' : 'known' }));
  const bounded = planPatch([{ offset: 0, size: 2 ** 21, checksum: 'known' }], alternating);
  assert.equal(bounded.reusedBytes, 0); assert.equal(bounded.operations.length, 1);
});

type Fault = 'none' | 'no-range' | 'wrong-range' | 'oversize' | 'truncated' | 'corrupt-range' | 'encoded' | 'network' | 'bad-map' | 'bad-base' | 'bad-cache' | 'other-repository';
async function scenario(fault: Fault = 'none') {
  const directory = await mkdtemp(join(tmpdir(), 'ldv-delta-'));
  const calls: { url: string; auth: string | null; range: string | null }[] = [];
  let activeFault: Fault = 'none';
  const fetchUpdate: UpdateFetch = async (url, options) => {
    const headers = new Headers(options.headers), range = headers.get('range');
    calls.push({ url, auth: headers.get('authorization'), range });
    if (headers.get('authorization') === 'Bearer expired') return new Response(null, { status: 401 });
    if (url.includes('/releases/tags/')) return new Response(JSON.stringify({ tag_name: 'v1.0.0', assets: [old.release.asset, old.release.blockmap] }));
    const id = Number(url.split('/').at(-1));
    if (url.startsWith('https://api.github.com')) return new Response(null, { status: 302, headers: { Location: `https://release-assets.githubusercontent.com/${id}` } });
    const source = id < 20 ? old : next;
    if (id % 2 === 1) return new Response(activeFault === 'bad-map' && id === 21 ? Buffer.alloc(source.map.length) : source.map);
    if (!range || activeFault === 'no-range') return new Response(source.bytes);
    if (activeFault === 'network') throw new Error('ERR_CONNECTION_RESET secret');
    const parts = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(parts[1]), end = Number(parts[2]);
    let bytes = source.bytes.subarray(start, end + 1);
    if (activeFault === 'oversize') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
    if (activeFault === 'truncated') bytes = bytes.subarray(0, -1);
    if (activeFault === 'corrupt-range') bytes = Buffer.alloc(bytes.length);
    return new Response(bytes, { status: 206, headers: {
      'Content-Range': `bytes ${activeFault === 'wrong-range' ? start + 1 : start}-${end}/${source.bytes.length}`,
      ...(activeFault === 'encoded' ? { 'Content-Encoding': 'gzip' } : {}),
    } });
  };
  async function download(release: UpdateRelease, repository = 'owner/releases') {
    const folder = join(directory, randomUUID()); await mkdir(folder);
    const path = join(folder, release.asset.name);
    const transfer = await downloadUpdate({ directory, currentVersion: '1.0.0', repository, token: 'expired', release, destination: path, fetchUpdate, progress: () => {} });
    return { path, transfer };
  }
  try {
    const initial = await download(old.release);
    assert.equal(initial.transfer.mode, 'full'); assert.deepEqual(await readFile(initial.path), old.bytes);
    if (fault === 'bad-base') await writeFile(initial.path, Buffer.alloc(old.bytes.length));
    if (fault === 'bad-cache') await writeFile(join(directory, 'delta-cache.json'), '{bad');
    activeFault = fault; calls.length = 0;
    const result = await download(next.release, fault === 'other-repository' ? 'another/repository' : 'owner/releases');
    assert.deepEqual(await readFile(result.path), next.bytes);
    assert.ok(calls.filter(c => c.url.startsWith('https://release-assets')).every(c => c.auth === null));
    assert.ok((await readdir(join(result.path, '..'))).every(name => !name.endsWith('.part')));
    return { ...result, calls, directory, initial };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

test('cached full installer enables verified delta after restart, with anonymous token fallback', async () => {
  const result = await scenario();
  try {
    assert.equal(result.transfer.mode, 'delta'); assert.equal(result.transfer.reusedBytes, old.bytes.length);
    assert.equal(result.transfer.downloadedBytes, change.length + next.map.length);
    assert.ok(result.calls.some(c => c.range && c.auth === 'Bearer expired'));
    assert.ok(result.calls.some(c => c.range && c.auth === null));
    assert.ok(!result.calls.some(c => c.url.endsWith('/20') && !c.range));
  } finally { await rm(result.directory, { recursive: true, force: true }); }
});

for (const fault of ['no-range', 'wrong-range', 'oversize', 'truncated', 'corrupt-range', 'encoded', 'network', 'bad-map', 'bad-base'] as const) {
  test(`delta ${fault} falls back to a complete independently verified download`, async () => {
    const result = await scenario(fault);
    try {
      assert.equal(result.transfer.mode, 'full'); assert.equal(result.transfer.reusedBytes, 0); assert.equal(result.transfer.fallback, true);
      assert.ok(result.transfer.downloadedBytes >= next.bytes.length);
      assert.ok(result.calls.some(c => c.url.endsWith('/20') && !c.range));
    } finally { await rm(result.directory, { recursive: true, force: true }); }
  });
}
test('a missing cache record can adopt a verified legacy download using its exact release', async () => {
  const result = await scenario('bad-cache');
  try {
    assert.equal(result.transfer.mode, 'delta'); assert.ok(result.calls.some(c => c.url.includes('/tags/v1.0.0')));
  } finally { await rm(result.directory, { recursive: true, force: true }); }
});

test('optional malformed map metadata does not block legacy full releases', () => {
  for (const map of [undefined, { ...next.release.blockmap, size: 9 * 1024 ** 2 }, { ...next.release.blockmap, digest: 'invalid' }]) {
    const release = selectRelease({ tag_name: 'v1.0.1', assets: [next.release.asset, map] }, '1.0.0', 'darwin', 'arm64');
    assert.equal(release?.blockmap, undefined); assert.deepEqual(release?.asset, next.release.asset);
  }
});

test('invalid full download after failed delta leaves no installable file or partial data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ldv-delta-failure-'));
  const destination = join(directory, 'installer.zip');
  try {
    await assert.rejects(downloadUpdate({ directory, repository: 'owner/releases', currentVersion: '1.0.0', release: next.release,
      destination, progress: () => {}, fetchUpdate: async url => new Response(url.endsWith('/21') ? Buffer.alloc(next.map.length) : Buffer.alloc(next.bytes.length)),
    }), /SHA256/);
    await assert.rejects(readFile(destination)); assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cache traversal and absolute paths are discarded before any reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ldv-delta-paths-'));
  try {
    for (const folder of ['../outside', directory, 'not-a-uuid']) {
      await writeFile(join(directory, 'delta-cache.json'), JSON.stringify({ format: 1, repository: 'owner/releases', folder, asset: old.release.asset, blockmap: old.release.blockmap }));
      const destination = join(directory, randomUUID());
      const transfer = await downloadUpdate({ directory, repository: 'owner/releases', currentVersion: '1.0.0', release: next.release,
        destination, progress: () => {}, fetchUpdate: async url => new Response(url.endsWith('/21') ? next.map : next.bytes),
      });
      assert.equal(transfer.mode, 'full'); assert.equal(transfer.reusedBytes, 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
