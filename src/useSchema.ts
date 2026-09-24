import { useEffect, useRef, useState } from 'react';
import type { Profile, SchemaIndex } from './shared';
import { requestedSchemas, tableKey } from './completion';
import { withSystemCatalogs } from './systemCatalogs';

export function useSchema(profile: Profile | undefined, catalog: string, schema: string, revision: number, ddlMappingId?: string) {
  const [automaticRevision, setAutomaticRevision] = useState(0);
  const manualRevision = useRef(revision);
  const [index, setIndex] = useState<SchemaIndex>();
  const [status, setStatus] = useState('');
  const [sourceStatus, setSourceStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, { time: number; promise: Promise<SchemaIndex> }>());
  const generation = useRef(0);
  const sourceQueue = useRef(Promise.resolve());
  useEffect(() => { cache.current.clear(); }, [profile, revision, automaticRevision, ddlMappingId]);
  function load(catalog: string, schema: string): Promise<SchemaIndex> {
    if (!profile) return Promise.reject(new Error('Выберите подключение.'));
    const key = JSON.stringify([profile.id, catalog, schema]);
    const cached = cache.current.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.promise;
    if (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value!);
    const current = generation.current;
    const promise = window.studio.schema.load({ profileId: profile.id, catalog, schema }).then(index => {
      // Warm source text sequentially without delaying SQL completion or sharing console transactions.
      sourceQueue.current = sourceQueue.current.then(async () => {
        if (generation.current !== current) return;
        try { await window.studio.sources.load({ profileId: profile.id, catalog: index.catalog, schema: index.schema, automatic: true }); }
        catch (error) { if (generation.current === current) setSourceStatus(`Исходники: ${(error as Error).message}`); }
      });
      return index;
    });
    cache.current.set(key, { time: Date.now(), promise });
    // Retain failures briefly to avoid repeatedly querying an unavailable server while typing.
    void promise.catch(() => { if (cache.current.get(key)?.promise === promise) cache.current.set(key, { time: Date.now() - 285000, promise }); });
    return promise;
  }
  useEffect(() => {
    const minutes = profile?.jdbc?.options?.introspectionMinutes ?? 0;
    if (!profile || profile.jdbc?.options?.autoSync === false || !minutes) return;
    const timer = setInterval(() => setAutomaticRevision(value => value + 1), minutes * 60000);
    return () => clearInterval(timer);
  }, [profile]);
  useEffect(() => {
    const current = ++generation.current;
    const manual = manualRevision.current !== revision; manualRevision.current = revision;
    setIndex(undefined); setStatus(''); setSourceStatus(''); setBusy(Boolean(profile));
    if (!profile || !ddlMappingId && profile.jdbc?.options?.autoSync === false && !manual) { setBusy(false); return; }
    const timer = setTimeout(() => {
      void loadScope().then(value => {
        if (generation.current !== current) return;
        setIndex(value); setStatus(value.warnings.join('\n'));
      }).catch(error => { if (generation.current === current) setStatus(error.message); }).finally(() => { if (generation.current === current) setBusy(false); });
    }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [profile, catalog, schema, revision, automaticRevision, ddlMappingId]);

  async function loadScope(): Promise<SchemaIndex> {
    const result = await loadDatabaseScope();
    return profile && !ddlMappingId ? withSystemCatalogs(result, profile) : result;
  }
  async function loadDatabaseScope(): Promise<SchemaIndex> {
    if (ddlMappingId) {
      const key = `ddl:${ddlMappingId}`, cached = cache.current.get(key);
      if (cached && Date.now() - cached.time < 5000) return cached.promise;
      const promise = window.studio.ddl.index(ddlMappingId).then(index => {
        if (index.profileId !== profile?.id || index.catalog !== catalog || index.schema !== schema) throw new Error('DDL mapping изменился. Откройте новую консоль из mapping.');
        return index;
      });
      cache.current.set(key, { time: Date.now(), promise });
      return promise;
    }
    const selected = profile?.jdbc?.schemas;
    if (selected?.mode !== 'selected') return load(catalog, schema);
    if (!selected.selected.length) return { profileId: profile!.id, catalog, schema, tables: [], relationships: [], warnings: [] };
    const values: SchemaIndex[] = [], warnings: string[] = [];
    // Sequential requests avoid overwhelming the server or opening hundreds of JVMs.
    for (const context of selected.selected.slice(0, 32)) {
      try { values.push(await load(context.catalog, context.schema)); } catch (error) { warnings.push((error as Error).message); }
    }
    if (selected.selected.length > 32) warnings.push('Фоновая индексация ограничена 32 схемами. Остальные загружаются при явном обращении в SQL.');
    const first = values[0] ?? { profileId: profile!.id, catalog, schema, tables: [], relationships: [], warnings: [] };
    return { ...first, catalog, schema, tables: [...new Map(values.flatMap(value => value.tables).map(table => [tableKey(table), table])).values()], relationships: [...new Map(values.flatMap(value => value.relationships).map(relation => [relation.id, relation])).values()], warnings: [...warnings, ...values.flatMap(value => value.warnings)] };
  }
  async function forQuery(sql: string, offset: number): Promise<SchemaIndex | undefined> {
    if (!profile) return;
    const current = generation.current;
    try {
      const base = await loadScope();
      if (ddlMappingId) { if (current !== generation.current) return; setStatus(base.warnings.join('\n')); setIndex(base); return base; }
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
    } catch (error) {
      if (current !== generation.current) return;
      setStatus((error as Error).message);
      if (!ddlMappingId) return withSystemCatalogs({ profileId: profile.id, catalog, schema, tables: [], relationships: [], warnings: [(error as Error).message] }, profile);
      return;
    }
  }
  return { index, status: [status, sourceStatus].filter(Boolean).join('\n'), busy, forQuery };
}
