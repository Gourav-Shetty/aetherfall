# Level Editor (walls)

Paint collision walls for the 100×100 arena. The server is authoritative:
it loads `data/walls.json` on boot, resolves movement against walls in the
sim tick (axis-separated **slide**, never stick), and serves the map over
HTTP. The in-game editor (`?editormode=1`) and the standalone tool both
read/write the same file format.

## Wall file format (`aetherfall-walls/v1`)

```json
{
  "format": "aetherfall-walls/v1",
  "tile": 1,
  "version": 1,
  "count": 2,
  "walls": [{ "x": 12, "y": 7, "w": 1, "h": 1 }, { "x": 20, "y": 20, "w": 2, "h": 1 }]
}
```

- Canonical entries are `WallRect` objects `{x, y, w, h}` (see
  `WALLS_VERSION`, `WallRect`, `validateWalls` in `shared/src/index.ts` —
  additive, protocol v1 untouched).
- Legacy `[tx, ty]` tuples (and `{tx, ty}`) from the old client-overlay
  export still validate — the server accepts both, so old files keep working.
- Guards: entries must be finite (NaN/Infinity rejected), coords in
  `[0, 1000]`, extents `1..128`, at most 10 000 entries per file.

## Server

- Boot: loads `./data/walls.json` when present (checks `WALLS_PATH`,
  `<cwd>/data/walls.json`, `<cwd>/server/data/walls.json`, and paths
  relative to the compiled file). Absent/invalid → open arena.
  Override path with `WALLS_PATH=./data/walls.json`.
- Collision (`server/src/sim.ts`, additive hook): per tick, each player's
  displacement goes through `moveWithSlide()` (X first, then Y at the new X,
  body radius `PLAYER_RADIUS = 0.4`). A blocked axis is reverted while the
  other still applies, so diagonal motion slides along walls. Spawns inside a
  wall are nudged out via spiral search. Empty wall set = zero behavior
  change (open arena, same traces as before).
- HTTP (metrics port, default `9090`, CORS-open):
  - `GET /walls` → current canonical doc (public, used by editors on join).
  - `POST /walls` → admin only: `Authorization: Bearer <ADMIN_TOKEN>`
    (or `x-admin-token` header / `?token=`). Default token is `dev`
    (`ADMIN_TOKEN=dev`). Body is validated (`400` bad JSON, `422` invalid
    walls, `401` missing token), installed live via `sim.setWalls()`, and
    persisted to `data/walls.json`.

```powershell
# inspect
Invoke-RestMethod http://localhost:9090/walls | ConvertTo-Json -Depth 4
# publish (dev token)
Invoke-RestMethod -Method Post http://localhost:9090/walls `
  -Headers @{ Authorization = 'Bearer dev'; 'Content-Type' = 'application/json' } `
  -Body (Get-Content ./data/walls.json -Raw)
```

## In-game editor (`client/src/editor.ts`, `?editormode=1`)

- Fetches authoritative walls on join (`GET /walls`; metrics base derived
  from `?server=` or the page host, override with `?walls=<http-base>`).
- Paint/erase auto-syncs via debounced `POST /walls` (800 ms); token from
  `?admintoken=` / `?token=` / `localStorage af_admin_token`, default `dev`.
- Panel: paint toggle, **+room / +corridor / +dungeon** stamps (room sizes
  sampled from `genDungeon()` in `@aetherfall/engine`; dungeon pastes a
  24×18 generated chunk at the cursor), export `walls.json`, import file,
  manual sync ↑ / reload ↓, clear. Status line shows sync state.

Try: `http://localhost:5173/?editormode=1&autojoin=1` (server on `:8081`,
metrics on `:9090`).

## Standalone tool (`tools/level-editor/index.html`)

No server, no build — open the file in a browser (or `npx serve tools/level-editor`).
600px canvas over the 100×100 arena, paint/erase/room/corridor/dungeon
brushes (embedded `genDungeon` copy, seed input), save/import `walls.json`,
and direct push-to-server POST. Drop a saved file at `server/data/walls.json`
(or repo `data/walls.json`) and restart the server, or POST it live.

## Tests

- `shared/src/walls.test.ts` — `validateWalls` accepts rects + legacy
  tuples, rejects NaN/Infinity/huge/oversized/wrong-format; slide helper
  blocks X but keeps Y; tile-key round-trip.
- `server/src/walls.test.ts` — sim slide against a vertical barrier, open
  arena unchanged, spawn nudge, determinism with walls, editor-JSON →
  `saveWallsFile` → `loadWallsFile` round-trip via temp `WALLS_PATH`,
  invalid POST bodies rejected.
- Client `vite build` must pass (editor imports `@aetherfall/shared` +
  `@aetherfall/engine` runtime; build `shared` first so `dist` has the wall
  schema).
