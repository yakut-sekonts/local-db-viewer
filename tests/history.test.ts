import assert from 'node:assert/strict';
import test from 'node:test';
import { appendHistory, filterHistory, historyContext, parseHistory, pinHistory, HISTORY_LIMIT, HISTORY_MAX_CHARS, HISTORY_PIN_LIMIT, type HistoryItem } from '../src/history';
import type { Profile } from '../src/shared';

const entry = (id: string, values: Partial<HistoryItem> = {}): HistoryItem => ({ id, sql: 'SELECT 1', profileId: 'p1', profileName: 'Рабочая БД', catalog: '', schema: '', state: 'FINISHED', time: 100, duration: 0, ...values });
const profile: Profile = { id: 'p1', name: 'New name', engine: 'postgres', endpoint: 'postgresql://localhost/test', user: '', auth: 'none', tls: false, catalog: '', schema: '', hasSecret: false,
  jdbc: { defaultSessionTemplate: 'new-default', sessionTemplates: [{ id: 'saved', name: 'Analyst' }, { id: 'new-default', name: 'Current default' }] } };

test('history migrates legacy records, preserves exact SQL and excludes malformed or duplicate records and unrelated fields', () => {
  const sql = "-- Привет 名🙂\r\nSELECT 'quote\\line', 9007199254740993;";
  const result = parseHistory(JSON.stringify([null, 'bad', entry('old', { sql }), entry('old', { sql: 'duplicate' }), entry('bad-state', { state: 'RUNNING' as never }),
    entry('bad-time', { time: 8.64e15 + 1 }), entry('bad-duration', { duration: -1 }), entry('bad-mode', { mode: 'unsafe' as never }), entry('bad-object', { state: { toString: null } as never }),
    entry('bad-template', { templateId: 42 as never }), entry('bad-search', { searchPath: '\0' }), entry('bad-rows', { maxRows: 10001 }),
    { ...entry('context', { time: 101, templateId: '', searchPath: '"my schema", public', maxRows: 100, mode: 'script' }), password: 'not retained' },
  ]));
  assert.deepEqual(result.map(item => item.id), ['context', 'old']);
  assert.equal(result[1]?.sql, sql); assert.equal(result[1]?.templateId, undefined);
  assert.equal(result[0]?.templateId, ''); assert.equal(result[0]?.searchPath, '"my schema", public');
  assert.ok(!JSON.stringify(result).includes('not retained'));
  for (const text of [null, '{broken', '{}', 'false', '"text"']) assert.deepEqual(parseHistory(text), []);
});

test('search combines Unicode substring, profile identity, status and pins without treating SQL as a regexp', () => {
  const items = [entry('a', { sql: 'SELECT [a.b] FROM ёж', profileId: 'p1', pinned: true }), entry('b', { sql: 'SELECT [a.b]', profileId: 'p2', state: 'FAILED', time: 102 }), entry('c', { schema: 'Sales', state: 'CANCELED', time: 101 })];
  const filters = { text: '', profileId: '', state: '', pinned: false };
  assert.deepEqual(filterHistory(items, { ...filters, text: 'ЁЖ' }).map(item => item.id), ['a']);
  assert.deepEqual(filterHistory(items, { ...filters, text: '[a.b]', profileId: 'p2', state: 'FAILED' }).map(item => item.id), ['b']);
  assert.deepEqual(filterHistory(items, { ...filters, text: 'sales', state: 'CANCELED' }).map(item => item.id), ['c']);
  assert.deepEqual(filterHistory(items, { ...filters, pinned: true }).map(item => item.id), ['a']);
  assert.deepEqual(filterHistory(items, filters).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(items.map(item => item.id), ['a', 'b', 'c']);
});

test('retention bounds count and protects old pinned SQL when new queries finish', () => {
  let items = parseHistory(JSON.stringify([entry('pinned', { time: 0, pinned: true }), ...Array.from({ length: 99 }, (_, i) => entry(String(i), { time: i + 1 }))]));
  const original = structuredClone(items);
  items = appendHistory(items, entry('new', { time: 200 })).items;
  assert.equal(items.length, HISTORY_LIMIT); assert.ok(items.some(item => item.id === 'pinned')); assert.ok(!items.some(item => item.id === '0'));
  assert.equal(original.length, HISTORY_LIMIT); assert.ok(original.some(item => item.id === '0'));
  items = appendHistory(items, entry('late', { time: 150 })).items;
  assert.deepEqual(items.slice(0, 2).map(item => item.id), ['new', 'late']);
  assert.equal(appendHistory(items, entry('new', { time: 201 })).items.filter(item => item.id === 'new').length, 1);
});

test('serialized history stays bounded without truncating SQL or silently evicting pins', () => {
  const pinned = entry('pinned', { sql: '🙂'.repeat(200000), pinned: true });
  let items = parseHistory(JSON.stringify([pinned]));
  const large = entry('large', { sql: '"'.repeat(400000), time: 200 });
  const result = appendHistory(items, large);
  assert.match(result.warning ?? '', /не помещается/); assert.deepEqual(result.items, items);
  items = appendHistory(items, entry('small', { sql: 'SELECT 2', time: 201 })).items;
  assert.equal(items.length, 2); assert.equal(items.find(item => item.id === 'pinned')?.sql, pinned.sql);
  assert.ok(JSON.stringify(items).length <= HISTORY_MAX_CHARS);
  const noPins = parseHistory(JSON.stringify([large, entry('older', { sql: 'x'.repeat(800000) })]));
  assert.deepEqual(noPins.map(item => item.id), ['large']);
  assert.equal(noPins[0]?.sql, large.sql);
});

test('pin limit is explicit; unpinning and restore keep count and storage invariants', () => {
  let items = parseHistory(JSON.stringify(Array.from({ length: 21 }, (_, i) => entry(String(i), { pinned: i < 20 }))));
  assert.throws(() => pinHistory(items, '20'), /до 20/);
  items = pinHistory(items, '0'); items = pinHistory(items, '20');
  assert.equal(items.filter(item => item.pinned).length, HISTORY_PIN_LIMIT);
  assert.equal(pinHistory(items, 'missing'), items);
  const excess = parseHistory(JSON.stringify(Array.from({ length: 120 }, (_, i) => entry(String(i), { pinned: true }))));
  assert.equal(excess.length, 100); assert.equal(excess.filter(item => item.pinned).length, 20);
  assert.deepEqual(parseHistory(JSON.stringify(items)), items);
});

test('history resolves exact connection and template identity instead of falling back to current defaults', () => {
  const saved = entry('saved', { catalog: 'analytics', schema: 'reports', searchPath: 'reports, public', templateId: 'saved', templateName: 'Analyst' });
  const target = historyContext(saved, [profile]);
  assert.equal(target.profile?.id, 'p1'); assert.equal(target.context.templateId, 'saved'); assert.equal(target.context.searchPath, 'reports, public'); assert.equal(target.warning, undefined);
  assert.equal(historyContext(entry('base', { templateId: '' }), [profile]).context.templateId, '');
  const missing = historyContext(saved, [{ ...profile, id: 'another', name: saved.profileName }]);
  assert.equal(missing.profile, undefined); assert.match(missing.warning ?? '', /Подключение удалено/);
  const missingTemplate = historyContext({ ...saved, templateId: 'removed' }, [profile]);
  assert.equal(missingTemplate.profile, undefined); assert.match(missingTemplate.warning ?? '', /Шаблон сессии удалён/);
  const legacy = historyContext(entry('legacy'), [profile]);
  assert.equal(legacy.profile?.id, 'p1'); assert.equal(legacy.context.templateId, undefined); assert.match(legacy.warning ?? '', /Старая запись/);
});
