# AETHERFALL — Persistence (PERSIST-PROD)

Three-tier storage with boot-safe fallback. The server **never crashes on
storage failure**: every backend degrades to the next tier with a `console.warn`.

## Backend tiers (`server/src/db.ts`)

| Tier | When | Notes |
|------|------|-------|
| `postgres` | `DATABASE_URL` set **and** reachable | Pooled `pg` client (max 10), auto-migrates `server/src/persist/migrate.sql` on boot. Local sqlite stays the **synchronous** source of truth; pg is a write-through mirror. |
| `better-sqlite3` / `node:sqlite` | default (no `DATABASE_URL`, or pg down) | WAL mode (`PRAGMA journal_mode=WAL`), file `./data/aetherfall.db`. |
| `json` | no sqlite driver loads | `./data/db.json`, best-effort. Survives read-only FS / minimal containers. |

`db.backend` reports the **effective** backend (`postgres` once the mirror is
live, else the local tier). `db.localBackend`, `db.usingPostgres`, and
`db.pgReady` expose the details for `/healthz` and tests.

### Env vars

| Var | Default | Effect |
|-----|---------|--------|
| `DATABASE_URL` | unset (local tiers) | e.g. `postgres://aether:aether@postgres:5432/aetherfall`. Unreachable/invalid → warn + local fallback, boot continues. |
| `REDIS_URL` | unset (in-memory presence) | e.g. `redis://redis:6379`. Unreachable → warn + in-memory `Map` fallback. |
| `AETHERFALL_NO_SHUTDOWN_HOOK` | unset | Set to `1` to skip SIGINT/SIGTERM flush handlers (used by unit tests). |
| `AETHERFALL_NO_EXIT` | unset | Set to `1` so shutdown handlers flush/close without `process.exit`. |

## Schema (`server/src/persist/migrate.sql`)

Idempotent Postgres DDL — every statement uses `IF NOT EXISTS`, safe to
`psql "$DATABASE_URL" -f server/src/persist/migrate.sql` repeatedly. The server
applies the same SQL automatically when the pg mirror connects. The runtime
source of truth is the `MIGRATE_SQL` constant in
`server/src/persist/migrate.ts` (kept in sync with the `.sql` file by
`persist.test.ts`, so `dist/` needs no `.sql` copy).

Tables: `players`, `snapshots`, `chat_log`, `guilds`, `items`,
`quests_progress`, plus indexes on `snapshots(tick)`, `chat_log(at)`,
`items(player_id)`, `quests_progress(player_id)`.

Timestamps are `BIGINT` millis (`Date.now()`), matching the sqlite fallback.
The sqlite schema in `db.ts` mirrors the same six tables in sqlite dialect
(`AUTOINCREMENT`, `done INTEGER 0/1`).

## Snapshots (5s cadence, batched)

`index.ts` calls `db.saveSnapshot(tick, json)` every 5s of ticks. `DB`
buffers rows and `flushSnapshots()` writes them:

- sqlite: **one transaction** via a prepared `INSERT` (`better-sqlite3`
  `transaction()` when available, else explicit `BEGIN/COMMIT`);
- postgres: **one multi-row INSERT** (`buildSnapshotBatchInsert`);
- auto-flush every 5s **and** when the buffer hits 100 rows;
- `PRAGMA wal_checkpoint(TRUNCATE)` after each flush keeps `-wal`/`-shm` small;
- `close()` and the SIGINT/SIGTERM handlers flush first — no snapshot loss on
  graceful shutdown.

`recentSnapshots()` includes buffered (not-yet-flushed) rows so readers always
see the latest ticks.

## Presence (`server/src/persist/presence.ts`)

Online players + shard assignment with a **10s heartbeat TTL**
(`PRESENCE_TTL_SEC`, configurable per instance):

- Redis (`REDIS_URL`): `SETEX presence:{playerId} 10 {shardId}`; `GET` for
  online/shard checks; `KEYS presence:*` for listings.
- Memory (default): `Map` of `{ shard, expires }` with lazy expiry + `prune()`.

`Presence` construction never throws or blocks; Redis dial-out happens in the
background and any failure warns + falls back to memory. Failed Redis
heartbeats degrade per-call to memory, so a Redis outage never drops players.

## Docker Compose (`infra/docker-compose.yml`)

| Command | What runs |
|---------|-----------|
| `docker compose up --build` | server (8081+9090) + web (8080). `DATABASE_URL`/`REDIS_URL` point at the `postgres`/`redis` hostnames, but those services are profile-gated — the server logs a warn and runs on sqlite + memory. |
| `docker compose --profile full up --build` | + `postgres:16-alpine` (user/pass/db `aether`/`aether`/`aetherfall`, volume `pgdata`, healthcheck `pg_isready`) + `redis:7-alpine` (healthcheck `redis-cli ping`). Server `depends_on` both with `required: false`, so the same file works with and without the profile. |
| `docker compose --profile observability up` | + prometheus (9091). Included in `full` too. |

Env wiring on the `server` service matches the compose service names:

```yaml
DATABASE_URL: postgres://aether:aether@postgres:5432/aetherfall
REDIS_URL: redis://redis:6379
```

## Ops

- **Manual migrate:** `psql "$DATABASE_URL" -f server/src/persist/migrate.sql`
- **Backup (sqlite dev):** copy `./data/aetherfall.db` (WAL checkpoint on flush
  means the main file is usually current; copy `-wal` too for strict safety).
- **Backup (prod):** `pg_dump "$DATABASE_URL"`.
- **Check backend:** server logs `db=<backend>` at boot and
  `[db] postgres mirror live` when pg connects; `/healthz` reports tick/players.
