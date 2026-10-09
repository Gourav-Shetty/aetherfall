// @aetherfall/server — persist/presence: online players + shard assignment.
// Redis (ioredis) when REDIS_URL is set, else in-memory Map.
// Heartbeats refresh a 10s TTL (configurable). Boot-safe: construction never
// throws and never blocks; Redis failures warn + fall back to memory.

export const PRESENCE_TTL_SEC = 10;
const KEY_PREFIX = 'presence:';

type MemEntry = { shard: string; expires: number };

// Minimal Redis surface used (real ioredis satisfies this).
export type RedisLike = {
  setex: (key: string, ttlSec: number, value: string) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<unknown>;
  keys: (pattern: string) => Promise<string[]>;
  quit: () => Promise<unknown>;
};

export class Presence {
  readonly backend: 'redis' | 'memory';
  readonly ttlSec: number;
  private mem = new Map<string, MemEntry>();
  private redis: RedisLike | null = null;
  private redisReady = false;
  /** Resolves true once Redis is usable; false when staying on memory. */
  readonly ready: Promise<boolean>;

  constructor(opts: { url?: string; ttlSec?: number; redis?: RedisLike } = {}) {
    this.ttlSec = opts.ttlSec ?? PRESENCE_TTL_SEC;
    if (opts.redis) {
      this.backend = 'redis';
      this.redis = opts.redis;
      this.ready = (async () => {
        try {
          await opts.redis!.setex(`${KEY_PREFIX}__probe`, 1, '1');
          await opts.redis!.del(`${KEY_PREFIX}__probe`);
          this.redisReady = true;
          return true;
        } catch (err) {
          console.warn(`[persist/presence] injected redis unusable, memory fallback: ${(err as Error)?.message ?? err}`);
          this.redis = null;
          return false;
        }
      })();
      return;
    }
    const url = opts.url ?? process.env.REDIS_URL;
    if (!url) {
      this.backend = 'memory';
      this.ready = Promise.resolve(false);
      return;
    }
    this.backend = 'redis';
    this.ready = this.connectRedis(url);
  }

  private async connectRedis(url: string): Promise<boolean> {
    try {
      const mod = (await import('ioredis')) as unknown as {
        default?: new (u: string, o?: Record<string, unknown>) => RedisLike & { on?: (e: string, f: (...a: unknown[]) => void) => void };
      };
      const Ctor = mod.default;
      if (!Ctor) throw new Error('ioredis module has no default export');
      const client = new Ctor(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 4000 });
      const connectable = client as unknown as { connect?: () => Promise<void> };
      if (typeof connectable.connect === 'function') await connectable.connect();
      await client.setex(`${KEY_PREFIX}__probe`, 1, '1');
      await client.del(`${KEY_PREFIX}__probe`);
      this.redis = client;
      this.redisReady = true;
      console.log('[persist/presence] redis backend ready');
      return true;
    } catch (err) {
      console.warn(`[persist/presence] redis unavailable, memory fallback: ${(err as Error)?.message ?? err}`);
      this.redis = null;
      return false;
    }
  }

  private key(id: number | string): string {
    return `${KEY_PREFIX}${id}`;
  }

  /** Heartbeat: mark player online on a shard, refresh TTL. */
  async heartbeat(playerId: number | string, shardId: string): Promise<void> {
    if (this.redis && this.redisReady) {
      try {
        await this.redis.setex(this.key(playerId), this.ttlSec, shardId);
        return;
      } catch (err) {
        console.warn(`[persist/presence] heartbeat redis failed, memory fallback: ${(err as Error)?.message ?? err}`);
        this.redis = null;
        this.redisReady = false;
      }
    }
    this.mem.set(String(playerId), { shard: shardId, expires: Date.now() + this.ttlSec * 1000 });
  }

  async isOnline(playerId: number | string): Promise<boolean> {
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.get(this.key(playerId));
        if (v !== null) return true;
        // fall through to memory (may hold newer heartbeats from fallback window)
      } catch {
        /* fall through */
      }
    }
    const e = this.mem.get(String(playerId));
    if (!e) return false;
    if (e.expires <= Date.now()) {
      this.mem.delete(String(playerId));
      return false;
    }
    return true;
  }

  async getShard(playerId: number | string): Promise<string | null> {
    if (this.redis && this.redisReady) {
      try {
        const v = await this.redis.get(this.key(playerId));
        if (v !== null) return v;
      } catch {
        /* fall through */
      }
    }
    const e = this.mem.get(String(playerId));
    if (!e || e.expires <= Date.now()) {
      if (e) this.mem.delete(String(playerId));
      return null;
    }
    return e.shard;
  }

  /** Remove a player immediately (logout). */
  async leave(playerId: number | string): Promise<void> {
    this.mem.delete(String(playerId));
    if (this.redis && this.redisReady) {
      try {
        await this.redis.del(this.key(playerId));
      } catch {
        /* ignore */
      }
    }
  }

  /** Sweep expired memory entries; returns ids still online. */
  async onlineIds(): Promise<string[]> {
    const now = Date.now();
    for (const [k, e] of this.mem) if (e.expires <= now) this.mem.delete(k);
    const ids = [...this.mem.keys()];
    if (this.redis && this.redisReady) {
      try {
        const keys = await this.redis.keys(`${KEY_PREFIX}*`);
        for (const k of keys) {
          const id = k.slice(KEY_PREFIX.length);
          if (id !== '__probe' && !ids.includes(id)) ids.push(id);
        }
      } catch {
        /* ignore */
      }
    }
    return ids;
  }

  /** Drop expired memory entries; returns number removed. */
  prune(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, e] of this.mem) {
      if (e.expires <= now) {
        this.mem.delete(k);
        n++;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    this.mem.clear();
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        /* ignore */
      }
      this.redis = null;
      this.redisReady = false;
    }
  }
}

/** Env factory: Redis when REDIS_URL is set, else memory. Never throws. */
export function createPresenceFromEnv(ttlSec = PRESENCE_TTL_SEC): Presence {
  try {
    return new Presence({ ttlSec });
  } catch (err) {
    console.warn(`[persist/presence] constructor failed, memory fallback: ${(err as Error)?.message ?? err}`);
    const p = Object.create(Presence.prototype) as Presence;
    return p;
  }
}
