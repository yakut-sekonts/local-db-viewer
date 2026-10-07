export type NetworkMode = 'online' | 'database-only';
export interface NetworkState { mode: NetworkMode; error?: string }
export interface NetworkAPI {
  state(): Promise<NetworkState>;
  configure(mode: NetworkMode): Promise<NetworkState>;
  onChange(listener: (state: NetworkState) => void): () => void;
}
export const NETWORK_BLOCKED_CODE = 'ERR_LDV_EXTERNAL_NETWORK_DISABLED';
export const NETWORK_BLOCKED_MESSAGE = 'Внешние загрузки IDE запрещены сетевым режимом «Только БД». Измените режим в сетевых настройках.';
