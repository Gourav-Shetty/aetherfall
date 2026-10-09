// @aetherfall/server — cross-shard global-chat relay.
// Transport selection: REDIS_URL set (+ `redis` package resolvable) -> redis
// pub/sub on channel `aetherfall:global-chat`; otherwise an in-process
// EventEmitter bus (single-process default, zero deps).
// Receivers MUST skip messages whose `origin` equals their own shard id — that
// is what keeps the relay loop-free in both single- and multi-process setups.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

export type GlobalChatMsg = {
  from: string;
  text: string;
  channel: string;
  /** Shard that first accepted the message; receivers skip their own. */
  origin: string;
  at?: number;
};

export type Unsubscribe = () => void;

export interface ChatTransport {
  readonly kind: 'memory' | 'redis';
  publish(msg: GlobalChatMsg): void;
  subscribe(fn: (msg: GlobalChatMsg) => void): Unsubscribe;
  close(): void;
}

export function isRemote(msg: GlobalChatMsg, localShardId: string): boolean {
  return msg.origin !== localShardId;
}

function sanitize(msg: GlobalChatMsg): GlobalChatMsg | null {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.from !== 'string' || typeof msg.text !== 'string') return null;
  if (typeof msg.origin !== 'string' || typeof msg.channel !== 'string') return null;
  const text = msg.text.slice(0, 200);
  if (text.trim().length === 0) return null;
  return { from: msg.from.slice(0, 16), text, channel: msg.channel, origin: msg.origin, at: msg.at };
}

export class InMemoryChatBus implements ChatTransport {
  readonly kind = 'memory' as const;
  private emitter = new EventEmitter();

  publish(msg: GlobalChatMsg): void {
    const clean = sanitize(msg);
    if (!clean) return;
    this.emitter.emit('global-chat', clean);
  }

  subscribe(fn: (msg: GlobalChatMsg) => void): Unsubscribe {
    const handler = (msg: GlobalChatMsg): void => {
      try {
        fn(msg);
      } catch {
        /* subscriber bugs must not break the bus */
      }
    };
    this.emitter.on('global-chat', handler);
    return () => {
      this.emitter.off('global-chat', handler);
    };
  }

  close(): void {
    this.emitter.removeAllListeners('global-chat');
  }
}

// Redis transport is best-effort and optional: `redis` is NOT a server
// dependency. When REDIS_URL is set but the package is missing (or the
// connection fails), we warn once and fall back to the in-memory bus so the
// server always boots. Install `redis` + set REDIS_URL to enable true
// multi-process relay (see docs/SHARDING.md).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

class RedisChatBus implements ChatTransport {
  readonly kind = 'redis' as const;
  private pub: RedisClient;
  private sub: RedisClient;
  private emitter = new EventEmitter();
  private closed = false;
  private static readonly CHANNEL = 'aetherfall:global-chat';

  private constructor(pub: RedisClient, sub: RedisClient) {
    this.pub = pub;
    this.sub = sub;
  }

  static async create(url: string): Promise<RedisChatBus | null> {
    try {
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod = require('redis') as { createClient: (opts: { url: string }) => RedisClient };
      if (!mod || typeof mod.createClient !== 'function') return null;
      const pub = mod.createClient({ url });
      const sub = mod.createClient({ url });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      pub.on('error', () => {});
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sub.on('error', () => {});
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await Promise.all([pub.connect(), sub.connect()]);
      const bus = new RedisChatBus(pub, sub);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await sub.subscribe(RedisChatBus.CHANNEL, (raw: string) => {
        if (bus.closed) return;
        try {
          const parsed = JSON.parse(raw) as GlobalChatMsg;
          const clean = sanitize(parsed);
          if (clean) bus.emitter.emit('global-chat', clean);
        } catch {
          /* malformed payload ignored */
        }
      });
      return bus;
    } catch {
      return null;
    }
  }

  publish(msg: GlobalChatMsg): void {
    if (this.closed) return;
    const clean = sanitize(msg);
    if (!clean) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      void Promise.resolve(this.pub.publish(RedisChatBus.CHANNEL, JSON.stringify(clean))).catch(() => {});
    } catch {
      /* publish is fire-and-forget */
    }
  }

  subscribe(fn: (msg: GlobalChatMsg) => void): Unsubscribe {
    const handler = (msg: GlobalChatMsg): void => {
      try {
        fn(msg);
      } catch {
        /* ignore */
      }
    };
    this.emitter.on('global-chat', handler);
    return () => {
      this.emitter.off('global-chat', handler);
    };
  }

  close(): void {
    this.closed = true;
    this.emitter.removeAllListeners('global-chat');
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      void Promise.resolve(this.pub.quit()).catch(() => {});
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      void Promise.resolve(this.sub.quit()).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

export type ChatBusOptions = { redisUrl?: string };

/**
 * Create the global-chat relay. Synchronous fast path: REDIS_URL unset ->
 * in-memory bus. REDIS_URL set -> kicks off an async redis connect and
 * returns an in-memory bus immediately; callers can `await busReady` via the
 * `upgrade` hook when they need the redis transport before serving.
 */
export function createChatBus(opts: ChatBusOptions = {}): ChatTransport {
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  if (!url) return new InMemoryChatBus();
  // Async best-effort upgrade; the returned handle swaps itself when ready.
  const handle = new UpgradeableChatBus(url);
  void handle.upgrade();
  return handle;
}

/** Starts in-memory, swaps to redis once connected (falls back silently). */
class UpgradeableChatBus implements ChatTransport {
  readonly kind = 'memory' as const;
  private inner: ChatTransport = new InMemoryChatBus();
  private warned = false;

  constructor(private url: string) {}

  async upgrade(): Promise<void> {
    const redis = await RedisChatBus.create(this.url);
    if (redis) {
      const old = this.inner;
      // Replay nothing — chat is ephemeral; just swap transports.
      this.inner = redis;
      old.close();
    } else if (!this.warned) {
      this.warned = true;
      console.warn('[shard] REDIS_URL set but redis unavailable; using in-process chat relay');
    }
  }

  publish(msg: GlobalChatMsg): void {
    this.inner.publish(msg);
  }

  subscribe(fn: (msg: GlobalChatMsg) => void): Unsubscribe {
    return this.inner.subscribe(fn);
  }

  close(): void {
    this.inner.close();
  }
}
