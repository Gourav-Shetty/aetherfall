// @aetherfall/replay — compact binary recording container (`.bin`, magic "AFRB").
//
// Recordings are produced by the recorder as newline-delimited JSON (human
// diffable, but ~10x larger than needed). This module defines the binary
// container used by `--format bin`, the analyze CLI (`--bin`) and the browser
// dashboard: fixed little-endian layout, no compression, no dependencies.
//
// Layout (all integers little-endian):
//
//   header (16 bytes)
//     0  4  magic  "AFRB"
//     4  2  version u16 (= CONTAINER_VERSION)
//     6  2  flags   u16 (bit0: chat records present, bit1: event records present)
//     8  4  recordCount u32
//    12  4  reserved u32 (= 0, keeps 8-byte alignment for the record array)
//
//   record (repeated recordCount times)
//     u32 tMs            milliseconds since record start
//     u8  kind          1 welcome | 2 snapshot | 3 chat | 4 event
//     welcome:  u32 id, u32 tick, u16 entityCount, entity[entityCount]
//     snapshot: u32 tick, u16 entityCount, entity[entityCount],
//               u16 removedCount, u32 removed[removedCount]
//     chat:     u8 channel (0 global | 1 guild | 2 say), str from, str text
//     event:    str kind, u32 payloadLen, payloadLen bytes of UTF-8 JSON
//
//   entity
//     u32 id, u8 kind (1 player | 2 npc | 3 mob | 4 pickup | 5 projectile),
//     f64 x, f64 y, f64 vx, f64 vy, f64 hp, f64 maxHp, u8 optionalFlags,
//     [f64 dir]      when optionalFlags bit0
//     [i32 level]    when optionalFlags bit1
//     [str name]     when optionalFlags bit2
//     [u32 seq]      when optionalFlags bit3
//
//   str = u16 byteLength, then UTF-8 bytes (truncated to 65535 bytes).
//
// Encoding is byte-deterministic: the same records always produce the same
// bytes (no timestamps, no map iteration, no floating-point formatting).

import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';

export const CONTAINER_MAGIC = 'AFRB';
export const CONTAINER_VERSION = 1;
export const CONTAINER_HEADER_BYTES = 16;

export const RECORD_KINDS = { welcome: 1, snapshot: 2, chat: 3, event: 4 } as const;
const ENTITY_KINDS = { player: 1, npc: 2, mob: 3, pickup: 4, projectile: 5 } as const;
const CHAT_CHANNELS = { global: 0, guild: 1, say: 2 } as const;

const F_DIR = 1;
const F_LEVEL = 2;
const F_NAME = 4;
const F_SEQ = 8;

export type RecordingRecord = { t: number; msg: ServerMsg };

const MAX_STR_BYTES = 65535;

const enc = new TextEncoder();
const dec = new TextDecoder();

function entityKindCode(kind: string): number {
  const code = (ENTITY_KINDS as Record<string, number>)[kind];
  return code ?? ENTITY_KINDS.mob;
}

function entityKindName(code: number): EntitySnapshot['kind'] {
  for (const [name, value] of Object.entries(ENTITY_KINDS)) {
    if (value === code) return name as EntitySnapshot['kind'];
  }
  return 'mob';
}

function chatChannelCode(channel: string): number {
  const code = (CHAT_CHANNELS as Record<string, number>)[channel];
  return code ?? CHAT_CHANNELS.say;
}

function chatChannelName(code: number): 'global' | 'guild' | 'say' {
  for (const [name, value] of Object.entries(CHAT_CHANNELS)) {
    if (value === code) return name as 'global' | 'guild' | 'say';
  }
  return 'say';
}

/** Growable little-endian writer. Doubles its buffer; no deps. */
class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + n) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.len, v & 0xff);
    this.len += 1;
  }

  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
  }

  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  i32(v: number): void {
    this.need(4);
    this.view.setInt32(this.len, Math.trunc(v) | 0, true);
    this.len += 4;
  }

  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.len, Number.isFinite(v) ? v : 0, true);
    this.len += 8;
  }

  str(s: string): void {
    const bytes = enc.encode(s).subarray(0, MAX_STR_BYTES);
    this.u16(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  finish(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

/** Bounds-checked little-endian reader; throws on truncation. */
class Reader {
  private view: DataView;
  pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`container: truncated at byte ${this.pos} (need ${n})`);
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(): string {
    const n = this.u16();
    this.need(n);
    const s = dec.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  bytes(): Uint8Array {
    const n = this.u32();
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

function writeEntity(w: Writer, e: EntitySnapshot): void {
  w.u32(e.id);
  w.u8(entityKindCode(String(e.kind)));
  w.f64(e.p?.x ?? 0);
  w.f64(e.p?.y ?? 0);
  w.f64(e.v?.x ?? 0);
  w.f64(e.v?.y ?? 0);
  w.f64(e.hp ?? 0);
  w.f64(e.maxHp ?? 0);
  let flags = 0;
  if (e.dir !== undefined && Number.isFinite(e.dir)) flags |= F_DIR;
  if (e.level !== undefined && Number.isFinite(e.level)) flags |= F_LEVEL;
  if (e.name !== undefined) flags |= F_NAME;
  if (e.seq !== undefined && Number.isFinite(e.seq)) flags |= F_SEQ;
  w.u8(flags);
  if (flags & F_DIR) w.f64(e.dir as number);
  if (flags & F_LEVEL) w.i32(e.level as number);
  if (flags & F_NAME) w.str(String(e.name));
  if (flags & F_SEQ) w.u32(e.seq as number);
}

function readEntity(r: Reader): EntitySnapshot {
  const id = r.u32();
  const kind = entityKindName(r.u8());
  const x = r.f64();
  const y = r.f64();
  const vx = r.f64();
  const vy = r.f64();
  const hp = r.f64();
  const maxHp = r.f64();
  const flags = r.u8();
  const out: EntitySnapshot = { id, kind, p: { x, y }, v: { x: vx, y: vy }, hp, maxHp };
  if (flags & F_DIR) out.dir = r.f64();
  if (flags & F_LEVEL) out.level = r.i32();
  if (flags & F_NAME) out.name = r.str();
  if (flags & F_SEQ) out.seq = r.u32();
  return out;
}

/** True when the buffer starts with the container magic (sniffing aid). */
export function isContainer(buf: Uint8Array): boolean {
  if (buf.length < CONTAINER_HEADER_BYTES) return false;
  return (
    buf[0] === CONTAINER_MAGIC.charCodeAt(0) &&
    buf[1] === CONTAINER_MAGIC.charCodeAt(1) &&
    buf[2] === CONTAINER_MAGIC.charCodeAt(2) &&
    buf[3] === CONTAINER_MAGIC.charCodeAt(3)
  );
}

/** Serialize records into the binary container. Byte-deterministic. */
export function encodeContainer(records: readonly RecordingRecord[]): Buffer {
  let flags = 0;
  for (const r of records) {
    if (r.msg.t === 'chat') flags |= 1;
    if (r.msg.t === 'event') flags |= 2;
  }
  const w = new Writer(4096 + records.length * 256);
  for (const ch of CONTAINER_MAGIC) w.u8(ch.charCodeAt(0));
  w.u16(CONTAINER_VERSION);
  w.u16(flags);
  w.u32(records.length);
  w.u32(0);
  for (const rec of records) {
    const msg = rec.msg;
    w.u32(Math.max(0, Math.round(rec.t)));
    switch (msg.t) {
      case 'welcome': {
        w.u8(RECORD_KINDS.welcome);
        w.u32(msg.id);
        w.u32(msg.tick);
        w.u16(msg.snapshot.length);
        for (const e of msg.snapshot) writeEntity(w, e);
        break;
      }
      case 'snapshot': {
        w.u8(RECORD_KINDS.snapshot);
        w.u32(msg.tick);
        w.u16(msg.entities.length);
        for (const e of msg.entities) writeEntity(w, e);
        w.u16(msg.removed.length);
        for (const id of msg.removed) w.u32(id);
        break;
      }
      case 'chat': {
        w.u8(RECORD_KINDS.chat);
        w.u8(chatChannelCode(msg.channel));
        w.str(msg.from);
        w.str(msg.text);
        break;
      }
      case 'event': {
        w.u8(RECORD_KINDS.event);
        w.str(msg.kind);
        w.bytes(enc.encode(JSON.stringify(msg.payload ?? null)));
        break;
      }
      default: {
        throw new Error(`container: unsupported message type`);
      }
    }
  }
  return w.finish();
}

/** Parse the binary container back into records. Throws on malformed input. */
export function decodeContainer(input: Uint8Array): RecordingRecord[] {
  if (!isContainer(input)) throw new Error('container: bad magic (want AFRB)');
  const r = new Reader(input);
  r.pos = 4;
  const version = r.u16();
  if (version !== CONTAINER_VERSION) {
    throw new Error(`container: unsupported version ${version} (want ${CONTAINER_VERSION})`);
  }
  r.u16(); // flags (informational; re-derived on encode)
  const count = r.u32();
  r.u32(); // reserved
  const out: RecordingRecord[] = [];
  for (let i = 0; i < count; i++) {
    const t = r.u32();
    const kind = r.u8();
    if (kind === RECORD_KINDS.welcome) {
      const id = r.u32();
      const tick = r.u32();
      const n = r.u16();
      const snapshot: EntitySnapshot[] = [];
      for (let k = 0; k < n; k++) snapshot.push(readEntity(r));
      out.push({ t, msg: { t: 'welcome', id, tick, snapshot } });
    } else if (kind === RECORD_KINDS.snapshot) {
      const tick = r.u32();
      const n = r.u16();
      const entities: EntitySnapshot[] = [];
      for (let k = 0; k < n; k++) entities.push(readEntity(r));
      const rn = r.u16();
      const removed: number[] = [];
      for (let k = 0; k < rn; k++) removed.push(r.u32());
      out.push({ t, msg: { t: 'snapshot', tick, entities, removed } });
    } else if (kind === RECORD_KINDS.chat) {
      const channel = chatChannelName(r.u8());
      const from = r.str();
      const text = r.str();
      out.push({ t, msg: { t: 'chat', from, text, channel } });
    } else if (kind === RECORD_KINDS.event) {
      const kindName = r.str();
      const payload = JSON.parse(dec.decode(r.bytes()) as string) as unknown;
      out.push({ t, msg: { t: 'event', kind: kindName, payload } });
    } else {
      throw new Error(`container: unknown record kind ${kind} at record ${i}`);
    }
  }
  return out;
}