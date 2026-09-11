export interface UpdateSettings {
  repository: string;
  automatic: boolean;
  hasToken: boolean;
}
export interface UpdateState {
  currentVersion: string;
  phase: 'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  settings: UpdateSettings;
  version?: string;
  notes?: string;
  progress?: number;
  error?: string;
  checkedAt?: number;
}
export interface UpdateAPI {
  state(): Promise<UpdateState>;
  configure(input: { repository: string; automatic: boolean; token?: string }): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
  onChange(listener: (state: UpdateState) => void): () => void;
}
