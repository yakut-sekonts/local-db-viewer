import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { jdbcConfig } from './jdbc-config';
import type { Connection } from './trino';
import type { JdbcProperty } from '../src/jdbc';
import { runtimePaths, bundledDrivers } from './runtime-paths';
import { profileDriver } from '../src/drivers';
import { openSshTunnel, type SshTunnel } from './ssh';
import { sshProperties } from './ssh-jdbc';
import { beforeConnect, startupTimeout } from './before-connect';

export class JdbcWorker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private controller = new AbortController();
  private tunnel?: SshTunnel;
  private queued: unknown[] = [];
  private initialization: Promise<void>;
  private certificateDirectory?: string;
  private cleanup?: Promise<void>;
  private output = '';
  private closed = false;
  constructor(profile: Connection, inspectionOnly = false) {
    super();
    this.initialization = this.initialize(profile, inspectionOnly).catch(error => { if (!this.closed) this.emit('error', error); void this.terminate(); });
  }
  private async initialize(profile: Connection, inspectionOnly: boolean): Promise<void> {
    // Initialization is asynchronous so consumers can attach error listeners first.
    await Promise.resolve();
    const { java, common } = runtimePaths();
    if (!existsSync(java) || !existsSync(join(common, 'local-db-viewer-bridge.jar'))) throw new Error('Встроенный JDBC runtime не найден. Выполните подготовку runtime и сборку приложения.');
    const bridge = join(common, 'local-db-viewer-bridge.jar');
    const driverClasspath = [...(profile.driverClasspath ?? [...(profile.jdbc?.classpath ?? []), ...(bundledDrivers(common)[profileDriver(profile)]?.paths ?? [])]), bridge];
    const config = jdbcConfig(profile);
    if (!inspectionOnly) {
      await beforeConnect(profile.jdbc, this.controller.signal);
      if (profile.jdbc?.ssh?.enabled) {
        // Reject unsupported/conflicting configurations before opening a tunnel.
        sshProperties(profile, config.url, config.properties, 1);
        this.tunnel = await openSshTunnel(profile.jdbc.ssh, this.controller.signal, error => { if (!this.closed) this.emit('error', error); void this.terminate(); });
        config.properties = sshProperties(profile, config.url, config.properties, this.tunnel.port);
      }
    }
    if (this.closed) { this.tunnel?.close(); return; }
    this.certificateDirectory = await mkdtemp(join(tmpdir(), 'local-db-viewer-jdbc-'));
    if (this.closed) { await this.cleanFiles(); return; }
    const classpath = [join(common, 'local-db-viewer-bridge.jar'), ...readdirSync(common).filter(name => /^gson-.*\.jar$/.test(name)).map(name => join(common, name))].join(delimiter);
    this.child = spawn(java, ['-Xmx512m', '-Dfile.encoding=UTF-8', '--enable-native-access=ALL-UNNAMED', ...(profile.jdbc?.vmOptions ?? []), ...(this.tunnel ? [`-Dlocaldbviewer.ssh.port=${this.tunnel.port}`] : []), '-cp', classpath, 'LocalDBViewerBridge'], {
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
    this.child.on('exit', code => { this.closed = true; this.controller.abort(); this.tunnel?.close(); void this.cleanFiles(); this.emit('exit', code); });
    this.postMessage({ ...config, engine: profile.engine, driverId: profileDriver(profile), certificateDirectory: this.certificateDirectory, certificates: profile.jdbc?.certificates ?? {}, sslCa: profile.sslCa ?? '', driverClasspath });
    for (const message of this.queued.splice(0)) this.postMessage(message);
  }
  postMessage(value: unknown): void {
    if (this.closed) throw new Error('JDBC-сессия закрыта.');
    if (this.child) this.child.stdin.write(`${JSON.stringify(value)}\n`);
    else this.queued.push(value);
  }
  async terminate(): Promise<number> {
    if (this.closed) { await this.cleanFiles(); return this.child?.exitCode ?? 0; }
    this.closed = true;
    this.controller.abort(); this.tunnel?.close(); this.queued = [];
    const child = this.child;
    if (!child) { await this.initialization; await this.cleanFiles(); this.emit('exit', 0); return 0; }
    return new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
      child.once('exit', code => { clearTimeout(timer); void this.cleanFiles().then(() => resolve(code ?? 0)); });
      child.kill();
    });
  }
  private cleanFiles(): Promise<void> {
    if (!this.certificateDirectory) return Promise.resolve();
    this.cleanup ??= rm(this.certificateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    return this.cleanup;
  }
}

export async function inspectJdbc<T>(profile: Connection, request: { kind: string; [key: string]: unknown }, timeout = 60000): Promise<T> {
  const worker = new JdbcWorker(profile, ['properties', 'probe'].includes(request.kind));
  if (!['properties', 'probe'].includes(request.kind)) timeout += startupTimeout(profile.jdbc);
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
