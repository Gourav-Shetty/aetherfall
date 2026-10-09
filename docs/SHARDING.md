# Sharding

Horizontal scale-out for AETHERFALL: sticky player→shard routing, a
least-loaded matchmaking queue, cross-shard global chat, and a player-transfer
stub. **Single-shard default is unchanged**: with no env set, everything
routes locally and no redirects are ever sent.

## Env

| Var | Default | Meaning |
| --- | ------- | ------- |
| `SHARD_ID` | `shard-0` | This process's shard id |
| `SHARDS` | (local only) | Comma-separated WS hosts, e.g. `ws://a:8081,ws://b:8081` → `shard-0`, `shard-1`, … |
| `REDIS_URL` | (unset) | Set to use redis pub/sub for global chat (needs the optional `redis` npm package) |
| `MAX_PLAYERS_PER_SHARD` | `Infinity` | Overflow admission threshold; full shards redirect to least-loaded |

## Routing (`server/src/shard.ts`, `server/src/router/`)

- `routePlayer(playerId, shardList)` — **rendezvous (highest-random-weight)
  hashing**: each shard scores `FNV1a(playerId::shardId)`, highest wins.
  Deterministic, no ring maintenance.
- Membership churn is bounded: adding/removing a shard only moves players that
  mapped to that shard (~1/N), verified `<30%` in `shard.test.ts`.
- `ShardRouter.fromEnv()` builds the registry from `SHARDS`; `leastLoaded()`
  picks fewest players → lowest `tickMs` → lowest id (used by matchmaking).
- `ShardNode` tracks load (`players`, `tickMs`, updated every tick) and shapes
  the `/healthz` body: `{ok, shard, tick, players, tickMs, uptime, shards}`.

## Matchmaking (`server/src/matchmaking.ts`)

- `Matchmaker.join/leave/assignNext()` — FIFO queue; `assignNext()` pops the
  head and returns `{request, shard, event}` where `event` is the redirect.
- Redirect wire shape (protocol-v1 safe `event` envelope):
  `{t:'event',kind:'redirect',payload:{url,shard}}` — client reconnects to `url`.
- Server wiring (`index.ts`, hello path):
  1. Sticky route: non-local owners get an immediate redirect + close.
  2. Overflow: when `sockets.size >= MAX_PLAYERS_PER_SHARD`, queue-join and
     redirect to the least-loaded shard (admit locally if we still are it).

## Global chat relay (`server/src/router/pubsub.ts`)

- `createChatBus()` → redis transport when `REDIS_URL` is set **and** the
  optional `redis` package resolves; otherwise an in-process `EventEmitter`
  bus (zero deps). Redis connect is async best-effort — the server always
  boots, falling back with a warning.
- Loop-free by `origin`: publishers tag their `SHARD_ID`; subscribers skip
  their own shard's messages. Local `global`-channel chats are broadcast
  locally **and** published; remote arrivals are broadcast locally only.

## Player transfer (stub)

- `transferOut({id,name,x,y,hp,maxHp,inv,quests}) → JSON` serializes everything
  a destination shard needs; `transferIn(json)` validates (version, finite
  numbers, inventory/quest shapes) and throws on malformed input.
- `applyTransfer(game, snap)` restores the gameplay side (`ensurePlayer` +
  pos + `inv` + `quests`). Sim entity + socket attach remain the caller's job:
  full live migration needs a two-phase handshake (freeze source → transfer →
  resume destination) plus client reconnect to the redirect URL — not yet
  implemented.
- Round-trip covered in `matchmaking.test.ts`.

## Operating

- Run N processes with distinct `PORT`/`METRICS_PORT`/`SHARD_ID` and a shared
  `SHARDS` list. Without redis, each process relays only its own chat;
  set `REDIS_URL` (+ `npm i redis`) for true cross-process global chat.
- Watch `aetherfall_players` per shard + `/healthz → tickMs` to size
  `MAX_PLAYERS_PER_SHARD`.

## Verify (2026-10-02)

Shard wiring in `server/src/index.ts` confirmed committed (no re-apply
needed): sticky-routing redirect, `MAX_PLAYERS` overflow→queue, `/healthz`
`{shard,tick,players,tickMs,shards}`. Walls/anticheat/perf hunks intact,
`git status` clean, `presence.ts` verify-only (untouched).

| Check | Result |
| --- | --- |
| `/healthz` shard-0 (`:9090`) | `ok:true shard:shard-0 players:20 tickMs:~1.05` mid-run, `shards:[shard-0]` |
| `/healthz` shard-1 (`:9091`) | `ok:true shard:shard-1 tickMs:~0.8–1.8`, `shards:[shard-1]` |
| Live bots shard-0 (`ws://localhost:8081`, 20 bots / 12s) | `connected=20/20 errors=0 snapshots=1940 tickGaps=0` |
| Live bots shard-1 (`ws://localhost:8082`, 20 bots / 12s) | `connected=20/20 errors=0 snapshots=1957 tickGaps=0` |
| `Matchmaker.assignNext` least-loaded | pop head → `shard-1` (2 vs 20 players) + `{t:'event',kind:'redirect',payload:{url,shard}}` |
| Tie-break (equal players) | lower `tickMs` wins |
| `transferOut`/`transferIn` round-trip | `id/name/x/y/hp/maxHp/inv/quests` exact (237 B); bad version throws |
| `applyTransfer(game, snap)` | gameplay player restored (pos + `inv` + `quests`) |
| Global chat relay (`createChatBus`, in-process, no redis) | `kind=memory`; origin-suppressed both directions (shard-0 got bob-only, shard-1 got alice-only) |
| `npm run build` + `typecheck` (`@aetherfall/server`) | green |

Live test: two `node dist/index.js` processes
(`PORT=8081/METRICS_PORT=9090/SHARD_ID=shard-0`,
`PORT=8082/METRICS_PORT=9091/SHARD_ID=shard-1`), single-shard default
(no `SHARDS`, so each admits locally); node checks via `verify-shard.mjs`
(8/8 pass, since removed). Jobs killed after.

## Finding (2026-10-03): multi-shard mode admits exactly 1 player

Two measured facts, both about the *cluster*, not the single shard:

1. **Sticky routing deadlocks admission.** The route key is `nextId`
   (`server/src/index.ts`, hello path): `shards.routePlayer(nextId)` decides
   whether to admit, and `pid = nextId++` runs **after** the redirect
   `return`. A shard that does not own id 1 therefore evaluates the same id on
   every inbound hello, redirects forever, and never advances its counter — so
   it never admits anyone. The single shard that does own id 1 admits one
   player, then wedges on id 2 (owned by a different shard, whose own counter
   is still stuck at 1). Measured with all 5 shards booted and a client that
   *follows* redirects: 12 clients -> 67 redirect hops -> **1 admitted**;
   second wave of 12 -> 72 hops -> **0 admitted**. `ops/scripts/start-shards.ps1`
   exports `SHARDS` for every shard, so that cluster is in this state today
   (its smoke test still passes: it only asserts `/healthz`, never player
   counts). Fix: key the route on a stable identity hash (e.g.
   `hashStr(name)` / session id) instead of an admit-ordered counter, and
   advance `nextId` before the redirect so no shard can get stuck.
2. **The bot harness did not follow redirects at the time of measurement.** It counts a socket as
   "connected" on TCP/WS open and then only handles `welcome` / `snapshot` /
   `event:kicked`. A `redirect` envelope is ignored, the socket closes, and it
   retries the same port: 20 bots -> 100 reconnects, 0 snapshots, 0 players
   (`tools/bots/report-redirect-20.csv`). Add redirect handling (reconnect
   to `payload.url`) before using this harness for anything multi-shard.

Capacity numbers therefore come from `SHARDS` **unset** (single-shard default:
every process admits locally, zero redirects) — see `docs/SCALE.md` sharded soak
runbook. Note the `ROUTER` env var named in some runbooks does not exist; the
real knobs are `SHARD_ID`, `SHARDS`, `MAX_PLAYERS_PER_SHARD`, `REDIS_URL`.

## Fix (2026-10-03): stable-key sticky routing

The finding above is fixed; multi-shard mode now admits across the cluster:

- Route key is the CLIENT-stable identity `nonce ?? token ?? name`
  (`helloRouteKey`, `server/src/router/hash.ts`): `nonce` first (canonical;
  aliases `sid` / `clientId` / `routeKey` / `sessionId` normalize to it), then
  auth token, then display name, namespaced by kind. Every shard computes the
  same owner for the same hello, so a redirect-following client lands after at
  most 1 hop. Never key on `nextId` — admit-ordered server state deadlocks
  admission (see finding).
- Thread-through, all additive/optional (old clients without a nonce still
  connect via `token ?? name`): `shared` `ClientMsg.hello.nonce` (+ aliases);
  `validateHello`, `safeParseClientMsg`, and the proto:2 probe preserve it;
  the socket hello path and the overflow queue key on the stable `routeKey`;
  `ShardRouter.routeHello()` is the single choke point (single-shard default
  still always local, no redirects).
- `ops/scripts/start-shards.ps1` needs NO change: a shared `SHARDS` registry +
  per-shard `SHARD_ID` is exactly what rendezvous routing needs — the export
  was only "broken" while the server keyed on `nextId`.

| Check | Result |
| --- | --- |
| `shard-admission.test.ts` (12 nonce clients / 3 shards) | 12 admitted, total hops ≤ 36, spread across all 3 shards; plus name-fallback, cross-shard owner agreement, reconnect determinism, alias, and malformed-key cases |
| Full server suite + typecheck | 587/587 green |
| Live 3 shards (`:8281–:8283`, metrics `:9290–:9292`), 30 bots via entry shard | 30/30 welcomed with snapshots, 23 hops total, max 1 per bot (shard-0: 7 direct + 23 `sticky-route` redirects; shard-1: 11 joins; shard-2: 12 joins; redirect targets match joins exactly — no ping-pong) |
