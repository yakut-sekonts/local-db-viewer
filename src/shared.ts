export type AuthMode = 'none' | 'basic' | 'bearer';
export type SSLVerification = 'FULL' | 'CA' | 'NONE';
export type DatabaseEngine = 'trino' | 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'clickhouse' | 'jdbc';
export const ENGINES: Record<DatabaseEngine, { name: string; endpoint: string; user: string }> = {
  jdbc: { name: 'JDBC', endpoint: 'jdbc:', user: '' },
  trino: { name: 'Trino', endpoint: 'http://localhost:8080', user: '' },
  postgres: { name: 'PostgreSQL', endpoint: 'postgresql://localhost:5432/postgres', user: 'postgres' },
  mysql: { name: 'MySQL', endpoint: 'mysql://localhost:3306', user: 'root' },
  mariadb: { name: 'MariaDB', endpoint: 'mysql://localhost:3306', user: 'root' },
  sqlite: { name: 'SQLite', endpoint: '', user: '' },
  mssql: { name: 'Microsoft SQL Server', endpoint: 'mssql://localhost:1433/master', user: '' },
  clickhouse: { name: 'ClickHouse', endpoint: 'http://localhost:8123', user: 'default' },
};
export interface Profile {
  id: string;
  name: string;
  endpoint: string;
  user: string;
  auth: AuthMode;
  engine: DatabaseEngine;
  tls: boolean;
  sslVerification?: SSLVerification;
  sslCa?: string;
  jdbc?: import('./jdbc').JdbcSettings;
  jdbcSecrets?: string[];
  jdbcEnvironmentNames?: string[];
  catalog: string;
  schema: string;
  hasSecret: boolean;
}
export type ProfileDraft = Omit<Profile, 'id' | 'hasSecret'> & { id?: string; secret?: string };
export type Cell = unknown;
export interface Column { name: string; type: string }
export interface QueryStats {
  state?: string;
  elapsedTimeMillis?: number;
  processedRows?: number;
  processedBytes?: number;
  queued?: boolean;
}
export interface QuerySnapshot {
  script?: { index: number; total: number; completed: number; line: number; preview: string; state: QuerySnapshot['state']; elapsedTimeMillis: number; dataLimited?: boolean };
  requestId: string;
  queryId: string;
  state: 'RUNNING' | 'FINISHED' | 'FAILED' | 'CANCELED';
  columns: Column[];
  rows: Cell[][];
  totalRows: number;
  truncated: boolean;
  stats: QueryStats;
  error?: string;
  errorLocation?: { lineNumber: number; columnNumber: number };
  updateType?: string;
  updateCount?: number | string;
  warnings: string[];
  catalog?: string;
  schema?: string;
  inTransaction: boolean;
  searchPath?: string;
  contextApplied?: boolean;
}
export interface QueryInput {
  mode?: 'statement' | 'script';
  applyContext?: boolean;
  searchPath?: string;
  ddlMappingId?: string;
  templateId?: string;
  requestId: string;
  sessionId: string;
  profileId: string;
  sql: string;
  catalog: string;
  schema: string;
  maxRows: number;
}
export function executionState(result?: QuerySnapshot): QuerySnapshot['state'] | undefined { return result?.script?.state ?? result?.state; }
export interface MetadataInput {
  profileId: string;
  kind: 'catalogs' | 'schemas' | 'tables' | 'columns';
  catalog?: string;
  schema?: string;
  table?: string;
}
export interface MetadataResult { columns: Column[]; rows: Cell[][]; truncated: boolean }
export interface TableRef { catalog: string; schema: string; name: string }
export interface TableMeta extends TableRef { columns: Column[]; metadataSource?: 'bundled' }
export interface Relationship {
  id: string;
  name: string;
  source: TableRef;
  target: TableRef;
  columns: { source: string; target: string }[];
  kind: 'foreign-key' | 'virtual';
}
export interface SchemaInput { profileId: string; catalog: string; schema: string }
export interface JdbcDialect { quote: string; catalogs: boolean; schemas: boolean; catalogAtStart: boolean; catalogSeparator: string; unquotedCase: 'lower' | 'upper' | 'preserve'; fullOuterJoins: boolean }
export interface SchemaIndex extends SchemaInput { dialect?: JdbcDialect; tables: TableMeta[]; relationships: Relationship[]; warnings: string[] }
export interface DesktopAPI {
  sources: import('./sources').SourcesAPI;
  ddl: import('./ddl').DdlAPI;
  jdbc: { properties(profile: ProfileDraft): Promise<import('./jdbc').JdbcProperty[]>; preview(input: MetadataInput): Promise<string>; browse(profile: ProfileDraft, input: Omit<MetadataInput, 'profileId'>): Promise<MetadataResult> };
  ssh: { fingerprint(host: string, port: number): Promise<string> };
  drivers: import('./drivers').DriversAPI;
  updates: import('./updates').UpdateAPI;
  profiles: {
    list(): Promise<Profile[]>;
    save(profile: ProfileDraft): Promise<Profile>;
    remove(id: string): Promise<void>;
    test(profile: ProfileDraft): Promise<string>;
  };
  query: {
    run(input: QueryInput): Promise<void>;
    cancel(requestId: string): Promise<void>;
    release(sessionId: string, requireNoTransaction?: boolean): Promise<void>;
    onUpdate(listener: (value: QuerySnapshot) => void): () => void;
  };
  metadata(input: MetadataInput): Promise<MetadataResult>;
  schema: {
    load(input: SchemaInput): Promise<SchemaIndex>;
    saveRelation(profileId: string, relation: Relationship): Promise<void>;
    removeRelation(profileId: string, id: string): Promise<void>;
  };
  exportCSV(input: { columns: Column[]; rows: Cell[][] }): Promise<boolean>;
  files: { path(kind: 'certificate' | 'key' | 'store' | 'ddl' | 'executable'): Promise<string | null>; open(): Promise<{ name: string; sql: string } | null>; save(sql: string): Promise<boolean>; database(): Promise<string | null>; certificate(): Promise<{ name: string; pem: string } | null> };
}
declare global { interface Window { studio: DesktopAPI } }
