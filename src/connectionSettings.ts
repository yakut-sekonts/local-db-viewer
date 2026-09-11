import type { DatabaseEngine, ProfileDraft } from './shared';

export const usesHTTP = (engine: DatabaseEngine) => engine === 'trino' || engine === 'clickhouse';

/** The URL was authoritative for HTTP connections in 0.1.0; keep their transport unchanged. */
export function sslEnabled(profile: Pick<ProfileDraft, 'engine' | 'endpoint' | 'tls'>): boolean {
  if (profile.engine === 'sqlite') return false;
  return usesHTTP(profile.engine) ? /^https:\/\//i.test(profile.endpoint) : profile.tls;
}

export function toggleSSL(draft: ProfileDraft, enabled: boolean): ProfileDraft {
  const endpoint = usesHTTP(draft.engine)
    ? draft.endpoint.replace(/^https?:\/\//i, enabled ? 'https://' : 'http://')
    : draft.endpoint;
  return { ...draft, tls: enabled, endpoint };
}
