import { format, type SqlLanguage } from 'sql-formatter';
import type { DatabaseEngine } from './shared';
import { defaultCodeStyle, type CodeStyle } from './codeStyle';

export function formatSQL(sql: string, engine: DatabaseEngine, style: CodeStyle = defaultCodeStyle, driverId?: string): string {
  if (sql.length > 128000) throw new Error('Форматирование ограничено 128 KB. Выделите меньший фрагмент SQL.');
  const dialects: Record<string, SqlLanguage> = { trino: 'trino', presto: 'trino', postgres: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', mssql: 'transactsql', clickhouse: 'clickhouse', sqlite: 'sqlite', oracle: 'plsql', duckdb: 'duckdb', redshift: 'redshift', snowflake: 'snowflake', bigquery: 'bigquery', hive: 'hive', spark: 'spark', db2: 'db2' };
  try {
    return format(sql, { language: dialects[engine === 'jdbc' ? driverId ?? '' : engine] ?? 'sql', keywordCase: style.keywordCase, tabWidth: style.indentSize, useTabs: style.useTabs, linesBetweenQueries: 1 });
  } catch {
    // Parser errors may echo SQL or credentials in literals. Keep them inside the worker.
    throw new Error('Этот SQL не поддерживается форматтером выбранного диалекта. Текст сохранён без изменений.');
  }
}
