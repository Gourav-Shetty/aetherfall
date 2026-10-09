# Architecture
- Authoritative server 20Hz, snapshots 10Hz, client prediction + reconciliation.
- ECS on both sides (shared sim code), spatial hash for interest (40m), chunk streaming.
- Sharding stub: single shard now, router reserves shardId for MMO scale.
- Persistence: SQLite dev (WAL), Postgres-ready schema in server/src/db.ts.
- Anti-cheat: input rate limit, speed clamp, teleport reject, server re-sim.

## Server modules
- `server/src/sim.ts` — deterministic fixed-tick sim (`Sim`): integrates player
  velocity over `World` + `SpatialHash` from `@aetherfall/engine`, arena clamp
  (100x100), friction, `tick` counter. Gameplay systems plug in via
  `registerSystem(hook, pre?)` hooks — server owns the loop, gameplay owns the rules.
- `server/src/interest.ts` — 40m radius culling per player (`filterInterest`,
  `INTEREST_RADIUS=40`). `InterestTracker` keeps per-viewer known sets and
  computes `removed[]` so clients evict out-of-range/despawned entities.
- `server/src/anticheat.ts` — `AntiCheat` class: input-rate limit (15ms min,
  >66Hz rejected), speed clamp (8 u/s), teleport reject (max 5 units/step).
  All rejects append to an in-memory `violations[]` log (warned to console).
- `server/src/db.ts` — `DB` class, schema `players | snapshots | chat_log`.
  Backend order: `better-sqlite3` (if installed) -> `node:sqlite` WAL at
  `./data/aetherfall.db` -> JSON fallback at `./data/db.json`. Never crashes
  boot: falls back silently. Snapshots persisted every 5s, player rows on
  join/leave, chat appended on every message.
- `server/src/auth.ts` — JWT-less dev tokens: `issueToken(name)` produces
  `b64(name).exp.hmac_sha256(secret, payload)`; `verifyToken` checks HMAC
  (timing-safe) + expiry; `guestIdentity` for token-less dev login.
  `resolveIdentity(name, token)` prefers token, falls back to guest.
- `server/src/shard.ts` — `ShardRouter` stub: `localShardId` from `SHARD_ID`
  env (default `shard-0`), `routePlayer()` pins to local shard, `register/
  unregister/list` reserved for cross-shard transfer.
- `server/src/index.ts` — wires it all: hello (proto check + identity + welcome
  with interest-filtered snapshot) -> input (anticheat -> sim velocity) ->
  per-tick interest-filtered `snapshot{entities, removed}` @10Hz.
