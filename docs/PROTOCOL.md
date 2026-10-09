# Protocol v1
hello -> welcome -> input@20Hz -> snapshot@10Hz. See shared/src/index.ts.
Interest: server only sends entities within 40 units.

## Deltas (implemented)
- `welcome` snapshot is now interest-filtered: only entities within 40m of the
  spawnee (plus self) are included. Full world state is never leaked at join.
- `snapshot` is per-player filtered: `server/src/index.ts` builds one full
  snapshot per tick, then `InterestTracker.update(viewerId, pos, full)` emits
  `{ visible, removed }` per connection. Wire shape unchanged (protocol v1
  compatible): `{ t:'snapshot', tick, entities: visible, removed }`.
- `removed: number[]` semantics: entity ids that left the 40m radius OR
  despawned since the last snapshot for that viewer. Clients must evict them
  (also used for `despawn` events on disconnect).
- `hello` accepts optional `token` (HMAC dev token, see `server/src/auth.ts`);
  absent/invalid token falls back to guest identity. `proto` mismatch still
  gets `{ t:'event', kind:'bad-proto' }` + close.
- Input path unchanged (`input{seq,dt,move,...}`); server clamps move axes to
  [-1,1] x 8 u/s, rejects >66Hz senders and teleports (>5 units/step), logs to
  anticheat violations. No new client fields required.

## v2 (binary, opt-in)
`PROTOCOL.md` documents the shipping wire format. The negotiated binary
alternative lives in `shared/src/protocol2.ts` and is described, with measured
byte counts, in **PROTOCOL2.md**. It is off by default: v1 stays the wire format
unless the server is started with `PROTO=2`.
