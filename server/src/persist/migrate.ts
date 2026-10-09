// @aetherfall/server — persist/migrate: canonical Postgres DDL as a TS constant.
// Mirrors ./migrate.sql (apply manually with `psql "$DATABASE_URL" -f migrate.sql`).
// The constant is the runtime source of truth so `dist/` needs no .sql copy;
// persist.test.ts asserts the two stay in sync.

export const MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS players (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  x       DOUBLE PRECISION NOT NULL DEFAULT 0,
  y       DOUBLE PRECISION NOT NULL DEFAULT 0,
  hp      INTEGER NOT NULL DEFAULT 100,
  updated BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id   SERIAL PRIMARY KEY,
  tick INTEGER NOT NULL,
  json TEXT NOT NULL,
  at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id      SERIAL PRIMARY KEY,
  sender  TEXT NOT NULL,
  text    TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'say',
  at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  owner_id   INTEGER NOT NULL,
  members    TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id        SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 1,
  updated   BIGINT NOT NULL,
  UNIQUE (player_id, item_id)
);

CREATE TABLE IF NOT EXISTS quests_progress (
  player_id INTEGER NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  quest_id  TEXT NOT NULL,
  stage     INTEGER NOT NULL DEFAULT 0,
  done      BOOLEAN NOT NULL DEFAULT FALSE,
  updated   BIGINT NOT NULL,
  PRIMARY KEY (player_id, quest_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON snapshots (tick DESC);
CREATE INDEX IF NOT EXISTS idx_chat_log_at ON chat_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_items_player ON items (player_id);
CREATE INDEX IF NOT EXISTS idx_quests_player ON quests_progress (player_id);
`.trim();

/** Tables the migration must create (checked by persist.test.ts). */
export const MIGRATE_TABLES = [
  'players',
  'snapshots',
  'chat_log',
  'guilds',
  'items',
  'quests_progress',
] as const;
