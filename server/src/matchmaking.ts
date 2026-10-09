// @aetherfall/server — matchmaking queue (least-loaded assignment -> redirect)
// plus the cross-shard player-transfer stub (serialize pos/hp/inv/quests).
import type { ServerMsg } from '@aetherfall/shared';
import type { Inventory } from './game/inventory.js';
import type { QuestState } from './game/quests.js';
import { ensurePlayer, setPlayerPos, type GameState } from './game/index.js';
import type { ShardInfo, ShardRouter } from './shard.js';

export type MatchRequest = { playerId: number | string; name: string; enqueuedAt: number };

export class Matchmaker {
  private queue: MatchRequest[] = [];

  constructor(private router: ShardRouter) {}

  /** Queue a join; returns 1-based position. Idempotent per playerId. */
  join(playerId: number | string, name: string): number {
    const existing = this.queue.findIndex((q) => q.playerId === playerId);
    if (existing >= 0) return existing + 1;
    this.queue.push({ playerId, name, enqueuedAt: Date.now() });
    return this.queue.length;
  }

  leave(playerId: number | string): boolean {
    const i = this.queue.findIndex((q) => q.playerId === playerId);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  get size(): number {
    return this.queue.length;
  }

  /** Least-loaded shard per the router registry. */
  assign(): ShardInfo {
    return this.router.leastLoaded();
  }

  /**
   * Pop the queue head and assign it the least-loaded shard.
   * Returns the redirect event the server sends before closing the socket —
   * the client reconnects to `payload.url` (protocol v1: `event` envelope).
   */
  assignNext(): { request: MatchRequest; shard: ShardInfo; event: ServerMsg } | null {
    const request = this.queue.shift();
    if (!request) return null;
    const shard = this.assign();
    return { request, shard, event: redirectTo(shard) };
  }

  /** Redirect event for one player to the least-loaded shard. */
  assignPlayer(): ServerMsg {
    return redirectTo(this.assign());
  }
}

/** `{t:'event',kind:'redirect',payload:{url,shard}}` for a shard. */
export function redirectTo(shard: Pick<ShardInfo, 'shardId' | 'host'>): ServerMsg {
  return { t: 'event', kind: 'redirect', payload: { url: shard.host, shard: shard.shardId } };
}

// --- player transfer stub -------------------------------------------------

export const TRANSFER_VERSION = 1;

export type TransferSnapshot = {
  v: number;
  id: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  inv: Inventory;
  quests: QuestState;
};

export type TransferOut = {
  id: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  inv: Inventory;
  quests: QuestState;
};

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Serialize a live player (sim pos/hp + gameplay inv/quests) for transfer. */
export function transferOut(p: TransferOut): string {
  const snap: TransferSnapshot = {
    v: TRANSFER_VERSION,
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    hp: p.hp,
    maxHp: p.maxHp,
    inv: p.inv,
    quests: p.quests,
  };
  return JSON.stringify(snap);
}

function validInventory(inv: unknown): inv is Inventory {
  if (!inv || typeof inv !== 'object') return false;
  const slots = (inv as { slots?: unknown }).slots;
  if (!Array.isArray(slots) || slots.length > 20) return false;
  for (const s of slots) {
    if (s === null) continue;
    if (!s || typeof s !== 'object') return false;
    const { itemId, count } = s as { itemId?: unknown; count?: unknown };
    if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 64) return false;
    if (!isFiniteNum(count) || count < 1 || count > 99) return false;
  }
  return true;
}

function validQuests(q: unknown): q is QuestState {
  if (!q || typeof q !== 'object') return false;
  const { progress, level, xp } = q as { progress?: unknown; level?: unknown; xp?: unknown };
  if (!isFiniteNum(level) || !isFiniteNum(xp)) return false;
  if (!progress || typeof progress !== 'object') return false;
  for (const p of Object.values(progress as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') return false;
    const { questId, count } = p as { questId?: unknown; count?: unknown };
    if (typeof questId !== 'string' || !isFiniteNum(count)) return false;
  }
  return true;
}

/** Deserialize + validate a transfer payload. Throws on malformed input. */
export function transferIn(json: string): TransferSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new Error('transfer: invalid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('transfer: not an object');
  const o = raw as Record<string, unknown>;
  if (o.v !== TRANSFER_VERSION) throw new Error(`transfer: unsupported version (${String(o.v)})`);
  if (!isFiniteNum(o.id) || typeof o.name !== 'string' || o.name.length === 0) {
    throw new Error('transfer: bad identity');
  }
  for (const k of ['x', 'y', 'hp', 'maxHp'] as const) {
    if (!isFiniteNum(o[k])) throw new Error(`transfer: bad ${k}`);
  }
  if (!validInventory(o.inv)) throw new Error('transfer: bad inventory');
  if (!validQuests(o.quests)) throw new Error('transfer: bad quests');
  return raw as TransferSnapshot;
}

/**
 * Apply a validated snapshot to a destination shard's gameplay state:
 * ensures the player, restores pos/inventory/quests. (Sim entity + socket
 * attach remain the caller's job; see docs/SHARDING.md.)
 */
export function applyTransfer(game: GameState, snap: TransferSnapshot): void {
  const p = ensurePlayer(game, snap.id, snap.name, snap.x, snap.y);
  setPlayerPos(game, snap.id, snap.x, snap.y);
  p.inv = snap.inv;
  p.quests = snap.quests;
}
