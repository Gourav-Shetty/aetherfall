// AETHERFALL client — mobile touch joystick + attack button. Mouse-compatible for testing.
// Usage: const joy = new Joystick(base, knob); joy.vec -> {x,y} in [-1,1].
// `normalize(dx, dy, halfWidth)` is pure so the dead-zone/clamp math is unit
// testable without a DOM.
export class Joystick {
  vec = { x: 0, y: 0 };
  private activePointer: number | null = null;
  private baseRect: DOMRect | null = null;

  constructor(private base: HTMLElement, private knob: HTMLElement) {
    this.bind();
  }

  get active(): boolean {
    return this.activePointer !== null;
  }

  private setKnob(dx: number, dy: number) {
    const r = 34; // max knob travel px
    const len = Math.hypot(dx, dy);
    const k = len > r ? r / len : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  private resetKnob() {
    this.knob.style.transform = 'translate(0px, 0px)';
  }

  private bind() {
    const start = (e: PointerEvent) => {
      this.activePointer = e.pointerId;
      this.baseRect = this.base.getBoundingClientRect();
      this.base.setPointerCapture?.(e.pointerId);
      this.move(e);
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== this.activePointer || !this.baseRect) return;
      this.move(e);
      e.preventDefault();
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.activePointer) return;
      this.reset();
      e.preventDefault();
    };
    this.base.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // Losing focus mid-drag (alt-tab, notification) never fires pointerup,
    // which would leave the player walking into a wall forever.
    window.addEventListener('blur', () => this.reset());
  }

  /** Snap the stick back to neutral (also used on window blur). */
  reset() {
    this.activePointer = null;
    this.baseRect = null;
    this.vec.x = 0;
    this.vec.y = 0;
    this.resetKnob();
  }

  private move(e: PointerEvent) {
    const r = this.baseRect ?? this.base.getBoundingClientRect();
    const { x, y } = normalize(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / 2);
    this.vec.x = x;
    this.vec.y = y;
    this.setKnob(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
  }
}

/** Dead-zone 0.15 of the base radius, then clamp to the unit disc. */
const DEAD_ZONE = 0.15;

/**
 * Pure stick math: offset from the base centre (px) -> [-1,1] vector.
 * `half` is the base radius in px. Zero/NaN radius yields a neutral stick.
 */
export function normalize(dx: number, dy: number, half: number): { x: number; y: number } {
  if (!Number.isFinite(half) || half <= 0) return { x: 0, y: 0 };
  let nx = dx / half;
  let ny = dy / half;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return { x: 0, y: 0 };
  const len = Math.hypot(nx, ny);
  if (len < DEAD_ZONE) return { x: 0, y: 0 };
  if (len > 1) { nx /= len; ny /= len; }
  return { x: nx, y: ny };
}

/** Blend keyboard axes with the analog stick, renormalized past the unit disc. */
export function blendMove(
  kx: number, ky: number, jx: number, jy: number,
): { x: number; y: number } {
  let x = kx + jx;
  let y = ky + jy;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  return { x, y };
}