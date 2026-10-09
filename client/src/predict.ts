import type { Vec2 } from '@aetherfall/shared';

export interface PredInput { seq: number; x: number; y: number; dt: number; }

/** Must match server movement speed (server/src/index.ts `sp = 8`). */
export const PRED_SPEED = 8;

/**
 * Client-side prediction with server reconciliation.
 * - applyInput: called at 20Hz alongside sendInput; integrates locally.
 * - reconcile: called on every snapshot for the local player; drops acked
 *   inputs (seq <= ackSeq) and re-simulates the rest from the server pos.
 */
export class Predictor {
  pos: Vec2 = { x: 10, y: 10 };
  pending = new Map<number, PredInput>();
  initialized = false;

  reset(x: number, y: number) {
    this.pos = { x, y };
    this.pending.clear();
    this.initialized = true;
  }

  applyInput(seq: number, x: number, y: number, dt: number) {
    const cx = Math.max(-1, Math.min(1, x));
    const cy = Math.max(-1, Math.min(1, y));
    // Server budget (anticheat moveToVelocity): overlong sticks normalize to the
    // unit circle. Mirror it so prediction matches authority (else diagonals
    // predict 8√2 u/s while the server moves 8 u/s -> constant mispredict).
    const mag = Math.hypot(cx, cy);
    const nx = mag > 1 ? cx / mag : cx;
    const ny = mag > 1 ? cy / mag : cy;
    this.pos = { x: this.pos.x + nx * PRED_SPEED * dt, y: this.pos.y + ny * PRED_SPEED * dt };
    this.clamp();
    this.pending.set(seq, { seq, x: nx, y: ny, dt });
    if (this.pending.size > 240) {
      const ks = [...this.pending.keys()].sort((a, b) => a - b);
      for (const k of ks.slice(0, this.pending.size - 240)) this.pending.delete(k);
    }
  }

  reconcile(serverX: number, serverY: number, ackSeq: number) {
    for (const k of [...this.pending.keys()]) if (k <= ackSeq) this.pending.delete(k);
    let x = serverX, y = serverY;
    for (const k of [...this.pending.keys()].sort((a, b) => a - b)) {
      const inp = this.pending.get(k)!;
      x += inp.x * PRED_SPEED * inp.dt;
      y += inp.y * PRED_SPEED * inp.dt;
    }
    this.pos = { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  }

  private clamp() {
    this.pos.x = Math.max(0, Math.min(100, this.pos.x));
    this.pos.y = Math.max(0, Math.min(100, this.pos.y));
  }
}
