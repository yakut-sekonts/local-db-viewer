import type { Column, Profile, SchemaIndex, TableMeta } from './shared';
import { sqlEngine, profileDriver } from './drivers';
import { patternAllows } from './schemaSettings';
import { tableKey } from './completion';

// A deliberately small reference set, not a claim about the connected server version or permissions.
// Trino 483: InformationSchemaTable.java. PostgreSQL 14–18: pg_namespace/pg_class catalogs.
// Other fields follow the vendor INFORMATION_SCHEMA, system.columns and sqlite_schema references.
const columns = (names: string, type: string): Column[] => names.split(' ').map(name => ({ name, type }));
export function withSystemCatalogs(index: SchemaIndex, profile: Profile): SchemaIndex {
  if (profile.jdbc?.options?.preIntrospectedObjects === false || profileDriver(profile) === 'redshift') return index;
  const engine = sqlEngine(profile), tables: TableMeta[] = [];
  const add = (catalog: string, schema: string, name: string, values: Column[]) => tables.push({ catalog, schema, name, columns: values, metadataSource: 'bundled' });
  const catalog = index.catalog || profile.catalog;
  if (engine === 'trino' && catalog) {
    const text = (names: string) => columns(names, 'varchar');
    add(catalog, 'information_schema', 'tables', text('table_catalog table_schema table_name table_type table_comment'));
    add(catalog, 'information_schema', 'columns', [...text('table_catalog table_schema table_name column_name'), { name: 'ordinal_position', type: 'bigint' }, ...text('column_default is_nullable data_type comment extra_info column_comment')]);
    add(catalog, 'information_schema', 'views', text('table_catalog table_schema table_name view_definition'));
    add(catalog, 'information_schema', 'schemata', text('catalog_name schema_name'));
    add(catalog, 'information_schema', 'table_privileges', text('grantor grantor_type grantee grantee_type table_catalog table_schema table_name privilege_type is_grantable with_hierarchy'));
    add(catalog, 'information_schema', 'roles', text('role_name'));
    add(catalog, 'information_schema', 'applicable_roles', text('grantee grantee_type role_name is_grantable'));
    add(catalog, 'information_schema', 'enabled_roles', text('role_name'));
  } else if (engine === 'postgres' && catalog) {
    add(catalog, 'pg_catalog', 'pg_namespace', [...columns('oid nspowner', 'oid'), ...columns('nspname', 'name'), ...columns('nspacl', 'aclitem[]')]);
    add(catalog, 'pg_catalog', 'pg_class', [...columns('oid relnamespace reltype reloftype relowner relam relfilenode reltablespace', 'oid'), ...columns('relname', 'name'), ...columns('relkind relpersistence', '"char"'), ...columns('relnatts', 'smallint'), ...columns('relhasindex relisshared relhasrules relhastriggers relhassubclass relrowsecurity relforcerowsecurity relispopulated relispartition', 'boolean')]);
    add(catalog, 'information_schema', 'tables', columns('table_catalog table_schema table_name table_type self_referencing_column_name reference_generation user_defined_type_catalog user_defined_type_schema user_defined_type_name is_insertable_into is_typed commit_action', 'справочное поле'));
    add(catalog, 'information_schema', 'columns', columns('table_catalog table_schema table_name column_name ordinal_position column_default is_nullable data_type character_maximum_length character_octet_length numeric_precision numeric_precision_radix numeric_scale datetime_precision', 'справочное поле'));
  } else if (engine === 'mssql' && catalog) {
    add(catalog, 'INFORMATION_SCHEMA', 'TABLES', [...columns('TABLE_CATALOG TABLE_SCHEMA TABLE_NAME', 'nvarchar(128)'), ...columns('TABLE_TYPE', 'varchar(10)')]);
    add(catalog, 'INFORMATION_SCHEMA', 'COLUMNS', [...columns('TABLE_CATALOG TABLE_SCHEMA TABLE_NAME COLUMN_NAME DATA_TYPE', 'nvarchar(128)'), ...columns('ORDINAL_POSITION CHARACTER_MAXIMUM_LENGTH CHARACTER_OCTET_LENGTH NUMERIC_SCALE', 'int'), ...columns('COLUMN_DEFAULT', 'nvarchar(4000)'), ...columns('IS_NULLABLE', 'varchar(3)')]);
  } else if (engine === 'mysql' || engine === 'mariadb') {
    add('information_schema', 'information_schema', 'TABLES', columns('TABLE_CATALOG TABLE_SCHEMA TABLE_NAME TABLE_TYPE ENGINE VERSION ROW_FORMAT TABLE_ROWS AVG_ROW_LENGTH DATA_LENGTH INDEX_LENGTH AUTO_INCREMENT CREATE_TIME UPDATE_TIME TABLE_COLLATION TABLE_COMMENT', 'справочное поле'));
    add('information_schema', 'information_schema', 'COLUMNS', columns('TABLE_CATALOG TABLE_SCHEMA TABLE_NAME COLUMN_NAME ORDINAL_POSITION COLUMN_DEFAULT IS_NULLABLE DATA_TYPE CHARACTER_MAXIMUM_LENGTH CHARACTER_OCTET_LENGTH NUMERIC_PRECISION NUMERIC_SCALE DATETIME_PRECISION CHARACTER_SET_NAME COLLATION_NAME COLUMN_TYPE COLUMN_KEY EXTRA PRIVILEGES COLUMN_COMMENT', 'справочное поле'));
  } else if (engine === 'clickhouse') {
    add('system', 'system', 'columns', [...columns('database table name type default_kind default_expression comment', 'String'), ...columns('position', 'UInt64')]);
    add('system', 'system', 'tables', columns('database name engine create_table_query', 'String'));
  } else if (engine === 'sqlite') {
    add('main', 'main', 'sqlite_schema', [...columns('type name tbl_name', 'TEXT'), ...columns('rootpage', 'INTEGER'), ...columns('sql', 'TEXT')]);
  }
  const actual = new Set(index.tables.map(tableKey)), settings = profile.jdbc?.schemas;
  return { ...index, tables: [...index.tables, ...tables.filter(table => !actual.has(tableKey(table)) && patternAllows(`${table.catalog}.${table.schema}.${table.name}`, settings?.objectInclude, settings?.objectExclude))] };
}
