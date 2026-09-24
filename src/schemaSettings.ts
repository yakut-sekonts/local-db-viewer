import type { SchemaSettings } from './jdbc';
import type { SchemaIndex, TableRef } from './shared';

/** Glob matching without regex backtracking. Only * and ? have special meaning. */
export function globMatches(pattern: string, value: string): boolean {
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (pattern.charAt(p) === '?' || pattern.charAt(p) === value.charAt(v)) { p++; v++; }
    else if (pattern.charAt(p) === '*') { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern.charAt(p) === '*') p++;
  return p === pattern.length;
}
export function patternAllows(value: string, include = '', exclude = ''): boolean {
  const patterns = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
  const positive = patterns(include), negative = patterns(exclude);
  return (!positive.length || positive.some(pattern => globMatches(pattern, value))) && !negative.some(pattern => globMatches(pattern, value));
}
export function schemaAllowed(settings: SchemaSettings | undefined, catalog: string, schema: string): boolean {
  if (!settings) return true;
  if (settings.mode === 'selected' && !settings.selected.some(item => item.catalog === catalog && item.schema === schema)) return false;
  return patternAllows(`${catalog}.${schema}`, settings.includePattern, settings.excludePattern);
}
export function objectAllowed(settings: SchemaSettings | undefined, table: TableRef): boolean {
  return schemaAllowed(settings, table.catalog, table.schema) && patternAllows(`${table.catalog}.${table.schema}.${table.name}`, settings?.objectInclude, settings?.objectExclude);
}
export function filterSchema(index: SchemaIndex, settings?: SchemaSettings): SchemaIndex {
  const tables = index.tables.filter(table => objectAllowed(settings, table));
  return { ...index, tables, relationships: index.relationships.filter(relation => objectAllowed(settings, relation.source) && objectAllowed(settings, relation.target)) };
}
export function isSystemSchema(catalog: string, schema: string): boolean {
  return /^(information_schema|performance_schema|mysql|pg_catalog|pg_toast(?:_temp_\d+)?|pg_temp_\d+|sys|system)$/i.test(schema) || /^(information_schema|performance_schema|mysql|system)$/i.test(catalog);
}
