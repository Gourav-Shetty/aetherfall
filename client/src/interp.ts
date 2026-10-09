import type { EntitySnapshot } from '@aetherfall/shared';

/** Render remote entities this far in the past to hide 10Hz snapshot jitter. */
export const INTERP_DELAY_MS = 100;

interface Sample { t: number; x: number; y: number; hp: number; }

/** Per-entity snapshot ring buffer + linear interpolation at now - 100ms. */
export class Interp {
  private buf = new Map<number, Sample[]>();

  push(ents: EntitySnapshot[], selfId: number, now = performance.now()) {
    for (const e of ents) {
      if (e.id === selfId) continue;
      let q = this.buf.get(e.id);
      if (!q) { q = []; this.buf.set(e.id, q); }
      const last = q[q.length - 1];
      if (!last || last.x !== e.p.x || last.y !== e.p.y || last.hp !== e.hp) {
        q.push({ t: now, x: e.p.x, y: e.p.y, hp: e.hp });
      }
      while (q.length > 12) q.shift();
    }
    for (const [id, q] of this.buf) {
      const last = q[q.length - 1];
      if (last && now - last.t > 2000) this.buf.delete(id);
    }
  }

  sample(id: number, now = performance.now()): Sample | null {
    const q = this.buf.get(id);
    if (!q || q.length === 0) return null;
    const rt = now - INTERP_DELAY_MS;
    if (q.length === 1 || rt <= q[0].t) return q[0];
    const last = q[q.length - 1];
    if (rt >= last.t) return last;
    for (let i = 1; i < q.length; i++) {
      if (q[i].t >= rt) {
        const a = q[i - 1], b = q[i];
        const f = (rt - a.t) / Math.max(1e-6, b.t - a.t);
        return { t: rt, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, hp: f < 0.5 ? a.hp : b.hp };
      }
    }
    return last;
  }

  prune(alive: Set<number>) {
    for (const id of [...this.buf.keys()]) if (!alive.has(id)) this.buf.delete(id);
  }
}
