import type { QueryResultData, QuerySnapshot } from './shared';

export function resultSets(snapshot: QuerySnapshot): QueryResultData[] { return [snapshot,...(snapshot.additionalResults ?? [])]; }

/** Execution status and individual result status differ after a later result fails. */
export function resultSetView(snapshot: QuerySnapshot, index: number): QuerySnapshot {
  const data = index === 0 ? snapshot : snapshot.additionalResults?.[index - 1];
  if (!data) return snapshot;
  let state = data.resultState ?? snapshot.state;
  if (state === 'RUNNING' && snapshot.state !== 'RUNNING') state = snapshot.state;
  const error = state === 'FAILED' || state === 'CANCELED' ? data.error ?? snapshot.error : undefined;
  return { ...snapshot, ...data, state, error, dataLimited: data.dataLimited, updateCount: data.updateCount, updateType: data.updateType,
    additionalResults: undefined, omittedResults: undefined, requestId: `${snapshot.requestId}:result:${index}` };
}
