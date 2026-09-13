import { DatabaseSession } from './database';
import type { Connection } from './trino';

export interface SessionLease { profileId: string; session: DatabaseSession; release(): Promise<void> }
/** A console holds a lease until disconnect; metadata holds one only while loading. */
export class SessionPool {
  private entries = new Map<string, { profileId: string; refs: number; session: Promise<DatabaseSession>; closing?: Promise<void> }>();
  constructor(private prepare: (connection: Connection) => Promise<Connection>) {}
  async acquire(connection: Connection, owner: string = crypto.randomUUID()): Promise<SessionLease> {
    const key = connection.jdbc?.options?.singleSession ? `profile:${connection.id}` : `console:${owner}`;
    let entry = this.entries.get(key);
    if (entry?.closing) { await entry.closing; return this.acquire(connection, owner); }
    if (!entry) {
      entry = { profileId: connection.id, refs: 0, session: this.prepare(connection).then(value => new DatabaseSession(value)) };
      this.entries.set(key, entry);
    }
    const held = entry; held.refs++;
    const release = async () => {
      if (--held.refs !== 0) return;
      held.closing = held.session.then(session => session.close()).finally(() => { if (this.entries.get(key) === held) this.entries.delete(key); });
      await held.closing;
    };
    try {
      const session = await held.session; let released = false;
      return { profileId: connection.id, session, release: async () => { if (!released) { released = true; await release(); } } };
    } catch (error) { await release().catch(() => {}); throw error; }
  }
  hasProfile(id: string): boolean { return [...this.entries.values()].some(entry => entry.profileId === id); }
  async abortAll(): Promise<void> { await Promise.allSettled([...this.entries.values()].map(async entry => (await entry.session).abort())); }
}
