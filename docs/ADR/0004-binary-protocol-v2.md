# ADR-0004: Binary protocol v2 negotiated over the v1 JSON handshake

- Status: accepted
- Date: 2026-10-02
- Context: Protocol v1 (`shared/src/index.ts`, `PROTOCOL_VERSION = 1`) is JSON
  text frames. Profiling showed JSON encoding dominating the snapshot section
  (92–98% of it), and measured snapshot size was ~7.9 KB/frame at 100 players
  and ~23.8 KB/frame at 300 — bandwidth, not CPU, becomes the wall first. But
  v1 is the shipped protocol: the client, the bots, the recorder, and the replay
  fixtures all speak it, and rewriting it in place would break every one of them.

## Decision

Ship **protocol v2 as a negotiated alternative**, not a replacement:

- The client advertises `proto: 2` and its capabilities (`binary`, `deltas`,
  `keyframe`, `chat`, `event`) inside the *existing JSON hello*. The server
  answers with a binary `P2Welcome` when it accepts, or with a v1 JSON welcome
  when it declines. `PROTO=2` is the only env value that enables it; unset stays
  v1 bit-for-bit.
- After acceptance every frame in both directions is one WS **binary** message:
  `0xAF 0x02 | type | flags | varint len | payload`, little-endian, LEB128
  varints, zigzag for negatives.
- Entity records are **bit-packed with two mask bytes** (`quick`, plus an `ext`
  byte only when `quick & 0x80`), positions quantized to 1/16 u (6.25 cm) and
  velocities to 1/256 u/s, names interned once per frame in a string table, and
  **delta-encoded** against the receiver's baseline with a keyframe every 50
  snapshots.
- Every decode failure is a decode-time rejection (`P2DecodeError`), never a
  throw into the tick loop; `safeDecodeServerFrame` / `safeDecodeClientFrame`
  wrap untrusted traffic with the same posture as `safeParseClientMsg` on v1.

## Alternatives considered

- **Replace v1 with v2 in place:** one protocol, but a flag day for the client,
  the 1000-bot harness, the recorder and every archived `.ndjson` replay.
  Rejected — the fallback path is exactly what makes this shippable.
- **Protobuf / flatbuffers / msgpack:** better tooling, but a code-gen
  dependency and a schema step in a repo whose point is that the wire format is
  legible in `shared/src/protocol2.ts`. Rejected.
- **Varint without quantization:** keeps precision, loses most of the win —
  positions become 5-byte doubles-ish values instead of 1-byte deltas.
  Rejected.
- **JSON + gzip only:** compresses well but costs CPU per viewer per frame and
  still pays JSON key repetition. Rejected.

## Consequences

- Good: measured **92–93% fewer bytes** for a moving snapshot stream, and **82%
  smaller even with deltas disabled entirely** — the format, not the delta
  scheme, carries most of the win (200 moving entities: 253 KB/s → 18.3 KB/s
  per player). Idle shards fall to 0.37 KB/s.
- Good: byte-identical semantics. `P2Entity` is structurally identical to v1
  `EntitySnapshot`, so v2 clients drive the same predict/render code; a
  `baseTick` mismatch yields `{ok:false, reason:'need-keyframe'}` instead of
  silently corrupting state, so a lost frame is a dropped frame, not a desync.
- Good: the negotiation table (`negotiateProto`) is exhaustive and unit-tested
  for older/future/non-integer/absent versions — the fallback is exercised by
  tests rather than hoped for.
- Bad: two codecs to keep in sync. Mitigated by v1 remaining untouched (zero
  runtime risk while v2 is off), one shared field-order table, and a
  re-encode harness (`tools/replay/src/measure.ts`) that measures real captures
  instead of hand-rolled fixtures.
- Bad: shipping a perf win nobody sees. The server wiring is 4 documented edits
  (`docs/PROTOCOL2.md` §6) that were deliberately **not** applied, so `PROTO`
  unset is bit-identical to v1; turning it on is a reviewed patch, not a
  refactor under pressure.