// @aetherfall/server — shard registry: parse SHARDS env into a stable shard list.
// Format: SHARDS="ws://host1:8081,ws://host2:8081" -> shard-0, shard-1, ...
// Unset/empty -> single local shard (default: zero behavior change).

export type ShardEntry = { shardId: string; host: string };

function localHost(): string {
  return `ws://localhost:${process.env.PORT ?? 8081}`;
}

/** Parse a SHARDS env value into entries. Never throws, never returns empty. */
export function parseShardHosts(envVal?: string): ShardEntry[] {
  const raw = (envVal ?? process.env.SHARDS ?? '').trim();
  if (!raw) {
    return [{ shardId: process.env.SHARD_ID ?? 'shard-0', host: localHost() }];
  }
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (hosts.length === 0) {
    return [{ shardId: process.env.SHARD_ID ?? 'shard-0', host: localHost() }];
  }
  return hosts.map((host, i) => ({ shardId: `shard-${i}`, host }));
}

/** Shard ids for a list of entries (routing key order = registry order). */
export function shardIdsOf(entries: readonly ShardEntry[]): string[] {
  return entries.map((e) => e.shardId);
}
