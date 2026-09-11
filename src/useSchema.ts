import { useEffect, useRef, useState } from 'react';
import type { Profile, SchemaIndex } from './shared';
import { requestedSchemas, tableKey } from './completion';

export function useSchema(profile: Profile | undefined, catalog: string, schema: string, revision: number) {
  const [index, setIndex] = useState<SchemaIndex>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, { time: number; promise: Promise<SchemaIndex> }>());
  const generation = useRef(0);
  useEffect(() => { cache.current.clear(); }, [profile, revision]);
  function load(catalog: string, schema: string): Promise<SchemaIndex> {
    if (!profile) return Promise.reject(new Error('Выберите подключение.'));
    const key = JSON.stringify([profile.id, catalog, schema]);
    const cached = cache.current.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.promise;
    if (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value!);
    const promise = window.studio.schema.load({ profileId: profile.id, catalog, schema });
    cache.current.set(key, { time: Date.now(), promise });
    // Retain failures briefly to avoid repeatedly querying an unavailable server while typing.
    void promise.catch(() => { if (cache.current.get(key)?.promise === promise) cache.current.set(key, { time: Date.now() - 285000, promise }); });
    return promise;
  }
  useEffect(() => {
    const current = ++generation.current;
    setIndex(undefined); setStatus(''); setBusy(Boolean(profile));
    if (!profile) return;
    const timer = setTimeout(() => {
      void load(catalog, schema).then(value => {
        if (generation.current !== current) return;
        setIndex(value); setStatus(value.warnings.join('\n'));
      }).catch(error => { if (generation.current === current) setStatus(error.message); }).finally(() => { if (generation.current === current) setBusy(false); });
    }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [profile, catalog, schema, revision]);

  async function forQuery(sql: string, offset: number): Promise<SchemaIndex | undefined> {
    if (!profile) return;
    const current = generation.current;
    try {
      const base = await load(catalog, schema);
      const needed = requestedSchemas(sql, offset, base, profile.engine);
      const extra = await Promise.allSettled(needed.map(context => load(context.catalog, context.schema)));
      if (current !== generation.current) return;
      const success = extra.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const warnings = [...base.warnings, ...success.flatMap(item => item.warnings), ...extra.flatMap(result => result.status === 'rejected' ? [String(result.reason?.message ?? result.reason)] : [])];
      setStatus([...new Set(warnings)].join('\n'));
      return { ...base,
        tables: [...new Map([base, ...success].flatMap(item => item.tables).map(table => [tableKey(table), table])).values()],
        relationships: [...new Map([base, ...success].flatMap(item => item.relationships).map(relation => [relation.id, relation])).values()], warnings,
      };
    } catch (error) { if (current === generation.current) setStatus((error as Error).message); return; }
  }
  return { index, status, busy, forQuery };
}
