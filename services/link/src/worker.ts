import { DurableObject } from 'cloudflare:workers';
import worker from './index.ts';
/** One object per snapshot/archive page. SQL supports the existing bounded 1 MB pages. */
export class LeaderboardStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS payload (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  }
  async getValue(): Promise<string | null> {
    return this.ctx.storage.sql.exec<{value: string}>('SELECT value FROM payload WHERE id=1').toArray()[0]?.value ?? null;
  }
  async putValue(value: string): Promise<void> {
    if (new TextEncoder().encode(value).byteLength > 1_000_000) throw new Error('Snapshot too large');
    const incoming = JSON.parse(value);
    const current = this.ctx.storage.sql.exec<{value: string}>('SELECT value FROM payload WHERE id=1').toArray()[0]?.value;
    // All SQL is synchronous, so an older lazy KV import cannot replace a live update.
    if (current && Date.parse(JSON.parse(current).updatedAt) > Date.parse(incoming.updatedAt)) return;
    this.ctx.storage.sql.exec('INSERT INTO payload (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', value);
  }
}
export default worker;
