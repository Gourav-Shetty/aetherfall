# Client (AETHERFALL web client)

Vite + TypeScript. Three.js isometric 2.5D renderer with Canvas2D fallback.
Authoritative server at `ws://localhost:8081` (override with `?server=ws://host:port`
or the Server field on the landing page).

## Run

```powershell
npm run dev --workspace=@aetherfall/client   # vite, http://localhost:5173
npm run build --workspace=@aetherfall/client # vite build + typecheck
npm run typecheck --workspace=@aetherfall/client
npm run test --workspace=@aetherfall/client
```

Quick join: `http://localhost:5173/?name=hero&autojoin=1`
Editor: `http://localhost:5173/?editormode=1`

## Landing page (`index.html`)

Portfolio-ready single-page shell: hero (`AETHERFALL` + tagline + tech pills),
Join card (name + server + Join button), Controls + Connection cards, Features
grid (6 cards), Screenshots placeholder row (3 gradient tiles — replace with
real captures), footer stack line. The overlay hides on first snapshot after
`welcome`; `?autojoin=1` skips it for one-click demos.

## Controls

| Input | Action |
|---|---|
| W A S D / arrows (default) | move (20Hz input) — remappable to arrows / `I J K L` / numpad `8 4 5 6` in the ♿ accessibility panel |
| Space / left-click / ⚔ button | attack flag → server (fx locally) — the attack key is rebindable (panel → Attack key → press a key, `Esc` cancels); click-to-attack and hold-to-attack (180ms repeat) are toggles |
| Enter | focus chat |
| L | toggle leaderboard — conflicts with `I J K L` right (`movementConflicts()` reports it and the panel shows a warning instead of silently shadowing it) |
| M | mute/unmute sounds |
| E (editormode) | toggle wall paint mode |
| Esc | close the accessibility panel |
| Tab / arrows in HUD | move between HUD regions (one tab stop per region) / rove inside a region; skip link jumps to the game view |
| Left-drag (editormode, paint on) | paint wall tile |
| Shift/right-drag (editormode) | erase wall tile |
| Touch joystick (left) + ⚔ (right) | mobile move + attack (auto-shown on coarse pointers) |

Full keyboard map, screen-reader announcements, locales and palette notes:
`docs/A11Y.md` (status: wired + active).

Chat channels: global / say / guild (selector next to the chat box).

Mobile: the joystick base auto-appears on coarse pointers / touch devices
(`(pointer: coarse)` or `ontouchstart`). Its analog vector is blended with the
keyboard axes in `readMove()` and renormalized when the combined vector leaves
the unit disc, so holding `D` while nudging the stick never exceeds top speed.
The stick snaps neutral on `pointerup`/`pointercancel` **and on window blur**
(alt-tab during a drag never leaves the player walking).

## UI modules

- `main.ts` — joins, 20Hz input (keyboard + joystick blend), net wiring,
  loading/death/leaderboard/vignette/toast/fps orchestration, renderer
  switching, frame loop.
- `hud.ts` — HP/XP bars, 20-slot inventory grid, quest tracker, chat box,
  128px minimap (4Hz), kill feed (6s fade), `updateLeaderboard(ents, selfId,
  levels)` (top-8 players from snapshot, Lv then HP), `setBosses(bars)`
  (top-centre boss HP bars, CSS injected once per document).
- `bosses.ts` — boss roster + HP-bar derivation, kept out of `hud.ts` so it is
  unit tested without a DOM. `BOSS_NAMES` is the canonical list (matching the
  four bosses in `server/src/ai/npc.ts`); `isBossEntity()` matches
  case-insensitively on a substring so a display-name tweak cannot silently
  drop a bar; `bossBars(list)` filters dead/degenerate bosses, sorts by
  `bossOrder()` so bars never jump rows between 5Hz refreshes, and clamps to
  `MAX_BOSS_BARS`; `bossGradient(name)` gives each boss its own bar colour.
- `fog.ts` — `FogOfWar` explored-chunk store + `FOG_RADIUS` (25m) /
  `FOG_CHUNK` (8m) constants. `markAround(x, y)` reveals chunks and returns
  how many were new; explored keys persist to `sessionStorage` (`af_fog_v1`,
  ≤4000 chunks, 2s write throttle). `flush()` bypasses the throttle and
  `installFogPersistence(fog)` wires `pagehide`/`beforeunload`/
  `visibilitychange` so the last chunks before a reload are never lost.
  Also exports `FogLike` (the slice renderers consume) and `RenderOpts`.
- `quests.ts` — `ChainTracker`, a client view-model of the 5-quest Elder
  Maren chain (`ward-spark` → `heart-of-fall`, mirroring
  `server/src/game/content.ts QUEST_CHAIN`). Feeds:
  `onQuestProgress/onQuestComplete` (authoritative `event` payloads),
  `onMobDie` (`event/mob-die`), `onExploreStep` (new fog chunk entered).
  Authoritative absolute counts always win over local fallbacks, and only the
  *active* quest is credited by the local fallbacks. `toHud()` renders the
  HUD rows (`▶` marks active, `n/goal` counts), `chainProgress()` is 0..1.
- `telegraph.ts` — `asTelegraph(payload)` validates the untrusted
  `event/telegraph` payload (shape/x/y/r/ttlMs/label with finite-number,
  range, and length guards) and returns `null` for anything malformed, so a
  hostile or future server cannot push NaN into a render loop.
  `telegraphFrac()` reports elapsed windup as a 0..1+ fraction. Labels seen on
  the wire: `golem-slam`, `wisp-blink`, `wisp-burst`, `warden-slam`,
  `wyrm-charge`, `wyrm-fire`; rendering is label-agnostic so a new boss skill
  needs no client change.
- `sound.ts` — WebAudio bleep stub, no assets (`attack/hit/death/respawn/
  join/chat/quest/kill/click`). Muted flag persisted (`af_muted` + settings).
- `settings.ts` — `SettingsStore` persisted to `af_settings_v1`: renderer
  pref (`auto|three|canvas`), render distance (15..50), quality
  (`low|med|high`), show-FPS, muted. `qualityCaps()` maps quality →
  `{pixelRatio, particles, flashes}`.
- `joystick.ts` — pointer-event virtual joystick, `vec {x,y}` in [-1,1] with
  dead-zone, knob transform; blended into `readMove()` with normalization.
  Pure helpers `normalize(dx, dy, half)` and `blendMove(kx, ky, jx, jy)` are
  exported so the dead-zone/clamp math is unit tested without a DOM.
- Loading screen (`#loading`) — shown on Join (`Connecting to …`), advances
  to `Loading world…` on `welcome`, hides on first snapshot; 4s failsafe
  message if the server is down.
- Death/respawn (`#death`) — shown on `respawn` event for the local id (or a
  0-hp snapshot fallback), auto-hides after 2.5s; Respawn button hides
  immediately + snaps the predictor to the authoritative pos; 6s failsafe.
- Damage vignette (`#vignette`) — radial red overlay, opacity ∝ damage
  (`0.45 + amt/12*0.25`), fades in 450ms; full flash on death.
- Toast (`#toast`) — renderer switches, fallbacks, transient notices (max 3).
- Boss HP bars (`.hud-tc` / `#hud-bosses`) — up to four top-centre bars, one per
  live boss in the snapshot (Stone Golem, Ember Wyrm, Void Wisp, Crypt Warden).
  Refreshed at 5Hz from the draw list via `hud.setBosses(bossBars(list))`;
  a boss at 0 HP drops out and the bars hide entirely when none are in the
  interest radius. Names are HTML-escaped.
- First-join tutorial toasts — on the first snapshot of a session, a short
  staggered toast run (move/attack, keys, the shrine, telegraph rings) plays
  once. The `af_tutorial_v1` flag in `sessionStorage` suppresses it on reload.
- Screen shake — `shake(amount)` in `main.ts` accumulates impulses into the
  active renderer (`IsoRenderer.shake` offsets the camera after `lookAt` so
  the fixed iso angle holds; `CanvasRenderer.shake` offsets the projection).
  Both decay with a ~350ms time constant and clamp the amplitude. Triggers:
  damage taken (∝ amount), respawn, level-up, quest-complete, `boss-kill`, and
  any `event/telegraph` that lands within `r + 6m` of the player.
- Fog-of-war — the world is fully lit within 25m of the player. Beyond that,
  explored ground is dimmed and never-seen ground is near-black; entities and
  telegraph rings standing in unexplored ground are not drawn at all, and the
  minimap hides them too.
- Settings panel (`#settings`, ⚙) — renderer Auto/Three/Canvas, quality
  Low/Med/High, render-distance slider (live value), FPS-meter + mute
  checkboxes. Applied live via `applySettings()`, persisted.
- Accessibility panel (`#a11y-panel`, ♿) — language (`en`/`tr`/`de`/`es`,
  persisted `af_locale_v1`, HUD re-renders live), high-contrast theme,
  deuteranopia/protanopia/tritanopia palettes (pushed into both world
  renderers via `applyPalette()` in `main.ts`, not just the minimap),
  reduced motion (kills shake + particles + CSS transitions), text size
  90–150 %, screen-reader announcements on/off, movement scheme, rebindable
  attack key, click/hold-to-attack. Persisted `af_a11y_v1`, `Esc` closes.
  Details: `docs/A11Y.md`.
- Localization (`i18n.ts` + `locales/{en,tr,de,es}.ts`, 237 keys each) —
  HUD/announcement/toast/tutorial strings plus a `SERVER_TEXT_INDEX` (91
  entries) that localizes authored server prose client-side (Elder Maren
  dialogue incl. the composed `@maren` wire format, quest/item/mob/boss names,
  templated `<name> slain` / `<name> joined` lines). Player-authored chat is
  never translated. Screen-reader live regions (polite `role="status"` +
  assertive `role="alert"`) announce joins, deaths, quest updates, boss
  telegraphs, low HP (< 25 %, descending-edge latched) and inventory/level
  events; the HUD carries `progressbar`/`list`/`log` roles with roving
  tabindex. Details: `docs/A11Y.md`.
- Leaderboard (`#leaderboard`, 🏆 / `L`) — hidden by default, refreshed at
  1Hz from the draw list while visible.
- FPS meter (`#fps`) — per-second window text (`three-iso · 60 fps`),
  toggleable; status bar keeps EMA fps + ping + pos + ent + seq/ack.

## Architecture

- `net.ts` — protocol preserved (`hello → welcome → input@20Hz → snapshot@10Hz`,
  chat, event). Adds ack tracking (`lastAckSeq` from echoed `entity.seq`) + RTT.
- `predict.ts` — client prediction at 8 u/s (matches server `sp`), stores
  `seq → input`, reconciles on snapshot: drop acked, re-simulate remainder.
- `interp.ts` — remote entities render at `now − 100ms` from a 12-sample ring
  buffer with linear interpolation. Local player always uses predicted pos.
- `renderer3d.ts` — primary. Orthographic dimetric camera that follows the
  player, instanced ground (10k) + walls in 2 draw calls, box avatars with
  sprite HP bars, directional + ambient + hemisphere light with day/night
  lerp (120s cycle), ring-flash hit fx (capped, see Perf). `setViewDistance()`,
  `setQuality(pixelRatioCap, maxFlashes)`, `setFog(fog, x, y)`, `shake(amp)`,
  `telegraph(x, y, r, ttlMs)`, `dispose()` for fallback switching.
  `tryCreate(container, terrain)` returns null without WebGL.
  `setEntityColors()` / `setTelegraphColor()` apply the a11y palette to bodies
  (live bodies re-tinted, local self marker untouched) + new rings.
  Fog-of-war retints the instanced meshes in place: un-fogged ground RGB
  is cached in a `Float32Array`, a per-tile tier cache means only tiles whose
  lit/remembered/unknown tier actually changed are rewritten, and the whole
  pass is throttled to 2Hz — so walking around costs a 10k tier scan twice a
  second and zero GPU uploads in the steady state. Avatars dim by the same
  three tiers.
- `renderer2d.ts` — fallback (also shows editor walls). Tiles from the
  genChunk mirror (`tiles.ts`), shadow/body/eyes sprites, HP bars + names,
  capped particles + damage numbers, day/night overlay. `setParticleCap()`,
  `setViewDistance()` (tile-size zoom), `fitToContainer()` (DPR-aware canvas).
  `render(..., opts)` takes `{fog, playerX, playerY}`; `shake(amp)` offsets the
  projection in px; `telegraph(...)` draws the expanding boss ring.
  `setEntityColors()` / `setTelegraphColor()` apply the a11y palette to bodies
  + rings (garbage-tolerant, defaults = shipped colours).
- `terrain_view.ts` — the client's view of the engine terrain field
  (`@aetherfall/engine` `heightAt` / `hazardAt` / `LandmarkIndex`, seed 1337 —
  the same seed the shard uses). One instance is created in `main.ts` and
  handed to both renderers and the HUD, so all three read the same numbers.
  The 100×100 arena grid (hazard kind / dps / elevation per tile) is built
  once, lazily, in ~3 ms and then every lookup is an array index; outside the
  arena it falls back to the engine functions. `zVisual(h) = 2.4 *
  tanh(h * 0.05 / 2.4)` compresses the raw ±43-unit field into the 30-unit
  isometric view for *display only* — collision, `z` and damage use the
  unscaled number. Elevation arrives in the snapshot only when the shard runs
  with `snapshotZ` (off by default), so the client normally samples the field
  itself; both paths are the same pure function, so they agree exactly.
- `hud.ts` — see UI modules above.
- `editor.ts` — `?editormode=1` paints 1-unit wall tiles over the 100×100
  arena and exports `{format:'aetherfall-walls/v1', walls:[[x,y]...]}` as
  `walls.json` + textarea JSON for `tools/` import.

## What the world looks like now (terrain)

The arena is no longer a flat green plane. The engine terrain field drives both
renderers, so what you see is the same field the shard simulates:

- **The ground has shape.** Every tile sits at its `heightAt()` elevation and
  is tilted along its local gradient, so hills and valleys read in the
  isometric view. The camera rig rides the ground under the player (smoothed),
  so walking uphill scrolls the world instead of sinking the avatar into it.
- **Avatars stand on the ground.** Players, NPCs, mobs, pickups and projectiles
  are placed at the elevation of the tile under them — the authoritative `z`
  when the shard sends it, otherwise the identical local sample. Name tags, hit
  flashes and boss telegraph rings move with them.
- **Water and lava are drawn.** Hazard tiles get a dark floor tint plus a
  translucent instanced surface quad at the water (or lava) level, so a lake
  reads as a body of water with depth rather than as a hole. Lava is opaque and
  hot-coloured. Both are impassable on the shard and cost HP while you stand in
  them, so the tint doubles as a warning.
- **Terrain reads at a glance.** Steep tiles (`slope > WALKABLE_MAX_SLOPE`)
  fade to rock grey; high ground (elevation > ~18) fades toward snow.
- **Minimap.** Water and lava are painted as 2×2-tile field cells (blue /
  orange) and landmarks as kind-coloured diamonds, both *under* the fog veils,
  so unexplored water stays hidden until you have been there.
- **Cost.** The 3D renderer goes from 2 to 4-5 instanced draw calls (water,
  lava, landmark pillars — the landmark mesh is skipped entirely when nothing is
  in range, and the 100×100 arena at seed 1337 contains no landmark cell). The
  arena grid is built once (~3 ms) and read as arrays afterwards, so frame cost
  is unchanged. The Canvas2D fallback gets the same cues with one extra fill per
  tile and no new state.
- Both renderers still work with no terrain attached (`new CanvasRenderer(canvas)`
  / `IsoRenderer.tryCreate(view)`) — that is what the headless tests exercise.
- The auto-fallback to Canvas2D is untouched (same trigger, same toast), and the
  fallback draws terrain too, so switching mid-run does not make the world flat.

## Protocol compatibility (`event` kinds)

`t:'event'` carries `{kind: string, payload: unknown}` — protocol v1 has no
typed event union, so the client treats every event as untrusted input and
routes it through a `switch` with an explicit `default: break`.

| kind | client reaction |
|---|---|
| `telegraph` | `asTelegraph()` validated → renderer ring + impact shake |
| `xp` / `xp-gain` | XP bar (absolute `xpLeft`, or `amount` accumulate) |
| `levelup` | XP bar, toast, chime, small shake |
| `mob-die` | kill feed; quests + chime when `killedBy === my id` (deduped against the snapshot fallback) |
| `mob-spawn` / `mob-respawn` / `mob-aggro` / `pickup-spawn` | ignored (snapshots are authoritative) |
| `quest-progress` / `quest-complete` | chain tracker + HUD rows, toast, chime |
| `loot` / `kill` / `boss-kill` | kill feed, chime, shake |
| `respawn` / `despawn` | death overlay for self, "rose again" for others |
| `redirect` / `queue` / `kicked` / `chat-limited` / `bad-proto` | toast |
| anything else | silently ignored |

Gameplay events carry `playerId`; the client filters on `net.id` so other
players' kills and quest progress never leak into your HUD. XP uses both the
current `{playerId, amount, level, xpLeft}` payload and the legacy
`{xp, next, level}` shape. Kills have two sources: the authoritative
`mob-die` event, and — for the AI minions that simply vanish from the snapshot
— a fallback that requires the mob to have been seen at **0 HP**. A mob that
leaves the interest radius is still at full HP and is therefore never mistaken
for a kill. `announcedDeaths` de-duplicates the two paths per entity id.

Server side today (`server/src/index.ts`) only routes player attacks through
`npcs.damageFromPlayer`, so `mob-die` / `xp-gain` / `loot` are wired but not
yet produced; the snapshot fallback is what keeps the kill feed and the
`ward-spark` chain quest moving until spawner-mob melee lands.

## Tests

`npm run test --workspace=@aetherfall/client` compiles the DOM-free modules to
`dist-test/` and runs them under `node --test` (359 tests, 0 failing). Covered: entity interpolation
and client-side prediction (pre-existing), plus the new UI logic — fog chunk
keying / radius / `sessionStorage` round-trip and corrupt-storage recovery,
the quest chain tracker (ordering, authoritative-vs-fallback precedence, goal
caps), `event/telegraph` payload validation, the boss roster / bar ordering,
the joystick dead-zone / blend math, the i18n catalogs (4-locale key coverage,
placeholder parity, fallback chain, server-prose + composed-dialogue
translation) and the a11y layer (settings sanitisation, keymaps, palette
separation + WCAG contrast, announcement queue, low-HP latch, roving-nav
maths, key filtering) including the renderer palette overrides
(`hexToRgb`, shipped defaults, per-kind replace, garbage tolerance), the
terrain view (`terrain_view.ts`:
grid/engine parity, build-once, out-of-arena fallback, gradient/slope
agreement, `zVisual` monotonicity and clamp, landmarks, loot anchors), the
terrain painting in the Canvas2D fallback (water palette, avatar lift vs shadow
position, the no-terrain path) and the minimap hazard/landmark overlay, and an
event-routing table that pins
every `kind` the server can emit as handled-or-deliberately-ignored so a new
server event fails the build until the client routes it. Renderer, DOM, and
WebGL paths stay covered by `npm run build` (typecheck) and manual QA.

## Perf notes

- Terrain: 4-5 instanced draw calls regardless of arena size (ground, walls,
  water, lava, landmarks — the last one only when something is in range);
  avatars are a few dozen meshes; `pixelRatio` capped by quality
  (low 1 / med 1.5 / high 2).
- Particles capped by quality (100/250/400 canvas; 12/30/60 three flashes);
  damage numbers capped at 40; flash overflow disposes the oldest ring.
- Telegraph rings capped at 12 live per renderer; each renderer disposes its
  geometry + material when a ring lands or when the cap evicts the oldest.
- Boss bars refresh at 5Hz, minimap 4Hz, status 2Hz, leaderboard 1Hz.
- Auto-fallback: when renderer pref is `auto` and the rolling 1s FPS stays
  <30 for 5 consecutive windows, the client disposes Three.js, shows Canvas2D,
  and toasts `Perf: fps < 30 for 5s — auto-fallback to Canvas2D` (once).
- Network: input 20Hz tiny JSON, snapshot 10Hz; interp buffer hides jitter
  instead of extra bandwidth; RTT shown in the status bar.
- Frame work per tick: O(visible tiles) canvas rects (fallback) or O(entities)
  mesh updates (three); the terrain grid is built once (~3 ms) and read as
  typed arrays, so a tile lookup costs an index rather than a `heightAt()`
  call. Minimap throttled 250ms, status 500ms, leaderboard 1000ms (only while
  visible).
- Render distance: three ortho view 15..50 (default 30); canvas tile size
  `32 * (30/dist)` so distance means the same thing on both renderers.
- Fog-of-war writes to `sessionStorage` at most once per 2s (plus an explicit
  flush on tab hide), and the renderer tint pass at most 2Hz, so neither can
  stall a frame.
- Known limits: editor walls are client-side overlay only (no server
  collision yet); quest progress is a client view-model that trusts the
  server's absolute counts but never re-derives them — the local kill/explore
  fallbacks exist only so the tracker still moves if an event is dropped.
  Boss bars only appear while a boss is inside the snapshot interest radius.
