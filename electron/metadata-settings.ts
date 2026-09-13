import type { Connection } from './trino';
import type { MetadataInput, MetadataResult } from '../src/shared';
import { isSystemSchema, schemaAllowed, objectAllowed } from '../src/schemaSettings';

export function filterMetadata(connection: Connection, input: Omit<MetadataInput, 'profileId'>, result: MetadataResult): MetadataResult {
  const settings = connection.jdbc?.schemas;
  return { ...result, rows: result.rows.filter(row => {
    const name = String(row[0] ?? '');
    if (input.kind === 'catalogs') return settings?.mode !== 'selected' || settings.selected.some(item => item.catalog === name);
    const catalog = input.catalog ?? '', schema = input.kind === 'schemas' ? name : input.schema ?? '';
    if (connection.jdbc?.options?.loadSystemSchemas === false && isSystemSchema(catalog, schema)) return false;
    if (!schemaAllowed(settings, catalog, schema)) return false;
    return input.kind !== 'tables' || objectAllowed(settings, { catalog, schema, name });
  }) };
}
