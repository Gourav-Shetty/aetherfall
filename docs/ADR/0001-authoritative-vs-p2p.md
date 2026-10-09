# ADR-0001: Authoritative server vs peer-to-peer

- Status: accepted
- Date: 2026-10-02
- Context: AETHERFALL is a multiplayer action world (movement, melee, mobs,
  trading) where cheating ruins the game and clients run untrusted browsers.

## Decision

Single authoritative server owns the simulation at fixed 20Hz; clients send
only intents (`input{move, attack, chat, seq}`) and render server snapshots
(10Hz) with prediction + reconciliation. No peer-to-peer state exchange.

## Alternatives considered

- **P2P / lockstep:** lower server cost, but any peer can forge state;
  NAT traversal + desync recovery cost exceeds the saved hosting for a
  portfolio-scale game. Rejected.
- **Client-authoritative with server relay:** simplest, but teleport/speed
  hacks are trivially undetectable. Rejected.

## Consequences

- Good: cheat surface shrinks to input timing/magnitude — enforceable with
  three cheap checks (rate, speed, teleport; `server/src/anticheat.ts`), all
  exported as `aetherfall_anticheat_rejects_total{kind}` in `/metrics`.
- Good: determinism is testable (`sim.test.ts`: same inputs → identical
  snapshots), replays are just recorded snapshots.
- Bad: server pays full sim + fan-out cost; mitigated by 40m interest culling
  (ADR-0003) and the measured headroom (2.5ms avg tick @50 players, see
  `docs/BENCHMARKS.md`).
