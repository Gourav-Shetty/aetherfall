# AETHERFALL — Custom MMO Engine From Scratch

![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)
![tick](https://img.shields.io/badge/tick-20Hz_authoritative-blue)
![snapshots](https://img.shields.io/badge/snapshots-10Hz_interest--culled-blue)
![loadtest](https://img.shields.io/badge/loadtest-50--bot_PASS-brightgreen)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

Portfolio + learning playground. No Unity/Godot/Colyseus.

## Stack (Node 22, no Docker required for dev)
- **Language:** TypeScript strict
- **Sim:** custom ECS, fixed-tick 20Hz server / 60Hz client interp, spatial hash, A*
- **Net:** authoritative WebSocket server (`ws`), binary protocol v2 (default, −95% bytes at 100 bots with v1 JSON fallback), client prediction + reconciliation, interest management, sharding stub
- **Persist:** SQLite (dev, better-sqlite3) with Postgres-ready schema, Redis optional (in-memory fallback)
- **Client:** Three.js 2.5D isometric + Canvas 2D fallback, HUD, minimap, editor
- **Tools:** headless bots (1000-ccu load test), replay viewer, level editor, benchmarks

## Layout
```
C:\aetherfall\
  shared/   protocol, types, seeded RNG, binary codec
  engine/   ECS, tick loop, spatial hash, pathfinding, world-gen
  server/   authoritative sim, auth JWT, snapshots, matchmaking/shard router
  client/   three.js renderer, prediction, HUD, minimap, editor UI
  tools/bots/  load-test bots + chaos + anti-cheat probes
  tools/replay/ replay recorder/viewer
  infra/    docker-compose (optional), prometheus config
  docs/     ARCHITECTURE.md, PROTOCOL.md, BENCHMARKS.md, ADRs
```

## Quickstart
```powershell
cd C:\aetherfall
npm install
npm run build --workspaces
npm run dev --workspace=@aetherfall/server
# in another terminal:
npm run dev --workspace=@aetherfall/client
```

## Tick / Net model
- Server ticks 20Hz, broadcasts snapshots 10Hz + deltas.
- Wire: binary protocol v2 is the default (−95% bytes at 100 bots, 0 gaps; `PROTO=1` / `?proto=1` forces v1 fallback).
- Client predicts local player, reconciles on server ack.
- Interest: 40m radius culling + chunk subscriptions.
- Anti-cheat: speed/teleport validation, input rate limit.
- Observability: zero-dep Prometheus text at `:9090/metrics` (tick ms,
  players, snapshot bytes, anticheat rejects) + `:9090/healthz`.

## Architecture

```mermaid
flowchart LR
    subgraph Client["client/ — prediction + render"]
        C3D["Three.js 2.5D iso / Canvas 2D fallback"]
        PRED["predict + reconcile"]
        HUD["HUD, minimap, editor"]
        C3D --> PRED --> HUD
    end
    subgraph Net["protocol v2 default — binary, v1 fallback"]
        IN["input{move,attack,chat,seq}"]
        SNAP["snapshot{entities,removed} @10Hz"]
        EV["event{...}"]
    end
    subgraph Server["server/ — authoritative 20Hz"]
        AC["anticheat<br/>rate/speed/teleport"]
        SIM["Sim + ECS hooks<br/>combat/quests/trades"]
        NPC["NPCManager<br/>FSM+BT, 2 bosses"]
        INT["interest 40m<br/>visible+removed"]
        MET["metrics<br/>/metrics /healthz"]
        DB[("SQLite dev<br/>Postgres-ready")]
        AC --> SIM --> INT
        NPC --> INT
        SIM --> MET
        SIM -. persist 5s .-> DB
    end
    HUD -- IN --> AC
    INT -- SNAP --> PRED
    SIM -- EV --> HUD
```

See `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`.

## Screenshots

| Isometric shrine (day) | Night raid (boss telegraph) | Editor (boss arena) |
|---|---|---|
| ![Isometric shrine — spawn area with HUD and minimap](docs/screenshots/map-isometric-shrine.svg) | ![Night raid — boss telegraph ring with damage numbers](docs/screenshots/combat-night-raid.svg) | ![Level editor — wall paint with boss arena trigger](docs/screenshots/editor-boss-arena.svg) |

SVG placeholders until real captures land — see `tools/capture/README.md`
(`node tools/capture/capture.mjs`, or F12 at 1280×720 → `docs/screenshots/shot-*.png`).
Benchmarks render at `tools/capture/dashboard.html` from `tools/bots/report-*.csv`.

## Hello → snapshot sequence

```mermaid
sequenceDiagram
    participant C as client (?name=hero&autojoin=1, v2 default)
    participant S as server :8081 (20Hz tick)
    C->>S: hello{name, proto:2} (falls back to proto:1 JSON on decline)
    S-->>C: welcome{id, tick, snapshot[]}
    loop input 20Hz
        C->>S: input{seq, dt, move, attack?}
    end
    loop snapshot 10Hz
        S-->>C: snapshot{tick, entities[], removed[]}
    end
    C->>C: predict local + reconcile on ack + interp remotes
    S-->>C: event{...} (damage, quest, trade)
    C->>S: chat{text} → S fans out chat{from, text}
```
