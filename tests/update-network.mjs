import assert from 'node:assert/strict';
import { createServer as createProxy } from 'node:http';
import { createServer as createTLS } from 'node:https';
import { connect } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Exercise the actual packaged updater over HTTPS CONNECT, without sending any
// requests or credentials to GitHub. Only this disposable session trusts the fixture.
export async function testUpdateNetwork(app, page, directory, artifacts) {
  const work = join(directory, 'network-fixture'); await mkdir(work);
  const platform = process.platform === 'win32' ? 'windows-x64' : 'mac-arm64';
  const java = process.env.LOCAL_DB_VIEWER_RESOURCES ? join(process.env.LOCAL_DB_VIEWER_RESOURCES, 'jre') : resolve('runtime', platform);
  const keytool = join(java, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const password = 'disposable-fixture';
  const execute = promisify(execFile);
  async function fixtureCertificate(name) {
    const store = join(work, name + '.p12');
    await execute(keytool, ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=api.github.com', '-ext', 'SAN=DNS:api.github.com,DNS:release-assets.githubusercontent.com', '-validity', '1', '-storetype', 'PKCS12', '-keystore', store, '-storepass', password, '-keypass', password, '-noprompt']);
    const { stdout: certificate } = await execute(keytool, ['-exportcert', '-rfc', '-alias', 'fixture', '-keystore', store, '-storepass', password]);
    return { pfx: await readFile(store), fingerprint: new X509Certificate(certificate).fingerprint256 };
  }
  // Use separate certificates: Chromium caches certificate verification results.
  const untrustedCertificate = await fixtureCertificate('untrusted');
  const trustedCertificate = await fixtureCertificate('trusted');
  const bytes = Buffer.from('HTTPS installer fixture: Кириллица 🌍');
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const calls = [], tunnels = [], sockets = new Set();
  let rejectTunnel = false;
  const tls = createTLS({ pfx: untrustedCertificate.pfx, passphrase: password }, (request, response) => {
    calls.push({ host: request.headers.host, auth: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null });
    if (request.url === '/auth-fixture') {
      if (request.headers.authorization === 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64')) { response.end('ok'); }
      else { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="disposable-fixture"' }); response.end(); }
      return;
    }
    if (request.headers.authorization === 'Bearer expired-fixture') { response.writeHead(401); response.end(); return; }
    if (request.url.endsWith('/latest')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [
        { id: 10, name: 'Local-DB-Viewer-9.9.9-windows-x64-setup.exe', size: bytes.length, digest },
        { id: 11, name: 'Local-DB-Viewer-9.9.9-mac-arm64.zip', size: bytes.length, digest },
      ] }));
    } else if (request.url.includes('/assets/')) {
      response.writeHead(302, { Location: 'https://release-assets.githubusercontent.com/fixture?signature=not-for-ui' }); response.end();
    } else { response.end(bytes); }
  });
  const proxy = createProxy((_request, response) => { response.writeHead(400); response.end(); });
  proxy.on('connect', (request, client, head) => {
    tunnels.push(request.url);
    if (rejectTunnel || !['api.github.com:443', 'release-assets.githubusercontent.com:443'].includes(request.url)) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = connect(tls.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  for (const server of [tls, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  try {
    await app.evaluate(async ({ session }, port) => {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}` });
      await session.defaultSession.closeAllConnections();
    }, proxy.address().port);
    const resolvedProxy = await app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://api.github.com'));
    assert.match(resolvedProxy, /PROXY 127\.0\.0\.1:/);
    await page.evaluate(() => window.studio.updates.configure({ repository: 'fixture/public', automatic: false, token: '' }));
    const untrusted = await page.evaluate(() => window.studio.updates.check());
    assert.equal(untrusted.phase, 'error'); assert.match(untrusted.error, /TLS-сертификат/);
    tls.setSecureContext({ pfx: trustedCertificate.pfx, passphrase: password });
    await app.evaluate(async ({ session }, fingerprint) => {
      const { X509Certificate } = process.getBuiltinModule('node:crypto');
      session.defaultSession.setCertificateVerifyProc((request, callback) => callback(
        ['api.github.com', 'release-assets.githubusercontent.com'].includes(request.hostname) && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -2));
      await session.defaultSession.closeAllConnections();
    }, trustedCertificate.fingerprint);
    // Populate Chromium's session auth cache deliberately. The updater must
    // omit it even on the same origin while retaining explicitly set PATs.
    await app.evaluate(async ({ net, session }) => {
      for (const domain of ['api.github.com', 'release-assets.githubusercontent.com']) await session.defaultSession.cookies.set({ url: `https://${domain}`, name: 'fixture-cookie', value: 'must-not-leak', secure: true });
      await new Promise((resolve, reject) => {
        const request = net.request({ url: 'https://api.github.com/auth-fixture', credentials: 'include', redirect: 'error' });
        const timer = setTimeout(() => { request.abort(); reject(new Error('Auth cache fixture timeout')); }, 10000);
        request.on('login', (_auth, callback) => callback('fixture-user', 'fixture-password'));
        request.on('error', error => { clearTimeout(timer); reject(error); });
        request.on('response', response => {
          response.on('data', () => {});
          response.on('end', () => { clearTimeout(timer); response.statusCode === 200 ? resolve() : reject(new Error('Auth fixture HTTP ' + response.statusCode)); });
        });
        request.end();
      });
    });
    for (const token of ['', 'valid-fixture', 'expired-fixture']) {
      calls.length = 0;
      await page.evaluate(token => window.studio.updates.configure({ repository: 'fixture/public', automatic: false, token }), token);
      const checked = await page.evaluate(() => window.studio.updates.check());
      assert.equal(checked.phase, 'available', checked.error);
      const downloaded = await page.evaluate(() => window.studio.updates.download());
      assert.equal(downloaded.phase, 'ready', downloaded.error);
      assert.equal(downloaded.progress, 100);
      const cdn = calls.filter(call => call.host === 'release-assets.githubusercontent.com');
      assert.equal(cdn.length, 1); assert.equal(cdn[0].auth, null);
      assert.ok(calls.every(call => call.cookie === null), 'session cookies must not be sent');
      assert.ok(calls.every(call => !call.auth?.startsWith('Basic ')), 'cached HTTP credentials must not be sent');
      if (!token) assert.ok(calls.every(call => call.auth === null));
      else assert.ok(calls.some(call => call.auth === `Bearer ${token}`));
      if (token === 'expired-fixture') assert.equal(calls.filter(call => call.host === 'api.github.com' && !call.auth).length, 2);
      assert.ok(!(await readFile(join(directory, 'updates/settings.json'), 'utf8')).includes('valid-fixture'));
    }
    const downloads = await readdir(join(directory, 'updates'), { withFileTypes: true });
    for (const folder of downloads.filter(entry => entry.isDirectory())) {
      const files = await readdir(join(directory, 'updates', folder.name));
      for (const file of files) assert.deepEqual(await readFile(join(directory, 'updates', folder.name, file)), bytes);
    }
    assert.ok(tunnels.includes('api.github.com:443')); assert.ok(tunnels.includes('release-assets.githubusercontent.com:443'));
    rejectTunnel = true;
    await app.evaluate(({ session }) => session.defaultSession.closeAllConnections());
    await page.evaluate(() => window.studio.updates.configure({ repository: 'fixture/public', automatic: false, token: '' }));
    const blocked = await page.evaluate(() => window.studio.updates.check());
    assert.equal(blocked.phase, 'error'); assert.match(blocked.error, /ERR_TUNNEL_CONNECTION_FAILED/);
    assert.ok(!blocked.error.includes('signature='));
    await writeFile(join(artifacts, 'update-network-results.json'), JSON.stringify({ passed: true, platform: process.platform, checks: ['HTTPS CONNECT proxy', 'untrusted TLS rejected', 'public tokenless check and download', 'private token encrypted', 'expired token public fallback', 'CDN has no credentials', 'streamed size and SHA256', 'proxy failure diagnostic'], testedAt: new Date().toISOString() }, null, 2));
    console.log('PASS: real Electron updater, HTTPS proxy, TLS verification, public/private access, redirects and diagnostics');
  } finally {
    await app.evaluate(async ({ session }) => {
      session.defaultSession.setCertificateVerifyProc(null);
      await session.defaultSession.clearAuthCache();
      await session.defaultSession.setProxy({ mode: 'system' });
      await session.defaultSession.closeAllConnections();
    });
    for (const socket of sockets) socket.destroy();
    await Promise.all([tls, proxy].map(server => new Promise(resolve => server.close(resolve))));
  }
}
