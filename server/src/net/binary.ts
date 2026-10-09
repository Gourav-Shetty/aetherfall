// @aetherfall/server — protocol v2 binary wire codec (negotiated, v2 default).
//
// This module is additive: with no `proto:2` client it is inert for that
// connection, and `server/src/index.ts` keeps speaking protocol v1 (JSON) for
// every v1 hello. v2 is the default offer: a `proto:2` + `caps.binary` hello is
// accepted unless `PROTO=1` pins the process to v1. Nothing here runs at
// import time and no socket is touched.
//
// ---------------------------------------------------------------------------
// WIRING (live — see docs/PROTOCOL2.md §6)
// ---------------------------------------------------------------------------
//   1. import { binaryProtocolEnabled, createSession, negotiateInbound } from './net/binary.js';
//
//   2. per-connection state, next to `const sockets = new Map<number, WebSocket>()`:
//        const sessions = new WeakMap<WebSocket, BinarySession>();
//
//   3a. hello intercept — this MUST run before `safeParseClientMsg`, because a
//       proto-2 hello looks like a version mismatch to the v1 parser:
//        ws.on('message', (raw) => {
//          const sess = sessions.get(ws) ?? createSession({ enabled: binaryProtocolEnabled() });
//          sessions.set(ws, sess);
//          if (sess.isUpgraded) {                             // binary only now
//            const f = sess.decodeClient(raw);                // null when malformed
//            if (f?.t === 'input') { /* existing input handling, f.input */ }
//            else anticheat.checkMalformed(pid, sim.tick, 'binary frame dropped');
//            return;
//          }
//          if (sess.peekHello(raw)) {        // JSON proto:2 OR binary P2Hello
//            const hello = sess.hello(raw);
//            if (hello && negotiateInbound(hello).proto === 2) {
//              sess.enableBinary();
//              // resolveIdentity / interest / spawn run exactly as they do for v1,
//              // then `send()` routes the welcome through the session:
//              send(ws, sess.encode({ t: 'welcome', id: pid, tick: sim.tick, snapshot: visible }));
//              return;
//            }
//            // declined -> fall through and send the v1 JSON welcome instead
//          }
//          /* ...the existing v1 message path, unchanged... */
//        });
//
//   3b. outbound — make `send()` route through the session (3 lines):
//        const sess = sessions.get(ws);
//        if (sess?.isUpgraded) { const b = sess.encode(msg); ws.send(b); metrics.observeSnapshot(b.length); return; }
//
//   4. `ws.on('close')`: sessions.delete(ws)  (or dropSession(sessions, ws))
//
// The session owns the per-connection delta baseline plus the snapshot counter
// that decides keyframes, so `send(ws, msg)` keeps its exact v1 signature and
// a v1-only client sees bit-for-bit today's behaviour.
import {
  P2_KEYFRAME_INTERVAL,
  P2_MAX_FRAME_BYTES,
  P2SnapshotStream,
  P2ViewStream,
  PROTO2_VERSION,
  baselineFromEntities,
  decodeHelloBinary,
  decodeInputBinary as decodeInputBytes,
  encodeAckBinary,
  encodeChatBinary,
  encodeEventBinary,
  encodeHelloBinary,
  encodeSnapshotAgainst,
  encodeWelcomeBinary,
  isKeyframeSeq,
  negotiateProto,
  prequantizeSnapshot,
  quantizeEntity,
  resolveKeyframeEvery,
  safeDecode,
  toP2Entity,
  type EncodeAgainstResult,
  type P2Baseline,
  type P2Entity,
  type P2Input,
  type P2Quant,
  type P2Welcome,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';
import { extractRouteKey } from '../router/hash.js';

/** Environment contract: v2 is the default offer; only PROTO=1 pins v1. */
export const PROTO_ENV_VAR = 'PROTO';

/** Handshake bounds, mirroring `safeParseClientMsg` on the v1 path. */
const MAX_HELLO_NAME_CHARS = 1024;
const MAX_HELLO_TOKEN_CHARS = 512;

export type Env = Record<string, string | undefined>;

/**
 * Is binary protocol v2 offered by this process? Default **true**: v2 is the
 * default wire format and a stray/garbage `PROTO` value keeps it (a v1-only
 * client never offers `proto:2`, so it stays on JSON regardless).
 * Only `PROTO=1` (alias `v1`/`json`) disables the offer — the rollback valve.
 */
export function binaryProtocolEnabled(env: Env = process.env): boolean {
  return !v1Forced(env);
}

/**
 * Explicit `PROTO=2` (alias `v2`/`binary`): the legacy opt-in flag. Still
 * honoured — it bypasses capability probing for `proto:2` hellos (accepts
 * even a caps-less probe). Unset/garbage behaves the same for real clients
 * (which always send caps) but still requires the `caps.binary` offer.
 */
export function v2Forced(env: Env = process.env): boolean {
  const raw = env[PROTO_ENV_VAR];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '2' || v === 'v2' || v === 'binary';
}

/**
 * `PROTO=1` pins the process to v1 even for clients that advertise proto 2.
 * The rollback/A-B valve: capability negotiation cannot override it.
 */
export function v1Forced(env: Env = process.env): boolean {
  const raw = env[PROTO_ENV_VAR];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'v1' || v === 'json';
}

/** Keyframe interval from env (PROTO_KEYFRAME=25), clamped to 1..255. */
export function keyframeEveryFromEnv(env: Env = process.env): number {
  const raw = Number(env['PROTO_KEYFRAME']);
  if (!Number.isInteger(raw) || raw < 1 || raw > 255) return P2_KEYFRAME_INTERVAL;
  return raw;
}

/* ------------------------------------------------------------------ *
 * inbound negotiation policy (what index.ts asks per connection)
 * ------------------------------------------------------------------ */

/**
 * Does this hello *offer* binary v2? `proto:2` plus `caps.binary: true` — the
 * JSON capability probe and a binary `P2Hello` frame both normalize to that.
 * A hello that omits caps, or explicitly sets `binary:false`, is not an offer.
 */
export function helloAdvertisesBinary(hello: unknown): boolean {
  if (!hello || typeof hello !== 'object') return false;
  const o = hello as { proto?: unknown; caps?: unknown };
  if (Number(o.proto) !== PROTO2_VERSION) return false;
  const caps = o.caps;
  if (!caps || typeof caps !== 'object') return false;
  return (caps as { binary?: unknown }).binary === true;
}

export type InboundDecision = {
  /** 2 = upgrade this connection to binary frames, 1 = stay on v1 JSON. */
  proto: 1 | 2;
  /** Machine-readable reason, logged with the connection. */
  reason: string;
  /** Keyframe interval in force for this connection (v2 only). */
  keyframeEvery: number;
};

/**
 * Server-side decision for one inbound hello.
 *
 * | PROTO | hello                       | result | reason             |
 * | ----- | --------------------------- | ------ | ------------------ |
 * | unset | `proto:2` + `caps.binary`   | **2**  | `accepted`         |
 * | unset | anything else               | 1      | `server-disabled`  |
 * | `2`   | `proto:2` + `caps.binary`   | **2**  | `accepted-forced`  |
 * | `2`   | `proto:2`, no/partial caps   | **2**  | `accepted-forced-no-caps` |
 * | `2`   | `proto:1` / bad / future     | 1      | `older-proto`, …   |
 * | `1`   | anything, including `proto:2`| 1      | `server-v1-forced` |
 *
 * v2 is the default: any `proto:2` + `caps.binary` offer is accepted unless
 * `PROTO=1` pins v1. `PROTO=2` keeps its legacy meaning (capability probing
 * is bypassed — a bare `proto:2` with no caps is still accepted). Neither
 * mode can turn a v1-only client into a binary client, because a client that
 * never asks is never upgraded.
 */
export function negotiateInbound(
  hello: unknown,
  env: Env = process.env,
  keyframeEvery: number = keyframeEveryFromEnv(env),
): InboundDecision {
  if (v1Forced(env)) return { proto: 1, reason: 'server-v1-forced', keyframeEvery };
  const forced = v2Forced(env);
  if (forced) {
    if (Number((hello as { proto?: unknown } | null)?.proto) !== PROTO2_VERSION) {
      const d = negotiateProto(hello, { enabled: true, keyframeEvery });
      return { proto: 1, reason: d.reason, keyframeEvery };
    }
    const offered = helloAdvertisesBinary(hello);
    return {
      proto: 2,
      reason: offered ? 'accepted-forced' : 'accepted-forced-no-caps',
      keyframeEvery: resolveKeyframeEvery(hello, { keyframeEvery }),
    };
  }
  if (!helloAdvertisesBinary(hello)) return { proto: 1, reason: 'server-disabled', keyframeEvery };
  return { proto: 2, reason: 'accepted', keyframeEvery: resolveKeyframeEvery(hello, { keyframeEvery }) };
}


/* ------------------------------------------------------------------ *
 * free functions — the two entry points named in the protocol v2 spec
 * ------------------------------------------------------------------ */

export type EncodeSnapshotResult = EncodeAgainstResult;

/**
 * Encode a v1-shaped snapshot/welcome message as a v2 binary frame.
 *
 * Pure: nothing is mutated. Feed the returned `baseline` back in as `prev` on
 * the next tick to get deltas. One map per player — never share.
 *
 * Keyframes default to ON unless the caller passes `keyframe: false`, and any
 * delta that cannot be expressed (a field was cleared) is promoted to a
 * keyframe automatically, so the encoder never emits a frame the decoder would
 * have to reject.
 */
export function encodeSnapshotBinary(
  msg: ServerMsg,
  prev: P2Baseline = new Map(),
  opts: { keyframe?: boolean; baseTick?: number } = {},
): EncodeSnapshotResult {
  if (msg.t !== 'snapshot' && msg.t !== 'welcome') {
    throw new TypeError(`encodeSnapshotBinary: expected snapshot|welcome, got ${String(msg.t)}`);
  }
  const entities = (msg.t === 'welcome' ? msg.snapshot : msg.entities) as EntitySnapshot[];
  const removed = msg.t === 'snapshot' ? msg.removed : [];
  return encodeSnapshotAgainst(
    entities.map(toP2Entity),
    removed,
    msg.tick,
    prev,
    // default ON: never emit a delta whose baseline the receiver may not hold
    { keyframe: msg.t === 'welcome' || opts.keyframe !== false, ...(opts.baseTick !== undefined ? { baseTick: opts.baseTick } : {}) },
  );
}

/** Decode a client input frame. Throws P2DecodeError on any malformed frame. */
export function decodeInputBinary(data: Uint8Array | ArrayBufferView | ArrayBuffer | string): P2Input {
  if (typeof data === 'string') throw new TypeError('decodeInputBinary: binary frame expected, got string');
  return decodeInputBytes(asBytes(data));
}

/** Zero-copy view over ws payloads (Buffer, typed array, or ArrayBuffer). */
export function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('binary frame expected (Uint8Array/ArrayBuffer), got ' + typeof data);
}

const JSON_SNIFF = new TextDecoder();

/**
 * JSON text carried by an inbound payload, or null when the payload is a real
 * binary frame.
 *
 * `ws` hands the server Buffers for text frames as well as binary ones (the
 * socket's `binaryType` decides, and the default is `nodebuffer`), so the v1
 * JSON handshake is NOT reliably a JS string. Sniffing the first byte keeps the
 * two lanes apart: JSON always starts with `{`/`[`, a v2 frame with `0xAF`.
 */
export function jsonTextOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (!(raw instanceof Uint8Array)) return null;
  if (raw.length === 0) return null;
  const first = raw[0]!;
  if (first !== 0x7b && first !== 0x5b) return null; // '{' or '['
  return JSON_SNIFF.decode(raw);
}

/* ------------------------------------------------------------------ *
 * per-connection session
 * ------------------------------------------------------------------ */

export type SessionOptions = {
  /** Protocol v2 switch. Default `binaryProtocolEnabled()` (v2 default, `PROTO=1` disables). */
  enabled?: boolean;
  /** Snapshots between keyframes. Default `keyframeEveryFromEnv()`. */
  keyframeEvery?: number;
};

export type SessionStats = {
  /** Snapshot counter — keyframe when `seq % keyframeEvery === 0`. */
  seq: number;
  /** Server tick of the baseline the client is holding. */
  baseTick: number;
  /** Last input seq applied (echoed in the ack). */
  lastInputSeq: number;
};

/** A v2 wire endpoint for one player: holds the delta baseline, never throws. */
export class BinarySession {
  readonly keyframeEvery: number;
  private stream: P2SnapshotStream;
  /** Serialize-once encoder used by the broadcast tick loop. */
  private view: P2ViewStream;
  private stats: SessionStats = { seq: 0, baseTick: 0, lastInputSeq: 0 };
  private enabledFlag: boolean;
  private keyframeEveryFlag: number;
  private upgraded = false;

  constructor(opts: SessionOptions = {}) {
    this.enabledFlag = opts.enabled ?? binaryProtocolEnabled();
    this.keyframeEveryFlag = opts.keyframeEvery ?? keyframeEveryFromEnv();
    this.keyframeEvery = this.keyframeEveryFlag;
    this.stream = new P2SnapshotStream(this.keyframeEveryFlag);
    this.view = new P2ViewStream(this.keyframeEveryFlag);
  }

  /** Whether this connection may negotiate binary frames. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Capability-driven upgrade step: the hello asked for proto 2 and the server
   * policy said yes, so allow binary before `upgrade()` flips the wire format.
   * A client-requested keyframe interval is honoured here (clamped 1..255).
   */
  enableBinary(keyframeEvery?: number): void {
    this.enabledFlag = true;
    const kf =
      keyframeEvery === undefined
        ? this.keyframeEveryFlag
        : Math.min(255, Math.max(1, Math.floor(keyframeEvery) || 1));
    if (kf === this.keyframeEveryFlag) return;
    this.keyframeEveryFlag = kf;
    this.stream = new P2SnapshotStream(kf);
    this.view = new P2ViewStream(kf);
  }

  /** True once the handshake agreed on binary frames (`upgrade()` was called). */
  get isUpgraded(): boolean {
    return this.upgraded;
  }

  get baseTick(): number {
    return this.stats.baseTick;
  }

  get seq(): number {
    return this.stats.seq;
  }

  get lastInputSeq(): number {
    return this.stats.lastInputSeq;
  }

  /** Mark the connection as upgraded to binary and drop the stale baseline. */
  upgrade(): void {
    this.upgraded = true;
    this.stream.reset();
    this.view.reset();
    this.stats = { seq: 0, baseTick: 0, lastInputSeq: 0 };
  }

  /** Reset per-connection state (disconnect / shard transfer). */
  reset(): void {
    this.upgraded = false;
    this.stream.reset();
    this.view.reset();
    this.stats = { seq: 0, baseTick: 0, lastInputSeq: 0 };
  }

  /** True when the raw payload looks like a binary frame rather than JSON. */
  static isBinaryFrame(raw: unknown): boolean {
    if (typeof raw === 'string') return false;
    return raw instanceof Uint8Array || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw);
  }

  /** Cheap "is this a hello?" probe that never throws. */
  peekHello(raw: unknown): boolean {
    const text = jsonTextOf(raw);
    if (text !== null) {
      const parsed = safeDecode(() => JSON.parse(text) as Record<string, unknown>);
      return parsed.ok && !!parsed.value && parsed.value['t'] === 'hello';
    }
    if (!BinarySession.isBinaryFrame(raw)) return false;
    const bytes = safeDecode(() => asBytes(raw));
    return bytes.ok && bytes.value.length > 3 && bytes.value[1] === PROTO2_VERSION && bytes.value[2] === 16;
  }

  /**
   * Normalize a handshake. Accepts BOTH the v1 JSON hello carrying `proto: 2`
   * and a binary P2Hello frame. Returns null when it is not a hello, is
   * malformed, or does not advertise proto 2.
   *
   * A `name` that is present but not a string is rejected outright (null), the
   * same posture as `safeParseClientMsg`: the handshake path must not silently
   * admit something the v1 parser would have dropped.
   */
  hello(raw: unknown): { t: 'hello'; name: string; token?: string; proto: number; caps?: Record<string, unknown>; nonce?: string } | null {
    const parsed = this.parseHello(raw);
    if (!parsed || parsed.proto !== PROTO2_VERSION) return null;
    if (typeof parsed.name !== 'string') return null;
    if (parsed.name.length > MAX_HELLO_NAME_CHARS) return null;
    if (typeof parsed.token === 'string' && parsed.token.length > MAX_HELLO_TOKEN_CHARS) return null;
    return {
      t: 'hello',
      name: parsed.name,
      ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
      proto: parsed.proto,
      ...(parsed.caps ? { caps: parsed.caps } : {}),
      // SHARDING: a JSON proto:2 probe may carry the client-stable
      // routing key (`nonce` + aliases); binary P2Hello frames have no such
      // field and fall back to `token ?? name` at route time.
      ...(parsed.nonce !== undefined ? { nonce: parsed.nonce } : {}),
    };
  }

  /** Negotiate: does this hello get protocol v2? */
  negotiate(hello: unknown): { proto: 1 | 2; reason: string } {
    return negotiateProto(hello, { enabled: this.enabled, keyframeEvery: this.keyframeEvery });
  }

  /** Keyframe interval actually in force for this connection. */
  resolveKeyframeEvery(hello: unknown): number {
    return resolveKeyframeEvery(hello, { keyframeEvery: this.keyframeEvery });
  }

  /** Record the last input seq the sim applied (for the ack). */
  noteInputSeq(seq: number): void {
    if (Number.isInteger(seq) && seq > this.stats.lastInputSeq) this.stats.lastInputSeq = seq;
  }

  /** Binary welcome frame (also seeds the delta baseline). */
  encodeWelcome(msg: P2Welcome): Uint8Array {
    const bytes = encodeWelcomeBinary(msg);
    // the welcome already told the client this state: seed from it
    this.stream.seed(msg.snapshot, msg.tick);
    this.view.seed(msg.snapshot, msg.tick);
    this.stats.seq = this.stream.seq;
    this.stats.baseTick = msg.tick;
    return bytes;
  }

  /**
   * Serialize-once broadcast: encode one viewer's snapshot frame straight from
   * the tick-wide quantized world.
   *
   * Byte-identical, per viewer, to
   * `session.encode({t:'snapshot', tick, entities: visibleEntities, removed})`
   * — same keyframe schedule, record order and string-table order — but the
   * world is quantized once per tick instead of once (twice) per viewer. The
   * caller must have `prequantizeSnapshot(full)`'d the tick and collected
   * `visible` as indices into that same array.
   */
  encodeView(
    quant: readonly P2Quant[],
    visible: readonly number[],
    removed: readonly number[],
    tick: number,
  ): Uint8Array {
    const bytes = this.view.encodeView(quant, visible, removed, tick);
    this.stats.seq = this.view.seq;
    this.stats.baseTick = this.view.baseTick;
    return bytes;
  }

  encodeChat(msg: { from: string; text: string; channel: 'global' | 'say' | 'guild' }): Uint8Array {
    return encodeChatBinary({ t: 'chat', ...msg });
  }

  /** v1 `payload: unknown` is kept as JSON text so the shape survives v2. */
  encodeEvent(msg: { kind: string; payload?: unknown }): Uint8Array {
    return encodeEventBinary({ t: 'event', kind: msg.kind, payload: JSON.stringify(msg.payload ?? null) });
  }

  encodeAck(rttMs?: number): Uint8Array {
    return encodeAckBinary({
      t: 'ack',
      tick: this.stats.baseTick,
      baseTick: this.stats.baseTick,
      lastInputSeq: this.stats.lastInputSeq,
      ...(rttMs !== undefined ? { rttMs } : {}),
    });
  }

  /**
   * Encode a v1-shaped outbound ServerMsg as binary — the drop-in for
   * `ws.send(JSON.stringify(msg))`. Chat/event keep their v1 semantics.
   */
  encode(msg: ServerMsg): Uint8Array {
    if (msg.t === 'snapshot') {
      const bytes = this.stream.encode(
        msg.entities.map(toP2Entity),
        msg.removed,
        msg.tick,
      );
      this.stats.seq = this.stream.seq;
      this.stats.baseTick = this.stream.baseTick;
      return bytes;
    }
    if (msg.t === 'welcome') {
      return this.encodeWelcome({
        t: 'welcome',
        proto: PROTO2_VERSION,
        id: msg.id,
        tick: msg.tick,
        name: '',
        snapshot: msg.snapshot.map(toP2Entity),
      });
    }
    if (msg.t === 'chat') return this.encodeChat({ from: msg.from, text: msg.text, channel: msg.channel });
    if (msg.t === 'event') return this.encodeEvent({ kind: msg.kind, payload: msg.payload });
    const never: never = msg;
    throw new TypeError(`BinarySession.encode: unhandled message ${JSON.stringify(never)}`);
  }

  /**
   * Decode a client frame (binary input or hello). Returns null on anything
   * malformed — a hostile frame can cost the sender a strike, never a tick.
   */
  decodeClient(raw: unknown): P2Input | { t: 'hello'; name: string; token?: string; proto: 2 } | null {
    const text = jsonTextOf(raw);
    if (text !== null) {
      const parsed = safeDecode(() => JSON.parse(text) as Record<string, unknown>);
      if (!parsed.ok || !parsed.value || parsed.value['t'] !== 'hello') return null;
      const token = parsed.value['token'];
      const name = parsed.value['name'];
      return {
        t: 'hello',
        name: typeof name === 'string' ? name : '',
        ...(typeof token === 'string' ? { token } : {}),
        proto: PROTO2_VERSION,
      };
    }
    const bytes = safeDecode(() => asBytes(raw));
    if (!bytes.ok || bytes.value.length < 4) return null;
    if (bytes.value[1] !== PROTO2_VERSION) return null;
    if (bytes.value[2] === 16) {
      const decoded = safeDecode(() => decodeHelloBinary(bytes.value));
      if (!decoded.ok) return null;
      const h = decoded.value;
      return {
        t: 'hello',
        name: h.name,
        ...(h.token !== undefined ? { token: h.token } : {}),
        proto: PROTO2_VERSION,
      };
    }
    const decoded = safeDecode(() => decodeInputBytes(bytes.value));
    return decoded.ok ? decoded.value : null;
  }

  private parseHello(raw: unknown): { name: unknown; token: unknown; proto: number; caps?: Record<string, unknown>; nonce?: string } | null {
    const text = jsonTextOf(raw);
    if (text !== null) {
      const parsed = safeDecode(() => JSON.parse(text) as Record<string, unknown>);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return null;
      const o = parsed.value;
      const proto = Number(o['proto']);
      if (!Number.isInteger(proto)) return null;
      const caps = o['caps'];
      // SHARDING: keep the client-stable routing key when the JSON
      // probe carries one (never rejects: unusable keys fall back downstream).
      const nonce = extractRouteKey(o);
      return {
        name: o['name'],
        token: o['token'],
        proto,
        ...(caps && typeof caps === 'object' && !Array.isArray(caps) ? { caps: caps as Record<string, unknown> } : {}),
        ...(nonce !== undefined ? { nonce } : {}),
      };
    }
    const bytes = safeDecode(() => asBytes(raw));
    if (!bytes.ok) return null;
    const b = bytes.value;
    if (b[2] !== 16) return null;
    const decoded = safeDecode(() => decodeHelloBinary(b));
    if (!decoded.ok) return null;
    const h = decoded.value;
    return {
      name: h.name,
      token: h.token,
      proto: h.proto,
      caps: h.caps as unknown as Record<string, unknown>,
    };
  }
}

/** Convenience factory mirroring `new BinarySession(opts)`. */
export function createSession(opts: SessionOptions = {}): BinarySession {
  return new BinarySession(opts);
}

/** Reset + forget a session on disconnect. Safe for unknown sockets. */
export function dropSession(sessions: WeakMap<object, BinarySession>, ws: object): void {
  const sess = sessions.get(ws);
  if (sess) sess.reset();
  sessions.delete(ws);
}

/** Binary hello frame — used by tests/tools; real clients send the JSON probe. */
export function encodeHelloProbe(name: string, token?: string, keyframe = P2_KEYFRAME_INTERVAL): Uint8Array {
  return encodeHelloBinary({
    t: 'hello',
    proto: PROTO2_VERSION,
    name,
    ...(token !== undefined ? { token } : {}),
    caps: { binary: true, deltas: true, keyframe, chat: true, event: true },
  });
}

/** Quantized baseline for a v1-shaped entity list (used by tools/tests). */
export function baselineOf(entities: EntitySnapshot[]): P2Baseline {
  return baselineFromEntities(entities.map(toP2Entity));
}

/** One-shot keyframe schedule check — mirrors BinarySession.encode's choice. */
export function shouldKeyframe(seq: number, keyframeEvery = P2_KEYFRAME_INTERVAL): boolean {
  return isKeyframeSeq(seq, keyframeEvery);
}

export {
  P2_KEYFRAME_INTERVAL,
  P2_MAX_FRAME_BYTES,
  PROTO2_VERSION,
  prequantizeSnapshot,
  quantizeEntity,
  type P2Baseline,
  type P2Entity,
  type P2Input,
  type P2Quant,
  type P2Welcome,
};