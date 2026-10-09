// @aetherfall/server — shard router: rendezvous-hash sticky routing, registry,
// per-shard load (players, tickMs) for matchmaking, and local node health.
// Single-shard default: SHARDS unset -> only the local shard exists and
// routePlayer() always returns it (previous stub behavior preserved).
import { helloRouteKey, parseShardHosts, routePlayer as rendezvousRoute } from './router/index.js';

export const SHARD_ID = process.env.SHARD_ID ?? 'shard-0';

export type ShardInfo = {
  shardId: string;
  host: string;
  players: number;
  /** Last observed main-loop tick duration in ms (load signal for matchmaking). */
  tickMs?: number;
};

/** Standalone sticky route: `routePlayer(playerId, shardList)` (rendezvous). */
export function routePlayer(playerId: number | string, shardList: readonly string[]): string {
  return rendezvousRoute(playerId, shardList);
}

export class ShardRouter {
  readonly localShardId: string;
  private shards = new Map<string, ShardInfo>();

  constructor(shardId: string = SHARD_ID) {
    this.localShardId = shardId;
    this.shards.set(shardId, { shardId, host: `ws://localhost:${process.env.PORT ?? 8081}`, players: 0 });
  }

  /** Build a router from SHARD_ID/SHARDS env (multi-shard registry). */
  static fromEnv(): ShardRouter {
    const local = process.env.SHARD_ID ?? 'shard-0';
    const router = new ShardRouter(local);
    for (const e of parseShardHosts()) {
      if (e.shardId === local) {
        const cur = router.shards.get(local);
        if (cur) cur.host = e.host;
        continue;
      }
      router.shards.set(e.shardId, { shardId: e.shardId, host: e.host, players: 0 });
    }
    return router;
  }

  register(info: ShardInfo): void {
    this.shards.set(info.shardId, info);
  }

  unregister(shardId: string): void {
    if (shardId !== this.localShardId) this.shards.delete(shardId);
  }

  get(shardId: string): ShardInfo | undefined {
    return this.shards.get(shardId);
  }

  /** Sticky route via rendezvous hashing over the live registry. */
  routePlayer(playerId: number | string): string {
    return rendezvousRoute(playerId, [...this.shards.keys()]);
  }

  /**
   * Sticky route for an untrusted hello object: keys on the CLIENT-stable
   * identity (`nonce ?? token ?? name`, see `helloRouteKey`), never on the
   * per-shard admit counter. Every shard computes the same owner for the same
   * hello, so a redirect-following client lands after at most 1 hop. This is
   * the method the socket hello path must use; `routePlayer` stays for call
   * sites that already hold a stable id.
   */
  routeHello(hello: unknown): string {
    return rendezvousRoute(helloRouteKey(hello), [...this.shards.keys()]);
  }

  /** Least-loaded shard: fewest players, then lowest tickMs, then shardId. */
  leastLoaded(): ShardInfo {
    let best: ShardInfo | undefined;
    for (const s of this.shards.values()) {
      if (!best) {
        best = s;
        continue;
      }
      if (
        s.players < best.players ||
        (s.players === best.players && (s.tickMs ?? 0) < (best.tickMs ?? 0)) ||
        (s.players === best.players && (s.tickMs ?? 0) === (best.tickMs ?? 0) && s.shardId < best.shardId)
      ) {
        best = s;
      }
    }
    // Registry never empties (local shard is pinned), but stay total.
    return best ?? { shardId: this.localShardId, host: '', players: 0 };
  }

  /** Heartbeat update from a shard's /healthz (or local tick). */
  updateLoad(shardId: string, players: number, tickMs: number): void {
    const s = this.shards.get(shardId);
    if (s) {
      s.players = players;
      s.tickMs = tickMs;
    }
  }

  setLocalPlayers(n: number): void {
    const s = this.shards.get(this.localShardId);
    if (s) s.players = n;
  }

  setLocalTickMs(ms: number): void {
    const s = this.shards.get(this.localShardId);
    if (s) s.tickMs = ms;
  }

  list(): ShardInfo[] {
    return [...this.shards.values()];
  }
}

/**
 * Local shard node: owns load reporting (players, tickMs) for /healthz.
 * The server loop calls setLoad() per tick; health() shapes the probe body.
 */
export class ShardNode {
  players = 0;
  tickMs = 0;

  constructor(
    readonly shardId: string = SHARD_ID,
    readonly startedAt: number = Date.now(),
  ) {}

  setLoad(players: number, tickMs: number): void {
    this.players = players;
    this.tickMs = tickMs;
  }

  health(tick: number): {
    ok: boolean;
    shard: string;
    tick: number;
    players: number;
    tickMs: number;
    uptime: number;
  } {
    return {
      ok: true,
      shard: this.shardId,
      tick,
      players: this.players,
      tickMs: this.tickMs,
      uptime: process.uptime(),
    };
  }
}
