import type { DatabaseEngine } from './shared';
export interface JdbcSettings {
  sessionTemplates?: SessionTemplate[];
  defaultSessionTemplate?: string;
  introspectionSessionTemplate?: string;
  ssh?: SshSettings;
  certificates?: CertificateSettings;
  schemas?: SchemaSettings;
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
    singleSession?: boolean;
    keepAliveSeconds?: number;
    keepAliveQuery?: string;
    autoDisconnectSeconds?: number;
    autoSync?: boolean;
    introspectionMinutes?: number;
    trackSchemaChanges?: boolean;
    loadSystemSchemas?: boolean;
    switchSchema?: 'automatic' | 'manual' | 'disabled';
    loadSources?: 'all' | 'user' | 'none';
    preIntrospectedObjects?: boolean;
    codeStyle?: { keywordCase: 'upper' | 'lower' | 'preserve'; indentSize: number; useTabs: boolean };
    beforeConnect?: BeforeConnectTask[];
  };
}
export interface SessionTemplate {
  id: string;
  name: string;
  authentication?: { user: string; auth: import('./shared').AuthMode; secret?: string; hasSecret?: boolean };
  driverVersion?: string;
  driverClass?: string;
  classpath?: string[];
  options?: Pick<NonNullable<JdbcSettings['options']>, 'readOnly' | 'autoCommit' | 'isolation' | 'startupStatements' | 'queryTimeoutSeconds'>;
}
export interface SshSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authentication: 'password' | 'key' | 'agent';
  privateKeyPath?: string;
  password?: string;
  passphrase?: string;
  hasPassword?: boolean;
  hasPassphrase?: boolean;
  fingerprint: string;
  localPort?: number;
  connectTimeoutSeconds?: number;
}
export interface CertificateSettings {
  trustSource?: 'driver' | 'java' | 'system' | 'file';
  trustStorePath?: string;
  trustStoreType?: 'JKS' | 'PKCS12' | 'PEM';
  trustStorePassword?: string;
  clientMode?: 'none' | 'pem' | 'store' | 'system';
  clientCertificatePath?: string;
  clientKeyPath?: string;
  clientKeyPassword?: string;
  clientStorePath?: string;
  clientStoreType?: 'JKS' | 'PKCS12';
  clientStorePassword?: string;
  savedSecrets?: string[];
}
export interface SchemaSettings {
  mode: 'all' | 'selected';
  selected: { catalog: string; schema: string }[];
  includePattern?: string;
  excludePattern?: string;
  objectInclude?: string;
  objectExclude?: string;
}
export interface BeforeConnectTask { id: string; name: string; executable: string; args: string[]; timeoutSeconds: number; enabled: boolean }
export interface JdbcProperty { name: string; description?: string; value?: string; required: boolean; choices?: string[] }
export const DRIVER_CLASSES: Record<DatabaseEngine, string> = {
  jdbc: '',
  trino: 'io.trino.jdbc.TrinoDriver', postgres: 'org.postgresql.Driver', mysql: 'com.mysql.cj.jdbc.Driver',
  mariadb: 'org.mariadb.jdbc.Driver', sqlite: 'org.sqlite.JDBC', mssql: 'com.microsoft.sqlserver.jdbc.SQLServerDriver', clickhouse: 'com.clickhouse.jdbc.ClickHouseDriver',
};
export const secretProperty = (name: string): boolean => /password|token|secret|credential|passphrase/i.test(name);
