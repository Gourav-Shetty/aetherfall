# AETHERFALL Security

Threat model, controls, and operator checklist for the authoritative server.

## Trust boundaries

- **Untrusted:** all WebSocket client messages (`hello` / `input` / `chat`),
  `POST /walls` bodies, `Authorization` headers, query strings.
- **Trusted:** sim state, wall set after `validateWalls()`, env secrets
  (`AUTH_SECRET`, `ADMIN_TOKEN`), `./data/*` files written by the server.
- The server never executes client code and never trusts client positions —
  velocity is clamped server-side and teleports are rejected/snapped.

## Auth (`server/src/auth.ts`)

- Display names: **16 chars max, `[A-Za-z0-9_-]` only** (no spaces — blocks
  impersonation padding and chat-spoof alignment).
- Tokens: `base64url(name).exp.hex(HMAC-SHA256(secret, payload))`, 24h TTL,
  constant-time compare, length caps pre-verify (fuzz DoS guard).
- **Revocation blacklist:** `revokeToken()` on every kick/shadowban;
  `verifyToken()` rejects revoked tokens. In-memory (single process, 10k
  cap with oldest-evict). Multi-shard prod should back this with Redis —
  the `verify()` check is unchanged, only the store moves.
- Admission: `MAX_PLAYERS_PER_SHARD` env, **default 500**. Full shard sends a
  `queue` position event (`{t:'event',kind:'queue',payload:{position,max}}`)
  then redirects to the least-loaded shard.

## Admin wall surface (`server/src/walls.ts` + `index.ts`)

- `POST /walls` requires `Authorization: Bearer <ADMIN_TOKEN>` or
  `x-admin-token`. The `?token=` / `?adminToken=` query fallback is **dev-only**
  (`NODE_ENV=production` refuses it) — query strings leak the secret into
  access logs, proxies, `Referer` and history.
- Token compare is **constant-time** (SHA-256 digest + `timingSafeEqual`), so
  a wrong token can't be brute-forced byte-by-byte over the wire.
- **Prod fail-closed:** when `NODE_ENV=production` and `ADMIN_TOKEN` is still
  `dev`, every admin request gets `403` until a real secret is set. Dev boot
  logs a one-time warning when the default is in use.
- **Rate limit: 10 req/min per IP** (sliding window, `429` after), checked
  **before** auth so probe/brute-force traffic is bounded too. Buckets are
  per-IP and memory-bounded (10k buckets, idle sweep).
- **Size cap:** bodies over 1MB rejected (`413`), pre-checked via
  `content-length` and enforced while buffering; `parseWallsBody()` also
  throws `413` over the cap, `400` on bad JSON, `422` on schema failure.
- Every wall change **and** every rejection is audit-logged with IP.

## Audit (`server/src/audit.ts`)

- Append-only JSON-lines at `./data/audit.log` (`AUDIT_PATH` overrides):
  `join`, `kick`, `wall-change`, `wall-rejected`, `redirect`, `queue`.
- Never throws — audit failure can't break the game loop (unserializable
  details degrade to an `unserializable: true` record).
- **Rotation is automatic:** `audit()` calls `rotateAuditIfNeeded()` on every
  write, so `audit.log` → `audit.log.1` past `AUDIT_MAX_BYTES` (default 1MB)
  without any caller remembering to. One generation is kept; ship it off
  (cron/sidecar) if you need history.

## Anti-cheat (`server/src/anticheat.ts`)

- Input rate (lossy backpressure, **no strike**), burst flood (strike), speed
  clamp with float epsilon (`SPEED_EPSILON = 0.01`), teleport step + burst
  heuristics, 3-strikes-in-10s shadowban kick with token revocation.
- Order matters: **burst is checked before rate**, so a real flood strikes
  even when the per-gap check would also drop it, and a queueing stall can
  only ever cost one input (burst window clears on trip, strikes decay 10s).
- `malformed` violation kind records safely-dropped fuzz traffic (no strike).
- `safeParseClientMsg()` is the socket entry point: never throws, caps
  payloads at 64KB, clamps move axes to `[-1,1]`, `dt` to `[0,0.25]`, chat to
  200 chars. `security.test.ts` fuzzes NaN/huge/null-proto/wrong-type
  traffic through it.
- A **wrong-protocol hello** is not a parse failure: it passes through as an
  empty hello shell so the server can answer `bad-proto` + close. No identity
  is ever derived from it (proto is checked before `resolveIdentity()`).

## Verified (2026-10-03)

- `server/dist/security.test.js`: 31/31 pass. Full server suite: 335 pass,
  0 fail.
- **Honest-bot soak** (20 bots x 30s, 7 864 inputs, 20Hz): `burst`=0,
  `speed`=0, `teleport`=0, `shadowban`=0 violations. Only `input-rate`
  backpressure drops (11) during a 40ms tick stall — recorded, never struck.
- **Fuzz probe** (throwaway, not committed): 500 malformed frames on one
  socket, then 4 016 frames across 8 concurrent sockets incl. 1.2MB/2MB
  frames, all with 3 honest clients connected through the storm. Server
  survived every round (ticks kept advancing, no uncaught exception); honest
  clients kept full 10Hz snapshots and were never kicked; anticheat counters
  stayed at 0 for every cheat kind.
- **Admin surface live check:** 13 authorized POSTs -> `200`x10 then `429`;
  1.5MB body -> `413`; wrong/missing token -> `401`; bad JSON -> `400`; bad
  schema -> `422`; rate-limited attempts audit-logged with IP.
- **Name sanitize live check (via audit trail):** `"a b!c@d  e"` -> `abcde`,
  `"gm<U+202E>evil"` -> `gmevil`, 64 chars -> 16 chars, `proto:999` ->
  `bad-proto` + close.

## Operator checklist

1. Set `AUTH_SECRET` and `ADMIN_TOKEN` to long random values in prod (prod
   refuses admin auth on the `dev` default, and refuses `?token=`).
2. Set `MAX_PLAYERS_PER_SHARD` per capacity plan (default 500).
3. Keep `./data/audit.log` shipping/rotating; alert on `kick` bursts and
   `wall-rejected` spikes.
4. Serve metrics (`:9090`) only on loopback / private net.
5. Redis (`REDIS_URL`) for cross-shard chat + future token-blacklist sync.
