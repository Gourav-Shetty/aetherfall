// @aetherfall/server — persist tests: migrate idempotency, boot fallback, presence TTL.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { MIGRATE_SQL, MIGRATE_TABLES } from './migrate.js';
import { PostgresMirror, buildSnapshotBatchInsert, type PoolLike } from './pg.js';
import { Presence } from './presence.js';
import { DB } from '../db.js';

// Never install process signal handlers from unit tests.
process.env.AETHERFALL_NO_SHUTDOWN_HOOK = '1';
process.env.AETHERFALL_NO_EXIT = '1';

const require = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findMigrateSql(): string | null {
  const candidates = [
    // tsx/dev: sibling of this source file.
    new URL('./migrate.sql', import.meta.url),
    // built: tests run with cwd=server/, sources still present in repo.
    ...['src/persist/migrate.sql', 'server/src/persist/migrate.sql'].map((p) => new URL(`file:///${resolve(process.cwd(), p)}`)),
  ];
  for (const u of candidates) {
    try {
      const path = u.protocol === 'file:' ? decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1') : String(u);
      if (existsSync(path)) return readFileSync(path, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

describe('persist/migrate.sql', () => {
  it('declares all six prod tables', () => {
    for (const t of MIGRATE_TABLES) {
      assert.ok(MIGRATE_SQL.includes(`CREATE TABLE IF NOT EXISTS ${t} (`), `missing table ${t}`);
    }
    assert.deepEqual([...MIGRATE_TABLES].sort(), ['chat_log', 'guilds', 'items', 'players', 'quests_progress', 'snapshots']);
  });

  it('is idempotent by construction (every CREATE uses IF NOT EXISTS)', () => {
    const creates = MIGRATE_SQL.match(/CREATE\s+(TABLE|INDEX)[\s\S]*?;/g) ?? [];
    assert.ok(creates.length >= 10, `expected >=10 DDL statements, got ${creates.length}`);
    for (const stmt of creates) {
      assert.ok(/IF NOT EXISTS/.test(stmt), `not idempotent: ${stmt.slice(0, 80)}`);
    }
  });

  it('migrate.sql file matches the MIGRATE_SQL runtime constant', () => {
    const file = findMigrateSql();
    assert.ok(file, 'migrate.sql not found next to sources');
    const norm = (s: string) => s.replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(norm(file!), norm(MIGRATE_SQL));
  });

  it('applies twice cleanly (translated SERIAL for sqlite)', () => {
    let DatabaseSync: new (f: string) => { exec: (s: string) => void; close: () => void };
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch {
      console.log('(skip) node:sqlite unavailable');
      return;
    }
    const translated = MIGRATE_SQL.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(translated);
      db.exec(translated); // second run must be a no-op, not an error
    } finally {
      db.close();
    }
  });
});

describe('persist/pg', () => {
  it('buildSnapshotBatchInsert builds a single multi-row INSERT', () => {
    const empty = buildSnapshotBatchInsert([]);
    assert.deepEqual(empty.values, []);
    const { text, values } = buildSnapshotBatchInsert([
      { tick: 100, json: '{}', at: 1 },
      { tick: 200, json: '[]', at: 2 },
    ]);
    assert.ok(text.startsWith('INSERT INTO snapshots (tick, json, at) VALUES ($1, $2, $3), ($4, $5, $6)'), text);
    assert.deepEqual(values, [100, '{}', 1, 200, '[]', 2]);
  });

  it('PostgresMirror runs CRUD against an injected pool', async () => {
    const seen: string[] = [];
    const fake: PoolLike = {
      query: async (text: string) => {
        seen.push(text);
        if (/RETURNING/.test(text)) return { rows: [{ id: 7, sender: 'a', text: 'hi', channel: 'say', at: 9 }] };
        if (/FROM players/.test(text)) return { rows: [{ id: 1, name: 'n', x: 2, y: 3, hp: 4, updated: 5 }] };
        if (/FROM guilds/.test(text)) return { rows: [{ id: 3, name: 'g', owner_id: 1, members: '[]', created_at: 6 }] };
        if (/FROM items/.test(text)) return { rows: [{ player_id: 1, item_id: 'sword', qty: 2, updated: 8 }] };
        if (/FROM quests_progress/.test(text)) return { rows: [{ player_id: 1, quest_id: 'q1', stage: 2, done: true, updated: 8 }] };
        if (/FROM chat_log/.test(text)) return { rows: [{ id: 7, sender: 'a', text: 'hi', channel: 'say', at: 9 }] };
        return { rows: [] };
      },
      end: async () => undefined,
    };
    const m = new PostgresMirror('postgres://fake/db', fake);
    assert.equal(await m.ready, true);
    assert.ok(await m.upsertPlayer({ id: 1, name: 'n', x: 2, y: 3, hp: 4, updated: 5 }));
    assert.deepEqual(await m.getPlayer(1), { id: 1, name: 'n', x: 2, y: 3, hp: 4, updated: 5 });
    assert.equal(await m.saveSnapshotsBatch([{ tick: 1, json: '{}', at: 1 }]), 1);
    assert.deepEqual(await m.logChat('a', 'hi', 'say'), { id: 7, from: 'a', text: 'hi', channel: 'say', at: 9 });
    assert.deepEqual(await m.recentChat(5), [{ id: 7, from: 'a', text: 'hi', channel: 'say', at: 9 }]);
    assert.ok(await m.upsertGuild('g', 1, '[]'));
    assert.deepEqual(await m.getGuild('g'), { id: 3, name: 'g', owner_id: 1, members: '[]', created_at: 6 });
    assert.ok(await m.setItem(1, 'sword', 2));
    assert.deepEqual(await m.getItems(1), [{ player_id: 1, item_id: 'sword', qty: 2, updated: 8 }]);
    assert.ok(await m.setQuestProgress(1, 'q1', 2, true));
    assert.deepEqual(await m.getQuestProgress(1), [{ player_id: 1, quest_id: 'q1', stage: 2, done: true, updated: 8 }]);
    assert.ok(seen[0].includes('CREATE TABLE IF NOT EXISTS players'), 'migrate runs first');
    await m.close();
  });

  it('PostgresMirror reports not-ready when migrate fails', async () => {
    const failing: PoolLike = {
      query: async () => {
        throw new Error('nope');
      },
      end: async () => undefined,
    };
    const m = new PostgresMirror('postgres://fake/db', failing);
    assert.equal(await m.ready, false);
    assert.equal(m.connected, false);
    assert.equal(await m.saveSnapshotsBatch([{ tick: 1, json: '{}', at: 1 }]), 0);
  });
});

describe('db boot fallback', () => {
  const savedUrl = process.env.DATABASE_URL;
  before(() => {
    delete process.env.DATABASE_URL;
  });

  it('boots without DATABASE_URL and round-trips all tables', () => {
    delete process.env.DATABASE_URL;
    const db = new DB(':memory:');
    try {
      assert.ok(['better-sqlite3', 'node:sqlite', 'json'].includes(db.localBackend), db.localBackend);
      const now = Date.now();
      db.upsertPlayer({ id: 1, name: 'hero', x: 5, y: 6, hp: 90, updated: now });
      // node:sqlite rows carry a null prototype — spread before comparing.
      assert.deepEqual({ ...db.getPlayer(1)! }, { id: 1, name: 'hero', x: 5, y: 6, hp: 90, updated: now });

      const g = db.upsertGuild('Knights', 1, JSON.stringify([1]));
      assert.equal(g.name, 'Knights');
      assert.equal(db.getGuild('Knights')?.ownerId, 1);

      db.setItem(1, 'iron-sword', 2);
      assert.deepEqual(db.getItems(1).map((i) => [i.itemId, i.qty]), [['iron-sword', 2]]);

      db.setQuestProgress(1, 'maren-1', 2, false);
      assert.deepEqual(db.getQuestProgress(1).map((q) => [q.questId, q.stage, q.done]), [['maren-1', 2, false]]);

      const c = db.logChat('hero', 'hello', 'say');
      assert.equal(c.text, 'hello');
      assert.equal(db.recentChat(5).at(-1)?.text, 'hello');

      db.saveSnapshot(100, '{"tick":100}');
      assert.equal(db.pendingSnapshots, 1);
      assert.equal(db.flushSnapshots(), 1);
      assert.equal(db.pendingSnapshots, 0);
      assert.ok(db.recentSnapshots(5).some((s) => s.tick === 100));
      db.checkpoint(); // must not throw
    } finally {
      db.close();
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  });

  it('unreachable DATABASE_URL falls back instead of crashing boot', async () => {
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/nope';
    const db = new DB(':memory:');
    try {
      const ok = await db.pgReady;
      assert.equal(ok, false);
      assert.equal(db.usingPostgres, false);
      assert.ok(['better-sqlite3', 'node:sqlite', 'json'].includes(db.backend), db.backend);
      db.upsertPlayer({ id: 9, name: 'fallback', x: 0, y: 0, hp: 100, updated: Date.now() });
      assert.equal(db.getPlayer(9)?.name, 'fallback');
    } finally {
      db.close();
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    }
  });
});

describe('persist/presence', () => {
  it('memory backend: online, shard assignment, TTL expiry', async () => {
    const p = new Presence({ ttlSec: 0.06 });
    assert.equal(p.backend, 'memory');
    await p.heartbeat(1, 'shard-0');
    await p.heartbeat(2, 'shard-1');
    assert.equal(await p.isOnline(1), true);
    assert.equal(await p.getShard(2), 'shard-1');
    assert.deepEqual((await p.onlineIds()).sort(), ['1', '2']);
    await sleep(150);
    assert.equal(await p.isOnline(1), false);
    assert.equal(await p.getShard(1), null);
    await p.close();
  });

  it('heartbeat refreshes TTL and leave() drops immediately', async () => {
    const p = new Presence({ ttlSec: 0.08 });
    await p.heartbeat(5, 'shard-0');
    await sleep(50);
    await p.heartbeat(5, 'shard-2'); // refresh + move shard
    assert.equal(await p.getShard(5), 'shard-2');
    await sleep(50);
    assert.equal(await p.isOnline(5), true); // refreshed deadline survives
    await p.leave(5);
    assert.equal(await p.isOnline(5), false);
    assert.equal(p.prune(), 0);
    await p.close();
  });

  it('prune() sweeps only expired entries', async () => {
    const p = new Presence({ ttlSec: 0.05 });
    await p.heartbeat('a', 'shard-0');
    await sleep(100);
    await p.heartbeat('b', 'shard-0');
    assert.equal(p.prune(), 1);
    assert.deepEqual(await p.onlineIds(), ['b']);
    await p.close();
  });

  it('redis backend works against an injected fake', async () => {
    const store = new Map<string, { v: string; exp: number }>();
    const fake = {
      setex: async (k: string, ttl: number, v: string) => {
        store.set(k, { v, exp: Date.now() + ttl * 1000 });
      },
      get: async (k: string) => {
        const e = store.get(k);
        if (!e || e.exp <= Date.now()) {
          store.delete(k);
          return null;
        }
        return e.v;
      },
      del: async (k: string) => {
        store.delete(k);
      },
      keys: async (pat: string) => {
        const prefix = pat.replace(/\*$/, '');
        return [...store.keys()].filter((k) => k.startsWith(prefix));
      },
      quit: async () => undefined,
    };
    const p = new Presence({ ttlSec: 10, redis: fake });
    assert.equal(await p.ready, true);
    assert.equal(p.backend, 'redis');
    await p.heartbeat(42, 'shard-3');
    assert.equal(await p.isOnline(42), true);
    assert.equal(await p.getShard(42), 'shard-3');
    assert.deepEqual(await p.onlineIds(), ['42']);
    await p.leave(42);
    assert.equal(await p.isOnline(42), false);
    await p.close();
  });
});
