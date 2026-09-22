import type { SchemaIndex } from './shared';
export interface DdlMapping { id: string; name: string; profileId: string; directory: string; catalog: string; schema: string }
export interface DdlFile { file: string; sql: string; hash: string }
export interface DdlDifference { file: string; local?: string; remote?: string; status: 'same' | 'new' | 'changed' | 'local-only' }
export interface DdlPreview { token: string; differences: DdlDifference[]; warnings: string[] }
export interface DdlAPI {
  list(): Promise<DdlMapping[]>;
  chooseDirectory(): Promise<string | null>;
  save(mapping: DdlMapping): Promise<DdlMapping>;
  remove(id: string): Promise<void>;
  files(id: string): Promise<DdlFile[]>;
  writeFile(id: string, file: string, sql: string, expectedHash: string): Promise<void>;
  preview(id: string): Promise<DdlPreview>;
  writePreview(token: string, files: string[]): Promise<void>;
  index(id: string): Promise<SchemaIndex>;
}
