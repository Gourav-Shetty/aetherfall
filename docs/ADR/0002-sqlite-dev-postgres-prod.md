# ADR-0002: SQLite for dev, Postgres-ready schema for prod

- Status: accepted
- Date: 2026-10-02
- Context: The server must persist players, snapshots, and chat without
  forcing contributors to install/run databases (Windows-first dev, no Docker
  daemon required).

## Decision

`server/src/db.ts` (`DB` class) ships a backend chain with a Postgres-ready
relational schema (`players | snapshots | chat_log`):

1. `better-sqlite3` if installed (native, WAL),
2. `node:sqlite` (Node ≥22.5, WAL at `./data/aetherfall.db`),
3. JSON-file fallback (`./data/db.json`).

Never throws at boot — falls back silently so `npm run dev:server` always
works. `DATABASE_URL` (under `docker compose --profile full`) points at the
optional Postgres 16 service; the SQL uses only portable constructs
(`ON CONFLICT(id) DO UPDATE`, autoincrement PKs) so the same statements run
on Postgres. Redis (`REDIS_URL`) is likewise optional with an in-memory
fallback.

## Alternatives considered

- **Postgres-only:** faithful to prod but kills zero-setup dev and breaks on
  machines without Docker. Rejected for dev; kept as the prod target.
- **Schemaless JSON store everywhere:** zero setup, but no query story for
  leaderboards/history and divergent prod/dev behavior. Rejected as primary.

## Consequences

- Good: clone → `npm install` → run; CI needs no services.
- Good: schema is migration-compatible: same table names/columns land in
  Postgres when `DATABASE_URL` is set.
- Bad: three backends to keep in sync — mitigated by the tiny surface
  (`upsertPlayer/getPlayer/saveSnapshot/logChat/recentChat`) covered by boot
  smoke (server logs `db=<backend>`) rather than an ORM.
