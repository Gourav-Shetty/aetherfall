# Protocol v2 — binary framing (default)

Protocol v1 (`shared/src/index.ts`, `PROTOCOL_VERSION = 1`) is JSON strings and is
**unchanged** as the fallback. v2 is the default wire format and lives entirely
in new files:

| piece | file |
| --- | --- |
| codec + types | `shared/src/protocol2.ts` |
| codec tests | `shared/src/protocol2.test.ts` |
| server wire codec (pluggable) | `server/src/net/binary.ts` |
| server wire codec tests | `server/src/net/binary.test.ts` |
| client decoder | `client/src/net2.ts` |
| client decoder tests | `client/src/net2.test.ts` |
| `.bin` recordings + measurement | `tools/replay/src/binlog.ts`, `tools/replay/src/measure.ts` |

Measured result: **92-93% fewer bytes** for a moving snapshot stream, **82%
even with no deltas at all** (see [Measured](#measured-bytes-vs-json)).

---

## 1. Handshake and fallback

v2 is negotiated over the v1 JSON hello, so a proto-2 client can always be
answered with v1 JSON:

```
client -> JSON   {"t":"hello","name":"hero","proto":2,
                  "caps":{"binary":true,"deltas":true,"keyframe":50,
                          "chat":true,"event":true}}
server -> binary [P2Welcome proto=2]                v2 accepted
server -> JSON   {"t":"welcome", ... ,"proto":1}    v2 declined, v1 continues
```

Rules (implemented in `negotiateProto`, tested in both shared and server —
v2 is the default, `PROTO=1` pins v1, `?proto=1` forces the legacy client):

| hello | result | reason |
| --- | --- | --- |
| `proto:2` + `caps.binary:true` | **2** | `accepted` |
| `proto:2` + `caps.binary:false` | 1 | `no-binary-capability` |
| `proto:2`, no `caps` | 1 | `no-caps` (`PROTO=2` legacy bypass: `accepted-forced-no-caps`) |
| `proto:1` | 1 | `older-proto` |
| `proto:3` | 1 | `future-proto` |
| `proto` non-integer / missing | 1 | `bad-proto` |
| server `PROTO=1` (any hello) | 1 | `server-v1-forced` |

v2 is the default: the client tries 2 first and falls back to v1 JSON on a
JSON welcome. `PROTO=1` pins the server to v1, `?proto=1` forces the legacy
v1 client; unknown/old clients (plain `proto:1`, no caps) keep working on
the untouched v1 path.

After a binary welcome **every** frame in both directions is one WS *binary*
message. There is no per-frame version field after that: a frame that is not
`0xAF 0x02` is dropped and counted (`decodeErrors` on the client,
`anticheat.checkMalformed` on the server).

A binary `P2Hello` frame (type 16) is also accepted as a probe, for tools that
already speak binary — the browser client and `recorder2` use the JSON form.

---

## 2. Frame layout

Everything below is little-endian. `varint` = unsigned LEB128 (7 bits/byte, high
bit = continue), `svarint` = zigzag varint (`n >= 0 ? 2n : -2n-1`, so small
negatives stay 1 byte). All integers are checked against 2^53.

### 2.1 Frame header

| off | size | field | notes |
| --- | --- | --- | --- |
| 0 | 1 | `magic` | `0xAF` |
| 1 | 1 | `version` | `2` |
| 2 | 1 | `type` | see the message table |
| 3 | 1 | `flags` | snapshot: bit0 `KEYFRAME`; all other types: 0 |
| 4 | n | `payloadLen` | varint, must equal the actual payload size |
| 4+n | m | `payload` | string table + body |

`P2_MAX_FRAME_BYTES` = 1 MiB. A declared length that disagrees with the buffer,
or exceeds the cap, is a decode error.

### 2.2 Payload preamble (every frame)

| size | field | notes |
| --- | --- | --- |
| n | `stringCount-1` | varint; entry 0 is the implicit empty string |
| n×2 | per entry: varint `byteLen` + `byteLen` bytes | UTF-8, `P2_MAX_STRING_BYTES` = 512, invalid UTF-8 rejected |
| n | `bodyLen` | varint, must match the remaining bytes exactly |
| m | `body` | type-specific |

Interning is per frame: 40 entities all named `same-mob` cost **one** table
entry (`shared/src/protocol2.test.ts`, "interns repeated names once per frame").

### 2.3 Message types

| code | name | direction | body |
| --- | --- | --- | --- |
| 1 | `P2Welcome` | S -> C | varint `id`, varint `tick`, varint `nameIdx`, varint `entityCount`, full records |
| 2 | `P2Snapshot` | S -> C | varint `tick`, varint `baseTick`, varint `removedCount`, varint ids…, varint `entityCount`, records |
| 3 | `P2Chat` | S -> C | u8 `channel`, varint `fromIdx`, varint `textIdx` |
| 4 | `P2Event` | S -> C | varint `kindIdx`, varint `payloadIdx` (JSON text) |
| 16 | `P2Hello` | C -> S | varint `nameIdx`, varint `tokenIdx`, varint `proto`, u8 `flags`, u8 `keyframeEvery` |
| 17 | `P2Input` | C -> S | u8 `flags`, varint `seq`, svarint `dtMs`, svarint `moveX`, svarint `moveY`, [svarint `skill`], [varint `targetId`], [varint `chatIdx`] |
| 18 | `P2Ack` | S -> C | u8 `flags`, varint `tick`, varint `baseTick`, varint `lastInputSeq`, [svarint `rttMs`] |

`P2Welcome` is always keyframe-shaped and seeds the client's delta baseline.

### 2.4 Entity record — bit-packed, two masks

A record is `varint id` + **two mask bytes** + the fields that are set. The
second mask byte only appears when `quick & 0x80`, so a steady-state delta
entity costs exactly one mask byte.

| mask | bit | field | width |
| --- | --- | --- | --- |
| `quick` | 0x01 | `pos` | 2 × svarint (`dx`, `dy` at 1/16 unit) |
| `quick` | 0x02 | `vel` | 2 × svarint (`dvx`, `dvy` at 1/256 u/s) |
| `quick` | 0x04 | `hp` | 1 × svarint |
| `quick` | 0x80 | `EXT` | an `ext` mask byte follows |
| `ext` | 0x01 | `maxHp` | 1 × svarint |
| `ext` | 0x02 | `dir` | 1 × svarint (1/1024 turn) |
| `ext` | 0x04 | `level` | 1 × svarint |
| `ext` | 0x08 | `name` | varint string index (absolute; `0` = cleared) |
| `ext` | 0x10 | `seq` | 1 × svarint |
| `ext` | 0x20 | `kind` | u8 (absolute) |

Field order on the wire (both directions): `pos, vel, hp, maxHp, dir, level,
name, seq, kind`.

* **Full record** (keyframe, or an id the receiver has never seen): always sets
  `quick` POS|VEL|HP|EXT and `ext` MAXHP|KIND, values are absolute.
* **Delta record**: every present field is the *difference* against the
  receiver's baseline entry for that id. `name` and `kind` are absolute.
* A record with both masks zero is dropped by the encoder, so no-op deltas cost
  zero bytes.

Kind codes: `0 player, 1 npc, 2 mob, 3 pickup, 4 projectile`.

### 2.5 Quantization

| field | scale | resolution | note |
| --- | --- | --- | --- |
| `p.x`, `p.y` | 1/16 | 6.25 cm | 6.25 cm error is far below a 0.4 u player radius |
| `v.x`, `v.y` | 1/256 | 0.004 u/s | |
| `dir` | 1/1024 | 0.001 turn | only present when `dir !== undefined` |
| `dt` | 1/1000 | 1 ms | |
| `hp`, `maxHp` | integer | 1 hp | clamped to 0..65535 (keep hp integral in the sim) |
| `seq`, `level` | integer | 1 | |

Values are `Math.round`-ed and magnitude-clamped (never wrapped), so a rogue
`1e12` position cannot corrupt neighbouring fields.

---

## 3. Deltas, keyframes and the baseline

```
tick 0   welcome (keyframe)                -> client baseline = tick 0
tick 1   snapshot baseTick=0  delta         -> client baseline = tick 1
tick 2   snapshot baseTick=1  delta         -> client baseline = tick 2
...
tick 50  snapshot baseTick=0  KEYFRAME      -> client baseline = tick 50
```

* **Keyframe every `keyframeEvery` snapshots** (`P2_KEYFRAME_INTERVAL = 50`,
  configurable with `PROTO_KEYFRAME`, clamped to 1..255, and a client may request
  its own value in `caps.keyframe`). At 10 Hz that bounds re-sync to 5 s.
* `baseTick` names the baseline a delta applies to. On a keyframe it is always
  `0` (a sentinel; the decoder rejects anything else).
* `applySnapshot(msg, baseline, baseTick)` returns
  `{ok:false, reason:'need-keyframe'}` when `baseTick` does not match, so a lost
  frame can never be papered over: the client drops the frame and waits for the
  next keyframe (`droppedSnapshots` counts them).
* Removals are applied **after** the records in the same frame, so `removed`
  always wins.
* A delta cannot express a *cleared* field (a name disappearing). `diffSnapshot`
  reports `needsKeyframe` and the sender promotes that frame to a keyframe, so
  the encoder never emits something the decoder would have to reject.

Type mapping: `P2Entity` is structurally identical to v1 `EntitySnapshot`
(`toP2Entity` / `toEntitySnapshot`), so v2 clients feed v1 render/predict code
unchanged.

---

## 4. Rejection rules (all decode-time, never throw into the tick loop)

`P2DecodeError` (message prefixed `protocol2: `) is raised for: bad magic,
unsupported version, frame < 5 bytes, length mismatch, payload > 1 MiB, unknown
message type, truncated varint/float/string, varint > 2^53 or > 9 bytes, invalid
UTF-8 in the string table, string index past the table, > 4096 strings,
> 8192 entity records, unknown kind code, `hp`/`maxHp` out of range,
non-finite float32, keyframe with `baseTick != 0`, `baseTick > tick`,
input `seq == 0`, `dt` out of range, unknown flag bits, trailing bytes after the
body, and `applySnapshot` on a delta whose entity has no baseline and no
required fields.

`safeDecodeServerFrame` / `safeDecodeClientFrame` wrap this for untrusted traffic
and return `{ok:false, error}` instead of throwing — the same crash-safe posture
as `safeParseClientMsg` on the v1 path. 50 tests in
`shared/src/protocol2.test.ts` cover the malformed side, including a
single-byte-corruption sweep over every frame type (only `P2DecodeError`s
observed).

---

## 5. Measured: bytes vs JSON

Produced by `tools/replay/measure.ts` (`npm run measure -w @aetherfall/replay`),
200 frames per scenario, snapshots 10 Hz, inputs 20 Hz, keyframe every 50.
Same state encoded both ways; no estimates.

### Snapshot streams

| scenario | entities | keyframes | JSON B/frame | v2 B/frame | v2/JSON | saved | bits/entity/frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| moving | 5 | 4 | 700 | 57.0 | 8.1% | **91.9%** | 91.3 |
| moving | 20 | 4 | 2620 | 192.6 | 7.4% | **92.6%** | 77.1 |
| moving | 60 | 4 | 7755 | 548.4 | 7.1% | **92.9%** | 73.1 |
| moving | 200 | 4 | 25888 | 1871.0 | 7.2% | **92.8%** | 74.8 |
| idle (nothing moved) | 60 | 4 | 7667 | 38.4 | 0.5% | **99.5%** | 5.1 |
| moving, no names | 60 | 4 | 7434 | 544.8 | 7.3% | **92.7%** | 72.6 |
| moving, no hp churn | 60 | 4 | 7812 | 536.6 | 6.9% | **93.1%** | 71.5 |
| moving, keyframe every 10 | 60 | 20 | 7755 | 615.0 | 7.9% | **92.1%** | 82.0 |
| moving, keyframe every snapshot (no deltas) | 60 | 200 | 7755 | 1364.7 | 17.6% | **82.4%** | 182.0 |

The last row is the interesting one: **even with deltas entirely disabled, the
binary format is 82% smaller** than v1 JSON. Deltas take it to 93%.

### Single frames (no baseline to diff against)

| frame | JSON B | v2 B | v2/JSON |
| --- | --- | --- | --- |
| welcome (60 entities) | 7590 | 1630 | 21.5% |
| ack | 71 | 16 | 22.5% |
| chat | 95 | 56 | 58.9% |
| event (telegraph, JSON payload) | 110 | 87 | 79.1% |
| input (idle) | 66 | 14 | 21.2% |
| input (moving + attack) | 99 | 16 | 16.2% |
| input (+ chat) | 103 | 41 | 39.8% |

Chat and events are dominated by their text, so they gain the least — they are
already near the floor. `P2Event.payload` stays JSON text on purpose: v1
`payload: unknown` has no schema to compile against.

### Archived session re-encoded

`tools/replay/recordings/trial.ndjson` (a real recorder capture) re-encoded
through the same codec:

| frame | JSON B | v2 B |
| --- | --- | --- |
| welcome | 378 | 92 |
| 40 snapshots | 6573 | 526 |
| **total** | **6951** | **618** |

That recording watched an almost empty shard (13–19 B per delta), which is why
it beats the synthetic average.

### Per-player wire budget

| scenario | down B/s v1 | down B/s v2 | down KB/s v2 | up B/s v1 | up B/s v2 |
| --- | --- | --- | --- | --- | --- |
| 5 entities moving | 7000 | 570 | 0.56 | 4030 | 442 |
| 20 entities moving | 26202 | 1926 | 1.88 | 4030 | 442 |
| 60 entities moving | 77548 | 5484 | 5.36 | 4030 | 442 |
| 200 entities moving | 258876 | 18710 | 18.27 | 4030 | 442 |
| 60 entities idle | 76675 | 384 | 0.37 | 4030 | 442 |

200 moving entities in view: 18.3 KB/s down instead of 253 KB/s. The idle case
(0.37 KB/s) is the common one — most of a shard is not moving between ticks.

### Live swarm wire (bots, 10 Hz snapshots, 20 Hz inputs)

Same profiles/inputs both lanes; `bytes_down` is inbound payload bytes per bot
(JSON text + binary frames). The 4-bot smokes ran back-to-back on one shard;
the 100-bot soak ran the proto2 build speaking v1 (regression check); the
20-bot run ran `PROTO=2` speaking binary. The paired
100-bot v1-vs-v2 soak is tabulated last.

| run | bots | proto | bytes_down avg/bot | B/snapshot | snapshots avg/bot | tick gaps | errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| smoke v1 | 4 | 1 | 226011 | 2379 | 95 | 0 | none |
| smoke v2 | 4 | 2 | 16011 | 160 | 100 | 0 | none |
| soak (v1 wire) | 100 | 1 | 2108843 | 7511 | 281 | 0 | none |
| smoke v2 (PROTO=2) | 20 | 2 | 29590 | 251 | 118 | 0 | none |
| v1 soak (100-bot) | 100 | 1 | 2636134 | 9484 | 278 | 0 | none |
| v2 soak (100-bot) | 100 | 2 | 146619 | 603 | 243 | 0 | none |

4-bot smoke: **92.9% fewer bytes** (160 vs 2379 B/snapshot), matching the
synthetic 92–93%. The 20-bot v2 run carries more entities per snapshot (20
players in view), hence 251 B/snapshot. The 100-bot v1 soak is clean (0 gaps,
0 errors): the proto2 build does not regress the v1 path at scale. The
100-bot v2 soak has now been run (see `docs/BENCHMARKS.md` v1-vs-v2 100-bot soak, paired
back-to-back with v1 on isolated ports, 30s, 100/100 clean both lanes, 0 gaps,
chaos flood contained via shadowban-kick, teleport probe clamped): **93.6%
fewer bot-measured bytes per snapshot** (603 vs 9484 B/snapshot), **96.0% per
snapshot payload server-side** (367 vs 9084 B), **94.7% total server wire**
(13.9MB vs 262.7MB). Caveat: the soak box was RAM-starved, so its tick
columns are contention-flavoured — see BENCHMARKS for the full table.

Raw reports: `tools/bots/report-proto1-smoke.csv`,
`tools/bots/report-proto2-smoke.csv`, `tools/bots/report-proto2-soak-v1.csv`,
`tools/bots/report-v1-100.csv`, `tools/bots/report-v2-100.csv`.

---

## 6. Server wiring (shipped, v2 default)

`server/src/index.ts` negotiates per connection; v2 binary is the default and
v1 JSON is the fallback (`PROTO=1` pins v1, `?proto=1` forces the legacy
client, old `proto:1` clients never upgrade):
the four edits below. Everything lives in `server/src/net/binary.ts`, which is
inert until a proto:2 hello arrives or `PROTO=2` is set.

1. `import { binaryProtocolEnabled, createSession, negotiateInbound, ... }`
   `from './net/binary.js'` next to the other imports (`PROTO2-HOOK`).
2. Per-connection state beside `sockets`: `sessions: WeakMap<WebSocket,
   BinarySession>`, `binarySockets: WeakSet<WebSocket>` plus a live
   `binaryCount` so the tick loop skips unused pre-passes.
3. In `wss.on('message')`, **before** `safeParseClientMsg` (a proto-2 hello is a
   version mismatch for the v1 parser and would be dropped as `bad-proto`):
   upgraded sockets decode binary (`decodeClient`, re-wrapped as
   `{t:'input',input}` so anticheat/NPC/chat stay shared); pre-admission
   sockets probe with `sess.peekHello` / `sess.hello` / `negotiateInbound`,
   and a declined offer falls through to the exact v1 path:

```ts
ws.on('message', (raw) => {
  const sess = sessions.get(ws) ?? createSession({ enabled: binaryProtocolEnabled() });
  sessions.set(ws, sess);
  if (sess.isUpgraded) {                       // binary from here on
    const f = sess.decodeClient(raw);          // null when malformed
    if (f?.t === 'input') { /* existing input handling with f.input */ }
    else anticheat.checkMalformed(pid, sim.tick, 'binary frame dropped');
    return;
  }
  if (sess.enabled && sess.peekHello(raw)) {   // JSON proto:2 or binary P2Hello
    const hello = sess.hello(raw);
    if (hello && negotiateInbound(hello).proto === 2) {
      // ...admit via the shared hello path, then upgradeSession(ws) before
      // the welcome, which send() encodes as a P2Welcome frame.
      // Declined -> fall through to the v1 path and let it send JSON.
    }
  }
  /* ...the existing v1 message path, unchanged... */
});
```

4. `send`, `broadcast`, `sendLane`/`sendToMany` route per socket (one
   `JSON.stringify` fan-out for v1, one binary encode per upgraded socket),
   and `ws.on('close')` calls `releaseSession(ws)`.

Serialize-once per tick: when `binaryCount > 0` the 10 Hz snapshot stage calls
`prequantizeSnapshot(full, quantScratch)` once, then per viewer
`sess.encodeView(quantScratch, visibleScratch, removed, sim.tick)` — the v1
`serializeEntities` + `snapshotFrame` splice is untouched alongside it. The
perf hot path (`snapshotFrame`/`entityJson`/`InterestIndex`) is byte-identical
for v1; binary adds a parallel pre-pass only.

Policy (`negotiateInbound`, tested in `server/src/net/binary.test.ts` —
negotiation matrix: 2->2, 2->1 fallback, 1->1, forced flags):

| `PROTO` | hello | result |
| --- | --- | --- |
| unset (default) | `proto:2` + `caps.binary:true` | **2** (`accepted`) |
| unset (default) | anything else | 1 |
| `2` (legacy) | `proto:2` (caps probing bypassed) | **2** (`accepted-forced` / `accepted-forced-no-caps`) |
| `2` (legacy) | `proto:1` / bad / future | 1 |
| `1` | anything, including `proto:2` | 1 (`server-v1-forced`, rollback valve) |

Env: v2 is the default offer — unset/garbage accepts a `proto:2` +
`caps.binary` hello. `PROTO=2` (also `v2`/`binary`) keeps its legacy meaning
(caps probing bypassed for `proto:2` hellos); `PROTO=1` (also `v1`/`json`)
pins everyone to v1. `PROTO_KEYFRAME=25` overrides the keyframe interval
(clamped 1..255).

`BinarySession` owns the delta baseline, the snapshot counter that decides
keyframes and the last-input-seq ack. The free functions
`encodeSnapshotBinary(msg, prev, opts)` and `decodeInputBinary(bytes)` are
exported for direct use and are pure (no hidden mutation).

Note on module resolution: `@aetherfall/shared` resolves to `shared/src` for
types via the existing `paths` mapping. v2 needs the subpath
`@aetherfall/shared/dist/protocol2.js`, which resolves at runtime through the
workspace symlink to `shared/dist/protocol2.js` (the same rule the bare
specifier already follows) and types via a matching `paths` entry in
`tsconfig.base.json`.

---

## 7. Client wiring (shipped, v2 default)

`client/src/main.ts` selects the client per page load: the default constructs
`NetClientV2` (tries v2, falls back to v1 JSON on a JSON welcome); only an
explicit `?proto=1` (alias `v1`/`json`) keeps the legacy v1 `NetClient`
(`protoFromSearch` in `client/src/net2.ts`, unit-tested — a stray link can
never break the shipping client because the fallback keeps working).
`NetClientV2` mirrors `NetClient` field-for-field:

`ws, id, tick, entities, lastAckSeq, rttMs, onChat, onSnapshot, onWelcome,
onEvent, connect(url,name), sendInput(seq,x,y,extra?), sendChat(text,channel)`
plus `proto`, `onFallback(reason)`, `droppedSnapshots`, `decodeErrors`.

* `connect()` sets `binaryType = 'arraybuffer'` (keeps decoding synchronous) and
  sends the JSON capability probe on open.
* A binary welcome sets `proto = 2` and every later `sendInput` / `sendChat`
  goes out as a frame. A JSON welcome sets `proto = 1`, fires `onFallback`
  once, and the same object keeps working as a v1 client — the fallback path is
  exercised by tests, not just hoped for.
* `attach(transport, name)` swaps in any transport, which is how the tests drive
  it without a browser.

The game loads on v2 by default. `main.ts` auto-negotiates (a JSON welcome
fires `onFallback` once with a toast and the same object keeps working as a
v1 client), and the HUD shows the negotiated `proto` beside the render mode
and ping so the default can be verified live (`?proto=1` forces v1 for
comparison). Bots take the same choice with `--proto 2` (`tools/bots`,
default 1, auto-fallback included).

---

## 8. `.bin` recordings

`tools/replay/src/binlog.ts` reads and writes a binary container holding raw v2
frames, next to the existing `.ndjson` recorder.

| off | size | field |
| --- | --- | --- |
| 0 | 6 | magic `AFBIN2` |
| 6 | 1 | version `2` |
| 7 | 1 | flags (reserved) |
| 8 | n | record: u8 `type` (1 = frame, 0 = EOF), varint `ms`, varint `len`, `len` bytes |

```bash
# record a live v2 session (start the server with PROTO=2 first)
npm run record2 -w @aetherfall/replay -- --duration 30 --out recordings/run.bin

# convert an archived v1 recording to v2 frames (delta-compressed + keyframed)
npm run bin -w @aetherfall/replay -- convert recordings/trial.ndjson recordings/trial.bin

# inspect / stats
npm run bin -w @aetherfall/replay -- inspect recordings/trial.bin --frames 5
npm run bin -w @aetherfall/replay -- stats recordings/trial.bin --json

# export a .bin back to v1 ndjson so tools/replay/viewer.html can replay it
npm run bin -w @aetherfall/replay -- convert recordings/trial.bin recordings/trial.ndjson
```

Container overhead is ~4 B per record (type byte + two varints); for the archived
session, 618 B of frames became a 790 B file. `decodeRecordedFrames` replays a log
exactly like a client and reports drops, and the
`ndjson -> bin -> ndjson -> bin` round trip is byte-stable (tested).

---

## 9. Verifying

```bash
npm run build   --workspaces
npm run typecheck --workspaces
npm run test    --workspaces     # shared 66, engine 103, server 594, client 363, bots 21, replay 79
npm run measure --workspace=@aetherfall/replay   # regenerate the tables above
```

v2 is the default wire: the server offers binary unless `PROTO=1` pins v1,
the client tries v2 first (`?proto=1` forces the legacy v1 client) and falls
back to v1 JSON on a JSON welcome. Negotiation matrix (2->2, 2->1 fallback,
1->1, forced flags) plus v2/v1 byte-parity on the same sim are covered below.

Coverage for this feature:

* `shared/src/protocol2.test.ts` — 57 tests: varint/zigzag/float32 boundaries,
  string interning, byte-stable round-trips for all 7 frame types, a 120-tick
  delta stream that must reconstruct the exact world, removal and clear
  semantics, keyframe schedule, negotiation matrix, malformed rejection
  (including a corruption sweep).
* `server/src/net/binary.test.ts` — 39 tests: `PROTO` gate (v2 default,
  `PROTO=1` pins v1, `PROTO=2` legacy caps bypass), baseline bookkeeping,
  keyframe cadence, a 60-snapshot stream decoded by a real client baseline,
  handshake junk tolerance, v1 message parity, `negotiateInbound` policy
  (forced/pinned/offer), serialize-once `encodeView` parity + a 120-tick
  view stream that reconstructs the world client-side, the v2-default
  negotiation matrix (2->2, 2->1 fallback, 1->1, forced flags), and v2/v1
  byte-parity on the same 30-tick sim.
* `client/src/net2.test.ts` — 21 tests: probe shape, upgrade, fallback,
  60-delta stream, baseline-drift drop, removals/despawn, ack/chat, hostile
  frames, v2-default `?proto=1` selection, the client-side negotiation matrix
  (2->2, 2->1 fallback, 1->1), and v2/v1 byte-parity on the same sim.
* `tools/replay/src/binlog.test.ts` + `bincli.test.ts` — 32 tests: container
  round-trip, corrupt files, ndjson conversion, replay verification, CLI args.