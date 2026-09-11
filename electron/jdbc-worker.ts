import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { jdbcConfig } from './jdbc-config';
import type { Connection } from './trino';
import type { JdbcProperty } from '../src/jdbc';

export class JdbcWorker extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private output = '';
  private closed = false;
  constructor(profile: Connection) {
    super();
    const resources = process.resourcesPath;
    const packaged = resources && existsSync(join(resources, 'jdbc'));
    const root = packaged ? resources : join(__dirname, '../runtime');
    const java = packaged ? join(root, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java')
      : join(root, process.platform === 'win32' ? 'windows-x64' : 'mac-arm64', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const common = join(root, packaged ? 'jdbc' : 'common');
    if (!existsSync(java) || !existsSync(join(common, 'local-db-viewer-bridge.jar'))) throw new Error('Встроенный JDBC runtime не найден. Выполните подготовку runtime и сборку приложения.');
    const classpath = [join(common, '*'), ...(profile.jdbc?.classpath ?? [])].join(delimiter);
    this.child = spawn(java, ['-Xmx512m', '-Dfile.encoding=UTF-8', '--enable-native-access=ALL-UNNAMED', ...(profile.jdbc?.vmOptions ?? []), '-cp', classpath, 'LocalDBViewerBridge'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: profile.jdbc?.workingDirectory || undefined,
      env: { ...process.env, ...(profile.jdbc?.environment ?? {}) },
    });
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', data => {
      this.output += decoder.write(data);
      if (this.output.length > 24 * 1024 * 1024) { this.emit('error', new Error('Ответ JDBC превышает 24 MB.')); void this.terminate(); return; }
      for (;;) {
        const newline = this.output.indexOf('\n'); if (newline < 0) break;
        const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1);
        try { this.emit('message', JSON.parse(line)); }
        catch { this.emit('error', new Error('Некорректный ответ JDBC bridge.')); void this.terminate(); }
      }
    });
    // Third-party driver logging can contain credentials or SQL. Drain stderr but
    // report only the sanitized exception sent through the bridge protocol.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => { if (!this.closed) this.emit('error', error); });
    this.child.on('error', error => this.emit('error', error));
    this.child.on('exit', code => { this.closed = true; this.emit('exit', code); });
    this.postMessage({ ...jdbcConfig(profile), engine: profile.engine, sslCa: profile.sslCa ?? '' });
  }
  postMessage(value: unknown): void {
    if (this.closed) throw new Error('JDBC-сессия закрыта.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  async terminate(): Promise<number> {
    if (this.closed) return this.child.exitCode ?? 0;
    this.closed = true;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000); timer.unref();
      this.child.once('exit', code => { clearTimeout(timer); resolve(code ?? 0); });
      this.child.kill();
    });
  }
}

export async function describeDriver(profile: Connection): Promise<JdbcProperty[]> {
  const worker = new JdbcWorker(profile);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('JDBC-драйвер не вернул свойства за 20 секунд.')), 20000);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('exit', () => { clearTimeout(timer); reject(new Error('JDBC bridge завершился до чтения свойств.')); });
      worker.on('message', message => {
        if (message.kind !== 'properties') return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error)); else resolve(message.properties);
      });
      worker.postMessage({ kind: 'properties' });
    });
  } finally { await worker.terminate(); }
}
