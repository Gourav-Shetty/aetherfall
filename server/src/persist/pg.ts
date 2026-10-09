// @aetherfall/server — persist/pg: Postgres prod path (pooled, auto-migrate).
// Boot-safe: connect failures resolve to null/false with a console.warn —
// callers (db.ts) fall back to sqlite/JSON. Never throws from the factory.
import { MIGRATE_SQL } from './migrate.js';

export type PgPlayerRow = { id: number; name: string; x: number; y: number; hp: number; updated: number };
export type PgChatRow = { id: number; from: string; text: string; channel: string; at: number };
export type SnapshotRow = { tick: number; json: string; at: number };
export type GuildRow = { id: number; name: string; owner_id: number; members: string; created_at: number };
export type ItemRow = { player_id: number; item_id: string; qty: number; updated: number };
export type QuestRow = { player_id: number; quest_id: string; stage: number; done: boolean; updated: number };

// Minimal Pool surface so tests can inject a fake.
export type PoolLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

/** Pure helper: multi-row INSERT for batched snapshot flushes (tested without a live PG). */
export function buildSnapshotBatchInsert(rows: SnapshotRow[]): { text: string; values: unknown[] } {
  if (rows.length === 0) return { text: '-- no rows', values: [] };
  const vals: unknown[] = [];
  const groups = rows.map((r, i) => {
    const o = i * 3;
    vals.push(r.tick, r.json, r.at);
    return `($${o + 1}, $${o + 2}, $${o + 3})`;
  });
  return { text: `INSERT INTO snapshots (tick, json, at) VALUES ${groups.join(', ')}`, values: vals };
}

const CONNECT_TIMEOUT_MS = 5000;

export class PostgresMirror {
  readonly url: string;
  pool: PoolLike | null = null;
  connected = false;
  readonly ready: Promise<boolean>;

  constructor(url: string, pool?: PoolLike) {
    this.url = url;
    this.ready = pool ? this.attach(pool) : this.connect(url);
  }

  private async attach(pool: PoolLike): Promise<boolean> {
    this.pool = pool;
    try {
      await pool.query(MIGRATE_SQL);
      this.connected = true;
      return true;
    } catch (err) {
      console.warn(`[persist/pg] migrate failed on injected pool: ${(err as Error)?.message ?? err}`);
      this.pool = null;
      return false;
    }
  }

  private async connect(url: string): Promise<boolean> {
    let PoolCtor: new (opts: Record<string, unknown>) => PoolLike;
    try {
      const mod = (await import('pg')) as unknown as {
        default?: { Pool?: new (o: Record<string, unknown>) => PoolLike };
        Pool?: new (o: Record<string, unknown>) => PoolLike;
      };
      PoolCtor = (mod.default?.Pool ?? mod.Pool) as new (o: Record<string, unknown>) => PoolLike;
      if (!PoolCtor) throw new Error('pg module has no Pool export');
    } catch (err) {
      console.warn(`[persist/pg] 'pg' module unavailable, staying on sqlite/JSON fallback: ${(err as Error)?.message ?? err}`);
      return false;
    }
    const pool = new PoolCtor({ connectionString: url, max: 10, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    try {
      await pool.query('SELECT 1');
      await pool.query(MIGRATE_SQL);
      this.pool = pool;
      this.connected = true;
      console.log('[persist/pg] connected + migrated');
      return true;
    } catch (err) {
      console.warn(`[persist/pg] connect/migrate failed, staying on sqlite/JSON fallback: ${(err as Error)?.message ?? err}`);
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private async q(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] } | null> {
    if (!this.pool || !this.connected) return null;
    try {
      return await this.pool.query(text, params);
    } catch (err) {
      console.warn(`[persist/pg] query failed (local fallback still authoritative): ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  async upsertPlayer(row: PgPlayerRow): Promise<boolean> {
    const r = await this.q(
      `INSERT INTO players (id, name, x, y, hp, updated) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, x=EXCLUDED.x, y=EXCLUDED.y, hp=EXCLUDED.hp, updated=EXCLUDED.updated`,
      [row.id, row.name, row.x, row.y, row.hp, row.updated],
    );
    return r !== null;
  }

  async getPlayer(id: number): Promise<PgPlayerRow | undefined> {
    const r = await this.q('SELECT id, name, x, y, hp, updated FROM players WHERE id = $1', [id]);
    const row = r?.rows[0];
    if (!row) return undefined;
    return {
      id: Number(row.id),
      name: String(row.name),
      x: Number(row.x),
      y: Number(row.y),
      hp: Number(row.hp),
      updated: Number(row.updated),
    };
  }

  async saveSnapshot(tick: number, json: string, at = Date.now()): Promise<boolean> {
    return (await this.saveSnapshotsBatch([{ tick, json, at }])) > 0;
  }

  /** Batched multi-row insert; returns rows written (0 when offline). */
  async saveSnapshotsBatch(rows: SnapshotRow[]): Promise<number> {
    if (rows.length === 0 || !this.pool || !this.connected) return 0;
    const { text, values } = buildSnapshotBatchInsert(rows);
    const r = await this.q(text, values);
    return r ? rows.length : 0;
  }

  async logChat(from: string, text: string, channel: string, at = Date.now()): Promise<PgChatRow | null> {
    const r = await this.q(
      'INSERT INTO chat_log (sender, text, channel, at) VALUES ($1,$2,$3,$4) RETURNING id, sender, text, channel, at',
      [from, text, channel, at],
    );
    const row = r?.rows[0];
    if (!row) return null;
    return { id: Number(row.id), from: String(row.sender), text: String(row.text), channel: String(row.channel), at: Number(row.at) };
  }

  async recentChat(limit = 20): Promise<PgChatRow[]> {
    const r = await this.q('SELECT id, sender, text, channel, at FROM chat_log ORDER BY id DESC LIMIT $1', [limit]);
    return (r?.rows ?? []).reverse().map((row) => ({
      id: Number(row.id),
      from: String(row.sender),
      text: String(row.text),
      channel: String(row.channel),
      at: Number(row.at),
    }));
  }

  async upsertGuild(name: string, ownerId: number, membersJson: string, createdAt = Date.now()): Promise<boolean> {
    const r = await this.q(
      `INSERT INTO guilds (name, owner_id, members, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET owner_id=EXCLUDED.owner_id, members=EXCLUDED.members`,
      [name, ownerId, membersJson, createdAt],
    );
    return r !== null;
  }

  async getGuild(name: string): Promise<GuildRow | undefined> {
    const r = await this.q('SELECT id, name, owner_id, members, created_at FROM guilds WHERE name = $1', [name]);
    const row = r?.rows[0];
    if (!row) return undefined;
    return { id: Number(row.id), name: String(row.name), owner_id: Number(row.owner_id), members: String(row.members), created_at: Number(row.created_at) };
  }

  async setItem(playerId: number, itemId: string, qty: number, updated = Date.now()): Promise<boolean> {
    const r = await this.q(
      `INSERT INTO items (player_id, item_id, qty, updated) VALUES ($1,$2,$3,$4)
       ON CONFLICT (player_id, item_id) DO UPDATE SET qty=EXCLUDED.qty, updated=EXCLUDED.updated`,
      [playerId, itemId, qty, updated],
    );
    return r !== null;
  }

  async getItems(playerId: number): Promise<ItemRow[]> {
    const r = await this.q('SELECT player_id, item_id, qty, updated FROM items WHERE player_id = $1', [playerId]);
    return (r?.rows ?? []).map((row) => ({
      player_id: Number(row.player_id),
      item_id: String(row.item_id),
      qty: Number(row.qty),
      updated: Number(row.updated),
    }));
  }

  async setQuestProgress(playerId: number, questId: string, stage: number, done: boolean, updated = Date.now()): Promise<boolean> {
    const r = await this.q(
      `INSERT INTO quests_progress (player_id, quest_id, stage, done, updated) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (player_id, quest_id) DO UPDATE SET stage=EXCLUDED.stage, done=EXCLUDED.done, updated=EXCLUDED.updated`,
      [playerId, questId, stage, done, updated],
    );
    return r !== null;
  }

  async getQuestProgress(playerId: number): Promise<QuestRow[]> {
    const r = await this.q('SELECT player_id, quest_id, stage, done, updated FROM quests_progress WHERE player_id = $1', [playerId]);
    return (r?.rows ?? []).map((row) => ({
      player_id: Number(row.player_id),
      quest_id: String(row.quest_id),
      stage: Number(row.stage),
      done: Boolean(row.done),
      updated: Number(row.updated),
    }));
  }

  async close(): Promise<void> {
    try {
      await this.pool?.end();
    } catch {
      /* ignore */
    } finally {
      this.pool = null;
      this.connected = false;
    }
  }
}

/** Boot-safe factory: null when DATABASE_URL is unset or connect fails. */
export async function tryConnectPostgres(url = process.env.DATABASE_URL): Promise<PostgresMirror | null> {
  if (!url) return null;
  const mirror = new PostgresMirror(url);
  const ok = await mirror.ready;
  return ok ? mirror : null;
}
