import definitions from '../drivers/definitions.json';
import products from '../drivers/products.json';
import type { DatabaseEngine, ProfileDraft } from './shared';

export interface DriverDefinition {
  id: string; name: string; className: string; url: string; documentation: string; note?: string;
  maven?: { group: string; artifact: string; classifier?: string; versionPattern?: string };
}
export interface DatabaseProduct { id: string; name: string; driverId: string; engine: DatabaseEngine; note?: string }
export const DRIVERS: DriverDefinition[] = definitions;
export const DATABASE_PRODUCTS = products as DatabaseProduct[];
export function driverDefinition(id: string): DriverDefinition {
  const driver = DRIVERS.find(driver => driver.id === id);
  if (!driver) throw new Error('Неизвестный JDBC-драйвер.');
  return driver;
}
export function profileDriver(profile: Pick<ProfileDraft, 'engine' | 'jdbc'>): string { return profile.jdbc?.driverId || (profile.engine === 'jdbc' ? 'custom' : profile.engine); }
export function productName(profile: Pick<ProfileDraft, 'engine' | 'jdbc'>): string {
  return DATABASE_PRODUCTS.find(product => product.id === (profile.jdbc?.productId || profile.engine))?.name || driverDefinition(profileDriver(profile)).name;
}
export interface DriverFile { path: string; size: number; sha256: string }
export interface DriverRelease { key: string; version: string; files: DriverFile[] }
export interface DriverCatalog { format: 1; drivers: Record<string, DriverRelease> }
export interface DriverInstallation extends DriverRelease { source: 'bundled' | 'download' | 'local'; paths: string[] }
export interface DriverStatus {
  id: string; selected?: string; installed: { key: string; version: string; source: DriverInstallation['source'] }[];
  latest?: string; available: boolean; phase?: 'downloading' | 'verifying'; progress?: number; error?: string;
}
export interface DriversState { drivers: DriverStatus[]; checking: boolean; automatic: boolean; checkedAt?: number; error?: string }
export interface DriversAPI {
  state(): Promise<DriversState>;
  check(): Promise<DriversState>;
  automatic(enabled: boolean): Promise<void>;
  install(id: string): Promise<void>;
  select(id: string, key: string): Promise<void>;
  import(id: string, version: string): Promise<boolean>;
  onChange(listener: (state: DriversState) => void): () => void;
}

export function compareDriverVersions(a: string, b: string): number {
  const numbers = (value: string) => value.match(/\d+/g)?.map(Number) ?? [];
  const left = numbers(a), right = numbers(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function sqlEngine(profile: Pick<ProfileDraft, 'engine' | 'jdbc'>): DatabaseEngine {
  if (profile.engine !== 'jdbc') return profile.engine;
  const id = profileDriver(profile);
  if (['trino', 'postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'clickhouse'].includes(id)) return id as DatabaseEngine;
  if (id === 'presto') return 'trino';
  if (id === 'redshift') return 'postgres';
  return 'jdbc';
}
