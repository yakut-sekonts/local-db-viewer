// Supported release formats are X.Y.Z and X.Y.Z-beta.N (no build metadata).
export interface ReleaseVersion { major: number; minor: number; patch: number; beta?: number }
export function parseReleaseVersion(value: unknown): ReleaseVersion | undefined {
  if (typeof value !== 'string') return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  const beta = match[4] === undefined ? undefined : Number(match[4]);
  if (![major, minor, patch, ...(beta === undefined ? [] : [beta])].every(Number.isSafeInteger)) return;
  return { major, minor, patch, beta };
}
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  if (!a || !b) throw new Error('Некорректная версия релиза: ожидается X.Y.Z или X.Y.Z-beta.N.');
  for (const part of ['major', 'minor', 'patch'] as const) if (a[part] !== b[part]) return a[part] > b[part] ? 1 : -1;
  if (a.beta === b.beta) return 0;
  if (a.beta === undefined) return 1;
  if (b.beta === undefined) return -1;
  return a.beta > b.beta ? 1 : -1;
}
