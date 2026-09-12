// UI/restart fixtures; HTTPS transport itself is exercised by update-network.mjs.
export async function installUpdateFixture(app, fixture) {
  await app.evaluate(({ net }, fixture) => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const { Readable } = process.getBuiltinModule('node:stream');
    const { createReadStream } = process.getBuiltinModule('node:fs');
    globalThis.__originalUpdateRequest = net.request;
    net.request = options => {
      const url = String(options.url);
      if (!url.startsWith('https://api.github.com/repos/')) throw new Error('Unexpected fixture URL');
      const request = new EventEmitter();
      let response;
      request.setHeader = () => {};
      request.abort = () => { response?.destroy(); request.emit('close'); };
      request.end = () => queueMicrotask(() => {
        response = url.endsWith('/latest') ? Readable.from([Buffer.from(JSON.stringify({ tag_name: `v${fixture.version}`, body: 'Test release notes', assets: [
          { id: 100, name: `Local-DB-Viewer-${fixture.version}-mac-arm64.zip`, size: fixture.size, digest: fixture.digest },
          { id: 101, name: `Local-DB-Viewer-${fixture.version}-windows-x64-setup.exe`, size: fixture.size, digest: fixture.digest },
        ] }))]) : fixture.archive ? createReadStream(fixture.archive) : Readable.from([Buffer.from(fixture.bytes)]);
        response.statusCode = 200; response.headers = {};
        response.once('close', () => request.emit('close'));
        request.emit('response', response);
      });
      return request;
    };
  }, fixture);
}

export async function restoreUpdateFixture(app) {
  await app.evaluate(({ net }) => { net.request = globalThis.__originalUpdateRequest; delete globalThis.__originalUpdateRequest; });
}
