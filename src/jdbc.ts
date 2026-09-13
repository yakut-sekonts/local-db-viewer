import type { DatabaseEngine } from './shared';
export interface JdbcSettings {
  driverId?: string;
  productId?: string;
  driverVersion?: string;
  url?: string;
  driverClass?: string;
  properties?: Record<string, string>;
  vmOptions?: string[];
  environment?: Record<string, string>;
  workingDirectory?: string;
  classpath?: string[];
  options?: {
    readOnly?: boolean;
    autoCommit?: boolean;
    isolation?: 'default' | 'read-uncommitted' | 'read-committed' | 'repeatable-read' | 'serializable';
    connectTimeoutSeconds?: number;
    queryTimeoutSeconds?: number;
    startupStatements?: string[];
  };
}
export interface JdbcProperty { name: string; description?: string; value?: string; required: boolean; choices?: string[] }
export const DRIVER_CLASSES: Record<DatabaseEngine, string> = {
  jdbc: '',
  trino: 'io.trino.jdbc.TrinoDriver', postgres: 'org.postgresql.Driver', mysql: 'com.mysql.cj.jdbc.Driver',
  mariadb: 'org.mariadb.jdbc.Driver', sqlite: 'org.sqlite.JDBC', mssql: 'com.microsoft.sqlserver.jdbc.SQLServerDriver', clickhouse: 'com.clickhouse.jdbc.ClickHouseDriver',
};
export const secretProperty = (name: string): boolean => /password|token|secret|credential|passphrase/i.test(name);
