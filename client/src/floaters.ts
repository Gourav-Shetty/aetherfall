// Pooled DOM damage-number layer for the three.js channel.
//
// The Canvas2D renderer paints its damage numbers straight onto the canvas; the
// WebGL channel has no text API we can hit for free, so it draws the same
// pooled numbers as absolutely-positioned divs over the canvas — the layer the
// nametags already live on. Every rule (cap, lifetime, rise, colours, the
// reduced-motion / high-contrast gate) comes from feedback.ts, so the two
// channels cannot drift apart.
//
// Pooling is the whole point: DMG_MAX divs are created on first use and then
// reused forever. A damage number is never a `createElement`, and nothing is
// allocated per frame beyond the pooled element's own style writes.

import {
  DAMAGE_STYLES,
  DamageNumberPool,
  DmgMode,
  DamageKind,
  FINISHER_LABEL,
  damageNumberText,
} from './feedback.js';
import type { DrawEntity } from './types.js';

/** Screen-space anchor for one pooled number. */
interface FloaterView {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  alpha: number;
  rise: number;
}

export class FloatTextLayer {
  private pool = new DamageNumberPool();
  private mode: DmgMode = 'full';
  private divs: HTMLElement[] = [];
  /** Reused projection output; the layer never allocates inside update(). */
  private view: FloaterView = {
    x: 0, y: 0, text: '', color: '#fff', size: 13, alpha: 1, rise: 0,
  };

  constructor(private layer: HTMLElement) {}

  /** Current presentation mode (tests). */
  getMode(): DmgMode {
    return this.mode;
  }

  /** Live numbers as of the last update (tests + cap pinning). */
  liveCount(): number {
    return this.pool.liveCount;
  }

  /** Pool capacity (DMG_MAX). */
  capacity(): number {
    return this.pool.capacity;
  }

  /**
   * a11y gate (see damageNumberMode). 'off' clears the layer outright so a
   * high-contrast player never sees floating text.
   */
  setMode(mode: DmgMode) {
    this.mode = mode === 'off' ? 'off' : mode === 'short' ? 'short' : 'full';
    if (this.mode === 'off') {
      this.pool.clear();
      this.hideAll();
    }
  }

  /** Spawn a number at a world anchor (or on `followId` when given). */
  spawn(x: number, y: number, amount: number, kind: DamageKind = 'normal', nowMs?: number, followId = -1): boolean {
    const t = nowMs ?? performance.now();
    return this.pool.spawn(x, y, amount, kind, t, this.mode, followId);
  }

  /**
   * Spawn the finisher marker. The executing swing removes no HP worth
   * printing, so the labelled number carries the confirmation instead.
   */
  spawnFinisher(x: number, y: number, nowMs?: number): boolean {
    return this.pool.spawnLabel(x, y, FINISHER_LABEL, 'finisher', nowMs ?? performance.now(), this.mode);
  }

  /**
   * Advance + position every live number. `project` maps a world (x, y, z) to
   * screen pixels; `list` resolves `followId` anchors so the player's own
   * damage rides along with them.
   */
  update(
    nowMs: number,
    list: DrawEntity[] | null,
    project: (x: number, y: number, z: number) => { sx: number; sy: number },
    terrainZ?: (x: number, y: number) => number,
  ): void {
    this.pool.step(nowMs);
    let used = 0;
    for (let i = 0; i < this.pool.capacity; i++) {
      const d = this.pool.at(i);
      if (!d.active) continue;
      let wx = d.x;
      let wy = d.y;
      if (d.followId >= 0 && list !== null) {
        for (let j = 0; j < list.length; j++) {
          const e = list[j]!;
          if (e.id !== d.followId) continue;
          wx = e.x;
          wy = e.y;
          break;
        }
      }
      const z = terrainZ === undefined ? 0 : terrainZ(wx, wy);
      const p = project(wx, wy, z);
      const style = DAMAGE_STYLES[d.kind] ?? DAMAGE_STYLES.normal;
      const v = this.view;
      v.x = p.sx;
      v.y = p.sy;
      v.text = damageNumberText(d);
      v.color = style.color;
      v.size = style.size;
      v.alpha = d.alpha;
      v.rise = d.offset;
      // Paint into a DENSE node index (0..used-1) rather than the pool slot
      // index, so an idle node is reused by the very next hit instead of the
      // layer growing to DMG_MAX over a session.
      this.paint(used, v);
      used++;
    }
    for (let i = used; i < this.divs.length; i++) this.hide(i);
  }

  /** Write one pooled div's transform/colour. Creates it on first use. */
  private paint(i: number, v: FloaterView) {
    let el = this.divs[i];
    if (el === undefined) {
      el = this.layer.ownerDocument.createElement('div');
      el.className = 'float af-pool';
      // A pooled div is repositioned by transform only, so the browser never
      // reflows the whole overlay.
      el.style.position = 'absolute';
      el.style.transform = 'translate(-50%,-50%)';
      el.style.willChange = 'transform, opacity';
      el.style.pointerEvents = 'none';
      this.layer.appendChild(el);
      this.divs[i] = el;
    }
    const alpha = Math.max(0, Math.min(1, v.alpha));
    el.style.opacity = alpha.toFixed(3);
    el.style.color = v.color;
    el.style.fontSize = `${v.size}px`;
    el.style.transform = `translate(-50%,-50%) translate(${v.x.toFixed(1)}px, ${(v.y - 18 - v.rise).toFixed(1)}px)`;
    if (el.textContent !== v.text) el.textContent = v.text;
    el.style.display = '';
  }

  /** Hide (never destroy) one pooled div. */
  private hide(i: number) {
    const el = this.divs[i];
    if (el === undefined) return;
    el.style.display = 'none';
  }

  private hideAll() {
    for (let i = 0; i < this.divs.length; i++) this.hide(i);
  }

  /** Drop every live number (respawn, disconnect, mode flips). */
  clear(): void {
    this.pool.clear();
    this.hideAll();
  }

  /**
   * Forget the pooled divs entirely. Call this when the host layer's contents
   * are wiped (renderer switch): the old nodes are detached, so keeping the
   * references would silently paint into nothing.
   */
  reset(): void {
    this.pool.clear();
    for (let i = 0; i < this.divs.length; i++) {
      const el = this.divs[i];
      if (el === undefined) continue;
      try { el.remove(); } catch { /* detached already */ }
    }
    this.divs.length = 0;
  }
}