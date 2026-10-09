# AETHERFALL — 90-second demo script

Total: ~90s. Needs: server on :8081, client on :5173 (or :8080 via compose),
optional second browser window for multiplayer + `tools/replay/viewer.html`.

## Setup (before the clock starts)

```powershell
cd C:\aetherfall
npm install; npm run build --workspaces
npm run dev:server      # :8081 WS, :9090 /metrics + /healthz
npm run dev:client      # :5173 (separate terminal)
```

Smoke check: `http://localhost:9090/healthz` → `{"ok":true,...}`.

## Controls

| input | action |
|---|---|
| WASD / arrows | move (server-authoritative, 8 u/s clamp) |
| mouse click / Space | attack (chips nearest NPC within 3u) |
| Enter / chat box | chat (`say`); `@maren <text>` talks to Elder Maren (quest-giver) |
| minimap (corner) | live positions; editor toggle for level editing |
| Canvas 2D fallback | auto if WebGL unavailable |

## Script (90s)

| t | you do | audience sees | talking point |
|---|---|---|---|
| 0–10s | Open client, spawn in arena | 2.5D isometric world, HUD + minimap | "Custom engine — no Unity/Godot. TS strict, ECS, 20Hz authoritative server." |
| 10–25s | Run around, attack a mob | Mob takes damage, dies/respawns; HP bars | "Server owns the sim — client predicts + reconciles. Mobs/combat run in the tick." |
| 25–40s | Open 2nd window, walk apart | Both players visible, then culled past 40m | "Interest management: 40m radius culling + removed[] eviction — bandwidth scales with density, not CCU." |
| 40–55s | Type `@maren hello`, take quest | Elder Maren replies with options 1/2/3 | "Rule-based quest dialogue + quests/inventory/trading all in-tick." |
| 55–70s | Spam inputs / teleport attempt (or run bots: `node tools/bots/dist/index.js --bots 0 --duration 1`) | Movement clamps, flood ignored, server keeps ticking | "Anti-cheat: 15ms rate limit, 8 u/s speed clamp, 5u teleport reject — all counted in /metrics." |
| 70–85s | Show `http://localhost:9090/metrics` + replay viewer | tick avg/p95, players, snapshot bytes, rejects; scrub recorded run | "Zero-dep Prometheus exposition + .ndjson replay recorder/viewer for debugging." |
| 85–90s | Close | — | "SQLite dev, Postgres-ready schema, Redis optional. Compose file is opt-in — dev needs only Node 22." |

## Camera beats + voiceover (3 shots)

Frame each beat as a locked camera move so the recording cuts cleanly.
Resolution 1280×720, client `?name=hero&autojoin=1`, second window for beat 2.

### Beat 1 — Orbit the shrine (0–10s, wide)
Camera: slow orbit / pan around spawn (50,50) at max zoom-out, HUD + minimap visible.
Voiceover: "Aetherfall — a custom MMO engine, no Unity, no Godot.
TypeScript strict, ECS sim, authoritative twenty-hertz server."

### Beat 2 — Split-screen chase (25–40s, two windows side by side)
Camera: window A follows player 1 into the treeline, window B holds on player 2
until they pass 40 meters and pop from `snapshot.entities` into `removed[]`.
Voiceover: "Interest management — a forty-meter cull plus removed eviction.
Bandwidth scales with density, not with total players online."

### Beat 3 — Boss telegraph push-in (55–70s, tight)
Camera: push in on the Hollow King arena as the red ring draws; hold through
one windup → hit → damage number → vignette pulse.
Voiceover: "The server owns damage. The client predicts, then reconciles.
Anti-cheat clamps speed and teleports — all counted in /metrics."

GIF slots: capture ~6s loops of each beat and drop them into the landing
screenshots row (see `tools/capture/README.md`).

## Fallback if the server is offline (replay-file demo)

Never dead-air a demo. If `:8081` / `:9090` is unreachable:

```powershell
# 1. Say it out loud: "Server's down — good, I'll show the replay path."
# 2. Open the offline-safe artifacts (all committed, no server needed):
start tools\capture\dashboard.html        # benchmark charts from report-*.csv
start tools\replay\viewer.html            # replay scrubber
# 3. Load tools/replay/recordings/*.ndjson in the viewer and scrub:
#    - drag the timeline to the boss telegraph tick
#    - narrate beat 3's voiceover over the frozen ring
# 4. Show docs/screenshots/*.svg in README as the storyboard.
```

Talking point while scrubbing: "Every snapshot is recorded as newline-delimited
JSON — a failed live moment becomes a replayed anecdote. The same file the
viewer scrubs is what `node tools/replay/dist/recorder.js --duration 90`
writes during a live run."

## If something breaks (live-demo insurance)

- WS dead? Check server terminal for `[server] AETHERFALL authoritative…` and
  `healthz`. Restart server; clients reconnect with `hello`.
- Blank 3D? Canvas 2D fallback engages automatically; mention it as a feature.
- Bots instead of crowd: `SERVER=ws://localhost:8081 BOTS=20 node
  tools/bots/dist/index.js --duration 60` gives a living world with zero staging.
- Record everything: `node tools/replay/dist/recorder.js --duration 90` then
  scrub the run in `tools/replay/viewer.html` — a failed live moment becomes a
  replayed anecdote.
