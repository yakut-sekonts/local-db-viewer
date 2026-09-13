import { Client } from 'ssh2';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import type { SshSettings } from '../src/jdbc';

const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
export async function sshFingerprint(host: string, port: number): Promise<string> {
  if (!host || host.length > 512 || /[\s\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Укажите SSH host и port.');
  const client = new Client();
  return new Promise((resolve, reject) => {
    let result = '';
    client.on('error', error => { client.destroy(); if (result) resolve(result); else reject(error); });
    client.on('close', () => { if (result) resolve(result); else reject(new Error('SSH сервер закрыл соединение.')); });
    client.connect({ host, port, username: 'fingerprint-inspection', readyTimeout: 15000,
      hostVerifier: (key: Buffer) => { result = fingerprint(key); return false; },
    });
  });
}

class Handshake {
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private failure?: Error;
  constructor(private socket: Socket) { socket.on('data', this.data); socket.on('error', this.error); socket.on('end', this.end); socket.on('close', this.end); }
  private data = (data: Buffer) => { this.buffer = Buffer.concat([this.buffer, data]); if (this.buffer.length > 256 * 1024) this.error(new Error('SSH proxy handshake too large.')); this.wake?.(); };
  private error = (error: Error) => { this.failure = error; this.wake?.(); };
  private end = () => this.error(new Error('SSH proxy disconnected.'));
  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) { if (this.failure) throw this.failure; await new Promise<void>(resolve => { this.wake = resolve; }); }
    if (this.failure) throw this.failure;
    const result = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return result;
  }
  async header(first: Buffer): Promise<Buffer> {
    const bytes = [first]; let tail = first.toString('latin1');
    while (!tail.endsWith('\r\n\r\n')) { if (bytes.length >= 16384) throw new Error('SSH proxy HTTP header too large.'); const byte = await this.read(1); bytes.push(byte); tail = (tail + byte.toString('latin1')).slice(-4); }
    return Buffer.concat(bytes);
  }
  release(): void { this.socket.pause(); this.socket.off('data', this.data); this.socket.off('error', this.error); this.socket.off('end', this.end); this.socket.off('close', this.end); if (this.buffer.length) this.socket.unshift(this.buffer); this.buffer = Buffer.alloc(0); }
}

export interface SshTunnel { port: number; close(): void }
export async function openSshTunnel(settings: SshSettings, signal: AbortSignal, onFailure: (error: Error) => void): Promise<SshTunnel> {
  if (signal.aborted) throw new Error('SSH connection cancelled.');
  let privateKey: Buffer | undefined;
  if (settings.authentication === 'key') {
    const file = await open(settings.privateKeyPath!, 'r');
    try { if ((await file.stat()).size > 512 * 1024) throw new Error('SSH private key превышает 512 KB.'); privateKey = await file.readFile(); } finally { await file.close(); }
  }
  if (signal.aborted) throw new Error('SSH connection cancelled.');
  const client = new Client(), sockets = new Set<Duplex>();
  let server: Server | undefined, closed = false, ready = false;
  const close = () => { if (closed) return; closed = true; signal.removeEventListener('abort', close); for (const socket of sockets) socket.destroy(); server?.close(); client.destroy(); };
  signal.addEventListener('abort', close, { once: true });
  const channel = (host: string, port: number) => new Promise<Duplex>((resolve, reject) => {
    if (closed || !host || !port || port > 65535) { reject(new Error('Invalid SSH destination.')); return; }
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (error) { reject(error); return; }
      if (closed) { stream.destroy(); reject(new Error('SSH connection closed.')); return; }
      sockets.add(stream); stream.once('close', () => sockets.delete(stream)); resolve(stream);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client.on('error', error => { if (!ready) reject(error); else if (!closed) onFailure(new Error(`SSH: ${error.message}`)); close(); });
      client.on('close', () => { if (!ready) reject(new Error('SSH connection closed.')); else if (!closed) onFailure(new Error('SSH tunnel disconnected.')); close(); });
      client.once('ready', () => { ready = true; resolve(); });
      client.connect({ host: settings.host, port: settings.port, username: settings.user,
        password: settings.authentication === 'password' ? settings.password : undefined,
        privateKey, passphrase: settings.passphrase,
        agent: settings.authentication === 'agent' ? (process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK) : undefined,
        readyTimeout: (settings.connectTimeoutSeconds ?? 15) * 1000, keepaliveInterval: 20000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => fingerprint(key) === settings.fingerprint.replace(/=+$/, ''),
      });
    });
    if (closed) throw new Error('SSH connection cancelled.');
    server = createServer(socket => {
      if (sockets.size >= 128 || closed) { socket.destroy(); return; }
      sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
      const timer = setTimeout(() => socket.destroy(new Error('SSH proxy handshake timeout.')), 15000); timer.unref();
      const reader = new Handshake(socket);
      void (async () => {
        const first = await reader.read(1); let host: string, port: number, httpRequest: Buffer | undefined, connected: Buffer;
        if (first[0] === 5) {
          const count = (await reader.read(1))[0]!;
          if (!(await reader.read(count)).includes(0)) throw new Error('SOCKS authentication method unsupported.');
          socket.write(Buffer.from([5, 0]));
          const request = await reader.read(4);
          if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) throw new Error('SOCKS CONNECT required.');
          if (request[3] === 3) host = (await reader.read((await reader.read(1))[0]!)).toString('utf8');
          else if (request[3] === 1) host = [...await reader.read(4)].join('.');
          else if (request[3] === 4) { const bytes = await reader.read(16); host = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':'); }
          else throw new Error('SOCKS address unsupported.');
          port = (await reader.read(2)).readUInt16BE(); connected = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
        } else {
          const header = (await reader.header(first)).toString('latin1'), lines = header.split('\r\n');
          const [method, target, version] = (lines.shift() ?? '').split(' ');
          if (!method || !target || version !== 'HTTP/1.1' && version !== 'HTTP/1.0') throw new Error('Invalid HTTP proxy request.');
          const url = new URL(method === 'CONNECT' ? `https://${target}` : target);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid HTTP proxy target.');
          host = url.hostname.replace(/^\[|\]$/g, ''); port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
          if (method === 'CONNECT') connected = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
          else {
            if (url.protocol !== 'http:') throw new Error('HTTPS requires CONNECT.');
            httpRequest = Buffer.from([`${method} ${url.pathname}${url.search} ${version}`, ...lines.filter(line => line && !/^(?:proxy-|connection:|host:)/i.test(line)), `Host: ${url.host}`, 'Connection: close', '', ''].join('\r\n'), 'latin1');
            connected = Buffer.alloc(0);
          }
        }
        const stream = await channel(host, port);
        stream.on('error', () => socket.destroy()); socket.once('close', () => stream.destroy()); stream.once('close', () => socket.destroy());
        clearTimeout(timer); reader.release(); if (connected.length) socket.write(connected); if (httpRequest) stream.write(httpRequest);
        socket.pipe(stream).pipe(socket); socket.resume();
      })().catch(() => { clearTimeout(timer); reader.release(); socket.destroy(); });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(settings.localPort ?? 0, '127.0.0.1', resolve); });
    if (closed) throw new Error('SSH connection cancelled.');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('SSH proxy unavailable.');
    return { port: address.port, close };
  } catch (error) { close(); throw error; }
}
