import type { SchemaInput, TableRef } from './shared';
export interface ObjectSource extends TableRef { id: string; kind: string; sql: string | null }
export interface SourceIndex extends SchemaInput { objects: ObjectSource[]; warnings: string[]; loadedAt: number; skipped?: boolean }
export interface SourcesAPI { load(input: SchemaInput & { refresh?: boolean; automatic?: boolean }): Promise<SourceIndex> }
