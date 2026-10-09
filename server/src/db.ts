// @aetherfall/server — persistence: Postgres (prod) -> node:sqlite (WAL) -> JSON fallback.
// Boot-safe: constructor never throws and never blocks. When DATABASE_URL is
// set, a Postgres mirror connects in the background (pooled `pg` client,
// auto-migrates persist/migrate.sql); local sqlite stays the synchronous source
// of truth and all writes are mirrored fire-and-forget. Any pg failure warns
// and keeps the local backend. Snapshots are batched (single transaction /
// multi-row INSERT), WAL-checkpointed, and flushed on graceful shutdown.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type PlayerRow = { id: number; name: string; x: number; y: number; hp: number; updated: number };
export type ChatRow = { id: number; from: string; text: string; channel: string; at: number };
export type GuildRow = { id: number; name: string; ownerId: number; members: string; createdAt: number };
export type ItemRow = { playerId: number; itemId: string; qty: number; updated: number };
export type QuestProgressRow = { playerId: number; questId: string; stage: number; done: boolean; updated: number };
export type SnapshotInfo = { tick: number; at: number };
type SnapshotBufRow = { tick: number; json: string; at: number };

type LocalBackend = 'better-sqlite3' | 'node:sqlite' | 'json';
type Backend = LocalBackend | 'postgres';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, hp INTEGER NOT NULL DEFAULT 100, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, text TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guilds (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL, members TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL, UNIQUE (player_id, item_id));
CREATE TABLE IF NOT EXISTS quests_progress (player_id INTEGER NOT NULL, quest_id TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY (player_id, quest_id));
CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON snapshots (tick DESC);
CREATE INDEX IF NOT EXISTS idx_chat_log_at ON chat_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_items_player ON items (player_id);
CREATE INDEX IF NOT EXISTS idx_quests_player ON quests_progress (player_id);
`;

const FLUSH_INTERVAL_MS = 5000;
const SNAPSHOT_BATCH_MAX = 100;

function dataDir(): string {
  const dir = resolve(process.cwd(), 'data');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

export class DB {
  /** Effective backend: 'postgres' once the mirror connects, else the local backend. */
  backend: Backend = 'json';
  private local: LocalBackend = 'json';
  private sqlite: { exec: (sql: string) => void; prepare: (sql: string) => unknown; close: () => void } | null = null;
  private better: unknown = null;
  private jsonPath = '';
  private json = {
    players: {} as Record<string, PlayerRow>,
    snapshots: [] as SnapshotBufRow[],
    chat_log: [] as ChatRow[],
    guilds: {} as Record<string, GuildRow>,
    items: {} as Record<string, ItemRow>,
    quests: {} as Record<string, QuestProgressRow>,
  };
  private chatSeq = 1;
  private guildSeq = 1;

  // Postgres mirror (async, background; local stays sync source of truth).
  private pgMirror: {
    connected: boolean;
    upsertPlayer: (r: PlayerRow) => Promise<unknown>;
    saveSnapshotsBatch: (r: SnapshotBufRow[]) => Promise<number>;
    logChat: (f: string, t: string, c: string, at?: number) => Promise<unknown>;
    upsertGuild: (n: string, o: number, m: string, at?: number) => Promise<unknown>;
    setItem: (p: number, i: string, q: number, at?: number) => Promise<unknown>;
    setQuestProgress: (p: number, q: string, s: number, d: boolean, at?: number) => Promise<unknown>;
    close: () => Promise<void>;
  } | null = null;
  /** Resolves true when the Postgres mirror is live (false = local fallback). */
  pgReady: Promise<boolean> = Promise.resolve(false);

  // Snapshot batching.
  private snapBuf: SnapshotBufRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private static shutdownHooked = false;
  private static instances = new Set<DB>();

  constructor(dbPath?: string) {
    const dir = dataDir();
    const file = dbPath ?? resolve(dir, 'aetherfall.db');
    // 1) better-sqlite3 if present (optional native dep)
    try {
      const Ctor = require('better-sqlite3') as new (f: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { run: (...a: unknown[]) => void; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
        close: () => void;
      };
      const db = new Ctor(file);
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec(SCHEMA_SQL);
      this.better = db;
      this.local = 'better-sqlite3';
      this.backend = 'better-sqlite3';
    } catch {
      /* not installed or native load failed -> continue */
    }
    // 2) node:sqlite (Node >=22.5)
    if (this.better === null) {
      try {
        const mod = require('node:sqlite') as {
          DatabaseSync: new (f: string) => { exec: (s: string) => void; prepare: (s: string) => unknown; close: () => void };
        };
        const db = new mod.DatabaseSync(file);
        db.exec('PRAGMA journal_mode=WAL;');
        db.exec(SCHEMA_SQL);
        this.sqlite = db;
        this.local = 'node:sqlite';
        this.backend = 'node:sqlite';
      } catch {
        /* fall through to JSON */
      }
    }
    // 3) JSON file fallback
    if (this.better === null && this.sqlite === null) {
      this.local = 'json';
      this.backend = 'json';
      this.jsonPath = resolve(dir, 'db.json');
      try {
        if (existsSync(this.jsonPath)) {
          const raw = readFileSync(this.jsonPath, 'utf8');
          const parsed = JSON.parse(raw) as Partial<typeof this.json>;
          if (parsed && typeof parsed === 'object') {
            this.json = {
              players: (parsed.players ?? {}) as Record<string, PlayerRow>,
              snapshots: (parsed.snapshots ?? []) as SnapshotBufRow[],
              chat_log: (parsed.chat_log ?? []) as ChatRow[],
              guilds: (parsed.guilds ?? {}) as Record<string, GuildRow>,
              items: (parsed.items ?? {}) as Record<string, ItemRow>,
              quests: (parsed.quests ?? {}) as Record<string, QuestProgressRow>,
            };
            const maxId = this.json.chat_log.reduce((m, c) => Math.max(m, c.id), 0);
            this.chatSeq = maxId + 1;
            const maxGid = Object.values(this.json.guilds).reduce((m, g) => Math.max(m, g.id), 0);
            this.guildSeq = maxGid + 1;
          }
        }
      } catch {
        /* start empty */
      }
    }

    // Batched snapshot flush (5s cadence matches the server's save tick).
    try {
      this.flushTimer = setInterval(() => {
        try {
          this.flushSnapshots();
        } catch {
          /* ignore */
        }
      }, FLUSH_INTERVAL_MS);
      const t = this.flushTimer as unknown as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    } catch {
      this.flushTimer = null;
    }

    DB.instances.add(this);
    DB.hookShutdown();

    // Postgres prod path (background, non-blocking, never throws).
    const url = process.env.DATABASE_URL;
    if (url) {
      this.pgReady = this.initPostgres(url);
    }
  }

  /** Local storage backend (sync source of truth). */
  get localBackend(): LocalBackend {
    return this.local;
  }

  /** True once the Postgres mirror has connected + migrated. */
  get usingPostgres(): boolean {
    return this.pgMirror !== null && this.pgMirror.connected;
  }

  /** Buffered snapshots not yet flushed. */
  get pendingSnapshots(): number {
    return this.snapBuf.length;
  }

  private async initPostgres(url: string): Promise<boolean> {
    try {
      const mod = (await import('./persist/pg.js')) as unknown as {
        PostgresMirror: new (u: string) => {
          connected: boolean;
          ready: Promise<boolean>;
          upsertPlayer: (r: PlayerRow) => Promise<unknown>;
          saveSnapshotsBatch: (r: SnapshotBufRow[]) => Promise<number>;
          logChat: (f: string, t: string, c: string, at?: number) => Promise<unknown>;
          upsertGuild: (n: string, o: number, m: string, at?: number) => Promise<unknown>;
          setItem: (p: number, i: string, q: number, at?: number) => Promise<unknown>;
          setQuestProgress: (p: number, q: string, s: number, d: boolean, at?: number) => Promise<unknown>;
          close: () => Promise<void>;
        };
      };
      const mirror = new mod.PostgresMirror(url);
      const ok = await mirror.ready;
      if (ok) {
        this.pgMirror = mirror;
        this.backend = 'postgres';
        console.log('[db] postgres mirror live (local sqlite remains sync cache)');
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[db] postgres init failed, local ${this.local} fallback: ${(err as Error)?.message ?? err}`);
      this.pgMirror = null;
      return false;
    }
  }

  private static hookShutdown(): void {
    if (DB.shutdownHooked) return;
    if (process.env.AETHERFALL_NO_SHUTDOWN_HOOK) return;
    DB.shutdownHooked = true;
    const shutdown = (sig: string) => {
      console.log(`[db] ${sig} — flushing snapshots + checkpoint + close`);
      for (const db of DB.instances) {
        try {
          db.flushSnapshots();
        } catch {
          /* ignore */
        }
        try {
          db.checkpoint();
        } catch {
          /* ignore */
        }
        try {
          db.closeLocal();
        } catch {
          /* ignore */
        }
        if (db.pgMirror) void db.pgMirror.close().catch(() => undefined);
      }
      if (!process.env.AETHERFALL_NO_EXIT) process.exit(0);
    };
    try {
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    } catch {
      /* non-process env */
    }
  }

  private persistJson(): void {
    if (this.local !== 'json' || !this.jsonPath) return;
    try {
      mkdirSync(dirname(this.jsonPath), { recursive: true });
      writeFileSync(this.jsonPath, JSON.stringify(this.json));
    } catch {
      /* best effort */
    }
  }

  private run(sql: string, ...params: unknown[]): void {
    if (this.better) {
      (this.better as { prepare: (s: string) => { run: (...a: unknown[]) => void } }).prepare(sql).run(...params);
      return;
    }
    if (this.sqlite) {
      (this.sqlite.prepare(sql) as { run: (...a: unknown[]) => unknown }).run(...params);
    }
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    if (this.better) {
      return (this.better as { prepare: (s: string) => { get: (...a: unknown[]) => T } }).prepare(sql).get(...params) as T | undefined;
    }
    if (this.sqlite) {
      return (this.sqlite.prepare(sql) as { get: (...a: unknown[]) => T }).get(...params) as T | undefined;
    }
    return undefined;
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    if (this.better) {
      return (this.better as { prepare: (s: string) => { all: (...a: unknown[]) => T[] } }).prepare(sql).all(...params);
    }
    if (this.sqlite) {
      return (this.sqlite.prepare(sql) as { all: (...a: unknown[]) => T[] }).all(...params);
    }
    return [];
  }

  // --- players ---

  upsertPlayer(row: PlayerRow): void {
    if (this.local === 'json') {
      this.json.players[String(row.id)] = row;
      this.persistJson();
    } else {
      this.run(
        'INSERT INTO players (id, name, x, y, hp, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y, hp=excluded.hp, updated=excluded.updated',
        row.id, row.name, row.x, row.y, row.hp, row.updated,
      );
    }
    if (this.pgMirror?.connected) void this.pgMirror.upsertPlayer(row).catch(() => undefined);
  }

  getPlayer(id: number): PlayerRow | undefined {
    if (this.local === 'json') return this.json.players[String(id)];
    return this.get<PlayerRow>('SELECT * FROM players WHERE id = ?', id);
  }

  // --- snapshots (buffered batch) ---

  saveSnapshot(tick: number, json: string): void {
    this.snapBuf.push({ tick, json, at: Date.now() });
    if (this.snapBuf.length >= SNAPSHOT_BATCH_MAX) {
      try {
        this.flushSnapshots();
      } catch {
        /* ignore */
      }
    }
  }

  /** Write buffered snapshots in one transaction (+ pg multi-row batch). Returns rows flushed. */
  flushSnapshots(): number {
    if (this.snapBuf.length === 0) return 0;
    const rows = this.snapBuf;
    this.snapBuf = [];
    try {
      this.writeSnapshotBatch(rows);
    } catch {
      // Re-queue on local failure so shutdown can retry; keep newest 500.
      this.snapBuf = rows.concat(this.snapBuf).slice(-500);
      return 0;
    }
    try {
      this.checkpoint();
    } catch {
      /* ignore */
    }
    if (this.pgMirror?.connected) void this.pgMirror.saveSnapshotsBatch(rows).catch(() => undefined);
    return rows.length;
  }

  private writeSnapshotBatch(rows: SnapshotBufRow[]): void {
    if (rows.length === 0) return;
    if (this.local === 'json') {
      for (const r of rows) this.json.snapshots.push(r);
      if (this.json.snapshots.length > 200) this.json.snapshots.splice(0, this.json.snapshots.length - 200);
      this.persistJson();
      return;
    }
    if (this.better) {
      const db = this.better as {
        prepare: (s: string) => { run: (...a: unknown[]) => void };
        exec?: (s: string) => void;
        transaction?: <T extends unknown[], R>(fn: (...a: T) => R) => (...a: T) => R;
      };
      const stmt = db.prepare('INSERT INTO snapshots (tick, json, at) VALUES (?, ?, ?)');
      if (typeof db.transaction === 'function') {
        db.transaction((list: SnapshotBufRow[]) => {
          for (const r of list) stmt.run(r.tick, r.json, r.at);
        })(rows);
      } else {
        for (const r of rows) stmt.run(r.tick, r.json, r.at);
      }
      return;
    }
    if (this.sqlite) {
      try {
        this.sqlite.exec('BEGIN');
        const stmt = this.sqlite.prepare('INSERT INTO snapshots (tick, json, at) VALUES (?, ?, ?)') as {
          run: (...a: unknown[]) => unknown;
        };
        for (const r of rows) stmt.run(r.tick, r.json, r.at);
        this.sqlite.exec('COMMIT');
      } catch (err) {
        try {
          this.sqlite.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
  }

  recentSnapshots(limit = 10): SnapshotInfo[] {
    // Include not-yet-flushed rows so callers see the latest ticks.
    const buffered: SnapshotInfo[] = this.snapBuf.slice(-limit).map((r) => ({ tick: r.tick, at: r.at }));
    if (this.local === 'json') {
      const stored = this.json.snapshots.slice(-limit).map((r) => ({ tick: r.tick, at: r.at }));
      return stored.concat(buffered).slice(-limit);
    }
    const rows = this.all<{ tick: number; at: number }>('SELECT tick, at FROM snapshots ORDER BY id DESC LIMIT ?', limit);
    return rows.reverse().concat(buffered).slice(-limit);
  }

  /** WAL checkpoint (TRUNCATE) so -wal/-shm stay small; best-effort no-op on JSON. */
  checkpoint(): void {
    if (this.better) {
      try {
        (this.better as { exec: (s: string) => void }).exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* ignore */
      }
      return;
    }
    if (this.sqlite) {
      try {
        this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* ignore */
      }
    }
  }

  // --- chat ---

  logChat(from: string, text: string, channel: string): ChatRow {
    const at = Date.now();
    if (this.local === 'json') {
      const row: ChatRow = { id: this.chatSeq++, from, text, channel, at };
      this.json.chat_log.push(row);
      if (this.json.chat_log.length > 500) this.json.chat_log.splice(0, this.json.chat_log.length - 500);
      this.persistJson();
      if (this.pgMirror?.connected) void this.pgMirror.logChat(from, text, channel, at).catch(() => undefined);
      return row;
    }
    this.run('INSERT INTO chat_log (sender, text, channel, at) VALUES (?, ?, ?, ?)', from, text, channel, at);
    const row = this.all<ChatRow>('SELECT * FROM chat_log ORDER BY id DESC LIMIT 1')[0];
    if (this.pgMirror?.connected) void this.pgMirror.logChat(from, text, channel, at).catch(() => undefined);
    return row ?? { id: -1, from, text, channel, at };
  }

  recentChat(limit = 20): ChatRow[] {
    if (this.local === 'json') return this.json.chat_log.slice(-limit);
    const rows = this.all<{ id: number; sender: string; text: string; channel: string; at: number }>(
      'SELECT * FROM chat_log ORDER BY id DESC LIMIT ?', limit,
    );
    return rows.reverse().map((r) => ({ id: r.id, from: r.sender, text: r.text, channel: r.channel, at: r.at }));
  }

  // --- guilds ---

  upsertGuild(name: string, ownerId: number, members: string, createdAt = Date.now()): GuildRow {
    if (this.local === 'json') {
      const existing = this.json.guilds[name];
      const row: GuildRow = existing ?? { id: this.guildSeq++, name, ownerId, members, createdAt };
      row.ownerId = ownerId;
      row.members = members;
      this.json.guilds[name] = row;
      this.persistJson();
      if (this.pgMirror?.connected) void this.pgMirror.upsertGuild(name, ownerId, members, row.createdAt).catch(() => undefined);
      return row;
    }
    this.run(
      'INSERT INTO guilds (name, owner_id, members, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, members=excluded.members',
      name, ownerId, members, createdAt,
    );
    const row = this.get<GuildRow & { owner_id: number; created_at: number }>('SELECT * FROM guilds WHERE name = ?', name);
    if (this.pgMirror?.connected) void this.pgMirror.upsertGuild(name, ownerId, members, createdAt).catch(() => undefined);
    if (!row) return { id: -1, name, ownerId, members, createdAt };
    return { id: (row as { id: number }).id, name, ownerId, members, createdAt: (row as { created_at: number }).created_at ?? createdAt };
  }

  getGuild(name: string): GuildRow | undefined {
    if (this.local === 'json') return this.json.guilds[name];
    const row = this.get<{ id: number; name: string; owner_id: number; members: string; created_at: number }>(
      'SELECT * FROM guilds WHERE name = ?', name,
    );
    if (!row) return undefined;
    return { id: row.id, name: row.name, ownerId: row.owner_id, members: row.members, createdAt: row.created_at };
  }

  // --- items (per-player stacks) ---

  setItem(playerId: number, itemId: string, qty: number): void {
    const updated = Date.now();
    if (this.local === 'json') {
      this.json.items[`${playerId}:${itemId}`] = { playerId, itemId, qty, updated };
      this.persistJson();
    } else {
      this.run(
        'INSERT INTO items (player_id, item_id, qty, updated) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, item_id) DO UPDATE SET qty=excluded.qty, updated=excluded.updated',
        playerId, itemId, qty, updated,
      );
    }
    if (this.pgMirror?.connected) void this.pgMirror.setItem(playerId, itemId, qty, updated).catch(() => undefined);
  }

  getItems(playerId: number): ItemRow[] {
    if (this.local === 'json') return Object.values(this.json.items).filter((i) => i.playerId === playerId);
    const rows = this.all<{ player_id: number; item_id: string; qty: number; updated: number }>(
      'SELECT player_id, item_id, qty, updated FROM items WHERE player_id = ?', playerId,
    );
    return rows.map((r) => ({ playerId: r.player_id, itemId: r.item_id, qty: r.qty, updated: r.updated }));
  }

  // --- quest progress ---

  setQuestProgress(playerId: number, questId: string, stage: number, done: boolean): void {
    const updated = Date.now();
    const doneInt = done ? 1 : 0;
    if (this.local === 'json') {
      this.json.quests[`${playerId}:${questId}`] = { playerId, questId, stage, done, updated };
      this.persistJson();
    } else {
      this.run(
        'INSERT INTO quests_progress (player_id, quest_id, stage, done, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id, quest_id) DO UPDATE SET stage=excluded.stage, done=excluded.done, updated=excluded.updated',
        playerId, questId, stage, doneInt, updated,
      );
    }
    if (this.pgMirror?.connected) void this.pgMirror.setQuestProgress(playerId, questId, stage, done, updated).catch(() => undefined);
  }

  getQuestProgress(playerId: number): QuestProgressRow[] {
    if (this.local === 'json') return Object.values(this.json.quests).filter((q) => q.playerId === playerId);
    const rows = this.all<{ player_id: number; quest_id: string; stage: number; done: number; updated: number }>(
      'SELECT player_id, quest_id, stage, done, updated FROM quests_progress WHERE player_id = ?', playerId,
    );
    return rows.map((r) => ({ playerId: r.player_id, questId: r.quest_id, stage: r.stage, done: r.done === 1, updated: r.updated }));
  }

  private closeLocal(): void {
    try {
      if (this.better) (this.better as { close: () => void }).close();
      if (this.sqlite) this.sqlite.close();
    } catch {
      /* ignore */
    } finally {
      this.better = null;
      this.sqlite = null;
    }
  }

  close(): void {
    if (this.flushTimer) {
      try {
        clearInterval(this.flushTimer);
      } catch {
        /* ignore */
      }
      this.flushTimer = null;
    }
    try {
      this.flushSnapshots();
    } catch {
      /* ignore */
    }
    try {
      this.checkpoint();
    } catch {
      /* ignore */
    }
    this.closeLocal();
    if (this.pgMirror) void this.pgMirror.close().catch(() => undefined);
    this.pgMirror = null;
    DB.instances.delete(this);
  }
}
