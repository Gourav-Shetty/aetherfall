import {
  type Vec2,
  MAX_SPEED,
  stepBodyPhysics,
  applyImpulse as sharedApplyImpulse,
  type BodyPhysicsState,
  HITSTOP_DEFAULT_MS,
  DASH_IFRAME_MS,
  DASH_IMPULSE,
  SDI_NUDGE_DIST,
  HitstopCancelBuffer,
} from '@aetherfall/shared';

export interface PredInput {
  seq: number;
  x: number;
  y: number;
  dt: number;
}

/** Must match server movement speed (authoritative MAX_SPEED = 8). */
export const PRED_SPEED = MAX_SPEED;

/**
 * Client-side prediction with server reconciliation using Venturelli's model.
 * - applyInput: called at 20Hz alongside sendInput; integrates locally using Venturelli model.
 * - reconcile: called on every snapshot for the local player; drops acked
 *   inputs (seq <= ackSeq) and re-simulates the rest from the server pos & vel.
 * - applyImpulse: instant acceleration for dash / jump / knockback (impact rule).
 * - hitstop & SDI: freezes prediction sim during hitstop; allows subtle SDI nudges on directional inputs.
 * - cancel window: queues inputs pressed during hitstop to chain reliably when hitstop ends.
 */
export class Predictor {
  pos: Vec2 = { x: 10, y: 10 };
  vel: Vec2 = { x: 0, y: 0 };
  z = 0;
  vz = 0;
  pending = new Map<number, PredInput>();
  initialized = false;

  hitstopUntil = 0;
  iframeUntil = 0;
  readonly cancelBuffer = new HitstopCancelBuffer<string>();

  reset(x: number, y: number, vx = 0, vy = 0, z = 0, vz = 0) {
    this.pos = { x, y };
    this.vel = { x: vx, y: vy };
    this.z = z;
    this.vz = vz;
    this.pending.clear();
    this.hitstopUntil = 0;
    this.iframeUntil = 0;
    this.cancelBuffer.clear();
    this.initialized = true;
  }

  applyHitstop(durationMs = HITSTOP_DEFAULT_MS, nowMs?: number) {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.hitstopUntil = Math.max(this.hitstopUntil, t + durationMs);
  }

  isHitStopped(nowMs?: number): boolean {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return t < this.hitstopUntil;
  }

  applyDash(dirX: number, dirY: number, impulse = DASH_IMPULSE, nowMs?: number) {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mag = Math.hypot(dirX, dirY);
    if (mag > 0) {
      this.vel.x = (dirX / mag) * impulse;
      this.vel.y = (dirY / mag) * impulse;
    }
    this.iframeUntil = t + DASH_IFRAME_MS;
  }

  isInvulnerable(nowMs?: number): boolean {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return t < this.iframeUntil;
  }

  applySdi(dirX: number, dirY: number, nudgeDist = SDI_NUDGE_DIST) {
    const mag = Math.hypot(dirX, dirY);
    if (mag > 0) {
      this.pos.x = Math.max(0, Math.min(100, this.pos.x + (dirX / mag) * nudgeDist));
      this.pos.y = Math.max(0, Math.min(100, this.pos.y + (dirY / mag) * nudgeDist));
    }
  }

  queueCancel(action: string, nowMs?: number) {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.cancelBuffer.queue(action, t);
  }

  pollCancel(nowMs?: number): string | null {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return this.cancelBuffer.consume(this.isHitStopped(t), t);
  }

  applyInput(seq: number, x: number, y: number, dt: number, nowMs?: number) {
    const cx = Math.max(-1, Math.min(1, x));
    const cy = Math.max(-1, Math.min(1, y));
    const mag = Math.hypot(cx, cy);
    const nx = mag > 1 ? cx / mag : cx;
    const ny = mag > 1 ? cy / mag : cy;

    if (this.isHitStopped(nowMs)) {
      if (mag > 0) {
        this.applySdi(nx, ny);
      }
      this.pending.set(seq, { seq, x: nx, y: ny, dt });
      return;
    }

    const body: BodyPhysicsState = {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      z: this.z,
      vz: this.vz,
    };
    stepBodyPhysics(body, { moveX: nx, moveY: ny }, dt, { boundsW: 100, boundsH: 100 });
    this.pos.x = body.x;
    this.pos.y = body.y;
    this.vel.x = body.vx;
    this.vel.y = body.vy;
    this.z = body.z ?? 0;
    this.vz = body.vz ?? 0;

    this.pending.set(seq, { seq, x: nx, y: ny, dt });
    if (this.pending.size > 240) {
      const ks = [...this.pending.keys()].sort((a, b) => a - b);
      for (const k of ks.slice(0, this.pending.size - 240)) this.pending.delete(k);
    }
  }

  applyImpulse(ix: number, iy: number, iz?: number) {
    this.vel.x += ix;
    this.vel.y += iy;
    if (iz !== undefined) this.vz += iz;
  }

  reconcile(
    serverX: number,
    serverY: number,
    ackSeq: number,
    serverVx?: number,
    serverVy?: number,
    serverZ?: number,
    serverVz?: number,
  ) {
    for (const k of [...this.pending.keys()]) {
      if (k <= ackSeq) this.pending.delete(k);
    }
    const body: BodyPhysicsState = {
      x: serverX,
      y: serverY,
      vx: serverVx !== undefined ? serverVx : this.vel.x,
      vy: serverVy !== undefined ? serverVy : this.vel.y,
      z: serverZ !== undefined ? serverZ : this.z,
      vz: serverVz !== undefined ? serverVz : this.vz,
    };
    for (const k of [...this.pending.keys()].sort((a, b) => a - b)) {
      const inp = this.pending.get(k)!;
      stepBodyPhysics(body, { moveX: inp.x, moveY: inp.y }, inp.dt, { boundsW: 100, boundsH: 100 });
    }
    this.pos.x = body.x;
    this.pos.y = body.y;
    this.vel.x = body.vx;
    this.vel.y = body.vy;
    this.z = body.z ?? 0;
    this.vz = body.vz ?? 0;
  }
}
