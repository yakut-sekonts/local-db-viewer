// UI/restart fixtures; HTTPS transport itself is exercised by update-network.mjs.
export async function installUpdateFixture(app, fixture) {
  await app.evaluate(({ net }, fixture) => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const { Readable } = process.getBuiltinModule('node:stream');
    const { createReadStream } = process.getBuiltinModule('node:fs');
    globalThis.__originalUpdateRequest = net.request;
    globalThis.__updateRangeRequests = 0;
    net.request = options => {
      const url = String(options.url);
      if (!url.startsWith('https://api.github.com/repos/')) throw new Error('Unexpected fixture URL');
      const request = new EventEmitter();
      let response;
      const headers = {};
      request.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
      request.abort = () => { response?.destroy(); request.emit('close'); };
      request.end = () => queueMicrotask(() => {
        const release = { tag_name: `v${fixture.version}`, draft: false, prerelease: fixture.version.includes('-beta.'), body: 'Test release notes', assets: [
          { id: 100, name: `Local-DB-Viewer-${fixture.version}-mac-arm64.zip`, size: fixture.size, digest: fixture.digest },
          { id: 101, name: `Local-DB-Viewer-${fixture.version}-windows-x64-setup.exe`, size: fixture.size, digest: fixture.digest },
          ...(fixture.blockmap ? [fixture.blockmap] : []),
        ] };
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
        response = url.endsWith('/latest') ? Readable.from([Buffer.from(JSON.stringify(release))])
          : url.includes('/releases?') ? Readable.from([Buffer.from(JSON.stringify(fixture.releases ?? [release]))])
          : url.endsWith('/assets/102') && fixture.blockmapPath ? createReadStream(fixture.blockmapPath)
          : fixture.archive ? createReadStream(fixture.archive, range ? { start: Number(range[1]), end: Number(range[2]) } : {}) : Readable.from([Buffer.from(fixture.bytes)]);
        response.statusCode = 200; response.headers = {};
        if (range && !url.endsWith('/assets/102')) {
          globalThis.__updateRangeRequests++;
          response.statusCode = 206;
          response.headers = { 'content-range': `bytes ${range[1]}-${range[2]}/${fixture.size}` };
        }
        response.once('close', () => request.emit('close'));
        request.emit('response', response);
      });
      return request;
    };
  }, fixture);
}

// A prior, completely downloaded installer is the delta base. The installed
// application itself remains untouched until the normal installer takes over.
export async function prepareDeltaFixture({ directory, currentVersion, version, baseArchive, archive }) {
  const { buildBlockMap } = await import('app-builder-lib/out/targets/blockmap/blockmap.js');
  const { createReadStream } = await import('node:fs');
  const { mkdir, copyFile, writeFile, stat } = await import('node:fs/promises');
  const { join, basename } = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const suffix = process.platform === 'win32' ? 'windows-x64-setup.exe' : 'mac-arm64.zip';
  const folder = randomUUID(), cache = join(directory, folder); await mkdir(cache, { recursive: true });
  const name = `Local-DB-Viewer-${currentVersion}-${suffix}`, cached = join(cache, name);
  await copyFile(baseArchive, cached);
  await buildBlockMap(cached, 'gzip', `${cached}.blockmap`);
  await buildBlockMap(archive, 'gzip', `${archive}.blockmap`);
  async function asset(path, id, name = basename(path)) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { id, name, size: (await stat(path)).size, digest: `sha256:${hash.digest('hex')}` };
  }
  await writeFile(join(directory, 'delta-cache.json'), JSON.stringify({ format: 1, repository: 'fixture/releases', folder,
    asset: await asset(cached, 90), blockmap: await asset(`${cached}.blockmap`, 91) }));
  const next = await asset(archive, 100);
  return { archive, version, size: next.size, digest: next.digest, blockmapPath: `${archive}.blockmap`,
    blockmap: await asset(`${archive}.blockmap`, 102, `Local-DB-Viewer-${version}-${suffix}.blockmap`) };
}

export async function restoreUpdateFixture(app) {
  await app.evaluate(({ net }) => { net.request = globalThis.__originalUpdateRequest; delete globalThis.__originalUpdateRequest; });
}
