// @aetherfall/client — protocol v2 decoder + NetClientV2.
//
// NetClientV2 is the DEFAULT client: it advertises proto 2 and falls back to
// v1 JSON when the server answers in JSON (PROTO=1, or an old build). Pass
// `?proto=1` to force the legacy v1 `NetClient` instead. Both clients expose
// the same game-loop surface (entities/id/tick/lastAckSeq/rttMs/connect/
// sendInput/sendChat/on*), so the game loop works unchanged on either wire.
//
// Handshake (see docs/PROTOCOL2.md):
//   client -> JSON  {t:'hello', name, proto:2, caps:{binary:true,deltas:true}}
//   server -> bin   P2Welcome proto=2      -> this.proto = 2, all frames binary
//   server -> JSON  welcome (v1)          -> this.proto = 1, stays on v1 JSON
// The v2 codec arrives as a real module (not type-only), so `vite build`
// resolves it through the workspace `shared/dist` output like editor.ts does.
import {
  P2_KEYFRAME_INTERVAL,
  PROTO2_VERSION,
  applySnapshot,
  baselineFromEntities,
  decodeFrame,
  encodeChatBinary,
  encodeInputBinary,
  safeDecodeServerFrame,
  toEntitySnapshot,
  type P2Baseline,
  type P2Entity,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';

/** Wire protocol this client asks for. v2 is the default; v1 is the `?proto=1` fallback. */
export const PROTO = 2;

/**
 * Which client the game loop should use for this page load.
 *
 * NetClientV2 is the default: it tries binary v2 and automatically falls back
 * to v1 JSON when the server declines (PROTO=1, or an old build). Only an
 * explicit `?proto=1` (alias `v1`/`json`) forces the legacy v1 `NetClient`;
 * missing, `2`/`v2`, empty, garbage and future values all try v2 first — safe
 * because the JSON-welcome fallback keeps the session working.
 */
export function protoFromSearch(search: string): 1 | 2 {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('proto');
  } catch {
    return 2;
  }
  if (v === null) return 2;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'v1' || s === 'json') return 1;
  return 2;
}

/** Snapshot cadence used for the request-rate fallback in v1 (unchanged). */
export const INPUT_HZ = 20;
export const INPUT_DT = 1 / INPUT_HZ;
/** Cap on in-flight RTT samples (same policy as net.ts). */
export const MAX_PENDING_INPUTS = 200;

export type ChatChannel = 'global' | 'say' | 'guild';

/** Anything that can put bytes on the wire — a WebSocket in the browser. */
export type NetV2Transport = {
  send(data: string | Uint8Array): void;
  close(): void;
};

/** Coerce a WS payload into bytes, or null when it is not a binary frame. */
export function toFrameBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Browser WebSocket -> transport. `readyState` gating mirrors net.ts. */
export function webSocketTransport(ws: WebSocket): NetV2Transport {
  return {
    send(data) {
      if (ws.readyState !== 1) return;
      ws.send(typeof data === 'string' ? data : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Protocol v2 client. Same public surface as `NetClient`, plus:
 *  - `proto` — the negotiated version (1 = v1 JSON fallback, 2 = binary)
 *  - `onFallback` — fired once when the server declines binary frames
 *  - `droppedSnapshots` / `decodeErrors` — delta/keyframe and fuzz counters
 */
export class NetClientV2 {
  ws?: WebSocket;
  id = -1;
  tick = 0;
  entities = new Map<number, EntitySnapshot>();
  /** Last server-acked input seq for the local player (drives reconcile + rtt). */
  lastAckSeq = 0;
  rttMs = 0;
  /** Negotiated wire protocol. 1 until a binary welcome proves 2. */
  proto: 1 | 2 = 1;
  /** Snapshots that could not be applied because the baseline did not line up. */
  droppedSnapshots = 0;
  /** Frames that failed to decode (fuzz/hostile traffic). */
  decodeErrors = 0;
  onChat: (from: string, text: string, channel: string) => void = () => {};
  onSnapshot: () => void = () => {};
  onWelcome: () => void = () => {};
  onEvent: (kind: string, payload: unknown) => void = () => {};
  /** Fired when the server answers with v1 JSON instead of a binary welcome. */
  onFallback: (reason: string) => void = () => {};

  /** Dev token, when the account has one. */
  token?: string;
  /** Keyframe cadence we advertise; the server clamps to its own config. */
  keyframeEvery = P2_KEYFRAME_INTERVAL;

  private transport?: NetV2Transport;
  private sendTimes = new Map<number, number>();
  private baseline: P2Baseline = new Map();
  private baseTick = 0;
  private pendingBlobs = 0;

  /** Binary frames currently being decoded off the event loop (Blob payloads). */
  get decoding(): number {
    return this.pendingBlobs;
  }

  /** `onFallback` fires at most once per connection. */
  private fallbackFired = false;

  /** Connect and advertise proto 2. Hello goes out on socket open. */
  connect(url: string, name: string): void {
    const ws = new WebSocket(url);
    // ArrayBuffer keeps decoding synchronous; Blob would need an await.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.transport = webSocketTransport(ws);
    ws.onopen = () => this.sendHello(name);
    ws.onmessage = (e) => this.handleData((e as MessageEvent).data);
    ws.onclose = () => this.onChat('system', 'disconnected — reload to rejoin', 'global');
    ws.onerror = () => {
      this.decodeErrors++;
    };
  }

  /** Attach an arbitrary transport (tests, replay harnesses, native clients). */
  attach(transport: NetV2Transport, name: string): void {
    this.transport = transport;
    this.sendHello(name);
  }

  detach(): void {
    this.transport?.close();
    this.transport = undefined;
    this.ws = undefined;
  }

  /** JSON hello carrying the proto-2 capability set. */
  sendHello(name: string): void {
    this.sendJson({
      t: 'hello',
      name,
      proto: PROTO,
      caps: { binary: true, deltas: true, keyframe: this.keyframeEvery, chat: true, event: true },
      ...(this.token !== undefined ? { token: this.token } : {}),
    });
  }

  /** One message in: string -> v1 JSON, everything else -> binary. */
  handleData(data: unknown): void {
    if (typeof data === 'string') {
      this.handleJson(data);
      return;
    }
    const bytes = toFrameBytes(data);
    if (bytes) {
      this.handleBinary(bytes);
      return;
    }
    // Blob payloads (binaryType not honoured): decode off the event loop.
    const blob = data as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (blob && typeof blob.arrayBuffer === 'function') {
      this.pendingBlobs++;
      void blob
        .arrayBuffer()
        .then((buf) => {
          this.handleBinary(new Uint8Array(buf));
        })
        .catch(() => {
          this.decodeErrors++;
        })
        .finally(() => {
          this.pendingBlobs--;
        });
      return;
    }
    this.decodeErrors++;
  }

  /* ---------------- inbound: v1 JSON fallback ---------------- */

  private handleJson(raw: string): void {
    let m: ServerMsg;
    try {
      m = JSON.parse(raw) as ServerMsg;
    } catch {
      this.decodeErrors++;
      return;
    }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') {
      this.decodeErrors++;
      return;
    }
    if (m.t === 'welcome') {
      // The server answered in v1 JSON: proto 2 was declined (or it is a v1-only
      // server). Everything from here on stays JSON.
      if (!this.fallbackFired) {
        this.fallbackFired = true;
        this.onFallback('server-declined-binary');
      }
      this.proto = 1;
      this.id = m.id;
      this.tick = m.tick;
      this.entities.clear();
      for (const en of m.snapshot) this.entities.set(en.id, en);
      this.onWelcome();
      this.onSnapshot();
    } else if (m.t === 'snapshot') {
      this.tick = m.tick;
      for (const en of m.entities) {
        this.entities.set(en.id, en);
        this.absorbLocalAck(en);
      }
      for (const r of m.removed) this.entities.delete(r);
      this.onSnapshot();
    } else if (m.t === 'chat') {
      this.onChat(m.from, m.text, m.channel);
    } else if (m.t === 'event') {
      if (m.kind === 'despawn') {
        const id = (m.payload as { id?: number } | null)?.id;
        if (typeof id === 'number') this.entities.delete(id);
      }
      this.onEvent(m.kind, m.payload);
    }
  }

  /* ---------------- inbound: v2 binary ---------------- */

  private handleBinary(bytes: Uint8Array): void {
    const head = safeDecodeServerFrame(bytes, this.baseline);
    if (!head.ok) {
      this.decodeErrors++;
      return;
    }
    const msg = head.value;
    if (msg.t === 'welcome') {
      if (msg.proto !== PROTO2_VERSION) {
        this.decodeErrors++;
        return;
      }
      this.proto = 2;
      this.id = msg.id;
      this.tick = msg.tick;
      this.entities.clear();
      for (const e of msg.snapshot) this.entities.set(e.id, toEntitySnapshot(e));
      this.baseline = baselineFromEntities(msg.snapshot);
      this.baseTick = msg.tick;
      this.onWelcome();
      this.onSnapshot();
      return;
    }
    if (msg.t === 'snapshot') {
      const applied = applySnapshot(msg, this.baseline, this.baseTick);
      if (!applied.ok) {
        // Baseline drift: wait for the next keyframe (at most P2_KEYFRAME_INTERVAL
        // snapshots) instead of guessing. This is the normal path after a
        // dropped frame, not an error.
        this.droppedSnapshots++;
        return;
      }
      this.tick = msg.tick;
      for (const en of applied.entities.values()) {
        const v1 = toEntitySnapshot(en);
        this.entities.set(v1.id, v1);
        this.absorbLocalAck(v1);
      }
      for (const id of applied.removed) this.entities.delete(id);
      this.baseline = applied.baseline;
      this.baseTick = applied.baseTick;
      this.onSnapshot();
      return;
    }
    if (msg.t === 'ack') {
      if (msg.lastInputSeq > this.lastAckSeq) this.lastAckSeq = msg.lastInputSeq;
      if (typeof msg.rttMs === 'number') this.rttMs = msg.rttMs;
      this.pruneSendTimes();
      return;
    }
    if (msg.t === 'chat') {
      this.onChat(msg.from, msg.text, msg.channel);
      return;
    }
    if (msg.t === 'event') {
      if (msg.kind === 'despawn') {
        const parsed = safeJson(msg.payload);
        const id = (parsed as { id?: number } | null)?.id;
        if (typeof id === 'number') this.entities.delete(id);
      }
      this.onEvent(msg.kind, safeJson(msg.payload));
    }
  }

  /* ---------------- outbound ---------------- */

  sendInput(seq: number, x: number, y: number, extra?: { attack?: boolean; chat?: string }): void {
    if (!this.transport) return;
    this.sendTimes.set(seq, nowMs());
    if (this.sendTimes.size > MAX_PENDING_INPUTS) {
      const ks = [...this.sendTimes.keys()].sort((a, b) => a - b);
      for (const k of ks.slice(0, this.sendTimes.size - MAX_PENDING_INPUTS)) this.sendTimes.delete(k);
    }
    if (this.proto === 1) {
      this.sendJson({ t: 'input', input: { seq, dt: INPUT_DT, move: { x, y }, ...extra } });
      return;
    }
    this.sendBinary(
      encodeInputBinary({
        t: 'input',
        input: { seq, dt: INPUT_DT, move: { x, y }, ...extra },
      }),
    );
  }

  sendChat(text: string, channel: ChatChannel = 'global'): void {
    if (!this.transport) return;
    const clipped = text.slice(0, 200);
    if (this.proto === 1) {
      this.sendJson({ t: 'chat', text: clipped, channel });
      return;
    }
    this.sendBinary(encodeChatBinary({ t: 'chat', from: '', text: clipped, channel }));
  }

  /* ---------------- internals ---------------- */

  private sendJson(msg: unknown): void {
    if (!this.transport) return;
    try {
      this.transport.send(JSON.stringify(msg));
    } catch {
      // A closed socket must never break the input loop.
      this.decodeErrors++;
    }
  }

  private sendBinary(bytes: Uint8Array): void {
    if (!this.transport) return;
    try {
      this.transport.send(bytes);
    } catch {
      // A closed socket must never break the input loop.
      this.decodeErrors++;
    }
  }

  /** Local player ack + RTT, mirroring net.ts. */
  private absorbLocalAck(en: EntitySnapshot): void {
    if (en.id !== this.id || typeof en.seq !== 'number') return;
    this.lastAckSeq = en.seq;
    const t0 = this.sendTimes.get(en.seq);
    if (t0 !== undefined) {
      this.rttMs = nowMs() - t0;
      this.pruneSendTimes();
    }
  }

  private pruneSendTimes(): void {
    for (const k of [...this.sendTimes.keys()]) if (k <= this.lastAckSeq) this.sendTimes.delete(k);
  }
}

/** Frame type code, for logging / tests. -1 when the frame is unreadable. */
export function frameTypeOf(bytes: Uint8Array): number {
  if (bytes.length < 4) return -1;
  try {
    return decodeFrame(bytes).type;
  } catch {
    return -1;
  }
}

function safeJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** v2 entities -> v1 entities for callers that keep the old shape. */
export function p2ToV1(entities: Iterable<P2Entity>): Map<number, EntitySnapshot> {
  const out = new Map<number, EntitySnapshot>();
  for (const e of entities) {
    const v1 = toEntitySnapshot(e);
    out.set(v1.id, v1);
  }
  return out;
}