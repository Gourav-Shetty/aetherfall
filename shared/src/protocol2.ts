// @aetherfall/shared — protocol v2 binary framing.
//
// ADDITIVE: nothing in this file changes protocol v1 (`shared/src/index.ts`,
// PROTOCOL_VERSION === 1, JSON string frames). v2 is a negotiated alternative
// wire format; a client advertises `proto: 2` in the *JSON* hello and the server
// either accepts (binary frames from then on) or falls back to v1 JSON.
//
//   client -> JSON  {t:'hello', name, proto:2, caps:{binary:true,deltas:true}}
//   server -> bin   [P2Welcome proto=2]        (v2 accepted)
//   server -> JSON  {t:'welcome', ..., proto:1} (v2 declined, v1 continues)
//
// Once v2 is accepted every frame is a single WS *binary* message:
//
//   off size field
//   0   1    magic 0xAF
//   1   1    version 2
//   2   1    msgType
//   3   1    flags (snapshot: bit0 = keyframe)
//   4   n    payload length, LEB128 uvarint (hard cap P2_MAX_FRAME_BYTES)
//   ..  ..   payload
//
// Every payload starts with a per-frame string table (interning) followed by a
// body. See docs/PROTOCOL2.md for the full layout tables.
import type { EntitySnapshot, Vec2 } from './index.js';

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

export const PROTO2_VERSION = 2;

/** First frame byte. Cheap sanity check against random/torn payloads. */
export const P2_MAGIC = 0xaf;

/** A keyframe every N snapshots keeps a fresh joiner / late subscriber bounded. */
export const P2_KEYFRAME_INTERVAL = 50;

/** Hard caps — every one of these is a decode-time rejection, never a throw-later. */
export const P2_MAX_FRAME_BYTES = 1 << 20; // 1 MiB per frame
export const P2_MAX_ENTITIES = 8192; // entity records per frame
export const P2_MAX_STRINGS = 4096; // interned strings per frame
export const P2_MAX_STRING_BYTES = 512; // utf-8 bytes per interned string

/** Fixed-point scales. Position 1/16u = 6.25cm, velocity 1/256 u/s. */
export const P2_POS_SCALE = 16;
export const P2_VEL_SCALE = 256;
export const P2_DIR_SCALE = 1024; // radians -> 1/1024 turn
export const P2_DT_SCALE = 1000; // dt seconds -> ms
export const P2_MAX_HP = 65535;

const Q_LIMIT_POS = 1 << 25;
const Q_LIMIT_VEL = 1 << 21;
const Q_LIMIT_DIR = 1 << 19;
const Q_LIMIT_MOVE = 1 << 21;
const Q_LIMIT_LEVEL = 1 << 24;
const Q_LIMIT_SEQ = 1 << 30;

export const P2Type = {
  Welcome: 1,
  Snapshot: 2,
  Chat: 3,
  Event: 4,
  Hello: 16,
  Input: 17,
  Ack: 18,
} as const;
export type P2TypeCode = (typeof P2Type)[keyof typeof P2Type];

export const P2_CHANNEL = { global: 0, say: 1, guild: 2 } as const;
export type P2Channel = keyof typeof P2_CHANNEL;

const CHANNEL_CODE: Record<string, number> = { global: 0, say: 1, guild: 2 };
const CHANNEL_NAME: P2Channel[] = ['global', 'say', 'guild'];

/** Entity kinds, wire codes 0..4 (index == code). */
export const P2_KINDS = ['player', 'npc', 'mob', 'pickup', 'projectile'] as const;
export type P2Kind = (typeof P2_KINDS)[number];

/**
 * Per-entity field masks. The first byte is always written; the second only
 * when QUICK_EXT is set, so a steady-state delta entity (pos+vel only) costs
 * exactly one mask byte.
 *
 *   QUICK 0x01 POS  0x02 VEL  0x04 HP  0x80 EXT (second mask byte follows)
 *   EXT   0x01 MAXHP 0x02 DIR  0x04 LEVEL 0x08 NAME 0x10 SEQ 0x20 KIND
 */
export const P2_QUICK = { POS: 0x01, VEL: 0x02, HP: 0x04, EXT: 0x80 } as const;
export const P2_EXT = { MAXHP: 0x01, DIR: 0x02, LEVEL: 0x04, NAME: 0x08, SEQ: 0x10, KIND: 0x20 } as const;

/** Frame flags. */
export const P2_FLAG_KEYFRAME = 0x01;

/** Input body flags. */
const P2_IN_ATTACK = 0x01;
const P2_IN_SKILL = 0x02;
const P2_IN_CHAT = 0x04;
const P2_IN_TARGET = 0x08;
const P2_IN_MOVE = 0x10;

/** Ack body flags. */
const P2_ACK_RTT = 0x01;

/** Hello body flags. */
const P2_HELLO_BINARY = 0x01;
const P2_HELLO_DELTAS = 0x02;
const P2_HELLO_CHAT = 0x04;
const P2_HELLO_EVENT = 0x08;

/* ------------------------------------------------------------------ *
 * message types
 * ------------------------------------------------------------------ */

/** Full entity state. Structurally assignable to v1 `EntitySnapshot`. */
export type P2Entity = {
  id: number;
  kind: P2Kind;
  p: Vec2;
  v: Vec2;
  hp: number;
  maxHp: number;
  dir?: number;
  level?: number;
  name?: string;
  seq?: number;
};

/**
 * A wire entity record. Keyframe frames carry every field; delta frames carry
 * only the fields that changed against the sender's baseline, so any optional
 * field may be absent ("unchanged"). `name: ''` is the explicit "name cleared"
 * marker (string-table index 0).
 */
export type P2EntityUpdate = {
  id: number;
  kind?: P2Kind;
  p?: Vec2;
  v?: Vec2;
  hp?: number;
  maxHp?: number;
  dir?: number;
  level?: number;
  name?: string;
  seq?: number;
};

export type P2Welcome = {
  t: 'welcome';
  proto: 2;
  id: number;
  tick: number;
  name: string;
  snapshot: P2Entity[];
};

export type P2Snapshot = {
  t: 'snapshot';
  tick: number;
  /** Baseline tick this delta applies to; ignored on keyframes (always 0). */
  baseTick: number;
  keyframe: boolean;
  entities: P2EntityUpdate[];
  removed: number[];
};

export type P2InputData = {
  seq: number;
  dt: number;
  move: Vec2;
  attack?: boolean;
  skill?: number;
  chat?: string;
  targetId?: number;
};

export type P2Input = { t: 'input'; input: P2InputData };

/** Server -> client baseline commit: "your input N is in, baseline T is solid". */
export type P2Ack = {
  t: 'ack';
  tick: number;
  baseTick: number;
  lastInputSeq: number;
  rttMs?: number;
};

export type P2Chat = { t: 'chat'; from: string; text: string; channel: P2Channel };

/** `payload` stays a JSON string so v1 `payload: unknown` semantics survive. */
export type P2Event = { t: 'event'; kind: string; payload: string };

export type P2HelloCaps = {
  /** Mandatory: a client that cannot decode binary frames must not claim this. */
  binary: true;
  deltas: boolean;
  /** Requested keyframe interval (1..255); server clamps. */
  keyframe: number;
  chat: boolean;
  event: boolean;
};

export type P2Hello = {
  t: 'hello';
  proto: 2;
  name: string;
  token?: string;
  caps: P2HelloCaps;
};

export type P2ServerFrame = P2Welcome | P2Snapshot | P2Chat | P2Event | P2Ack;
export type P2ClientFrame = P2Hello | P2Input;

/** Baseline entry: the exact quantized state the peer last saw. */
export type P2Quant = {
  id: number;
  code: number;
  qx: number;
  qy: number;
  qvx: number;
  qvy: number;
  hp: number;
  maxHp: number;
  qdir: number | null;
  level: number | null;
  name: string | null;
  seq: number | null;
};

export type P2Baseline = Map<number, P2Quant>;

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

export class P2DecodeError extends Error {
  constructor(message: string) {
    super('protocol2: ' + message);
    this.name = 'P2DecodeError';
  }
}

export class P2EncodeError extends Error {
  constructor(message: string) {
    super('protocol2: ' + message);
    this.name = 'P2EncodeError';
  }
}

/* ------------------------------------------------------------------ *
 * primitives: varint / zigzag / float32
 * ------------------------------------------------------------------ */

/** zigzag: signed -> unsigned. -(2n)-1 so 0 maps to 0 and -1 to 1. */
export function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

/** zigzag: unsigned -> signed. */
export function unzigzag(v: number): number {
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

/** Bytes a LEB128 uvarint will occupy (0..2^53-1). */
export function varintSize(v: number): number {
  if (!Number.isFinite(v) || v < 0) throw new P2EncodeError('varint expects a non-negative integer');
  let n = 1;
  let x = v;
  while (x >= 0x80) {
    x = Math.floor(x / 0x80);
    n++;
  }
  return n;
}

const MAX_VARINT_BYTES = 9; // ceil(53/7)

/** Growable little-endian byte writer. */
export class P2Writer {
  private buf: Uint8Array;
  private view: DataView | null = null;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(Math.max(8, initial));
  }

  get length(): number {
    return this.len;
  }

  reset(): this {
    this.len = 0;
    return this;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = null;
  }

  private dv(): DataView {
    if (!this.view) this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    return this.view;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** uint16 LE. */
  u16(v: number): this {
    this.ensure(2);
    this.dv().setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  }

  /** IEEE-754 float32 LE. */
  f32(v: number): this {
    this.ensure(4);
    this.dv().setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }

  /** LEB128 unsigned. */
  varint(v: number): this {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      throw new P2EncodeError(`varint expects a non-negative integer, got ${v}`);
    }
    if (v <= 0xffffffff) {
      let x = v >>> 0;
      while (x > 0x7f) {
        this.u8((x & 0x7f) | 0x80);
        x = x >>> 7;
      }
      this.u8(x);
      return this;
    }
    let n = v;
    while (n >= 0x80) {
      this.u8((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.u8(n);
    return this;
  }

  /** zigzag + varint. */
  svarint(v: number): this {
    if (!Number.isInteger(v)) throw new P2EncodeError(`svarint expects an integer, got ${v}`);
    return this.varint(zigzag(v));
  }

  raw(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Copy of the written bytes (exact length — safe to compare/send). */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /**
   * Zero-copy view of the written bytes. Only valid until the next write —
   * used by the serialize-once path to splice buffers without an intermediate
   * `slice()` copy per viewer.
   */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Bounds-checked reader. Every overrun throws P2DecodeError. */
export class P2Reader {
  readonly b: Uint8Array;
  pos: number;

  constructor(b: Uint8Array, pos = 0) {
    this.b = b;
    this.pos = pos;
  }

  get remaining(): number {
    return this.b.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new P2DecodeError('truncated payload');
  }

  u8(): number {
    this.need(1);
    return this.b[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.b[this.pos]! | (this.b[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    if (!Number.isFinite(v)) throw new P2DecodeError('non-finite float32');
    return v;
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    let count = 0;
    for (;;) {
      if (this.pos >= this.b.length) throw new P2DecodeError('truncated varint');
      const byte = this.b[this.pos++]!;
      if (++count > MAX_VARINT_BYTES) throw new P2DecodeError('varint too long');
      result += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(result)) throw new P2DecodeError('varint exceeds 2^53');
      if ((byte & 0x80) === 0) return result;
      scale *= 0x80;
    }
  }

  svarint(): number {
    return unzigzag(this.varint());
  }

  bytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) throw new P2DecodeError(`bad length ${n}`);
    this.need(n);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * per-frame string table (interning)
 * ------------------------------------------------------------------ */

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8', { fatal: true });

/** index 0 is always the empty string, so "no name" costs zero bytes. */
export type P2StringTable = { list: string[] };

export class P2StringTableWriter {
  private readonly map = new Map<string, number>();
  private readonly list: string[] = [''];
  /**
   * Optional utf-8 memo, shared across frames. The broadcast path encodes the
   * same ~60 names once per viewer per tick and TextEncoder is a measurable
   * slice of that; the bytes are immutable so caching them is safe.
   */
  private readonly utf8?: Map<string, Uint8Array>;

  constructor(utf8?: Map<string, Uint8Array>) {
    this.utf8 = utf8;
  }

  get count(): number {
    return this.list.length;
  }

  /** Reuse this table for the next frame (entry 0 stays the empty string). */
  reset(): this {
    this.map.clear();
    this.list.length = 1;
    return this;
  }

  /** Intern a string; 0 for undefined/empty. Throws past the per-frame cap. */
  index(s: string | undefined | null): number {
    if (s === undefined || s === null || s === '') return 0;
    const hit = this.map.get(s);
    if (hit !== undefined) return hit;
    if (this.list.length >= P2_MAX_STRINGS) throw new P2EncodeError('too many strings in one frame');
    const id = this.list.length;
    this.list.push(s);
    this.map.set(s, id);
    return id;
  }

  /** UTF-8 bytes for an interned entry, memoized when a cache was supplied. */
  private bytesOf(s: string): Uint8Array {
    const cache = this.utf8;
    if (cache === undefined) return ENC.encode(s);
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
    const fresh = ENC.encode(s);
    // Bound the memo: names are world state, not user input, but a shard can
    // still churn through a lot of them over a long uptime.
    if (cache.size >= P2_MAX_STRINGS) cache.clear();
    cache.set(s, fresh);
    return fresh;
  }

  write(w: P2Writer): this {
    w.varint(this.list.length - 1); // entry 0 is implicit
    for (let i = 1; i < this.list.length; i++) {
      const bytes = this.bytesOf(this.list[i]!);
      if (bytes.length > P2_MAX_STRING_BYTES) throw new P2EncodeError(`string longer than ${P2_MAX_STRING_BYTES}B`);
      w.varint(bytes.length);
      w.raw(bytes);
    }
    return this;
  }
}

function readStringTable(r: P2Reader): P2StringTable {
  const extra = r.varint();
  if (extra > P2_MAX_STRINGS) throw new P2DecodeError('too many strings');
  const list: string[] = [''];
  for (let i = 0; i < extra; i++) {
    const n = r.varint();
    if (n > P2_MAX_STRING_BYTES) throw new P2DecodeError('string too long');
    let text: string;
    try {
      text = DEC.decode(r.bytes(n));
    } catch {
      throw new P2DecodeError('invalid utf-8 in string table');
    }
    list.push(text);
  }
  return { list };
}

/* ------------------------------------------------------------------ *
 * frame packing
 * ------------------------------------------------------------------ */

export type P2RawFrame = {
  type: number;
  flags: number;
  strings: P2StringTable;
  body: P2Reader;
};

function packFrame(type: number, flags: number, body: P2Writer, strings: P2StringTableWriter): Uint8Array {
  const bodyBytes = body.toBytes();
  const payload = new P2Writer(bodyBytes.length + 128);
  strings.write(payload);
  payload.varint(bodyBytes.length);
  payload.raw(bodyBytes);

  const p = payload.toBytes();
  const out = new P2Writer(p.length + 8);
  out.u8(P2_MAGIC);
  out.u8(PROTO2_VERSION);
  out.u8(type);
  out.u8(flags);
  out.varint(p.length);
  out.raw(p);
  return out.toBytes();
}

/** Validate header + split table/body. Body reader must be fully consumed. */
export function decodeFrame(bytes: Uint8Array): P2RawFrame {
  if (!(bytes instanceof Uint8Array)) throw new P2DecodeError('frame must be a Uint8Array');
  if (bytes.length < 5) throw new P2DecodeError('frame too short');
  if (bytes[0] !== P2_MAGIC) throw new P2DecodeError('bad magic');
  if (bytes[1] !== PROTO2_VERSION) throw new P2DecodeError(`unsupported version ${bytes[1]}`);
  const type = bytes[2]!;
  const flags = bytes[3]!;
  const head = new P2Reader(bytes, 4);
  const len = head.varint();
  if (len > P2_MAX_FRAME_BYTES) throw new P2DecodeError(`frame too large (${len} > ${P2_MAX_FRAME_BYTES})`);
  const start = head.pos;
  if (bytes.length - start !== len) throw new P2DecodeError('declared length does not match payload');
  const payload = bytes.subarray(start, start + len);
  const r = new P2Reader(payload);
  const strings = readStringTable(r);
  const bodyLen = r.varint();
  if (r.remaining !== bodyLen) throw new P2DecodeError('declared body length does not match payload');
  return { type, flags, strings, body: new P2Reader(payload.subarray(r.pos, r.pos + bodyLen)) };
}

/** Reject trailing bytes, then hand back the decoded table. */
function finishBody(frame: P2RawFrame): P2StringTable {
  if (frame.body.remaining !== 0) throw new P2DecodeError('unexpected trailing bytes in body');
  return frame.strings;
}

function expectType(frame: P2RawFrame, type: number): void {
  if (frame.type !== type) throw new P2DecodeError(`expected msg type ${type}, got ${frame.type}`);
}

function readStr(table: P2StringTable, idx: number, what: string): string {
  if (idx >= table.list.length) throw new P2DecodeError(`bad string index for ${what}`);
  return table.list[idx]!;
}

function checkU32(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new P2DecodeError(`${what} out of range`);
  return v;
}

function checkKind(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code >= P2_KINDS.length) throw new P2DecodeError(`bad kind code ${code}`);
  return code;
}

/* ------------------------------------------------------------------ *
 * quantization
 * ------------------------------------------------------------------ */

function q(v: number, scale: number, limit: number, what: string): number {
  if (!Number.isFinite(v)) throw new P2EncodeError(`${what} is not finite`);
  const n = Math.round(v * scale);
  if (n > limit) return limit;
  if (n < -limit) return -limit;
  return n;
}

function qHp(v: number): number {
  if (!Number.isFinite(v)) throw new P2EncodeError('hp is not finite');
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > P2_MAX_HP) return P2_MAX_HP;
  return n;
}

/** Full entity -> exact quantized baseline entry. */
export function quantizeEntity(e: P2Entity): P2Quant {
  if (!Number.isInteger(e.id) || e.id < 0) throw new P2EncodeError('entity id must be a non-negative integer');
  const code = P2_KINDS.indexOf(e.kind);
  if (code < 0) throw new P2EncodeError(`unknown entity kind ${String(e.kind)}`);
  return {
    id: e.id,
    code,
    qx: q(e.p.x, P2_POS_SCALE, Q_LIMIT_POS, 'p.x'),
    qy: q(e.p.y, P2_POS_SCALE, Q_LIMIT_POS, 'p.y'),
    qvx: q(e.v.x, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.x'),
    qvy: q(e.v.y, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.y'),
    hp: qHp(e.hp),
    maxHp: qHp(e.maxHp),
    qdir: e.dir === undefined ? null : q(e.dir, P2_DIR_SCALE, Q_LIMIT_DIR, 'dir'),
    level: e.level === undefined ? null : clampInt(e.level, Q_LIMIT_LEVEL, 'level'),
    name: e.name === undefined || e.name === '' ? null : e.name,
    seq: e.seq === undefined ? null : clampInt(e.seq, Q_LIMIT_SEQ, 'seq'),
  };
}

function clampInt(v: number, limit: number, what: string): number {
  if (!Number.isFinite(v)) throw new P2EncodeError(`${what} is not finite`);
  const n = Math.round(v);
  if (n > limit) return limit;
  if (n < -limit) return -limit;
  return n;
}

/** Baseline entry -> full entity (inverse of quantizeEntity, modulo rounding). */
export function dequantizeEntity(qn: P2Quant): P2Entity {
  const e: P2Entity = {
    id: qn.id,
    kind: P2_KINDS[qn.code]!,
    p: { x: qn.qx / P2_POS_SCALE, y: qn.qy / P2_POS_SCALE },
    v: { x: qn.qvx / P2_VEL_SCALE, y: qn.qvy / P2_VEL_SCALE },
    hp: qn.hp,
    maxHp: qn.maxHp,
  };
  if (qn.qdir !== null) e.dir = qn.qdir / P2_DIR_SCALE;
  if (qn.level !== null) e.level = qn.level;
  if (qn.name !== null) e.name = qn.name;
  if (qn.seq !== null) e.seq = qn.seq;
  return e;
}

/** Build a baseline straight from a full state list. */
export function baselineFromEntities(entities: P2Entity[]): P2Baseline {
  const b: P2Baseline = new Map();
  for (const e of entities) {
    const qn = quantizeEntity(e);
    b.set(qn.id, qn);
  }
  return b;
}

/** v1 -> v2 entity (the two shapes are structurally identical). */
export function toP2Entity(e: EntitySnapshot): P2Entity {
  const out: P2Entity = {
    id: e.id,
    kind: e.kind,
    p: { x: e.p.x, y: e.p.y },
    v: { x: e.v.x, y: e.v.y },
    hp: e.hp,
    maxHp: e.maxHp,
  };
  if (e.dir !== undefined) out.dir = e.dir;
  if (e.level !== undefined) out.level = e.level;
  if (e.name !== undefined) out.name = e.name;
  if (e.seq !== undefined) out.seq = e.seq;
  return out;
}

/** v2 -> v1 entity, so a v2 client can feed v1 render/predict code unchanged. */
export function toEntitySnapshot(e: P2Entity): EntitySnapshot {
  return toP2Entity(e);
}

/* ------------------------------------------------------------------ *
 * entity records
 * ------------------------------------------------------------------ */

/** Write a complete entity record (keyframe form). */
function writeFullEntity(w: P2Writer, st: P2StringTableWriter, e: P2Entity): void {
  writeFullQuant(w, st, quantizeEntity(e));
}

/**
 * Keyframe record straight from an already-quantized entry — the serialize-once
 * path never builds the intermediate `P2Entity`. Byte-identical to
 * `writeFullEntity(w, st, e)` for any `e` that quantizes to `qn`.
 */
function writeFullQuant(w: P2Writer, st: P2StringTableWriter, qn: P2Quant): void {
  let ext = P2_EXT.MAXHP | P2_EXT.KIND;
  if (qn.qdir !== null) ext |= P2_EXT.DIR;
  if (qn.level !== null) ext |= P2_EXT.LEVEL;
  if (qn.name !== null) ext |= P2_EXT.NAME;
  if (qn.seq !== null) ext |= P2_EXT.SEQ;

  w.varint(qn.id);
  w.u8(P2_QUICK.POS | P2_QUICK.VEL | P2_QUICK.HP | P2_QUICK.EXT);
  w.u8(ext);
  w.svarint(qn.qx);
  w.svarint(qn.qy);
  w.svarint(qn.qvx);
  w.svarint(qn.qvy);
  w.svarint(qn.hp);
  w.svarint(qn.maxHp);
  if (ext & P2_EXT.DIR) w.svarint(qn.qdir!);
  if (ext & P2_EXT.LEVEL) w.svarint(qn.level!);
  if (ext & P2_EXT.NAME) w.varint(st.index(qn.name));
  if (ext & P2_EXT.SEQ) w.svarint(qn.seq!);
  w.u8(qn.code); // kind last: same order readEntityRecord reads it in
}

type P2QPatch = {
  code?: number;
  qx?: number;
  qy?: number;
  qvx?: number;
  qvy?: number;
  hp?: number;
  maxHp?: number;
  qdir?: number;
  level?: number;
  name?: string;
  seq?: number;
};

/** Quantize only the fields the update actually carries. */
function quantizePatch(e: P2EntityUpdate): P2QPatch {
  if (!Number.isInteger(e.id) || e.id < 0) throw new P2EncodeError('entity id must be a non-negative integer');
  const p: P2QPatch = {};
  if (e.kind !== undefined) {
    const code = P2_KINDS.indexOf(e.kind);
    if (code < 0) throw new P2EncodeError(`unknown entity kind ${String(e.kind)}`);
    p.code = code;
  }
  if (e.p !== undefined) {
    p.qx = q(e.p.x, P2_POS_SCALE, Q_LIMIT_POS, 'p.x');
    p.qy = q(e.p.y, P2_POS_SCALE, Q_LIMIT_POS, 'p.y');
  }
  if (e.v !== undefined) {
    p.qvx = q(e.v.x, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.x');
    p.qvy = q(e.v.y, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.y');
  }
  if (e.hp !== undefined) p.hp = qHp(e.hp);
  if (e.maxHp !== undefined) p.maxHp = qHp(e.maxHp);
  if (e.dir !== undefined) p.qdir = q(e.dir, P2_DIR_SCALE, Q_LIMIT_DIR, 'dir');
  if (e.level !== undefined) p.level = clampInt(e.level, Q_LIMIT_LEVEL, 'level');
  if (e.name !== undefined) p.name = e.name;
  if (e.seq !== undefined) p.seq = clampInt(e.seq, Q_LIMIT_SEQ, 'seq');
  return p;
}

function patchIsEmpty(p: P2QPatch): boolean {
  return (
    p.code === undefined &&
    p.qx === undefined &&
    p.qvx === undefined &&
    p.hp === undefined &&
    p.maxHp === undefined &&
    p.qdir === undefined &&
    p.level === undefined &&
    p.name === undefined &&
    p.seq === undefined
  );
}

/** Write a delta record: only the changed fields, as differences to `prev`. */
function writeDeltaEntity(w: P2Writer, st: P2StringTableWriter, e: P2EntityUpdate, prev: P2Quant): void {
  const p = quantizePatch(e);
  let quick = 0;
  if (p.qx !== undefined) quick |= P2_QUICK.POS;
  if (p.qvx !== undefined) quick |= P2_QUICK.VEL;
  if (p.hp !== undefined) quick |= P2_QUICK.HP;
  let ext = 0;
  if (p.maxHp !== undefined) ext |= P2_EXT.MAXHP;
  if (p.qdir !== undefined) ext |= P2_EXT.DIR;
  if (p.level !== undefined) ext |= P2_EXT.LEVEL;
  if (p.name !== undefined) ext |= P2_EXT.NAME;
  if (p.seq !== undefined) ext |= P2_EXT.SEQ;
  if (p.code !== undefined) ext |= P2_EXT.KIND;
  if (ext !== 0) quick |= P2_QUICK.EXT;

  w.varint(e.id);
  w.u8(quick);
  if (quick & P2_QUICK.EXT) w.u8(ext);
  if (quick & P2_QUICK.POS) {
    w.svarint(p.qx! - prev.qx);
    w.svarint(p.qy! - prev.qy);
  }
  if (quick & P2_QUICK.VEL) {
    w.svarint(p.qvx! - prev.qvx);
    w.svarint(p.qvy! - prev.qvy);
  }
  if (quick & P2_QUICK.HP) w.svarint(p.hp! - prev.hp);
  if (ext & P2_EXT.MAXHP) w.svarint(p.maxHp! - prev.maxHp);
  if (ext & P2_EXT.DIR) w.svarint(p.qdir! - prev.qdir!);
  if (ext & P2_EXT.LEVEL) w.svarint(p.level! - prev.level!);
  if (ext & P2_EXT.NAME) w.varint(st.index(p.name));
  if (ext & P2_EXT.SEQ) w.svarint(p.seq! - prev.seq!);
  if (ext & P2_EXT.KIND) w.u8(p.code!);
}

/**
 * Delta record straight from two quantized entries.
 *
 * This is the hot path of the v2 broadcast: the per-viewer baseline entry is
 * compared field-by-field (integers, no rounding) and only the changed fields
 * are written. Byte-identical to `writeDeltaEntity(w, st, toP2Update(qn, p),
 * p)` — including the `null` baseline arithmetic, where a field the receiver
 * never had reads as 0 (`null` coerces), exactly as the patch encoder does.
 */
function writeDeltaQuant(w: P2Writer, st: P2StringTableWriter, qn: P2Quant, p: P2Quant): void {
  let quick = 0;
  if (qn.qx !== p.qx || qn.qy !== p.qy) quick |= P2_QUICK.POS;
  if (qn.qvx !== p.qvx || qn.qvy !== p.qvy) quick |= P2_QUICK.VEL;
  if (qn.hp !== p.hp) quick |= P2_QUICK.HP;
  let ext = 0;
  if (qn.maxHp !== p.maxHp) ext |= P2_EXT.MAXHP;
  if (qn.qdir !== null && qn.qdir !== p.qdir) ext |= P2_EXT.DIR;
  if (qn.level !== null && qn.level !== p.level) ext |= P2_EXT.LEVEL;
  if (qn.name !== null && qn.name !== p.name) ext |= P2_EXT.NAME;
  if (qn.seq !== null && qn.seq !== p.seq) ext |= P2_EXT.SEQ;
  if (qn.code !== p.code) ext |= P2_EXT.KIND;
  if (ext !== 0) quick |= P2_QUICK.EXT;

  w.varint(qn.id);
  w.u8(quick);
  if (quick & P2_QUICK.EXT) w.u8(ext);
  if (quick & P2_QUICK.POS) {
    w.svarint(qn.qx - p.qx);
    w.svarint(qn.qy - p.qy);
  }
  if (quick & P2_QUICK.VEL) {
    w.svarint(qn.qvx - p.qvx);
    w.svarint(qn.qvy - p.qvy);
  }
  if (quick & P2_QUICK.HP) w.svarint(qn.hp - p.hp);
  if (ext & P2_EXT.MAXHP) w.svarint(qn.maxHp - p.maxHp);
  if (ext & P2_EXT.DIR) w.svarint(qn.qdir! - p.qdir!);
  if (ext & P2_EXT.LEVEL) w.svarint(qn.level! - p.level!);
  if (ext & P2_EXT.NAME) w.varint(st.index(qn.name!));
  if (ext & P2_EXT.SEQ) w.svarint(qn.seq! - p.seq!);
  if (ext & P2_EXT.KIND) w.u8(qn.code);
}

/** True when a delta cannot express the change (a field was *cleared*). */
function clearsField(qn: P2Quant, p: P2Quant): boolean {
  return (
    (p.qdir !== null && qn.qdir === null) ||
    (p.level !== null && qn.level === null) ||
    (p.name !== null && qn.name === null) ||
    (p.seq !== null && qn.seq === null)
  );
}

/**
 * Read one entity record.
 *
 * With `prev` (the receiver's baseline entry) the delta fields resolve to
 * absolute values, so the decoded frame has the same shape whether it came
 * off the wire or out of `diffSnapshot`. Without `prev` the record must be a
 * full one (keyframe, or an id the receiver has never seen).
 */
function readEntityRecord(r: P2Reader, table: P2StringTable, prev?: P2Quant): P2EntityUpdate {
  const id = checkU32(r.varint(), 'entity id');
  const quick = r.u8();
  const ext = quick & P2_QUICK.EXT ? r.u8() : 0;
  const out: P2EntityUpdate = { id };
  if (quick & P2_QUICK.POS) {
    // wire order: x then y
    const dx = r.svarint();
    const dy = r.svarint();
    out.p = { x: (prev ? prev.qx + dx : dx) / P2_POS_SCALE, y: (prev ? prev.qy + dy : dy) / P2_POS_SCALE };
  }
  if (quick & P2_QUICK.VEL) {
    const dx = r.svarint();
    const dy = r.svarint();
    out.v = { x: (prev ? prev.qvx + dx : dx) / P2_VEL_SCALE, y: (prev ? prev.qvy + dy : dy) / P2_VEL_SCALE };
  }
  if (quick & P2_QUICK.HP) {
    const hp = prev ? prev.hp + r.svarint() : r.svarint();
    if (hp < 0 || hp > P2_MAX_HP) throw new P2DecodeError('hp out of range');
    out.hp = hp;
  }
  if (ext & P2_EXT.MAXHP) {
    const maxHp = prev ? prev.maxHp + r.svarint() : r.svarint();
    if (maxHp < 0 || maxHp > P2_MAX_HP) throw new P2DecodeError('maxHp out of range');
    out.maxHp = maxHp;
  }
  if (ext & P2_EXT.DIR) {
    const d = r.svarint();
    const dir = prev && prev.qdir !== null ? prev.qdir + d : d;
    out.dir = dir / P2_DIR_SCALE;
  }
  if (ext & P2_EXT.LEVEL) {
    const d = r.svarint();
    out.level = prev && prev.level !== null ? prev.level + d : d;
  }
  // name is always an absolute table index (0 = cleared), never a delta
  if (ext & P2_EXT.NAME) out.name = readStr(table, r.varint(), 'entity name');
  if (ext & P2_EXT.SEQ) {
    const d = r.svarint();
    out.seq = prev && prev.seq !== null ? prev.seq + d : d;
  }
  if (ext & P2_EXT.KIND) out.kind = P2_KINDS[checkKind(r.u8())]!;
  return out;
}

/**
 * Diff a full state list against a baseline.
 *
 * Unchanged entities produce no record; entities missing from `next` are the
 * caller's business (the removed list). Returns `needsKeyframe` when a field
 * was *cleared* (e.g. a name dropped), which deltas cannot express — the
 * sender should emit a keyframe on the next frame instead.
 */
export function diffSnapshot(
  prev: P2Baseline,
  entities: P2Entity[],
): { updates: P2EntityUpdate[]; next: P2Baseline; needsKeyframe: boolean } {
  const next: P2Baseline = new Map();
  const updates: P2EntityUpdate[] = [];
  let needsKeyframe = false;
  for (const e of entities) {
    const qn = quantizeEntity(e);
    const p = prev.get(qn.id);
    next.set(qn.id, qn);
    if (!p) {
      updates.push(toP2Update(qn));
      continue;
    }
    if (p.qdir !== null && qn.qdir === null) needsKeyframe = true;
    if (p.level !== null && qn.level === null) needsKeyframe = true;
    if (p.name !== null && qn.name === null) needsKeyframe = true;
    if (p.seq !== null && qn.seq === null) needsKeyframe = true;
    const u = toP2Update(qn, p);
    if (u) updates.push(u);
  }
  return { updates, next, needsKeyframe };
}

function toP2Update(qn: P2Quant): P2EntityUpdate;
function toP2Update(qn: P2Quant, p: P2Quant): P2EntityUpdate | null;
function toP2Update(qn: P2Quant, p?: P2Quant): P2EntityUpdate | null {
  const u: P2EntityUpdate = { id: qn.id };
  let changed = false;
  if (!p || p.code !== qn.code) {
    u.kind = P2_KINDS[qn.code]!;
    changed = true;
  }
  if (!p || p.qx !== qn.qx || p.qy !== qn.qy) {
    u.p = { x: qn.qx / P2_POS_SCALE, y: qn.qy / P2_POS_SCALE };
    changed = true;
  }
  if (!p || p.qvx !== qn.qvx || p.qvy !== qn.qvy) {
    u.v = { x: qn.qvx / P2_VEL_SCALE, y: qn.qvy / P2_VEL_SCALE };
    changed = true;
  }
  if (!p || p.hp !== qn.hp) {
    u.hp = qn.hp;
    changed = true;
  }
  if (!p || p.maxHp !== qn.maxHp) {
    u.maxHp = qn.maxHp;
    changed = true;
  }
  if (qn.qdir !== null && (!p || p.qdir !== qn.qdir)) {
    u.dir = qn.qdir / P2_DIR_SCALE;
    changed = true;
  }
  if (qn.level !== null && (!p || p.level !== qn.level)) {
    u.level = qn.level;
    changed = true;
  }
  if (qn.name !== null && (!p || p.name !== qn.name)) {
    u.name = qn.name;
    changed = true;
  }
  if (qn.seq !== null && (!p || p.seq !== qn.seq)) {
    u.seq = qn.seq;
    changed = true;
  }
  return changed ? u : null;
}

/* ------------------------------------------------------------------ *
 * P2Welcome  (server -> client, always keyframe-shaped)
 * ------------------------------------------------------------------ */

export function encodeWelcomeBinary(msg: P2Welcome): Uint8Array {
  if (!Number.isInteger(msg.id) || msg.id < 0) throw new P2EncodeError('welcome id must be a non-negative integer');
  checkU32(msg.tick, 'welcome tick');
  const st = new P2StringTableWriter();
  const nameIdx = st.index(msg.name);
  const w = new P2Writer(64 + msg.snapshot.length * 24);
  w.varint(msg.id);
  w.varint(msg.tick);
  w.varint(nameIdx);
  if (msg.snapshot.length > P2_MAX_ENTITIES) throw new P2EncodeError('too many entities in welcome');
  w.varint(msg.snapshot.length);
  for (const e of msg.snapshot) writeFullEntity(w, st, e);
  return packFrame(P2Type.Welcome, 0, w, st);
}

export function decodeWelcomeBinary(bytes: Uint8Array): P2Welcome {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Welcome);
  const table = frame.strings;
  const r = frame.body;
  const id = checkU32(r.varint(), 'welcome id');
  const tick = checkU32(r.varint(), 'welcome tick');
  const name = readStr(table, r.varint(), 'welcome name');
  const count = r.varint();
  if (count > P2_MAX_ENTITIES) throw new P2DecodeError('too many entities in welcome');
  const snapshot: P2Entity[] = [];
  for (let i = 0; i < count; i++) {
    const u = readEntityRecord(r, table);
    // welcome records are always complete; anything missing is corrupt.
    if (u.kind === undefined || u.p === undefined || u.v === undefined || u.hp === undefined || u.maxHp === undefined) {
      throw new P2DecodeError('welcome entity record is not complete');
    }
    snapshot.push(u as P2Entity);
  }
  finishBody(frame);
  return { t: 'welcome', proto: PROTO2_VERSION, id, tick, name, snapshot };
}

/* ------------------------------------------------------------------ *
 * P2Snapshot  (server -> client, delta vs lastAck, keyframe every 50)
 * ------------------------------------------------------------------ */

export function encodeSnapshotBinary(msg: P2Snapshot, baseline?: P2Baseline): Uint8Array {
  checkU32(msg.tick, 'snapshot tick');
  if (!Number.isInteger(msg.baseTick) || msg.baseTick < 0 || msg.baseTick > 0xffffffff) {
    throw new P2EncodeError('baseTick must be a u32');
  }
  if (msg.baseTick > msg.tick) throw new P2EncodeError('baseTick must not exceed tick');
  if (msg.keyframe && msg.baseTick !== 0) throw new P2EncodeError('keyframe frames must carry baseTick 0');
  const base = msg.keyframe ? new Map<number, P2Quant>() : baseline ?? new Map<number, P2Quant>();
  const st = new P2StringTableWriter();
  const w = new P2Writer(32 + msg.entities.length * 8 + msg.removed.length * 2);

  w.varint(msg.tick);
  w.varint(msg.keyframe ? 0 : msg.baseTick);

  if (msg.removed.length > 0xffffffff) throw new P2EncodeError('removed overflow');
  w.varint(msg.removed.length);
  for (const id of msg.removed) w.varint(checkU32(id, 'removed id'));

  // Filter no-op deltas so the count matches what actually goes on the wire.
  const pending: Array<{ u: P2EntityUpdate; p: P2Quant | undefined }> = [];
  for (const e of msg.entities) {
    if (msg.keyframe) {
      pending.push({ u: e, p: undefined });
      continue;
    }
    const p = base.get(e.id);
    if (!p) {
      // Unknown id: deltas cannot describe it, so force full state.
      pending.push({ u: e, p: undefined });
      continue;
    }
    const patch = quantizePatch(e);
    if (patchIsEmpty(patch)) continue;
    pending.push({ u: e, p });
  }
  if (pending.length > P2_MAX_ENTITIES) throw new P2EncodeError('too many entities in snapshot');
  w.varint(pending.length);
  for (const { u, p } of pending) {
    if (p === undefined) writeFullEntity(w, st, u as P2Entity);
    else writeDeltaEntity(w, st, u, p);
  }

  return packFrame(P2Type.Snapshot, msg.keyframe ? P2_FLAG_KEYFRAME : 0, w, st);
}

/**
 * Decode a snapshot frame.
 *
 * `baseline` is the receiver's current baseline — **required for delta
 * frames**, because the entity records only carry what changed. Pass the same
 * map that was used to encode (or, for a real client, the one `applySnapshot`
 * returned last). Keyframes ignore it.
 */
export function decodeSnapshotBinary(bytes: Uint8Array, baseline?: P2Baseline): P2Snapshot {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Snapshot);
  const keyframe = (frame.flags & P2_FLAG_KEYFRAME) !== 0;
  const table = frame.strings;
  const r = frame.body;
  const tick = checkU32(r.varint(), 'snapshot tick');
  const baseTick = checkU32(r.varint(), 'snapshot baseTick');
  if (!keyframe && baseTick > tick) throw new P2DecodeError('baseTick must not exceed tick');
  if (keyframe && baseTick !== 0) throw new P2DecodeError('keyframe must carry baseTick 0');
  if (!keyframe && !baseline) throw new P2DecodeError('delta frame needs the receiver baseline to decode');
  const nRemoved = r.varint();
  if (nRemoved > P2_MAX_ENTITIES) throw new P2DecodeError('too many removed ids');
  const removed: number[] = [];
  for (let i = 0; i < nRemoved; i++) removed.push(checkU32(r.varint(), 'removed id'));
  const nEntities = r.varint();
  if (nEntities > P2_MAX_ENTITIES) throw new P2DecodeError('too many entities in snapshot');
  const entities: P2EntityUpdate[] = [];
  for (let i = 0; i < nEntities; i++) {
    // peek the id so the record can be resolved against its baseline entry
    const save = r.pos;
    const id = r.varint();
    r.pos = save;
    const u = readEntityRecord(r, table, keyframe ? undefined : baseline?.get(id));
    if (keyframe && (u.kind === undefined || u.p === undefined || u.v === undefined || u.hp === undefined || u.maxHp === undefined)) {
      throw new P2DecodeError('keyframe entity record is not complete');
    }
    entities.push(u);
  }
  finishBody(frame);
  return { t: 'snapshot', tick, baseTick, keyframe, entities, removed };
}

export type P2ApplyOk = {
  ok: true;
  entities: Map<number, P2Entity>;
  baseline: P2Baseline;
  /** Baseline to hand back on the next decode (this frame's tick). */
  baseTick: number;
  removed: number[];
};
export type P2ApplyErr = { ok: false; reason: 'need-keyframe'; wantTick: number };
export type P2ApplyResult = P2ApplyOk | P2ApplyErr;

/** True when `msg` cannot be applied on top of a baseline at `baseTick`. */
export function needsKeyframe(msg: P2Snapshot, baseTick: number): boolean {
  return !msg.keyframe && msg.baseTick !== baseTick;
}

/**
 * Resolve a snapshot frame against the receiver's baseline.
 *
 * Keyframes replace the baseline wholesale; deltas merge into it. Removals are
 * applied last so `removed` always wins over an entity in the same frame.
 * Returns `{ok:false, reason:'need-keyframe'}` when the baseline tick does not
 * line up — the client should drop this frame and wait for the next keyframe.
 */
export function applySnapshot(msg: P2Snapshot, baseline: P2Baseline, baseTick: number): P2ApplyResult {
  if (needsKeyframe(msg, baseTick)) return { ok: false, reason: 'need-keyframe', wantTick: msg.tick };
  const next: P2Baseline = msg.keyframe ? new Map() : new Map(baseline);
  const entities = new Map<number, P2Entity>();
  for (const u of msg.entities) {
    const prev = next.get(u.id);
    let qn: P2Quant;
    if (msg.keyframe || prev === undefined) {
      if (u.kind === undefined || u.p === undefined || u.v === undefined || u.hp === undefined || u.maxHp === undefined) {
        throw new P2DecodeError(`entity ${u.id}: delta record for an entity with no baseline is incomplete`);
      }
      qn = quantizeEntity(u as P2Entity);
    } else {
      const patch = quantizePatch(u);
      qn = {
        id: prev.id,
        code: patch.code ?? prev.code,
        qx: patch.qx ?? prev.qx,
        qy: patch.qy ?? prev.qy,
        qvx: patch.qvx ?? prev.qvx,
        qvy: patch.qvy ?? prev.qvy,
        hp: patch.hp ?? prev.hp,
        maxHp: patch.maxHp ?? prev.maxHp,
        qdir: patch.qdir ?? prev.qdir,
        level: patch.level ?? prev.level,
        name: patch.name !== undefined && patch.name !== '' ? patch.name : prev.name,
        seq: patch.seq ?? prev.seq,
      };
    }
    next.set(qn.id, qn);
    entities.set(qn.id, dequantizeEntity(qn));
  }
  for (const id of msg.removed) {
    next.delete(id);
    entities.delete(id);
  }
  if (!msg.keyframe) {
    for (const [id, qn] of next) if (!entities.has(id)) entities.set(id, dequantizeEntity(qn));
  }
  return { ok: true, entities, baseline: next, baseTick: msg.tick, removed: msg.removed.slice() };
}

/* ------------------------------------------------------------------ *
 * P2Input  (client -> server)
 * ------------------------------------------------------------------ */

export function encodeInputBinary(msg: P2Input): Uint8Array {
  const input = msg.input;
  if (!input || typeof input !== 'object') throw new P2EncodeError('input frame needs an input object');
  if (!Number.isInteger(input.seq) || input.seq <= 0 || input.seq > 0xffffffff) {
    throw new P2EncodeError('input seq must be a u32 > 0');
  }
  if (!Number.isFinite(input.dt) || input.dt <= 0) throw new P2EncodeError('input dt must be > 0');
  if (input.chat !== undefined && typeof input.chat !== 'string') throw new P2EncodeError('input chat must be a string');
  if (input.skill !== undefined && !Number.isInteger(input.skill)) throw new P2EncodeError('input skill must be an integer');
  if (input.targetId !== undefined && !Number.isInteger(input.targetId)) throw new P2EncodeError('input targetId must be an integer');
  if (input.chat !== undefined && ENC.encode(input.chat).length > P2_MAX_STRING_BYTES) {
    throw new P2EncodeError('input chat too long');
  }
  const st = new P2StringTableWriter();
  const mx = q(input.move.x, P2_VEL_SCALE, Q_LIMIT_MOVE, 'move.x');
  const my = q(input.move.y, P2_VEL_SCALE, Q_LIMIT_MOVE, 'move.y');
  let flags = 0;
  if (input.attack) flags |= P2_IN_ATTACK;
  if (input.skill !== undefined) flags |= P2_IN_SKILL;
  if (input.chat !== undefined) flags |= P2_IN_CHAT;
  if (input.targetId !== undefined) flags |= P2_IN_TARGET;
  if (mx !== 0 || my !== 0) flags |= P2_IN_MOVE;

  const w = new P2Writer(24);
  w.u8(flags);
  w.varint(input.seq);
  w.svarint(clampInt(Math.round(input.dt * P2_DT_SCALE), 1 << 20, 'dt'));
  w.svarint(mx);
  w.svarint(my);
  if (flags & P2_IN_SKILL) w.varint(clampInt(input.skill!, 0xffff, 'skill'));
  if (flags & P2_IN_TARGET) w.varint(checkU32(input.targetId!, 'targetId'));
  if (flags & P2_IN_CHAT) w.varint(st.index(input.chat));
  return packFrame(P2Type.Input, 0, w, st);
}

export function decodeInputBinary(bytes: Uint8Array): P2Input {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Input);
  const table = frame.strings;
  const r = frame.body;
  const flags = r.u8();
  if ((flags & ~0x1f) !== 0) throw new P2DecodeError('unknown input flag bits');
  const seq = checkU32(r.varint(), 'input seq');
  if (seq === 0) throw new P2DecodeError('input seq must be > 0');
  const dtMs = r.svarint();
  if (dtMs <= 0 || dtMs > (1 << 20)) throw new P2DecodeError('input dt out of range');
  const mx = r.svarint();
  const my = r.svarint();
  if (Math.abs(mx) > Q_LIMIT_MOVE || Math.abs(my) > Q_LIMIT_MOVE) throw new P2DecodeError('move out of range');
  const input: P2InputData = { seq, dt: dtMs / P2_DT_SCALE, move: { x: mx / P2_VEL_SCALE, y: my / P2_VEL_SCALE } };
  if (flags & P2_IN_ATTACK) input.attack = true;
  if (flags & P2_IN_SKILL) {
    const skill = r.varint();
    if (skill > 0xffff) throw new P2DecodeError('skill out of range');
    input.skill = skill;
  }
  if (flags & P2_IN_TARGET) input.targetId = checkU32(r.varint(), 'targetId');
  if (flags & P2_IN_CHAT) input.chat = readStr(table, r.varint(), 'input chat');
  finishBody(frame);
  return { t: 'input', input };
}

/* ------------------------------------------------------------------ *
 * P2Ack  (server -> client baseline commit)
 * ------------------------------------------------------------------ */

export function encodeAckBinary(msg: P2Ack): Uint8Array {
  checkU32(msg.tick, 'ack tick');
  checkU32(msg.baseTick, 'ack baseTick');
  checkU32(msg.lastInputSeq, 'ack lastInputSeq');
  if (msg.baseTick > msg.tick) throw new P2EncodeError('ack baseTick must not exceed tick');
  const w = new P2Writer(12);
  let flags = 0;
  if (msg.rttMs !== undefined) flags |= P2_ACK_RTT;
  w.u8(flags);
  w.varint(msg.tick);
  w.varint(msg.baseTick);
  w.varint(msg.lastInputSeq);
  if (flags & P2_ACK_RTT) w.svarint(clampInt(Math.round(msg.rttMs!), 1 << 24, 'rttMs'));
  return packFrame(P2Type.Ack, 0, w, new P2StringTableWriter());
}

export function decodeAckBinary(bytes: Uint8Array): P2Ack {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Ack);
  const r = frame.body;
  const flags = r.u8();
  if ((flags & ~P2_ACK_RTT) !== 0) throw new P2DecodeError('unknown ack flag bits');
  const tick = checkU32(r.varint(), 'ack tick');
  const baseTick = checkU32(r.varint(), 'ack baseTick');
  if (baseTick > tick) throw new P2DecodeError('baseTick must not exceed tick');
  const lastInputSeq = checkU32(r.varint(), 'ack lastInputSeq');
  const msg: P2Ack = { t: 'ack', tick, baseTick, lastInputSeq };
  if (flags & P2_ACK_RTT) {
    const rtt = r.svarint();
    if (rtt < 0) throw new P2DecodeError('rtt must be >= 0');
    msg.rttMs = rtt;
  }
  finishBody(frame);
  return msg;
}

/* ------------------------------------------------------------------ *
 * P2Chat / P2Event  (server -> client, v1 parity)
 * ------------------------------------------------------------------ */

export function encodeChatBinary(msg: P2Chat): Uint8Array {
  const channel = CHANNEL_CODE[msg.channel];
  if (channel === undefined) throw new P2EncodeError(`unknown channel ${String(msg.channel)}`);
  const st = new P2StringTableWriter();
  const from = st.index(msg.from);
  const text = st.index(msg.text);
  const w = new P2Writer(12);
  w.u8(channel);
  w.varint(from);
  w.varint(text);
  return packFrame(P2Type.Chat, 0, w, st);
}

export function decodeChatBinary(bytes: Uint8Array): P2Chat {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Chat);
  const table = frame.strings;
  const r = frame.body;
  const channel = r.u8();
  if (channel >= CHANNEL_NAME.length) throw new P2DecodeError(`unknown channel code ${channel}`);
  const from = readStr(table, r.varint(), 'chat from');
  const text = readStr(table, r.varint(), 'chat text');
  finishBody(frame);
  return { t: 'chat', from, text, channel: CHANNEL_NAME[channel]! };
}

export function encodeEventBinary(msg: P2Event): Uint8Array {
  if (typeof msg.kind !== 'string') throw new P2EncodeError('event kind must be a string');
  const st = new P2StringTableWriter();
  const kind = st.index(msg.kind);
  const payload = st.index(msg.payload);
  const w = new P2Writer(12);
  w.varint(kind);
  w.varint(payload);
  return packFrame(P2Type.Event, 0, w, st);
}

export function decodeEventBinary(bytes: Uint8Array): P2Event {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Event);
  const table = frame.strings;
  const r = frame.body;
  const kind = readStr(table, r.varint(), 'event kind');
  const payload = readStr(table, r.varint(), 'event payload');
  finishBody(frame);
  return { t: 'event', kind, payload };
}

/* ------------------------------------------------------------------ *
 * P2Hello  (client -> server capability probe)
 * ------------------------------------------------------------------ */

export function encodeHelloBinary(msg: P2Hello): Uint8Array {
  if (msg.proto !== PROTO2_VERSION) throw new P2EncodeError('hello must advertise proto 2');
  const st = new P2StringTableWriter();
  const name = st.index(msg.name);
  const token = st.index(msg.token);
  const caps = msg.caps;
  if (!caps || caps.binary !== true) throw new P2EncodeError('hello must advertise caps.binary');
  let flags = P2_HELLO_BINARY;
  if (caps.deltas) flags |= P2_HELLO_DELTAS;
  if (caps.chat) flags |= P2_HELLO_CHAT;
  if (caps.event) flags |= P2_HELLO_EVENT;
  const w = new P2Writer(16);
  w.varint(name);
  w.varint(token);
  w.varint(PROTO2_VERSION);
  w.u8(flags);
  w.u8(Math.min(255, Math.max(1, Math.floor(caps.keyframe) || 1)));
  return packFrame(P2Type.Hello, 0, w, st);
}

export function decodeHelloBinary(bytes: Uint8Array): P2Hello {
  const frame = decodeFrame(bytes);
  expectType(frame, P2Type.Hello);
  const table = frame.strings;
  const r = frame.body;
  const name = readStr(table, r.varint(), 'hello name');
  const token = readStr(table, r.varint(), 'hello token');
  const proto = r.varint();
  if (proto !== PROTO2_VERSION) throw new P2DecodeError(`hello proto ${proto} is not 2`);
  const flags = r.u8();
  if ((flags & ~0x0f) !== 0) throw new P2DecodeError('unknown hello flag bits');
  if ((flags & P2_HELLO_BINARY) === 0) throw new P2DecodeError('hello does not advertise the binary capability');
  const keyframe = r.u8();
  if (keyframe < 1) throw new P2DecodeError('caps.keyframe must be >= 1');
  const msg: P2Hello = {
    t: 'hello',
    proto: PROTO2_VERSION,
    name,
    caps: { binary: true, deltas: (flags & P2_HELLO_DELTAS) !== 0, keyframe, chat: (flags & P2_HELLO_CHAT) !== 0, event: (flags & P2_HELLO_EVENT) !== 0 },
  };
  if (token !== '') msg.token = token;
  finishBody(frame);
  return msg;
}

/* ------------------------------------------------------------------ *
 * negotiation
 * ------------------------------------------------------------------ */

export type ProtoDecision = { proto: 1 | 2; reason: string };

export type NegotiateOptions = {
  /** Server-side switch (PROTO=2). Default true. */
  enabled?: boolean;
  /** Clamp the client's requested keyframe interval. Default P2_KEYFRAME_INTERVAL. */
  keyframeEvery?: number;
};

/**
 * Decide the protocol for one connection.
 *
 * `hello` is the **v1 JSON hello** carrying `proto: 2` + `caps` — that is the
 * capability probe, so a proto-2 client can still be answered with v1 JSON.
 * Also accepts an already-decoded P2Hello.
 */
export function negotiateProto(hello: unknown, opts: NegotiateOptions = {}): ProtoDecision {
  const enabled = opts.enabled !== false;
  if (enabled === false) return { proto: 1, reason: 'server-disabled' };
  if (!hello || typeof hello !== 'object' || Array.isArray(hello)) return { proto: 1, reason: 'not-a-hello' };
  const o = hello as Record<string, unknown>;
  if (o['t'] !== 'hello') return { proto: 1, reason: 'not-a-hello' };
  const proto = o['proto'];
  if (typeof proto !== 'number' || !Number.isInteger(proto)) return { proto: 1, reason: 'bad-proto' };
  const caps = o['caps'];
  if (proto !== PROTO2_VERSION) return { proto: 1, reason: proto < PROTO2_VERSION ? 'older-proto' : 'future-proto' };
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return { proto: 1, reason: 'no-caps' };
  if ((caps as Record<string, unknown>)['binary'] !== true) return { proto: 1, reason: 'no-binary-capability' };
  return { proto: 2, reason: 'accepted' };
}

/** Keyframe interval to actually use (client request clamped to 1..255). */
export function resolveKeyframeEvery(hello: unknown, opts: NegotiateOptions = {}): number {
  const serverDefault = opts.keyframeEvery ?? P2_KEYFRAME_INTERVAL;
  let want = serverDefault;
  const caps = (hello as { caps?: Record<string, unknown> } | null)?.caps;
  const raw = caps?.['keyframe'];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 255) want = raw;
  return want;
}

/**
 * True when the snapshot at `seq` must be a keyframe (seq % interval === 0).
 */
export function isKeyframeSeq(seq: number, interval = P2_KEYFRAME_INTERVAL): boolean {
  return interval <= 0 ? true : seq % interval === 0;
}

/* ------------------------------------------------------------------ *
 * stream encoding (delta baseline + keyframe schedule)
 * ------------------------------------------------------------------ */

export type EncodeAgainstResult = {
  bytes: Uint8Array;
  /** Baseline to hold for this tick; becomes `prev` on the next call. */
  baseline: P2Baseline;
  /** True when the frame had to be a keyframe (scheduled, or a field cleared). */
  keyframe: boolean;
  /** Baseline tick encoded in the frame (0 on keyframes, which carry none). */
  baseTick: number;
};

/**
 * Encode one snapshot frame against a sender-side baseline.
 *
 * Pure: `prev` is never mutated. Ids in `removed` are dropped from the returned
 * baseline so they cannot resurface in a later delta. Any change a delta cannot
 * express (a field was *cleared*) is promoted to a keyframe, so the encoder
 * never emits a frame the decoder would have to reject.
 */
export function encodeSnapshotAgainst(
  entities: P2Entity[],
  removed: readonly number[],
  tick: number,
  prev: P2Baseline,
  opts: { keyframe: boolean; baseTick?: number },
): EncodeAgainstResult {
  const keyframe = (): EncodeAgainstResult => ({
    bytes: encodeSnapshotBinary({ t: 'snapshot', tick, baseTick: 0, keyframe: true, entities, removed: removed.slice() }),
    baseline: baselineFromEntities(entities),
    keyframe: true,
    baseTick: 0,
  });
  if (opts.keyframe) return keyframe();
  const { updates, next, needsKeyframe } = diffSnapshot(prev, entities);
  for (const id of removed) next.delete(id);
  if (needsKeyframe) return keyframe();
  const baseTick = opts.baseTick ?? tick - 1;
  if (baseTick > tick) throw new P2EncodeError(`baseTick ${baseTick} must not exceed tick ${tick}`);
  // `prev` (not `next`) is what the receiver holds: an entity that is both
  // removed and updated still needs a delta against the record it has.
  return {
    bytes: encodeSnapshotBinary({ t: 'snapshot', tick, baseTick, keyframe: false, entities: updates, removed: removed.slice() }, prev),
    baseline: next,
    keyframe: false,
    baseTick,
  };
}

/**
 * Stateful per-connection encoder: owns the delta baseline, the keyframe
 * schedule, and the client's current baseline tick. One instance per player.
 */
export class P2SnapshotStream {
  readonly keyframeEvery: number;
  private baseline: P2Baseline = new Map();
  private counter = 0;
  private clientTick = 0;

  constructor(keyframeEvery = P2_KEYFRAME_INTERVAL) {
    this.keyframeEvery = Math.min(255, Math.max(1, Math.floor(keyframeEvery) || 1));
  }

  /** Snapshots encoded so far. */
  get seq(): number {
    return this.counter;
  }

  /** Tick of the state the receiver holds (what the next delta builds on). */
  get baseTick(): number {
    return this.clientTick;
  }

  /** Current sender-side baseline (do not mutate). */
  get current(): P2Baseline {
    return this.baseline;
  }

  /**
   * Adopt a state the receiver already has (a welcome, or a snapshot that was
   * delivered out of band) as the delta baseline. Counts as one frame sent, so
   * the first real snapshot is a delta rather than a redundant keyframe.
   */
  seed(entities: P2Entity[], tick: number): void {
    this.baseline = baselineFromEntities(entities);
    this.clientTick = tick;
    this.counter = 1;
  }

  encode(entities: P2Entity[], removed: readonly number[], tick: number): Uint8Array {
    const out = encodeSnapshotAgainst(entities, removed, tick, this.baseline, {
      keyframe: isKeyframeSeq(this.counter, this.keyframeEvery),
      baseTick: this.clientTick,
    });
    this.baseline = out.baseline;
    this.counter++;
    // after applying any frame the receiver holds exactly this tick
    this.clientTick = tick;
    return out.bytes;
  }

  reset(): void {
    this.baseline = new Map();
    this.counter = 0;
    this.clientTick = 0;
  }
}

/* ------------------------------------------------------------------ *
 * serialize-once view encoder (broadcast hot path)
 * ------------------------------------------------------------------ */

/**
 * v1 `EntitySnapshot` -> quantized entry with no intermediate `P2Entity`.
 * Same values as `quantizeEntity(toP2Entity(e))`.
 */
export function quantizeSnapshot(e: EntitySnapshot): P2Quant {
  if (!Number.isInteger(e.id) || e.id < 0) throw new P2EncodeError('entity id must be a non-negative integer');
  const code = P2_KINDS.indexOf(e.kind);
  if (code < 0) throw new P2EncodeError(`unknown entity kind ${String(e.kind)}`);
  return {
    id: e.id,
    code,
    qx: q(e.p.x, P2_POS_SCALE, Q_LIMIT_POS, 'p.x'),
    qy: q(e.p.y, P2_POS_SCALE, Q_LIMIT_POS, 'p.y'),
    qvx: q(e.v.x, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.x'),
    qvy: q(e.v.y, P2_VEL_SCALE, Q_LIMIT_VEL, 'v.y'),
    hp: qHp(e.hp),
    maxHp: qHp(e.maxHp),
    qdir: e.dir === undefined ? null : q(e.dir, P2_DIR_SCALE, Q_LIMIT_DIR, 'dir'),
    level: e.level === undefined ? null : clampInt(e.level, Q_LIMIT_LEVEL, 'level'),
    name: e.name === undefined || e.name === '' ? null : e.name,
    seq: e.seq === undefined ? null : clampInt(e.seq, Q_LIMIT_SEQ, 'seq'),
  };
}

/**
 * Quantize the whole world ONCE per tick, index-aligned with `entities`.
 *
 * This is the v2 flavour of the v1 `serializeEntities` splice: the server
 * broadcasts the same world to N viewers, so the naive path quantizes every
 * entity N times — in fact twice per viewer (`diffSnapshot` quantizes, then
 * `encodeSnapshotBinary` re-quantizes each patch). Call this once, then hand the
 * result to `P2ViewStream.encodeView` per viewer together with that viewer's
 * interest indices.
 *
 * `out` may be reused across ticks (the returned array is the same object).
 */
export function prequantizeSnapshot(entities: readonly EntitySnapshot[], out: P2Quant[] = []): P2Quant[] {
  out.length = entities.length;
  for (let i = 0; i < entities.length; i++) out[i] = quantizeSnapshot(entities[i]!);
  return out;
}

/**
 * Per-viewer delta/keyframe encoder over a pre-quantized tick — the v2 twin of
 * `P2SnapshotStream`, split so the world is quantized once and only the
 * per-viewer part runs N times.
 *
 * `encodeView(quant, visible, removed, tick)` is byte-identical, for every
 * viewer, to `P2SnapshotStream.encode(subset, removed, tick)` where `subset` is
 * `visible.map(i => quant[i])`: same keyframe schedule, same record order, same
 * string-table interning order, same keyframe promotion when a field is
 * cleared. What it avoids is the per-viewer `toP2Entity` allocation, the double
 * quantization, the intermediate `P2EntityUpdate`/`P2QPatch` objects, and the
 * per-frame `TextEncoder.encode` of every name.
 */
export class P2ViewStream {
  readonly keyframeEvery: number;
  private baseline: P2Baseline = new Map();
  private counter = 0;
  private clientTick = 0;
  private readonly body = new P2Writer(1024);
  private readonly payload = new P2Writer(512);
  private readonly out = new P2Writer(1024);
  private readonly utf8 = new Map<string, Uint8Array>();
  private readonly strings: P2StringTableWriter;
  /** Scratch: which visible index each pending record came from. */
  private pendingIdx: number[] = [];
  /** Scratch: 1 when the record is a full one (id unknown to the receiver). */
  private pendingFull: number[] = [];
  private cap = 0;

  constructor(keyframeEvery = P2_KEYFRAME_INTERVAL) {
    this.keyframeEvery = Math.min(255, Math.max(1, Math.floor(keyframeEvery) || 1));
    this.strings = new P2StringTableWriter(this.utf8);
  }

  /** Snapshots encoded so far. */
  get seq(): number {
    return this.counter;
  }

  /** Tick of the state the receiver holds (what the next delta builds on). */
  get baseTick(): number {
    return this.clientTick;
  }

  /** Current sender-side baseline (do not mutate). */
  get current(): P2Baseline {
    return this.baseline;
  }

  /**
   * Adopt state the receiver already has (the welcome) as the delta baseline.
   * Counts as one frame sent, so the first real snapshot is a delta rather than
   * a redundant keyframe — same contract as `P2SnapshotStream.seed`.
   */
  seedQuants(quants: readonly P2Quant[], tick: number): void {
    const b: P2Baseline = new Map();
    for (let i = 0; i < quants.length; i++) {
      const qn = quants[i]!;
      b.set(qn.id, qn);
    }
    this.baseline = b;
    this.clientTick = tick;
    this.counter = 1;
  }

  /** `seedQuants` for callers holding `P2Entity` rather than pre-quantized state. */
  seed(entities: readonly P2Entity[], tick: number): void {
    const quants = new Array<P2Quant>(entities.length);
    for (let i = 0; i < entities.length; i++) quants[i] = quantizeEntity(entities[i]!);
    this.seedQuants(quants, tick);
  }

  /**
   * Encode one viewer's snapshot frame.
   *
   * @param quant   whole-tick quantized world (`prequantizeSnapshot`)
   * @param visible indices into `quant` this viewer can see, in any order
   * @param removed ids that left the viewer's interest set
   */
  encodeView(
    quant: readonly P2Quant[],
    visible: readonly number[],
    removed: readonly number[],
    tick: number,
  ): Uint8Array {
    const n = visible.length;
    if (n > P2_MAX_ENTITIES) throw new P2EncodeError('too many entities in snapshot');
    checkU32(tick, 'snapshot tick');
    if (n > this.cap) {
      this.pendingIdx = new Array<number>(n);
      this.pendingFull = new Array<number>(n);
      this.cap = n;
    }
    const idx = this.pendingIdx;
    const full = this.pendingFull;
    let keyframe = isKeyframeSeq(this.counter, this.keyframeEvery);
    let count = 0;
    if (keyframe) {
      count = n;
    } else {
      for (let k = 0; k < n; k++) {
        const qn = quant[visible[k]!]!;
        const p = this.baseline.get(qn.id);
        if (p === undefined) {
          // Unknown id: a delta cannot describe it, so force a full record.
          idx[count] = visible[k]!;
          full[count] = 1;
          count++;
          continue;
        }
        if (clearsField(qn, p)) {
          // A cleared field cannot be expressed as a delta: promote the whole
          // frame to a keyframe, exactly like `encodeSnapshotAgainst`.
          keyframe = true;
          count = n;
          break;
        }
        if (unchanged(qn, p)) continue; // a no-op delta costs zero bytes
        idx[count] = visible[k]!;
        full[count] = 0;
        count++;
      }
    }

    const w = this.body.reset();
    this.strings.reset();
    w.varint(tick);
    w.varint(keyframe ? 0 : this.clientTick);
    if (removed.length > 0xffffffff) throw new P2EncodeError('removed overflow');
    w.varint(removed.length);
    for (let i = 0; i < removed.length; i++) w.varint(checkU32(removed[i]!, 'removed id'));
    if (keyframe) {
      w.varint(n);
      for (let k = 0; k < n; k++) writeFullQuant(w, this.strings, quant[visible[k]!]!);
    } else {
      w.varint(count);
      for (let k = 0; k < count; k++) {
        const qn = quant[idx[k]!]!;
        if (full[k] === 1) writeFullQuant(w, this.strings, qn);
        else writeDeltaQuant(w, this.strings, qn, this.baseline.get(qn.id)!);
      }
    }

    // Baseline bookkeeping: a fresh map of exactly the visible set (ids absent
    // from it are the caller's `removed` list), matching diffSnapshot().
    const next: P2Baseline = new Map();
    for (let k = 0; k < n; k++) {
      const qn = quant[visible[k]!]!;
      next.set(qn.id, qn);
    }
    if (!keyframe) {
      for (let i = 0; i < removed.length; i++) next.delete(removed[i]!);
    }
    this.baseline = next;
    this.counter++;
    this.clientTick = tick;
    return this.pack(P2Type.Snapshot, keyframe ? P2_FLAG_KEYFRAME : 0);
  }

  reset(): void {
    this.baseline = new Map();
    this.counter = 0;
    this.clientTick = 0;
  }

  /**
   * Assemble header + string table + body with three reusable buffers, so a
   * per-viewer frame costs no allocations beyond the exact-length result.
   * Layout is identical to `packFrame`: [table][bodyLen][body].
   */
  private pack(type: number, flags: number): Uint8Array {
    const bodyLen = this.body.length;
    const p = this.payload.reset();
    this.strings.write(p);
    p.varint(bodyLen);
    p.raw(this.body.bytes());
    const o = this.out.reset();
    o.u8(P2_MAGIC);
    o.u8(PROTO2_VERSION);
    o.u8(type);
    o.u8(flags);
    o.varint(p.length);
    o.raw(p.bytes());
    return o.toBytes();
  }
}

/** True when every delta-able field is identical (a kind change still counts). */
function unchanged(qn: P2Quant, p: P2Quant): boolean {
  return (
    qn.qx === p.qx &&
    qn.qy === p.qy &&
    qn.qvx === p.qvx &&
    qn.qvy === p.qvy &&
    qn.hp === p.hp &&
    qn.maxHp === p.maxHp &&
    qn.code === p.code &&
    (qn.qdir === null || qn.qdir === p.qdir) &&
    (qn.level === null || qn.level === p.level) &&
    (qn.name === null || qn.name === p.name) &&
    (qn.seq === null || qn.seq === p.seq)
  );
}

/* ------------------------------------------------------------------ *
 * frame dispatch + crash-safe wrappers
 * ------------------------------------------------------------------ */

export function decodeServerFrame(bytes: Uint8Array, baseline?: P2Baseline): P2ServerFrame {
  const frame = decodeFrame(bytes);
  switch (frame.type) {
    case P2Type.Welcome:
      return decodeWelcomeBinary(bytes);
    case P2Type.Snapshot:
      return decodeSnapshotBinary(bytes, baseline);
    case P2Type.Chat:
      return decodeChatBinary(bytes);
    case P2Type.Event:
      return decodeEventBinary(bytes);
    case P2Type.Ack:
      return decodeAckBinary(bytes);
    default:
      throw new P2DecodeError(`unknown server msg type ${frame.type}`);
  }
}

export function decodeClientFrame(bytes: Uint8Array): P2ClientFrame {
  const frame = decodeFrame(bytes);
  switch (frame.type) {
    case P2Type.Hello:
      return decodeHelloBinary(bytes);
    case P2Type.Input:
      return decodeInputBinary(bytes);
    default:
      throw new P2DecodeError(`unknown client msg type ${frame.type}`);
  }
}

export type P2DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Never throws — mirrors server `safeParseClientMsg` for the binary path so a
 * hostile frame can only cost the sender an anticheat strike, never the tick.
 */
export function safeDecode<T>(fn: () => T): P2DecodeResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function safeDecodeServerFrame(bytes: Uint8Array, baseline?: P2Baseline): P2DecodeResult<P2ServerFrame> {
  return safeDecode(() => decodeServerFrame(bytes, baseline));
}

export function safeDecodeClientFrame(bytes: Uint8Array): P2DecodeResult<P2ClientFrame> {
  return safeDecode(() => decodeClientFrame(bytes));
}