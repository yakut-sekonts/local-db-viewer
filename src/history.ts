import type { Profile } from './shared';

export const HISTORY_LIMIT = 100;
export const HISTORY_PIN_LIMIT = 20;
// Bound the serialized UTF-16 text kept in localStorage independently of SQL drafts.
export const HISTORY_MAX_CHARS = 1024 * 1024;
export const HISTORY_STATES = { FINISHED: 'Готово', FAILED: 'Ошибка', CANCELED: 'Отменён' } as const;
export interface HistoryItem {
  id: string;
  sql: string;
  profileId: string;
  profileName: string;
  catalog: string;
  schema: string;
  state: keyof typeof HISTORY_STATES;
  time: number;
  duration: number;
  mode?: 'statement' | 'script';
  pinned?: boolean;
  // Undefined means an older entry did not record the template. Empty means no template.
  templateId?: string;
  templateName?: string;
  searchPath?: string;
  maxRows?: number;
}
export interface HistoryFilter { text: string; profileId: string; state: string; pinned: boolean }

function historyItem(value: unknown): HistoryItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  const limits = { id: 100, sql: 1_000_000, profileId: 100, profileName: 1000, catalog: 8192, schema: 8192 };
  for (const [key, limit] of Object.entries(limits)) if (typeof item[key] !== 'string' || item[key].length > limit) return;
  if (!item.id || typeof item.state !== 'string' || !Object.hasOwn(HISTORY_STATES, item.state)) return;
  if (typeof item.time !== 'number' || !Number.isFinite(item.time) || item.time < 0 || item.time > 8.64e15) return;
  if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0) return;
  if (item.mode !== undefined && item.mode !== 'statement' && item.mode !== 'script') return;
  for (const [key, limit] of Object.entries({ templateId: 100, templateName: 1000, searchPath: 8192 })) {
    if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > limit || /[\r\n\0]/.test(item[key]))) return;
  }
  if (item.maxRows !== undefined && (typeof item.maxRows !== 'number' || !Number.isInteger(item.maxRows) || item.maxRows < 1 || item.maxRows > 10000)) return;
  return {
    id: item.id as string, sql: item.sql as string, profileId: item.profileId as string, profileName: item.profileName as string,
    catalog: item.catalog as string, schema: item.schema as string, state: item.state as HistoryItem['state'], time: item.time, duration: item.duration,
    mode: item.mode, pinned: item.pinned === true, templateId: item.templateId as string | undefined,
    templateName: item.templateName as string | undefined, searchPath: item.searchPath as string | undefined, maxRows: item.maxRows as number | undefined,
  };
}

function retainHistory(items: HistoryItem[]): HistoryItem[] {
  let length = 2;
  const retained = new Set<string>();
  for (const item of [...items.filter(item => item.pinned), ...items.filter(item => !item.pinned)]) {
    const size = JSON.stringify({ ...item, pinned: false }).length + (retained.size ? 1 : 0);
    if (retained.size >= HISTORY_LIMIT || length + size > HISTORY_MAX_CHARS) continue;
    retained.add(item.id); length += size;
  }
  return items.filter(item => retained.has(item.id));
}

export function parseHistory(text: string | null): HistoryItem[] {
  try {
    if (!text || text.length > 10 * 1024 * 1024) return [];
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    const ids = new Set<string>(); let pins = 0;
    const items: HistoryItem[] = [];
    for (const value of data.slice(0, 1000)) {
      const item = historyItem(value);
      if (!item || ids.has(item.id)) continue;
      ids.add(item.id);
      if (item.pinned && ++pins > HISTORY_PIN_LIMIT) item.pinned = false;
      items.push(item);
    }
    return retainHistory(items.sort((a, b) => b.time - a.time));
  } catch { return []; }
}

export function appendHistory(items: HistoryItem[], item: HistoryItem): { items: HistoryItem[]; warning?: string } {
  const valid = historyItem(item);
  if (!valid) return { items, warning: 'Не удалось записать запрос в историю: некорректные данные.' };
  const retained = retainHistory([valid, ...items.filter(previous => previous.id !== valid.id)].sort((a, b) => b.time - a.time));
  return { items: retained, warning: retained.some(previous => previous.id === valid.id) ? undefined : 'SQL не помещается в историю. Сохраните его в файл или освободите место, удалив закреплённые записи.' };
}

export function pinHistory(items: HistoryItem[], id: string): HistoryItem[] {
  const item = items.find(item => item.id === id);
  if (!item) return items;
  if (!item.pinned && items.filter(item => item.pinned).length >= HISTORY_PIN_LIMIT) throw new Error(`Можно закрепить до ${HISTORY_PIN_LIMIT} запросов. Открепите ненужный запрос.`);
  // retainHistory reserves the longer unpinned representation, so either toggle fits.
  return items.map(item => item.id === id ? { ...item, pinned: !item.pinned } : item);
}

export function filterHistory(items: HistoryItem[], filter: HistoryFilter): HistoryItem[] {
  const text = filter.text.trim().toLowerCase();
  return items.filter(item => (!filter.profileId || item.profileId === filter.profileId)
    && (!filter.state || item.state === filter.state) && (!filter.pinned || item.pinned)
    && (!text || [item.sql, item.profileName, item.catalog, item.schema, item.templateName ?? ''].some(value => value.toLowerCase().includes(text))))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.time - a.time);
}

export function historyContext(item: HistoryItem, profiles: Profile[]) {
  const profile = profiles.find(profile => profile.id === item.profileId);
  const templateMissing = !!item.templateId && !profile?.jdbc?.sessionTemplates?.some(template => template.id === item.templateId);
  const warning = !profile ? 'Подключение удалено. SQL будет открыт без подключения.'
    : templateMissing ? 'Шаблон сессии удалён. SQL будет открыт без подключения: выберите подключение и шаблон заново.'
    : item.templateId === undefined ? 'Старая запись не содержит шаблон сессии: будет использован текущий шаблон по умолчанию.' : undefined;
  return { profile: !templateMissing ? profile : undefined, warning,
    context: { catalog: item.catalog, schema: item.schema, searchPath: item.searchPath, templateId: item.templateId } };
}
