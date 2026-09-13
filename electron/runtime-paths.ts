import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DriverInstallation } from '../src/drivers';
import { DRIVERS } from '../src/drivers';

export function runtimePaths() {
  const resources = process.resourcesPath;
  const packaged = resources && existsSync(join(resources, 'jdbc'));
  const root = packaged ? resources : resolve(__dirname, '../runtime');
  const common = join(root, packaged ? 'jdbc' : 'common');
  const java = packaged ? join(root, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : join(root, process.platform === 'win32' ? 'windows-x64' : 'mac-arm64', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return { common, java };
}
export function bundledDrivers(common = runtimePaths().common): Record<string, DriverInstallation> {
  const lock: { jars: { name: string; version: string; sha256: string }[] } = JSON.parse(readFileSync(join(common, 'runtime-lock.json'), 'utf8'));
  const shared = lock.jars.filter(file => /^(gson|slf4j-)/.test(file.name));
  const result: Record<string, DriverInstallation> = {};
  for (const driver of DRIVERS) {
    if (!['trino', 'postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'clickhouse'].includes(driver.id)) continue;
    const file = lock.jars.find(file => file.name.startsWith(driver.maven!.artifact + '-'));
    if (!file) continue;
    result[driver.id] = { key: 'bundled', version: file.version, files: [], source: 'bundled', paths: [file, ...shared].map(file => join(common, file.name)) };
  }
  return result;
}
