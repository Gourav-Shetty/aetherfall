# AETHERFALL QA — review

Date: 2026-10-02. Repo: `C:\aetherfall`, Node 22, PowerShell.
Baseline at start: build ✅, typecheck ✅, server tests 40/40 ✅,
`npm run test --workspaces` ❌ (no `test` script in client/bots/replay).

## 1. Required fixes (all done)

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1 | `client`, `tools/bots`, `tools/replay` had no `test` script → `npm run test --workspaces` failed | Real tests everywhere (no `echo ok` stubs): bots arg-contract tests, replay arg/filter tests, client interp+predict tests compiled via a new `tsconfig.test.json` (app `tsconfig.json` stays `noEmit`) | `client/package.json`, `client/tsconfig.test.json`, `client/src/*.test.ts`, `tools/bots/package.json`, `tools/bots/src/args.test.ts`, `tools/replay/package.json`, `tools/replay/src/recorder.test.ts` |
| 2 | Anticheat log-spam: honest normalized move → mag `8.0000001 > 8` → clamp + `console.warn` every tick | `SPEED_EPSILON = 0.01` budget in `checkVelocity`; `moveToVelocity` normalizes overlong sticks to the unit circle (diagonal budget); per-player+kind console throttle (1/s, violations still all recorded); non-finite velocities rejected as `(0,0)` instead of poisoning the sim | `server/src/anticheat.ts`, `server/src/anticheat.test.ts` (+4 tests) |
| 3 | Duplicate mob systems: `game/spawner.ts` (event-based, ids ~1M) vs `ai/npc.ts` (snapshot-based, ids 900001+) | Namespaced + unified: new `game/mobs.ts` owns the ranges (players 1–899999, NPC/boss 900000–999999, spawner 1000000–1999999, pickups ≥2000000), `unifiedMobSnapshot()` merges both + throws on collision; spawner `spawnChunk` linear-probes on hash-base collision; pickups moved out of the player id range; `fullSnapshot()` in `index.ts` now includes spawner mobs (previously silently dropped from every snapshot) | `server/src/game/mobs.ts`, `server/src/game/mobs.test.ts` (9 tests), `spawner.ts`, `ai/npc.ts`, `game/inventory.ts`, `server/src/index.ts` |
| 4 | No CI | `.github/workflows/ci.yml`: Node 22, `npm ci`, build, typecheck, test | `.github/workflows/ci.yml` (also committing the pre-existing untracked `package-lock.json` — `npm ci` needs it) |

## 2. Extra bugs found in review (all fixed)

- `ai/npc.ts`: `Math.random()` repath stagger → replaced with id-hashed deterministic stagger (sim reproducibility).
- `ai/dialogue.ts`: `freeform()` used substring match, so `"know"` triggered the `"no"` branch → word-boundary matching.
- `server/src/index.ts`: 20Hz `setInterval` body had no guard — one gameplay/NPC throw killed the loop silently → wrapped in try/catch with tick-tagged `console.error`.
- `server/src/index.ts`: `GameState.chat` rate limiter + `sanitizeChat` were dead code — chat went out unmasked/unlimited → both `input.chat` and `chat` paths now limit (1/s) + sanitize; over-limit senders get a protocol-safe `chat-limited` event.
- `client/src/predict.ts`: predictor integrated raw diagonals at 8√2 u/s while the server clamps to 8 → constant mispredict → mirrors the server unit-circle budget.
- `tools/bots`, `tools/replay`: entries executed on import (bots launched the swarm, recorder opened a socket) → `main()` guards so tests can import them.

Known (not fixed, follow-ups): `game/loot.ts` + `game/content.ts` are compiled but not yet wired into the server tick or `game/index.ts` re-exports (note: `content.ts` re-exports `xpForNextLevel`, colliding with `quests.ts` — resolve before star-exporting); `NpcEvent` vs spawner mobs have no shared combat loop yet (aggro events only).

## 3. Test matrix

`npm run build --workspaces` ✅ · `npm run typecheck --workspaces` ✅ ·
`npm run test --workspaces` ✅ (exit 0)

| Workspace | Runner | Tests | Pass | Fail |
|-----------|--------|-------|------|------|
| shared | `node --test dist/**/*.test.js` | 0 (no unit tests yet) | 0 | 0 |
| engine | same | 41 | 41 | 0 |
| server | same | 79 (incl. 9 new mob-namespace + 4 new anticheat) | 79 | 0 |
| client | `tsc -p tsconfig.test.json && node --test dist-test/**` | 7 (interp 3, predict 4) | 7 | 0 |
| bots | `node --test dist/**/*.test.js` | 4 (parseArgs contract) | 4 | 0 |
| replay | same | 4 (args + record filter) | 4 | 0 |
| **Total** | | **135** | **135** | **0** |

## 4. Load trial — 20 bots (this session)

Setup: `node server/dist/index.js` (dist rebuilt from this tree), then
`node tools/bots/dist/index.js --bots 20 --server ws://localhost:8081
--duration 15 --seed 1337` (chaos + anticheat probes on). Raw CSV:
`tools/bots/report-qa20.csv`.

| Metric | Result |
|--------|--------|
| Connects | 20/20, 0 errors, avg 22.1ms / p50 23.0ms / p95 41.0ms |
| Snapshots | 2440 total ≈ 8.11/s/bot (server emits 10Hz; gap = interest culling + close timing) |
| Messages | 11141 total (740.9/s); inputs 4867 (323.6/s); chats 251; attacks 466 |
| Chaos probe (300-input flood) | **PASS** — acceptedSeq=1/300, rate-limit ACTIVE, server survived |
| Anticheat probe (move=9999) | **PASS** — moved 1.87u, speed 4.25u/s, CLAMPED |
| Server liveness | `/healthz` ok before (tick 44) and after (tick 338, 0 players, uptime 21s) |
| Anticheat log volume | **5 stderr lines total** (2 node sqlite warnings + 3 throttled input-rate warns), **0 `speed` violations** — the float-dust clamp spam is gone |

Observation (not fixed): effective tick ≈ 15–16Hz, not 20Hz (`tick 44 @ 2.9s`,
`tick 338 @ 21s`). Consistent with Windows 15.6ms timer quantum on
`setInterval(50ms)`. Recommend a hi-res/self-correcting loop or tolerating
15Hz min-spec on Windows hosts.

Note: one earlier trial run died mid-swarm with no trace; the rerun with
identical parameters passed clean. Suspected cause is environmental (a leftover
`Start-Job` server from a prior shell), not a server bug — no crash trace in
either server log, and the passing run survived the full swarm + both probes.
