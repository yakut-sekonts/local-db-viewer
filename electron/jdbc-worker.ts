import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { jdbcConfig } from './jdbc-config';
import type { Connection } from './trino';
import type { JdbcProperty } from '../src/jdbc';
import { runtimePaths, bundledDrivers } from './runtime-paths';
import { profileDriver } from '../src/drivers';

export class JdbcWorker extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private output = '';
  private closed = false;
  constructor(profile: Connection) {
    super();
    const { java, common } = runtimePaths();
    if (!existsSync(java) || !existsSync(join(common, 'local-db-viewer-bridge.jar'))) throw new Error('Встроенный JDBC runtime не найден. Выполните подготовку runtime и сборку приложения.');
    const driverClasspath = profile.driverClasspath ?? [...(profile.jdbc?.classpath ?? []), ...(bundledDrivers(common)[profileDriver(profile)]?.paths ?? [])];
    const classpath = [join(common, 'local-db-viewer-bridge.jar'), ...readdirSync(common).filter(name => /^gson-.*\.jar$/.test(name)).map(name => join(common, name))].join(delimiter);
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
    this.postMessage({ ...jdbcConfig(profile), engine: profile.engine, sslCa: profile.sslCa ?? '', driverClasspath });
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

export async function inspectJdbc<T>(profile: Connection, request: { kind: string; [key: string]: unknown }, timeout = 60000): Promise<T> {
  const worker = new JdbcWorker(profile);
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`JDBC-драйвер не ответил за ${timeout / 1000} секунд.`)), timeout);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('exit', () => { clearTimeout(timer); reject(new Error('JDBC bridge завершился до получения ответа.')); });
      worker.on('message', message => {
        if (message.kind !== request.kind) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error)); else resolve(request.kind === 'properties' ? message.properties : message.value);
      });
      worker.postMessage(request);
    });
  } finally {
    // Embedded engines own file locks and server lifetimes. Release the JDBC
    // connection before terminating its JVM; SIGTERM alone can leave stale locks.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); worker.off('message', message); worker.off('exit', finish); resolve(); };
      const message = (value: any) => { if (value.kind === 'closed') finish(); };
      const timer = setTimeout(finish, 3000);
      worker.on('message', message); worker.once('exit', finish);
      try { worker.postMessage({ kind: 'close' }); } catch { finish(); }
    });
    await worker.terminate();
  }
}
export function describeDriver(profile: Connection): Promise<JdbcProperty[]> { return inspectJdbc(profile, { kind: 'properties' }, 20000); }
