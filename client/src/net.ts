import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';
import { asTelegraph, type TelegraphPayload } from './telegraph.js';

// Protocol wire format mirrors shared/src/index.ts (proto v1):
//   hello -> welcome -> input@20Hz -> snapshot@10Hz (+ chat / event).
// NOTE: type-only workspace import keeps `vite build` self-contained (no
// runtime dependency on workspace dist). PROTO must match PROTOCOL_VERSION.
export const PROTO = 1;

/** Boss telegraph payload (`event/telegraph`, broadcast by server/src/index.ts). */
export type { TelegraphPayload };
export { asTelegraph };

export type ChatChannel = 'global' | 'say' | 'guild';

export class NetClient {
  ws?: WebSocket;
  id = -1;
  tick = 0;
  entities = new Map<number, EntitySnapshot>();
  /** Last server-acked input seq for the local player (drives reconcile + rtt). */
  lastAckSeq = 0;
  rttMs = 0;
  onChat: (from: string, text: string, channel: string) => void = () => {};
  onSnapshot: () => void = () => {};
  onWelcome: () => void = () => {};
  onEvent: (kind: string, payload: unknown) => void = () => {};
  private sendTimes = new Map<number, number>();

  connect(url: string, name: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.ws!.send(JSON.stringify({ t: 'hello', name, proto: PROTO }));
    this.ws.onmessage = (e) => this.handle(String((e as MessageEvent).data));
    this.ws.onclose = () => this.onChat('system', 'disconnected — reload to rejoin', 'global');
  }

  private handle(raw: string) {
    let m: ServerMsg;
    try { m = JSON.parse(raw) as ServerMsg; } catch { return; }
    if (m.t === 'welcome') {
      this.id = m.id;
      this.tick = m.tick;
      for (const en of m.snapshot) this.entities.set(en.id, en);
      this.onWelcome();
      this.onSnapshot();
    } else if (m.t === 'snapshot') {
      this.tick = m.tick;
      for (const en of m.entities) {
        this.entities.set(en.id, en);
        if (en.id === this.id && typeof en.seq === 'number') {
          this.lastAckSeq = en.seq;
          const t0 = this.sendTimes.get(en.seq);
          if (t0 !== undefined) {
            this.rttMs = performance.now() - t0;
            for (const k of [...this.sendTimes.keys()]) if (k <= en.seq!) this.sendTimes.delete(k);
          }
        }
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

  sendInput(seq: number, x: number, y: number, extra?: { attack?: boolean; chat?: string }) {
    if (this.ws?.readyState !== 1) return;
    this.sendTimes.set(seq, performance.now());
    if (this.sendTimes.size > 200) {
      const ks = [...this.sendTimes.keys()].sort((a, b) => a - b);
      for (const k of ks.slice(0, this.sendTimes.size - 200)) this.sendTimes.delete(k);
    }
    this.ws.send(JSON.stringify({ t: 'input', input: { seq, dt: 1 / 20, move: { x, y }, ...extra } }));
  }

  sendChat(text: string, channel: ChatChannel = 'global') {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ t: 'chat', text: text.slice(0, 200), channel }));
  }
}
