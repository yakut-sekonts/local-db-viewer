export type UpdateChannel = 'stable' | 'beta';
export interface UpdateTransfer {
  mode: 'full' | 'delta';
  downloadedBytes: number;
  reusedBytes: number;
  totalBytes: number;
  fallback?: boolean;
}
export interface UpdateSettings {
  repository: string;
  automatic: boolean;
  hasToken: boolean;
  channel: UpdateChannel;
}
export interface UpdateState {
  currentVersion: string;
  phase: 'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  settings: UpdateSettings;
  version?: string;
  notes?: string;
  progress?: number;
  transfer?: UpdateTransfer;
  error?: string;
  installationError?: string;
  checkedAt?: number;
}
export interface UpdateAPI {
  state(): Promise<UpdateState>;
  configure(input: { repository: string; automatic: boolean; channel?: UpdateChannel; token?: string }): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
  onChange(listener: (state: UpdateState) => void): () => void;
}
